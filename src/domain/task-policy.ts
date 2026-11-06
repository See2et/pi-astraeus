import { isCli, isWriter, overlapping, type Job, type Task } from "./workflow.ts";

export function requireAdjudicableReview(task: Task, currentTarget: string): Job {
  const review = [...task.jobs].reverse().find((j) => j.role === "reviewer");
  if (
    !review?.valid ||
    review.result?.status !== "complete" ||
    review.result?.verdict !== "changes_required" ||
    review.result?.unresolved?.length ||
    !review.result?.checked_scope?.length ||
    !review.result?.evidence?.length
  )
    throw new Error(
      "Only complete changes_required review with complete scope/evidence triggers adjudication.",
    );
  if (task.target_id !== currentTarget)
    throw new Error("Review target changed; adjudication cannot repair a stale review.");
  if (task.jobs.some((j) => j.role === "adjudicator" && j.review_run === review.run_id && j.valid))
    throw new Error(
      "This review already has an adjudication. Investigate unresolved evidence instead of a debate loop.",
    );
  return review;
}

export function requireAdoptedCorrection(task: Task): Job | undefined {
  const review = [...task.jobs].reverse().find((j) => j.role === "reviewer");
  if (review?.valid && review.result?.verdict === "changes_required") {
    const decision = [...task.jobs]
      .reverse()
      .find((j) => j.role === "adjudicator" && j.review_run === review.run_id && j.valid);
    if (!decision || decision.result?.verdict !== "changes_required")
      throw new Error(
        "Only adopted fixes from a complete adjudication may return to the implementer.",
      );
    return decision;
  }
}

export function requireDisjointWriters(owned: readonly string[], running: readonly Job[]): void {
  if (running.some((j) => !isWriter(j.role) || overlapping(owned, j.owned_paths)))
    throw new Error("Concurrent writers need disjoint ownership; no writes during review.");
}

// A failed, undispatched preparation may settle only this exact persisted shape.
// Missing UUIDs, absent reports and lifecycle strings alone never prove freeze.
export function settlePreparationFailure(job: Job): boolean {
  const cli = job.cli;
  const settled =
    job.status === "prelaunch-failed" &&
    cli?.frozen === true &&
    typeof cli.preparation_failure === "string" &&
    cli.preparation_failure === job.error;
  if (
    !isCli(job) ||
    job.role !== "designer" ||
    job.agent_id !== null ||
    job.valid !== false ||
    job.result ||
    job.artifact ||
    !["unknown", "error", "unavailable", "prelaunch-failed"].includes(job.status) ||
    typeof job.error !== "string" ||
    !job.error ||
    !cli ||
    (!settled && (cli.frozen !== false || Object.hasOwn(cli, "preparation_failure"))) ||
    !Array.isArray(cli.evidence) ||
    cli.evidence.length ||
    Object.keys(cli).some(
      (key) => !["frozen", "evidence", "notified_status", "preparation_failure"].includes(key),
    )
  )
    return false;
  cli.preparation_failure ??= job.error;
  cli.frozen = true;
  job.status = "prelaunch-failed";
  job.collected = true;
  job.valid = false;
  return true;
}
