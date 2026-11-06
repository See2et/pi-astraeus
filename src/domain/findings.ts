import {
  isWriter,
  type Command,
  type Disposition,
  type Finding,
  type Job,
  type Task,
} from "./workflow.ts";

export function requireCompleteReview(review: Job, historical = false): void {
  const r = review.result;
  if (
    (!review.valid && !historical) ||
    review.role !== "reviewer" ||
    r?.status !== "complete" ||
    r.verdict === "inconclusive" ||
    r.unresolved?.length ||
    !r.checked_scope?.length ||
    !r.evidence?.length
  )
    throw new Error(
      "Complete validated review with scope/evidence required; unresolved coverage cannot be waived.",
    );
}
export function findingAt(review: Job, ref: string): Finding | string {
  const match = /^(violations|bugs|suggestions)\/(0|[1-9][0-9]*)$/.exec(ref);
  const list = match && review.result?.[match[1] as "violations" | "bugs" | "suggestions"];
  const value = list?.[Number(match?.[2])];
  if (!value)
    throw new Error("Unknown source finding ref; use exact violations/N, bugs/N or suggestions/N.");
  return value;
}
export function blockingRefs(review: Job): string[] {
  return (["violations", "bugs"] as const).flatMap((field) =>
    (review.result?.[field] ?? []).map((_, index) => `${field}/${index}`),
  );
}
export function sourceFinding(task: Task, value: string): { review: Job; ref: string } {
  const match = /^([^/]+)\/((?:violations|bugs)\/(?:0|[1-9][0-9]*))$/.exec(value);
  const review = match && task.jobs.find((j) => j.run_id === match[1]);
  if (!review)
    throw new Error(
      "prior_finding requires an exact saved review-run/bugs/N or review-run/violations/N source.",
    );
  // Retained result evidence is revalidated by the application even if a later
  // stop/collection changed lifecycle validity; that is not a finding disposition.
  requireCompleteReview(review, true);
  findingAt(review, match![2]);
  return { review, ref: match![2] };
}
export function dispositionFor(task: Task, review: Job, ref: string): Disposition | undefined {
  const history = task.dispositions ?? [];
  const explicit = [...history]
    .reverse()
    .find((d) => d.review_run === review.run_id && d.ref === ref);
  const finding = findingAt(review, ref);
  const linked =
    typeof finding !== "string" && finding.prior_decision
      ? history.find((d) => d.id === finding.prior_decision)
      : undefined;
  const base =
    explicit ?? linked ?? history.find((d) => d.finding_id === `${review.run_id}/${ref}`);
  // A later reopening or disputed decision for the same identity must not be
  // hidden by a reviewer linking an older, favorable decision.
  return base && [...history].reverse().find((d) => d.finding_id === base.finding_id);
}
export function recordDisposition(
  task: Task,
  review: Job,
  p: Command,
  id: string,
  adjudication?: Job,
): Disposition {
  requireCompleteReview(review);
  const finding = findingAt(review, p.ref ?? "");
  if (
    !["adopt", "reject", "optional"].includes(p.action!) ||
    !["clear", "disputed"].includes(p.route!) ||
    !p.authority?.trim() ||
    !p.rationale?.trim() ||
    !p.evidence?.trim()
  )
    throw new Error(
      "disposition requires action adopt/reject/optional, route clear/disputed, authority, rationale and concrete evidence.",
    );
  const history = task.dispositions ?? [];
  const priorId =
    p.prior_decision ??
    (!p.prior_finding && typeof finding !== "string" ? finding.prior_decision : undefined);
  if (p.prior_finding && priorId)
    throw new Error("Use prior_finding or prior_decision, not both identity mappings.");
  const source = p.prior_finding ? sourceFinding(task, p.prior_finding) : undefined;
  if (source && task.jobs.indexOf(source.review) >= task.jobs.indexOf(review))
    throw new Error("prior_finding must identify an earlier source review.");
  const prior = priorId
    ? history.find((d) => d.id === priorId)
    : source
      ? dispositionFor(task, source.review, source.ref)
      : dispositionFor(task, review, p.ref!);
  const identity = prior?.finding_id ?? p.prior_finding ?? id;
  if (priorId && !prior)
    throw new Error("Unknown prior_decision; explicit task-scoped trace required.");
  const existing = [...history]
    .reverse()
    .find((d) => d.review_run === review.run_id && d.ref === p.ref);
  if (existing && existing.finding_id !== identity)
    throw new Error(
      "Cannot remap an already decided source finding to a different identity; preserve its decision/reopening trace.",
    );
  const latest = prior && [...history].reverse().find((d) => d.finding_id === prior.finding_id)!;
  const previous = latest
    ? { action: latest.action, disputed: latest.route === "disputed", evidence: latest.evidence }
    : resolution(task, source?.review ?? review, source?.ref ?? p.ref!);
  if (previous.disputed && !adjudication)
    throw new Error(
      "Disputed scope/evidence/interpretation requires independent adjudication, not a clear-route overwrite.",
    );
  if (
    ["reject", "optional"].includes(previous.action!) &&
    !previous.disputed &&
    (p.action === "adopt" || p.route === "disputed") &&
    (!p.reopening?.trim() || p.evidence.trim() === previous.evidence?.trim())
  )
    throw new Error(
      "Reopening requires concrete new evidence or relevant code change, not a new ID, wording, severity or target hash.",
    );
  const decision: Disposition = {
    id,
    finding_id: identity,
    review_run: review.run_id,
    ref: p.ref!,
    review_hash: review.result_hash!,
    target_id: review.target_id!,
    action: p.action!,
    route: p.route === "disputed" ? "disputed" : adjudication ? "adjudicated" : p.route!,
    authority: p.authority.trim(),
    rationale: p.rationale.trim(),
    evidence: p.evidence.trim(),
    ...(latest ? { prior_decision: latest.id } : {}),
    ...(p.prior_finding ? { prior_finding: p.prior_finding } : {}),
    ...(p.reopening ? { reopening: p.reopening } : {}),
    ...(adjudication ? { adjudication_run: adjudication.run_id } : {}),
  };
  (task.dispositions ??= []).push(decision);
  task.accepted = false;
  const current = blockingRefs(review).map((ref) => dispositionFor(task, review, ref));
  task.phase = current.some((d) => d?.route === "disputed")
    ? "needs-adjudication"
    : current.some((d) => !d)
      ? "needs-assessment"
      : current.some((d) => d?.action === "adopt")
        ? "needs-fixes"
        : "ready-for-root";
  return decision;
}
function resolution(task: Task, review: Job, ref: string) {
  const decision = dispositionFor(task, review, ref);
  if (decision)
    return {
      action: decision.action,
      disputed: decision.route === "disputed",
      token: decision.id,
      evidence: decision.evidence,
    };
  // Existing v1 adjudications remain evidence without rewriting saved history.
  const legacy = [...task.jobs]
    .reverse()
    .find(
      (j) =>
        j.role === "adjudicator" &&
        j.review_run === review.run_id &&
        j.valid &&
        j.result?.status === "complete",
    );
  const item = legacy?.result?.decisions?.find((d) => d.ref === ref);
  return {
    action: item?.action === "fix" ? "adopt" : item?.action === "reject" ? "reject" : undefined,
    disputed: !!item && ["investigate", "human_decision"].includes(item.action),
    token: `${review.run_id}/${ref}`,
    evidence: item?.evidence,
  };
}
export function blockingReviews(task: Task): Job[] {
  return task.jobs.filter(
    (j) =>
      j.role === "reviewer" &&
      j.result?.status === "complete" &&
      j.result.verdict === "changes_required",
  );
}
export function pendingAdjudicationReports(task: Task): Job[] {
  return task.jobs.filter(
    (j) =>
      j.role === "adjudicator" &&
      j.result?.status === "complete" &&
      (j.result.verdict === "inconclusive" ||
        !!j.result.unresolved?.length ||
        !j.result.checked_scope?.length ||
        !j.result.evidence?.length),
  );
}
export function assessmentTokens(task: Task): string[] {
  return [
    ...new Set(
      blockingReviews(task)
        .flatMap((review) => blockingRefs(review).map((ref) => resolution(task, review, ref)))
        .filter((d) => d.action === "adopt" && !d.disputed)
        .map((d) => d.token)
        .concat(pendingAdjudicationReports(task).map((report) => `${report.run_id}/report`)),
    ),
  ];
}
function ownerAssessment(task: Task, token: string, start: number, end: number): boolean {
  return task.jobs
    .slice(start, end)
    .some(
      (owner) =>
        isWriter(owner.role) &&
        owner.valid &&
        owner.collected &&
        owner.dispatch === "confirmed" &&
        owner.assessed_decisions?.includes(token) &&
        !!owner.summary?.trim(),
    );
}
export function requireHistoricalResolutions(task: Task, current: Job): void {
  requireCompleteReview(current);
  const end = task.jobs.indexOf(current);
  for (const [index, review] of task.jobs.slice(0, end).entries()) {
    if (
      review.role !== "reviewer" ||
      review.result?.status !== "complete" ||
      review.result.verdict !== "changes_required"
    )
      continue;
    for (const ref of blockingRefs(review)) {
      const state = resolution(task, review, ref);
      if (!state.disputed && ["reject", "optional"].includes(state.action!)) continue;
      const assessed =
        state.action === "adopt" &&
        !state.disputed &&
        ownerAssessment(task, state.token, index + 1, end);
      if (!assessed)
        throw new Error(
          `Outstanding historical blocker ${review.run_id}/${ref}: explicit disposition or supported owner assessment followed by fresh complete review required; omission/pass alone is not resolution.`,
        );
    }
  }
  for (const report of pendingAdjudicationReports(task)) {
    if (!ownerAssessment(task, `${report.run_id}/report`, task.jobs.indexOf(report) + 1, end))
      throw new Error(
        `Adjudication ${report.run_id} has pending report-level unresolved/coverage/evidence matters. Individual dispositions, overrides or a later pass alone cannot waive them. Collect an owner assessment bound to this report, then a fresh complete review of the resolution evidence.`,
      );
  }
}
export function requireNoPendingDisputes(task: Task): void {
  const latest = new Map((task.dispositions ?? []).map((d) => [d.finding_id, d]));
  if (
    [...latest.values()].some(
      (d) =>
        d.route === "disputed" &&
        (task.dispositions ?? []).some(
          (origin) =>
            origin.finding_id === d.finding_id &&
            (/^(bugs|violations)\//.test(origin.ref) || !!origin.prior_finding),
        ),
    )
  )
    throw new Error(
      "Unresolved disputed findings require independent adjudication; a subsequent pass or omitted finding cannot silently discharge them.",
    );
}
export function requireResolvedFindings(task: Task, review: Job, fixing = false): void {
  requireCompleteReview(review);
  for (const ref of blockingRefs(review)) {
    const decision = dispositionFor(task, review, ref);
    if (!decision || decision.route === "disputed")
      throw new Error(
        "Unmapped blocking or disputed findings require explicit disposition/independent adjudication.",
      );
    if (!fixing && decision.action === "adopt")
      throw new Error("Adopted blocking findings require owner assessment/fix and a fresh review.");
  }
}
