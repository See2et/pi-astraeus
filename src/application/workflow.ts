import {
  blockingRefs,
  dispositionFor,
  recordDisposition,
  requireResolvedFindings,
  requireNoPendingDisputes,
  requireHistoricalResolutions,
  assessmentTokens,
  pendingAdjudicationReports,
  blockingReviews,
  sourceFinding,
} from "../domain/findings.ts";
import {
  requireAdjudicableReview,
  requireAdoptedCorrection,
  requireDisjointWriters,
  settlePreparationFailure,
} from "../domain/task-policy.ts";
import {
  ENTRY,
  ROLES,
  ACTIVE,
  isWriter,
  isCli,
  designAuthorization,
  designModel,
  selectModel,
  observedStatus,
  CLAUDE_TRANSPORT,
  CLI_EFFORTS,
  validatePaths,
  validateChecks,
  phaseAfterReport,
  requireCompleteChecks,
} from "../domain/workflow.ts";
import type { Task, Job, Command, CliState } from "../domain/workflow.ts";
import { assertReceipt, parseReport } from "../domain/receipts.ts";
import type { Runtime, Host, Context, MonitorSession, WorkflowOptions } from "./ports.ts";

export class Workflow {
  readonly host: Host;
  readonly root: string;
  readonly python: string;
  readonly claude: WorkflowOptions["claude"];
  tasks: Record<string, Task>;
  queue: Promise<unknown>;
  readonly pollInterval: number;
  readonly maxBackoff: number;
  session: MonitorSession | null;
  operationSession: MonitorSession | null = null;
  constructor(
    host: Host,
    { root, python, claude, pollInterval = 3000, maxBackoff = 30000 }: WorkflowOptions,
    private readonly io: Runtime,
  ) {
    this.host = host;
    this.root = root;
    this.python = python;
    this.claude = claude;
    this.tasks = {};
    this.queue = Promise.resolve();
    this.pollInterval = pollInterval;
    this.maxBackoff = maxBackoff;
    this.session = null;
  }
  dispose() {
    const session = this.session;
    if (!session) return;
    this.session = null;
    clearTimeout(session.timer ?? undefined);
    session.controller.abort();
  }
  current(session: MonitorSession | null): session is MonitorSession {
    if (!session || session !== this.session || session.controller.signal.aborted) return false;
    // Pi context accessors throw when their owning runtime/session is retired.
    try {
      if (session.ctx.sessionManager.getSessionId() !== session.id) return false;
      const anchor = session.treePause?.anchor;
      return (
        anchor == null ||
        session.ctx.sessionManager.getBranch().some((entry) => entry.id === anchor)
      );
    } catch {
      return false;
    }
  }
  ensureMonitoring(ctx: Context) {
    if (!this.session || !this.current(this.session)) this.startMonitoring(ctx);
  }
  startMonitoring(ctx: Context) {
    this.dispose();
    const session = {
      ctx,
      id: ctx.sessionManager.getSessionId(),
      controller: new AbortController(),
      timer: null,
      cursor: 0,
      failures: 0,
    };
    this.session = session;
    this.schedule(session, 0);
  }
  beforeTree(ctx: Context) {
    // Retire in-flight reads, but keep a session-owned timer: Pi emits no
    // session_tree on cancellation, summary abort, or summary error.
    this.startMonitoring(ctx);
    this.session!.treePause = { anchor: ctx.sessionManager.getLeafId() };
  }
  latestCli(tasks = Object.values(this.tasks)) {
    return [
      ...new Map(
        tasks.flatMap((task) =>
          task.jobs.filter(isCli).map((job) => [job.agent_id || job.run_id, { task, job }]),
        ),
      ).values(),
    ];
  }
  lifecycleSignature(job: Job) {
    return JSON.stringify({
      status: job.status,
      valid: job.valid,
      error: job.error,
      frozen: job.cli!.frozen,
      copy_frozen: job.cli!.copy_frozen,
      observed: job.cli!.observed,
      notified_status: job.cli!.notified_status,
    });
  }
  schedule(session: MonitorSession | null, delay = this.pollInterval) {
    if (!this.current(session) || !this.host.notify) return;
    clearTimeout(session.timer ?? undefined);
    session.timer = setTimeout(() => {
      if (!this.current(session)) return;
      const next = this.queue.then(async () => {
        if (!this.current(session)) return;
        if (session.treePause) {
          // Public isIdle includes branch summarization in Pi 1.0.4. Do not
          // append entries or trigger inference while navigation is pending.
          if (!session.ctx.isIdle()) return;
          delete session.treePause;
        }
        const owners = this.latestCli().filter(({ job }) => !job.collected);
        if (!owners.length) return;
        const { task, job } = owners[session.cursor++ % owners.length];
        // One owner per tick bounds occupation of the operation queue.
        const before = this.lifecycleSignature(job);
        const ok = await this.refreshCli(task, job, session.ctx, session);
        if (!this.current(session)) return;
        session.failures = ok ? 0 : Math.min(session.failures + 1, 5);
        // Stable polls must not append full baselines to the session every tick.
        if (before !== this.lifecycleSignature(job)) this.save(session.ctx);
      });
      this.queue = next.catch(() => {});
      next
        .catch(() => {})
        .finally(() =>
          this.schedule(
            session,
            Math.min(this.maxBackoff, this.pollInterval * 2 ** session.failures),
          ),
        );
    }, delay);
    session.timer.unref?.();
  }
  notice(task: Task, job: Job, ctx: Context, session: MonitorSession | null) {
    if (
      !session ||
      !this.current(session) ||
      session.treePause ||
      !this.host.notify ||
      job.cli!.notified_status === job.status
    )
      return;
    // Running clears the transition baseline but does not wake an idle parent.
    if (["work-ended", "blocked", "stopped", "unknown"].includes(job.status)) {
      const meaning =
        job.status === "work-ended"
          ? "Observed work ended; ready to attempt collect, NOT implementation success."
          : "Needs attention; NOT successful completion.";
      this.host.notify(
        {
          task_id: task.task_id,
          run_id: job.run_id,
          status: job.status,
          diagnostic: meaning,
          error: job.error?.slice(0, 1024),
        },
        ctx,
      );
    }
    job.cli!.notified_status = job.status;
    return true;
  }
  assertOperationActive() {
    if (this.operationSession && !this.current(this.operationSession))
      throw new Error("Operation belongs to retired session.");
  }
  settlePreparationFailure(job: Job) {
    return settlePreparationFailure(job);
  }
  async cliOperation(method: "observe" | "stop" | "start" | "resume", job: Job, ...args: any[]) {
    const session = this.operationSession;
    this.assertOperationActive();
    if (["observe", "stop"].includes(method)) {
      if (this.settlePreparationFailure(job)) return { prelaunch_failed: true };
      // Acceptance, collection and stop observe outside refreshCli as well.
      // Preserve verified failure provenance before any lifecycle overwrite.
      const task = Object.values(this.tasks).find((t) => t.jobs.includes(job));
      const preparationOnly = task && (await this.failedResumePreparation(task, job));
      this.assertOperationActive();
      if (preparationOnly) job.resume_preparation_failure ??= job.error;
    }
    const staged = structuredClone(job);
    let result, error;
    try {
      result = await (this.claude[method] as (...args: any[]) => Promise<any>)(
        staged,
        ...args,
        session?.controller.signal,
      );
    } catch (caught: any) {
      error = caught;
    }
    this.assertOperationActive();
    Object.assign(job, staged);
    if (
      method === "observe" ||
      ["CLAUDE_OBSERVATION_UNCERTAIN", "CLAUDE_BINDING_REFUSED"].includes(error?.code)
    ) {
      job.status = error ? "unknown" : observedStatus(job.cli!.observed);
      if (error) {
        job.cli!.observation_failure ??= String(error).slice(0, 1024);
        job.cli!.frozen = false;
        job.valid = false;
        job.error = String(error).slice(0, 1024);
      }
    }
    if (error) throw error;
    return result;
  }
  async refreshCli(task: Task, job: Job, ctx: Context, session = this.session) {
    if (session && !this.current(session)) return false;
    if (this.settlePreparationFailure(job)) return true;
    // Observation can change lifecycle status and clear the current error. Keep
    // verified preparation-only provenance separate so status/restore cannot
    // turn an inherited failed attempt into a superseding owner.
    const preparationOnly = await this.failedResumePreparation(task, job);
    if (session && !this.current(session)) return false;
    if (preparationOnly) job.resume_preparation_failure ??= job.error;
    const staged = structuredClone(job);
    let error;
    try {
      await this.claude.observe(staged, task.cwd, session?.controller.signal);
    } catch (caught: any) {
      error = caught;
    }
    // Never mutate a retired job reference, including from an ignored abort.
    if (session && !this.current(session)) return false;
    job.cli = staged.cli;
    if (
      !job.cli!.ownership_failure &&
      (job.error || "").startsWith("Error: Out-of-ownership baseline delta: ")
    ) {
      job.cli!.ownership_failure = {
        error: job.error!,
        provenance:
          "Retained failed collection state; pre-recovery report/source hashes were not captured by the older collector.",
      };
    }
    if (error) {
      job.cli!.observation_failure ??= String(error).slice(0, 1024);
      job.status = "unknown";
      job.cli!.frozen = false;
      job.valid = false;
      job.error = String(error).slice(0, 1024);
    } else {
      job.status = observedStatus(job.cli!.observed);
      if (!job.resume_preparation_failure) delete job.error;
    }
    this.notice(task, job, ctx, session);
    return !error;
  }
  bridge(args: string[], ctx: Context) {
    return this.io.run(
      this.python,
      [this.io.join(this.root, "scripts/astraeus.py"), ...args],
      ctx.cwd,
    );
  }
  async policy(ctx: Context) {
    return JSON.parse(await this.bridge(["policy", "--repo", ctx.cwd], ctx));
  }
  async target(ctx: Context) {
    return (await this.bridge(["target", "--repo", ctx.cwd], ctx)).trim();
  }
  manager() {
    return this.host.manager();
  }
  restore(ctx: Context) {
    this.dispose();
    this.tasks = {};
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === ENTRY && entry.data?.version === 1)
        this.tasks = structuredClone(entry.data.tasks);
    }
    for (const task of Object.values(this.tasks)) {
      for (const job of task.jobs)
        if (!isCli(job) && ACTIVE.has(job.status) && !this.manager()?.getRecord(job.agent_id))
          job.status = "unavailable";
    }
    this.show(ctx);
    if (this.host.notify) this.startMonitoring(ctx);
  }
  save(ctx: Context) {
    this.assertOperationActive();
    this.host.appendEntry(ENTRY, { version: 1, tasks: structuredClone(this.tasks) });
    this.show(ctx);
  }
  show(ctx: Context) {
    if (ctx.hasUI)
      ctx.ui.setStatus(
        "pi-astraeus",
        Object.values(this.tasks)
          .map((t) => `${t.task_id}: ${t.phase}`)
          .join(" · ") || "Astraeus ready",
      );
  }
  task(id: string, ctx: Context) {
    const task = this.tasks[id];
    if (!task) throw new Error(`Unknown task: ${id}`);
    if (task.cwd !== this.io.realpathSync(ctx.cwd))
      throw new Error("This task belongs to another working directory.");
    return task;
  }
  activeJobs(cwd: string) {
    return Object.values(this.tasks)
      .filter((task) => task.cwd === cwd)
      .flatMap((task) => {
        const latest = new Map(task.jobs.map((job) => [job.agent_id || job.run_id, job]));
        return [...latest.values()].filter((job) =>
          isCli(job)
            ? !job.cli!.frozen || (job.cli!.unexpected_copy && !job.cli!.copy_frozen)
            : job.dispatch !== "never" &&
              (ACTIVE.has(this.manager()?.getRecord(job.agent_id)?.status ?? job.status) ||
                (job.dispatch === "uncertain" && !job.collected) ||
                (isWriter(job.role) &&
                  !job.cessation &&
                  !["completed", "stopped", "failed"].includes(
                    this.manager()?.getRecord(job.agent_id)?.status ?? "",
                  ))),
        );
      });
  }
  async status(ctx: Context, id?: string, run?: string, ref?: string) {
    const session = this.session;
    const tasks = id ? [this.task(id, ctx)] : Object.values(this.tasks);
    for (const { task, job } of this.latestCli(tasks)) {
      await this.refreshCli(task, job, ctx, session);
      if (session && !this.current(session)) throw new Error("Session retired during observation.");
    }
    for (const task of tasks) {
      for (const job of task.jobs.filter((j) => !isCli(j))) {
        const record = this.manager()?.getRecord(job.agent_id);
        if (ACTIVE.has(job.status)) job.status = record?.status ?? "unavailable";
      }
      if (task.target_id && task.cwd === this.io.realpathSync(ctx.cwd)) {
        const target = await this.target(ctx);
        if (session && !this.current(session)) throw new Error("Session retired during status.");
        if (target !== task.target_id) {
          task.phase = "stale";
          task.accepted = false;
        }
      }
    }
    this.save(ctx);
    return tasks.map((task) => ({
      ...structuredClone(task),
      jobs: structuredClone(run ? task.jobs.filter((j) => j.run_id === run) : task.jobs),
      dispositions: structuredClone(
        task.dispositions?.filter((d) => (!run || d.review_run === run) && (!ref || d.ref === ref)),
      ),
      recovery: this.recovery({ op: "status", task_id: task.task_id, run_id: run }).recovery,
    }));
  }
  execute(params: Command, ctx: Context, signal?: AbortSignal) {
    const session = this.session;
    const next = this.queue.then(async () => {
      if (session && !this.current(session))
        throw new Error("Queued operation belongs to retired session.");
      this.operationSession = session;
      try {
        return await this.action(params, ctx, signal);
      } finally {
        try {
          if (session && this.current(session)) {
            let changed = false;
            for (const { task, job } of this.latestCli())
              changed = this.notice(task, job, ctx, session) || changed;
            if (changed) this.save(ctx);
          }
        } finally {
          this.operationSession = null;
        }
      }
    });
    this.queue = next.catch(() => {});
    return next;
  }
  async artifacts(task: Task, ctx: Context) {
    // Outside the source tree: receipts never invalidate a Git target or modify .gitignore.
    const session = ctx.sessionManager.getSessionId()!;
    if (!/^[\w-]+$/.test(session)) throw new Error("Invalid session ID");
    const path = this.io.join(this.host.agentDir(), "astraeus", session, task.task_id);
    await this.io.mkdir(path, { recursive: true, mode: 0o700 });
    return path;
  }
  async requireCessation(task: Task, job: Job) {
    if (job.dispatch === "never" && !job.agent_id) return;
    if (isCli(job)) {
      await this.cliOperation("observe", job, task.cwd);
      if (!job.cli!.frozen || (job.cli!.unexpected_copy && !job.cli!.copy_frozen))
        throw new Error(
          "Takeover requires exact CLI freeze; explicitly stop/collect the observed UUID/cwd first.",
        );
      await this.io.originalRequest(task, job);
      await this.claude.audit(job);
    } else {
      const record = this.manager()?.getRecord(job.agent_id);
      if (record) {
        if (record.type !== `astraeus-${job.role}`)
          throw new Error(
            "Predecessor native role binding changed; recover exact original host identity.",
          );
        if (!["completed", "stopped", "failed"].includes(record.status))
          throw new Error(
            "Predecessor writes have not ceased; explicitly stop and collect exact owner first.",
          );
        assertReceipt(job, record);
        job.cessation = {
          source: "native manager before takeover",
          status: record.status,
          agent_id: job.agent_id!,
        };
      } else if (!job.cessation || job.cessation.agent_id !== job.agent_id)
        throw new Error(
          "Cannot verify cessation of predecessor writes. Missing native record is not stop evidence. Recover exact native handle and explicitly stop/collect; do not retry dispatch.",
        );
    }
  }
  async auditDispositions(task: Task, ctx: Context) {
    const checked = new Set<string>();
    const historical = blockingReviews(task);
    const pendingReports = pendingAdjudicationReports(task);
    for (const review of historical) {
      await this.validate(review, task, ctx);
      checked.add(review.run_id);
    }
    for (const decision of task.jobs.filter(
      (j) =>
        j.role === "adjudicator" &&
        ((j.valid && historical.some((r) => r.run_id === j.review_run)) ||
          pendingReports.includes(j)),
    )) {
      await this.validate(decision, task, ctx);
      checked.add(decision.run_id);
    }
    for (const d of task.dispositions ?? []) {
      const source = task.jobs.find((j) => j.run_id === d.review_run);
      if (!source || source.result_hash !== d.review_hash || source.target_id !== d.target_id)
        throw new Error(
          "Persistent disposition source binding changed; recover original evidence.",
        );
      if (d.prior_finding) {
        const origin = sourceFinding(task, d.prior_finding).review;
        if (!checked.has(origin.run_id)) {
          await this.validate(origin, task, ctx);
          checked.add(origin.run_id);
        }
      }
      if (!checked.has(source.run_id)) {
        await this.validate(source, task, ctx);
        checked.add(source.run_id);
      }
      if (d.adjudication_run) {
        const adjudication = task.jobs.find((j) => j.run_id === d.adjudication_run);
        if (!adjudication || adjudication.review_run !== source.run_id)
          throw new Error("Disposition adjudication binding changed.");
        if (!checked.has(adjudication.run_id)) {
          await this.validate(adjudication, task, ctx);
          checked.add(adjudication.run_id);
        }
      }
    }
  }
  pendingReportContext(task: Task): string {
    const reports = pendingAdjudicationReports(task);
    return JSON.stringify({
      reports: reports.map(({ run_id, result_hash, target_id, result }) => ({
        run_id,
        result_hash,
        target_id,
        result,
      })),
      owner_assessments: task.jobs
        .filter(
          (j) =>
            isWriter(j.role) &&
            j.collected &&
            reports.some((r) => j.assessed_decisions?.includes(`${r.run_id}/report`)),
        )
        .map(
          ({
            run_id,
            valid,
            assessed_decisions,
            summary,
            artifact,
            result_hash,
            receipt_path,
            receipt_hash,
          }) => ({
            run_id,
            valid,
            assessed_decisions,
            summary,
            artifact,
            result_hash,
            receipt_path,
            receipt_hash,
          }),
        ),
    });
  }
  recovery(p: Command, error?: unknown) {
    const task = p.task_id ? this.tasks[p.task_id] : undefined;
    const jobs = task
      ? p.run_id
        ? task.jobs.filter((j) => j.run_id === p.run_id)
        : task.jobs.slice(-3)
      : [];
    return {
      diagnostic: error
        ? "Astraeus operation failed; post-operation state below, no success inferred."
        : "Post-operation state; status is not acceptance.",
      error: error === undefined ? undefined : String(error),
      task_id: p.task_id,
      run_id: p.run_id ?? jobs.at(-1)?.run_id,
      phase: task?.phase,
      accepted: task?.accepted,
      recovery: jobs.map((j) => ({
        run_id: j.run_id,
        status: j.status,
        collected: j.collected,
        valid: j.valid,
        dispatch: j.dispatch ?? "uncertain",
        lifecycle:
          j.dispatch === "never"
            ? "never dispatched"
            : j.collected
              ? j.valid
                ? "collected validated result; root acceptance still required"
                : "collected unsuccessful"
              : ACTIVE.has(
                    this.manager()?.getRecord(j.agent_id)?.status ?? (isCli(j) ? j.status : ""),
                  )
                ? "known running; collect later, not success"
                : "possibly launched or ended; verify exact host identity and collect outcome",
        allowed:
          j.dispatch === "never"
            ? ["status", "collect"]
            : [
                "status",
                "collect",
                "explicit stop after exact identity verification",
                ...(j.collected && isWriter(j.role) && (j.cessation || j.cli?.frozen)
                  ? [
                      "resume latest owner with bounded prompt and adopted decisions",
                      "explicit same-role delegate takeover with predecessor_run/reason/handoff and unchanged pins/scope",
                    ]
                  : []),
                ...(j.collected && !isWriter(j.role) && j.agent_id
                  ? ["fresh reviewer/adjudicator after evidence assessment"]
                  : []),
              ],
        blocked: [
          "blind retry of uncertain launch",
          "accept without complete evidence",
          ...(!j.cessation && !j.cli?.frozen
            ? ["fresh-owner takeover until verified cessation"]
            : []),
        ],
        guidance:
          "Inspect exact managed handle/lifecycle evidence. Missing records never prove stop. Recover original host identity; do not relaunch uncertain work. For collected failed owner, resume or explicitly take over only after cessation with reason/handoff and unchanged pins/scope.",
      })),
      allowed: task
        ? ["status(task_id)"]
        : [
            "start with task_id, requirements and acceptance; delegate also requires role/model/thinking/prompt",
          ],
    };
  }
  async validate(job: Job, task: Task, ctx: Context, accept = false) {
    if (job.result_hash !== this.io.hash(await this.io.readFile(job.artifact!, "utf8")))
      throw new Error("Saved result bytes changed; run a fresh review.");
    if (job.receipt_hash !== this.io.hash(await this.io.readFile(job.receipt_path!, "utf8")))
      throw new Error("Saved host receipt bytes changed.");
    const args = [
      "validate-result",
      job.artifact!,
      "--kind",
      job.role === "reviewer" ? "review" : "adjudication",
      "--task-id",
      task.task_id,
      "--target-id",
      job.target_id!,
      "--assurance",
      "reported",
    ];
    if (job.receipt_path!) args.push("--receipt", job.receipt_path!);
    if (job.role === "adjudicator") {
      const source = task.jobs.find((j) => j.run_id === job.review_run);
      if (
        !source ||
        source.result_hash !== this.io.hash(await this.io.readFile(source.artifact!, "utf8"))
      )
        throw new Error("Original review bytes changed; adjudication is stale.");
      if (
        source.receipt_hash !== this.io.hash(await this.io.readFile(source.receipt_path!, "utf8"))
      )
        throw new Error("Original review host receipt bytes changed.");
      args.push("--review-result", source.artifact!);
      if (source.receipt_path!) args.push("--review-receipt", source.receipt_path!);
    }
    if (accept) args.push("--accept");
    return JSON.parse(await this.bridge(args, ctx)).result;
  }
  async roleCheck(role: string, ctx: Context) {
    const name = `astraeus-${role}.md`;
    const bundled = await this.io.readFile(this.io.join(this.root, "agents", name), "utf8");
    // Match Tintinweb's supported discovery precedence; changed managed roles fail closed.
    const directories = [
      this.io.join(this.host.agentDir(), "agents"),
      this.io.join(ctx.cwd, ".agents/agents"),
      this.io.join(ctx.cwd, ".pi/agents"),
    ];
    let found = false;
    for (const directory of directories) {
      if (!this.io.existsSync(directory)) continue;
      for (const file of await this.io.readdir(directory)) {
        if (!file.endsWith(".md")) continue;
        const path = this.io.join(directory, file);
        const contents = await this.io.readFile(path, "utf8");
        const { frontmatter } = this.host.parseFrontmatter(contents);
        const declaredName = typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";
        const declared = declaredName || file.slice(0, -3);
        if (declared.toLowerCase() === `astraeus-${role}`) {
          if (contents !== bundled)
            throw new Error(`Role definition differs from bundled contract: ${path}`);
          found = true;
        }
      }
    }
    if (!found)
      throw new Error(
        `Missing ${name}. Install the bundled agent definitions (Nix Home Manager does this).`,
      );
  }
  async action(p: Command, ctx: Context, signal: AbortSignal | undefined) {
    const required: Record<string, (keyof Command)[]> = {
      start: ["task_id", "requirements", "acceptance"],
      delegate: ["task_id", "role", "model", "thinking", "prompt"],
      collect: ["task_id", "run_id"],
      stop: ["task_id", "run_id"],
      resume: ["task_id", "run_id", "prompt"],
      disposition: [
        "task_id",
        "run_id",
        "ref",
        "action",
        "route",
        "authority",
        "rationale",
        "evidence",
      ],
      reconcile_generated: ["task_id", "run_id"],
      accept: ["task_id"],
      invalidate: ["task_id"],
      authorize_design: ["task_id"],
      status: [],
    };
    if (!Object.hasOwn(required, p.op)) throw new Error(`Unknown operation: ${p.op}`);
    const missing = required[p.op].filter(
      (key) => typeof p[key] !== "string" || !(p[key] as string).trim(),
    );
    if (missing.length)
      throw new Error(`${p.op} requires ${missing.join(", ")}; no dispatch attempted.`);
    if (p.predecessor_run && p.op !== "delegate")
      throw new Error("predecessor_run is delegate-only; resume retains the existing owner.");
    if (p.op === "status") return this.status(ctx, p.task_id, p.run_id, p.ref);
    if (!p.task_id || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(p.task_id))
      throw new Error("task_id must be a short path-safe identifier.");
    if (p.op === "start") {
      if (this.tasks[p.task_id])
        throw new Error("Task already exists; use status/resume rather than replacing history.");
      if (!p.requirements?.trim() || !p.acceptance?.trim())
        throw new Error("start requires requirements and acceptance conditions.");
      await this.policy(ctx);
      await this.target(ctx);
      const design_authorization =
        p.design_request !== undefined || p.design_scope !== undefined
          ? designAuthorization(p)
          : null;
      const task = {
        design_authorization,
        task_id: p.task_id,
        cwd: await this.io.realpath(ctx.cwd),
        requirements: p.requirements,
        acceptance: p.acceptance,
        constraints: p.constraints || "",
        consequential: p.consequential !== false,
        phase: "implementation",
        jobs: [],
        target_id: null,
        accepted: false,
      };
      this.tasks[p.task_id] = task;
      this.save(ctx);
      return task;
    }
    const task = this.task(p.task_id, ctx);
    if (p.op === "authorize_design") {
      if (task.design_authorization)
        throw new Error(
          "Design authorization is already recorded for this task; do not replace its scope.",
        );
      task.design_authorization = designAuthorization(p);
      this.save(ctx);
      return task;
    }
    if (p.op === "invalidate") {
      task.phase = "stale";
      task.accepted = false;
      task.target_id = null;
      this.save(ctx);
      return task;
    }
    if (p.op === "delegate") return this.delegate(task, p, ctx, signal);
    const job = task.jobs.find((j) => j.run_id === p.run_id)!;
    if (["collect", "stop", "resume", "reconcile_generated", "disposition"].includes(p.op) && !job)
      throw new Error("Unknown run_id");
    if (p.op === "disposition") {
      if ((await this.target(ctx)) !== job.target_id || task.target_id !== job.target_id)
        throw new Error("Disposition requires the exact current reviewed target.");
      await this.auditDispositions(task, ctx);
      await this.validate(job, task, ctx);
      if (p.prior_finding)
        await this.validate(sourceFinding(task, p.prior_finding).review, task, ctx);
      const decision = recordDisposition(task, job, p, this.io.randomUUID());
      this.save(ctx);
      return decision;
    }
    if (p.op === "reconcile_generated") return this.reconcileGenerated(task, job, p, ctx);
    if (p.op === "collect") return this.collect(task, job, ctx);
    if (p.op === "stop") {
      // An undispatched correction owns no new work to stop. Settle it without
      // sending a stop to its shared predecessor's native session.
      if (!isCli(job) && isWriter(job.role) && job.resume_dispatch_started === false)
        return this.collect(task, job, ctx);
      if (this.settlePreparationFailure(job)) {
        this.save(ctx);
        return job;
      }
      try {
        if (isCli(job)) await this.cliOperation("stop", job, task.cwd);
        else {
          if (!job.agent_id)
            throw new Error(
              "No bound native handle: no stop attempted. Recover exact host identity and cessation evidence; do not retry uncertain launch.",
            );
          await this.io.rpc(this.host.events, "stop", { agentId: job.agent_id });
          const record = this.manager()?.getRecord(job.agent_id);
          if (!record || !["stopped", "completed", "failed"].includes(record.status))
            throw new Error(
              "Stop not verified by native host; inspect exact owner before retry or takeover.",
            );
          job.cessation = {
            source: "native manager after explicit stop",
            status: record.status,
            agent_id: job.agent_id!,
          };
        }
        job.status = isCli(job) ? observedStatus(job.cli!.observed) : "stopped";
        job.collected = false;
        job.valid = false;
        return job;
      } finally {
        this.save(ctx);
      }
    }
    if (p.op === "resume") return this.resume(task, job, p, ctx, signal);
    if (p.op === "accept") {
      // Re-observe external writers: a missing native manager is not freeze evidence.
      const cliOwners = new Map(
        Object.values(this.tasks)
          .filter((t) => t.cwd === task.cwd)
          .flatMap((t) => t.jobs.filter(isCli))
          .map((j) => [j.agent_id || j.run_id, j]),
      );
      for (const writer of cliOwners.values()) {
        try {
          await this.cliOperation("observe", writer, task.cwd);
        } catch (error: any) {
          task.accepted = false;
          task.phase = "needs-evidence";
          this.save(ctx);
          throw error;
        }
        if (!writer.cli!.frozen || (writer.cli!.unexpected_copy && !writer.cli!.copy_frozen))
          throw new Error("Freeze exact Claude writer before acceptance.");
        if (writer.valid && writer.cli!.unexpected_copy)
          throw new Error("Unexpected Claude copy cannot be accepted as successful work.");
        if (writer.valid) {
          try {
            if (
              writer.result_hash !== this.io.hash(await this.io.readFile(writer.artifact!, "utf8"))
            )
              throw new Error("Saved implementation report bytes changed.");
            await this.claude.audit(writer);
            const ownerTask = Object.values(this.tasks).find((t) => t.jobs.includes(writer));
            const before = await this.io.snapshot(task.cwd);
            await this.io.originalRequest(ownerTask!, writer);
            const { bytes, result } = await this.readCliReport(ownerTask!, writer, ctx);
            this.requireCliComplete(writer, result);
            await this.cliOperation("observe", writer, task.cwd);
            if (
              !writer.cli!.frozen ||
              JSON.stringify(await this.io.snapshot(task.cwd)) !== JSON.stringify(before) ||
              this.io.hash(await this.io.readFile(writer.artifact!)) !== this.io.hash(bytes)
            )
              throw new Error("Claude writer/source/report changed during final audit.");
          } catch (error: any) {
            writer.valid = false;
            writer.error = String(error);
            task.accepted = false;
            task.phase = "needs-evidence";
            this.save(ctx);
            throw error;
          }
        }
      }
      if (
        this.activeJobs(task.cwd).length ||
        task.jobs.some(
          (j) =>
            !j.collected ||
            (!isCli(j) && ACTIVE.has(this.manager()?.getRecord(j.agent_id)?.status ?? j.status)),
        )
      )
        throw new Error(
          "Collect every managed result before acceptance; unresolved or unknown ongoing writes require exact host cessation evidence.",
        );
      await this.auditDispositions(task, ctx);
      requireNoPendingDisputes(task);
      const latestWorkers = new Map();
      const responsibility = (writer: Job): string => {
        const parent = writer.predecessor_run ?? writer.resume_from;
        const prior =
          parent && task.jobs.slice(0, task.jobs.indexOf(writer)).find((j) => j.run_id === parent);
        return prior ? responsibility(prior) : (writer.agent_id ?? writer.run_id);
      };
      for (const writer of task.jobs.filter((j) => isWriter(j.role))) {
        // An unstarted correction is still failed work of its recorded owner,
        // not a new null-ID owner that permanently blocks later successful fixes.
        const prior = writer.resume_from
          ? task.jobs.find((j) => j.run_id === writer.resume_from)
          : undefined;
        const key =
          !writer.agent_id && prior?.agent_id && this.settlePreparationFailure(writer)
            ? prior.agent_id
            : writer.agent_id;
        latestWorkers.set(
          writer.predecessor_run || writer.resume_from
            ? responsibility(writer)
            : (key ?? writer.run_id),
          writer,
        );
      }
      if ([...latestWorkers.values()].some((j) => !j.valid))
        throw new Error("Implementation owner has unresolved failed or incomplete work.");
      const matches = JSON.parse(await this.bridge(["matches-review", "--repo", ctx.cwd], ctx));
      const existingReview = [...task.jobs].reverse().find((j) => j.role === "reviewer");
      const needsReview = task.consequential || matches.requires_review || !!existingReview;
      if (needsReview) {
        if ((await this.target(ctx)) !== task.target_id)
          throw new Error("Review target changed. Run a fresh review.");
        const last = [...task.jobs].reverse().find((j) => j.role === "reviewer");
        if (!last?.result || !last.valid)
          throw new Error("A complete validated review is required.");
        if (last.result.verdict === "pass") await this.validate(last, task, ctx, true);
        else if (
          last.result.verdict === "changes_required" &&
          blockingRefs(last).length &&
          blockingRefs(last).every((ref) => dispositionFor(task, last, ref))
        ) {
          await this.validate(last, task, ctx);
          requireResolvedFindings(task, last);
        } else {
          const adjudication = [...task.jobs]
            .reverse()
            .find((j) => j.role === "adjudicator" && j.review_run === last.run_id && j.valid);
          if (!adjudication)
            throw new Error(
              "Review does not pass; complete changes_required needs adjudication, inconclusive needs evidence.",
            );
          await this.validate(adjudication, task, ctx, true);
        }
        requireHistoricalResolutions(task, last);
      }
      // This tool checks process evidence; root remains responsible for truth and scope.
      task.accepted = true;
      task.phase = "accepted";
      task.accepted_target = await this.target(ctx);
      this.save(ctx);
      return {
        ...task,
        note: "Procedure checks passed. Root must independently judge evidence, scope and final acceptance; this is not system activation.",
      };
    }
    throw new Error(`Unknown operation: ${p.op}`);
  }
  async delegate(task: Task, p: Command, ctx: Context, _signal: AbortSignal | undefined) {
    const role = p.role!;
    if (!ROLES.includes(role) || !p.prompt?.trim())
      throw new Error("delegate requires role and a bounded prompt.");
    if (p.run_id && role !== "adjudicator")
      throw new Error(
        "delegate run_id selects an original review only for adjudicator; use resume for owner continuation or predecessor_run for succession.",
      );
    if (!isWriter(role) && p.predecessor_run)
      throw new Error(
        "Review/adjudication must use fresh independent sessions, never owner takeover.",
      );
    const policy = await this.policy(ctx);
    if (!isWriter(role) && policy.assurance === "strict")
      throw new Error(
        "strict review requires verified OS read-only sandbox; Pi/Tintinweb does not supply that receipt. No review launched.",
      );
    if (
      role === "designer" &&
      (!task.design_authorization || p.design_scope !== task.design_authorization!.scope)
    )
      throw new Error(
        "Designer requires recorded explicit design authorization and matching design_scope.",
      );
    const model =
      role === "designer"
        ? designModel(ctx.modelRegistry, p.model)
        : selectModel(ctx.modelRegistry.getAvailable(), p.model, policy);
    if (!p.thinking) throw new Error("Specify thinking explicitly.");
    const levels = role === "designer" ? CLI_EFFORTS : this.host.supportedThinking(model);
    if (!levels.includes(p.thinking))
      throw new Error(
        `Unsupported thinking ${p.thinking}; available: ${levels.join(", ")}. No clamping allowed.`,
      );
    await this.roleCheck(role, ctx);
    if (role !== "designer") {
      const ping = await this.io.rpc(this.host.events, "ping", {});
      if (ping?.version !== 2) throw new Error("Unsupported Tintinweb RPC version");
    }
    await this.auditDispositions(task, ctx);
    const currentTarget = await this.target(ctx);
    // External writer state must be current even without a native manager.
    const cliOwners = new Map(
      Object.values(this.tasks)
        .filter((t) => t.cwd === task.cwd)
        .flatMap((t) => t.jobs.filter(isCli))
        .map((j) => [j.agent_id || j.run_id, j]),
    );
    for (const writer of cliOwners.values()) {
      try {
        await this.cliOperation("observe", writer, task.cwd);
      } catch (error: any) {
        this.assertOperationActive();
        writer.cli!.frozen = false;
        writer.valid = false;
        writer.error = String(error);
        this.save(ctx);
      }
    }
    const running = this.activeJobs(task.cwd);
    if (
      Object.values(this.tasks).some(
        (t) => t.cwd === task.cwd && t.jobs.some((j) => j.dispatch === "uncertain" && !j.agent_id),
      )
    )
      throw new Error(
        "Possibly launched unbound dispatch: recover exact host identity/cessation evidence; no blind retry or new launch is allowed.",
      );
    if (!isWriter(role) && running.length)
      throw new Error("Freeze writers and collect outstanding work before review/adjudication.");
    if (!isWriter(role) && task.jobs.some((j) => !j.collected))
      throw new Error("Collect existing runs first.");
    let review: Job | undefined;
    if (role === "adjudicator") {
      review = requireAdjudicableReview(task, currentTarget, p.run_id);
    }
    let requiredChecks = p.checks ?? [];
    let owned = p.owned_paths || ["."];
    if (!owned.length) throw new Error("owned_paths must identify at least one owned path.");
    if (
      owned.some((x) => !x || x.startsWith("/") || x.split("/").includes("..") || x.includes("*"))
    )
      throw new Error("owned_paths must be literal repository-relative paths (or .), no globs.");
    owned = owned.map((path) => this.io.normalize(path).replace(/\/+$/, "") || ".");
    if (isWriter(role)) {
      requireDisjointWriters(owned, running);
      if (p.predecessor_run) {
        const prior = task.jobs.find((j) => j.run_id === p.predecessor_run);
        if (
          !prior ||
          prior.role !== role ||
          !prior.collected ||
          task.jobs.some(
            (j) => j.predecessor_run === prior.run_id || j.resume_from === prior.run_id,
          )
        )
          throw new Error(
            "Takeover requires latest collected predecessor of the same role, without an existing successor.",
          );
        if (!p.reason?.trim() || !p.handoff?.trim())
          throw new Error(
            "Takeover requires reason and handoff: requirements, current code/check evidence and unresolved decisions.",
          );
        if (
          prior.requested.model !== p.model ||
          prior.requested.effort !== p.thinking ||
          JSON.stringify(prior.owned_paths) !== JSON.stringify(owned)
        )
          throw new Error(
            "Takeover must preserve exact predecessor model/thinking and owned scope.",
          );
        if (
          (prior.transport ?? "pi-native") !==
          (role === "designer" ? CLAUDE_TRANSPORT : "pi-native")
        )
          throw new Error(
            "Takeover cannot migrate the predecessor transport; recover original native designer instead.",
          );
        if (isCli(prior)) {
          let checkOwner = prior;
          while (!checkOwner.cli?.checks && checkOwner.resume_from) {
            const parent = task.jobs
              .slice(0, task.jobs.indexOf(checkOwner))
              .find((j) => j.run_id === checkOwner.resume_from);
            if (!parent || !isCli(parent)) break;
            checkOwner = parent;
          }
          if (!checkOwner.cli?.checks)
            throw new Error(
              "Inherited required checks are unknown; recover original request/check evidence before takeover. An undispatched initial preparation may instead be retried as a fresh delegate after verified settlement.",
            );
          requiredChecks = checkOwner.cli.checks;
          if (p.checks && JSON.stringify(p.checks) !== JSON.stringify(requiredChecks))
            throw new Error(
              "Takeover preserves predecessor required checks; no silent removal or override.",
            );
        }
        await this.requireCessation(task, prior);
        const decision = requireAdoptedCorrection(task);
        if (decision) {
          if (currentTarget !== task.target_id)
            throw new Error("Target changed since review; obtain fresh evidence before fixes.");
          await this.validate(decision, task, ctx);
        }
      } else if (
        task.jobs.some((j) => isWriter(j.role) && j.collected && !this.settlePreparationFailure(j))
      )
        throw new Error(
          "Resume the original implementation owner or explicitly delegate with predecessor_run/reason/handoff after verified cessation of writes.",
        );
      task.target_id = null;
      task.accepted = false;
    } else task.target_id = currentTarget;
    const run_id = this.io.randomUUID();
    if (role === "designer") {
      validatePaths(owned);
      validateChecks(requiredChecks);
    }
    const job: Job = {
      run_id,
      role,
      transport: role === "designer" ? CLAUDE_TRANSPORT : "pi-native",
      agent_id: null,
      status: "queued",
      collected: false,
      valid: false,
      owned_paths: owned,
      requested: p.predecessor_run
        ? structuredClone(task.jobs.find((j) => j.run_id === p.predecessor_run)!.requested)
        : { model: p.model!, effort: p.thinking },
      review_run: review?.run_id ?? null,
      ...(isWriter(role) ? { assessed_decisions: assessmentTokens(task) } : {}),
      target_id: task.target_id,
      dispatch: "never",
      ...(p.predecessor_run
        ? { predecessor_run: p.predecessor_run, handoff: p.handoff, succession_reason: p.reason }
        : {}),
    };
    if (role === "designer") job.cli = { frozen: false, evidence: [] };
    task.jobs.push(job);
    task.accepted = false;
    task.phase = isWriter(role)
      ? "implementation"
      : role === "reviewer"
        ? "review"
        : "adjudication";
    this.save(ctx);
    try {
      const designText = task.design_authorization
        ? await this.io.readFile(this.io.join(this.root, "references/claude-design.md"), "utf8")
        : "";
      const policyText = await this.io.readFile(
        this.io.join(
          this.root,
          "skills",
          `pi-astraeus-${isWriter(role) ? "orchestrate" : role === "reviewer" ? "review" : "adjudicate"}`,
          "SKILL.md",
        ),
        "utf8",
      );
      const contract = !isWriter(role)
        ? await this.io.readFile(
            this.io.join(
              this.root,
              "schemas",
              `${role === "reviewer" ? "review" : "adjudication"}.json`,
            ),
            "utf8",
          )
        : "";
      const prompt = [
        `Task ${task.task_id}. Role ${role}. Work only on assigned scope; no child delegation.`,
        `Requirements:\n${task.requirements}\nAcceptance conditions:\n${task.acceptance}\nConstraints/non-goals/preserved contracts:\n${task.constraints}`,
        task.design_authorization
          ? `Design authorization (root-reported, not authenticated): ${JSON.stringify(task.design_authorization)}\nDesign handoff policy:\n${designText}`
          : "",
        `Assignment:\n${p.prompt}\nOwned paths:\n${owned.join("\n")}`,
        job.assessed_decisions?.length
          ? `This owner run is assigned assessment of these exact finding/report tokens: ${JSON.stringify(job.assessed_decisions)}. Report concrete assessment/refutation/correction and verification evidence for each within authorized scope, including report-level unresolved matters and coverage/evidence gaps. A supported refutation or evidence-only assessment need not change code. Root checks the substance; a completed run alone does not establish truth. Bound adjudication reports (claims/gaps to assess, not new scope authority): ${this.pendingReportContext(task)}`
          : "",
        `Role policy:\n${policyText}\nRead relevant references under ${this.io.join(this.root, "references")} when needed.`,
        !isWriter(role)
          ? `Stable target_id: ${task.target_id}. task_id: ${task.task_id}. Reported assurance: built-in read-only tools only, no OS sandbox or generation-time schema guarantee. Return exactly one JSON object matching this schema, no additional prose:\n${contract}`
          : "Return actual edits, verification outcomes and remaining issues. Keep implementation and ordinary verification together.",
        role === "reviewer" && pendingAdjudicationReports(task).length
          ? `Retained adjudication report-level matters remain pending even when individual claims are rejected. Independently check resolution of unresolved matters and coverage/evidence gaps against the original task and the reported owner assessment/check evidence below; do not infer resolution from omission, a prior pass, or an override. These claims/gaps are not new scope authority. This is reported evidence, not a proposed verdict: ${this.pendingReportContext(task)}`
          : "",
        task.dispositions?.length
          ? `Persistent finding history (root judgments, not new requirements):\n${JSON.stringify(task.dispositions)}\nLink repeated/reworded/new-ID findings with prior_decision. Reject/optional decisions remain nonblocking unless root explicitly reopens with concrete new evidence or relevant code change. A new target hash, severity or wording alone is insufficient. Unmapped new blocking findings still require root assessment. Do not infer arbitrary semantic equivalence.`
          : "",
        p.predecessor_run
          ? `Fresh-owner succession from ${p.predecessor_run}. Reason: ${p.reason}. You inherit all predecessor obligations, scope, check evidence, unresolved decisions and history; assess fixes, refute unsupported claims or propose a smaller repair. Handoff:\n${p.handoff}`
          : "",
        review
          ? `Original review bytes:\n${await this.io.readFile(review.artifact!, "utf8")}\nreview_sha256: ${review.result_hash}`
          : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      if (role === "designer") {
        await this.prepareCli(task, job, ctx, requiredChecks);
        this.save(ctx); // Persist binding before launch; failures must never invite a blind retry.
        job.dispatch = "uncertain";
        this.save(ctx);
        await this.cliOperation(
          "start",
          job,
          task.cwd,
          await this.cliPrompt(task, job, prompt),
          job.cli!.checks!,
        );
        job.dispatch = "confirmed";
        this.save(ctx);
        return job;
      }
      job.dispatch = "uncertain";
      this.save(ctx);
      const response = await this.io.rpc(this.host.events, "spawn", {
        type: `astraeus-${role}`,
        prompt,
        options: {
          description: `${task.task_id}: ${role}`,
          model,
          thinkingLevel: p.thinking,
          inheritContext: false,
          isBackground: true,
          cwd: ctx.cwd,
          onSpawned: (id: string) => {
            job.agent_id = id;
            job.dispatch = "confirmed";
            this.save(ctx);
          },
        },
      });
      job.agent_id = response.id;
      job.dispatch = "confirmed";
      job.status = this.manager()?.getRecord(response.id)?.status ?? "running";
      this.save(ctx);
      return job;
    } catch (error: any) {
      this.assertOperationActive();
      job.status = isCli(job)
        ? "unknown"
        : (this.manager()?.getRecord(job.agent_id)?.status ??
          (job.agent_id ? "unavailable" : "error"));
      job.error = String(error);
      if (job.dispatch === "never") job.collected = true;
      this.save(ctx);
      throw error;
    }
  }
  async prepareCli(task: Task, job: Job, ctx: Context, checks: string[], prior?: CliState) {
    for (const owned of job.owned_paths) {
      let path = this.io.resolve(task.cwd, owned);
      while (!this.io.existsSync(path)) {
        const parent = this.io.dirname(path);
        if (parent === path) throw new Error("Cannot resolve owned path");
        path = parent;
      }
      const canonical = await this.io.realpath(path);
      if (canonical !== task.cwd && !canonical.startsWith(task.cwd + "/"))
        throw new Error(`Designer ownership escapes cwd through symlink: ${owned}`);
    }
    const directory = this.io.join(await this.artifacts(task, ctx), job.run_id);
    if (directory === task.cwd || directory.startsWith(task.cwd + "/"))
      throw new Error("Claude control artifacts must be outside the managed cwd.");
    await this.io.mkdir(directory, { recursive: true, mode: 0o700 });
    const baseline = await this.io.snapshot(task.cwd);
    // Ownership remains bounded assignment; preserve dirty user work by instruction.
    for (const path of Object.keys(baseline.files)) {
      if (!job.owned_paths.some((o) => o === "." || path === o || path.startsWith(o + "/")))
        continue;
      if ((await this.io.lstat(this.io.join(task.cwd, path))).isSymbolicLink()) {
        const canonical = await this.io.realpath(this.io.join(task.cwd, path));
        if (canonical !== task.cwd && !canonical.startsWith(task.cwd + "/"))
          throw new Error(`Designer owned symlink escapes cwd: ${path}`);
      }
    }
    const dirty = prior ? prior.user_dirty! : baseline.dirty;
    const report_directory = prior ? prior.report_directory! : this.io.join(directory, "pending");
    await this.io.mkdir(report_directory, { recursive: true, mode: 0o700 });
    job.cli = {
      directory,
      report_directory,
      pending: this.io.join(report_directory, `${job.run_id}.json`),
      checks,
      baseline,
      dispatch_target: await this.target(ctx),
      user_dirty: dirty,
      evidence: prior ? [...prior.evidence] : [],
      frozen: false,
      ...(prior
        ? { short_id: prior.short_id, session_id: prior.session_id, observed: prior.observed }
        : {}),
    };
    const bytes = JSON.stringify(
      {
        task_id: task.task_id,
        run_id: job.run_id,
        owned_paths: job.owned_paths,
        checks,
        baseline,
        dispatch_target: job.cli!.dispatch_target!,
      },
      null,
      2,
    );
    const path = this.io.join(directory, "request.json");
    await this.io.writeFile(path, bytes, { mode: 0o600, flag: "wx" });
    job.cli!.evidence.push({ kind: "request", path, sha256: this.io.hash(bytes).slice(7) });
  }
  async cliPrompt(task: Task, job: Job, prompt: string) {
    const schema = await this.io.readFile(
      this.io.join(this.root, "schemas/implementation.json"),
      "utf8",
    );
    const role = await this.io.readFile(
      this.io.join(this.root, "agents/astraeus-designer.md"),
      "utf8",
    );
    return `${prompt}\n\nDesigner role contract, including unattended noninteractive behavior, applies to this initial or follow-up run (native frontmatter is not CLI isolation):\n${role}\n\nInstalled Claude Code background task, exact requested model claude-opus-5-5. Do not launch nested agents, create worktrees, commit/stage/reset/stash, push, publish, or edit workflow control metadata. Stay within the assigned paths and explicitly authorized design scope; owned_paths is advisory assignment, not a permission sandbox. Preserve existing user changes. Permissions are not an OS sandbox. Run required checks exactly: ${JSON.stringify(job.cli!.checks!)}. Report failed/denied checks truthfully. Missing checks means checks: [].\nWrite one JSON implementation result only to ${job.cli!.pending!}; do not edit control metadata or publish a final result. task_id=${JSON.stringify(task.task_id)}, run_id=${JSON.stringify(job.run_id)}, target_id=${JSON.stringify(job.cli!.dispatch_target!)}. changed_files reports your actual edits for this run, not preexisting or other writers' changes; shared-cwd baseline deltas are not exact attribution. Complete requires completed authorized work, all required checks passed, remaining: []. Schema:\n${schema}`;
  }
  async readCliReport(task: Task, job: Job, ctx: Context) {
    const candidate = job.artifact! || job.cli!.pending!;
    if (
      !(await this.io.lstat(candidate)).isFile() ||
      (await this.io.lstat(candidate)).isSymbolicLink()
    )
      throw new Error("Symlinked/nonregular implementation report.");
    const bytes = await this.io.readFile(candidate, "utf8");
    if (job.artifact! && job.result_hash !== this.io.hash(bytes))
      throw new Error("Saved implementation report bytes changed.");
    // Validate captured bytes, not a mutable child path reopened by Python.
    const validation = this.io.join(job.cli!.directory!, `validation-${this.io.randomUUID()}.json`);
    await this.io.writeFile(validation, bytes, { mode: 0o600, flag: "wx" });
    const result = JSON.parse(
      await this.bridge(
        [
          "validate-result",
          validation,
          "--kind",
          "implementation",
          "--task-id",
          task.task_id,
          "--target-id",
          job.cli!.dispatch_target!,
        ],
        ctx,
      ),
    ).result;
    if (result.run_id !== job.run_id)
      throw new Error("Implementation report has wrong run binding.");
    return { bytes, result };
  }
  requireCliComplete(job: Job, result: NonNullable<Job["result"]>) {
    requireCompleteChecks(job.cli!.checks!, result);
  }
  async reconcileGenerated(task: Task, job: Job, p: Command, ctx: Context) {
    // Compatibility operation for persisted ownership failures. No new approval,
    // cache fingerprints or Vitest receipt is needed under advisory ownership.
    if (
      !isCli(job) ||
      job.role !== "designer" ||
      !job.collected ||
      !job.cli!.frozen ||
      [...task.jobs].reverse().find((j) => isWriter(j.role)) !== job
    )
      throw new Error("Recollect only the latest original frozen designer.");
    if (
      job.error &&
      !job.cli!.ownership_failure &&
      job.error.startsWith("Error: Out-of-ownership baseline delta: ")
    ) {
      job.cli!.ownership_failure = {
        error: job.error!,
        provenance: "Historical failed collection; no historical hashes reconstructed.",
      };
    }
    return this.collectCli(task, job, ctx);
  }
  async collectCli(task: Task, job: Job, ctx: Context) {
    if (this.settlePreparationFailure(job)) {
      this.save(ctx);
      return job;
    }
    job.valid = false;
    let before;
    try {
      const observed = await this.cliOperation("observe", job, task.cwd);
      if (!job.cli!.frozen) {
        if (
          !(
            ["done", "stopped"].includes(observed.state) ||
            (observed.state === "blocked" && observed.status === "idle")
          )
        ) {
          if (
            observed.state === "working" &&
            ["running", "busy", "working"].includes(observed.status)
          )
            return { ...job, note: "Claude still working; unknown lifecycle is not completion." };
          throw new Error(
            "Claude lifecycle not collectable; explicitly stop exact writer or obtain evidence.",
          );
        }
        await this.cliOperation("stop", job, task.cwd);
      }
      if (job.cli!.unexpected_copy)
        throw new Error(
          "Unexpected copy cannot produce a successful implementation report, even after exact cleanup.",
        );
      job.collected = true;
      before = await this.io.snapshot(task.cwd);
      await this.io.originalRequest(task, job);
      const { bytes, result } = await this.readCliReport(task, job, ctx);
      job.result = result;
      await this.cliOperation("observe", job, task.cwd);
      if (
        !job.cli!.frozen ||
        JSON.stringify(await this.io.snapshot(task.cwd)) !== JSON.stringify(before)
      )
        throw new Error("Claude writer/source changed during collection.");
      if (!job.artifact!) {
        const final = this.io.join(job.cli!.directory!, "result.json");
        await this.io.publish(job.cli!.pending!, final, bytes);
        job.artifact = final;
      } else if (job.result_hash !== this.io.hash(bytes))
        throw new Error("Published implementation result changed.");
      job.result_hash = this.io.hash(bytes);
      job.summary = result.summary;
      // Publication records the outcome, including blocked/failed checks. It is
      // not acceptance and cannot promote incomplete work to success.
      this.requireCliComplete(job, result);
      job.valid = true;
      task.phase = "verification";
      task.target_id = null;
      delete job.error;
    } catch (error: any) {
      this.assertOperationActive();
      job.collected = job.cli!.frozen === true;
      job.error = String(error);
      task.phase = "needs-evidence";
    }
    this.save(ctx);
    return job;
  }
  async collect(task: Task, job: Job, ctx: Context) {
    if (isCli(job)) return this.collectCli(task, job, ctx);
    if (isWriter(job.role) && job.resume_dispatch_started === false) {
      // The shared manager still holds the predecessor's result until Agent
      // resumes it. Those bytes cannot be attributed to this unstarted run.
      job.collected = true;
      job.valid = false;
      job.status = "error";
      job.error ??= "Native resume never dispatched; no run-specific result exists.";
      task.phase = "needs-evidence";
      this.save(ctx);
      return job;
    }
    const record = this.manager()?.getRecord(job.agent_id);
    if (!record) {
      if (job.collected) return job;
      job.status = "unavailable";
      job.collected = true;
      job.valid = false;
      job.error =
        "Native child record unavailable: collected unsuccessful, not completed or stopped. Recover exact host handle and verify cessation before writer takeover; uncertain dispatch must not be blindly retried.";
      task.phase = "needs-evidence";
      this.save(ctx);
      return job;
    }
    job.status = record.status;
    if (job.resume_from && job.dispatch === "uncertain") {
      if (ACTIVE.has(record.status)) job.dispatch = "confirmed";
      else {
        job.collected = true;
        job.valid = false;
        job.error =
          "Native resume launch was not confirmed; terminal manager output may belong to predecessor. Outcome remains unsuccessful. Verify cessation, then explicitly resume this latest owner or take over with handoff; do not attribute predecessor output to this run.";
        task.phase = "needs-evidence";
        this.save(ctx);
        return job;
      }
    }
    if (isWriter(job.role) && ["completed", "stopped", "failed"].includes(record.status))
      job.cessation = {
        source: "native manager during collect",
        status: record.status,
        agent_id: job.agent_id!,
      };
    if (ACTIVE.has(record.status)) {
      this.save(ctx);
      return { ...job, note: "Still running. Continue independent work or collect later." };
    }
    job.collected = true;
    job.valid = false;
    try {
      if (record.type !== `astraeus-${job.role}`)
        throw new Error("Resolved child role differs from requested role.");
      const receipt = assertReceipt(job, record);
      const directory = await this.artifacts(task, ctx);
      const receiptBytes = JSON.stringify(receipt, null, 2);
      if (
        job.receipt_hash &&
        (job.receipt_hash !== this.io.hash(receiptBytes) ||
          job.receipt_hash !== this.io.hash(await this.io.readFile(job.receipt_path!, "utf8")))
      )
        throw new Error(
          "Saved host receipt bytes changed; collect a fresh run, not replacement evidence.",
        );
      job.receipt_path = this.io.join(directory, `${job.run_id}.receipt.json`);
      if (!job.receipt_hash)
        await this.io.writeFile(job.receipt_path!, receiptBytes, { mode: 0o600 });
      job.receipt_hash = this.io.hash(receiptBytes);
      if (record.status !== "completed")
        throw new Error(`Child ${record.status}: ${record.error || "incomplete output"}`);
      if (isWriter(job.role)) {
        job.summary = record.result || "";
        job.valid = true;
        task.phase = "verification";
        task.target_id = null;
      } else {
        if ((await this.target(ctx)) !== job.target_id || task.target_id !== job.target_id)
          throw new Error("Review target changed while child was running.");
        const bytes = parseReport(record.structuredJson ?? record.result ?? "");
        if (
          job.result_hash &&
          (job.result_hash !== this.io.hash(bytes) ||
            job.result_hash !== this.io.hash(await this.io.readFile(job.artifact!, "utf8")))
        )
          throw new Error("Saved result bytes changed; run a fresh review.");
        job.artifact = this.io.join(directory, `${job.run_id}.json`);
        if (!job.result_hash) await this.io.writeFile(job.artifact!, bytes, { mode: 0o600 });
        job.result_hash = this.io.hash(bytes);
        job.result = await this.validate(job, task, ctx);
        job.valid = true;
        task.phase = phaseAfterReport(job.role, job.result!);
        if (job.role === "adjudicator" && job.result!.status === "complete") {
          const source = task.jobs.find((j) => j.run_id === job.review_run)!;
          const staged = { ...task, dispositions: [...(task.dispositions ?? [])] };
          for (const d of job.result!.decisions ?? []) {
            if (d.ref.startsWith("unresolved/")) continue;
            recordDisposition(
              staged,
              source,
              {
                op: "disposition",
                ref: d.ref,
                action: d.action === "fix" ? "adopt" : "reject",
                route: ["investigate", "human_decision"].includes(d.action) ? "disputed" : "clear",
                authority: d.basis,
                rationale: d.rationale,
                evidence: d.evidence,
                reopening: d.rationale,
              },
              this.io.randomUUID(),
              job,
            );
          }
          task.dispositions = staged.dispositions;
          task.phase = phaseAfterReport(job.role, job.result!);
        }
      }
      await this.io.rpc(this.host.events, "consume", { agentId: job.agent_id });
      delete job.error;
    } catch (error: any) {
      job.valid = false;
      job.error = String(error);
      task.phase = "needs-evidence";
    }
    this.save(ctx);
    return job;
  }
  async failedResumePreparation(task: Task, candidate: Job) {
    if (this.settlePreparationFailure(candidate)) return true;
    if (!isCli(candidate)) {
      // Only a persisted checkpoint before the public Agent dispatch proves a
      // native attempt never ran. Tool errors/legacy attempts remain ambiguous.
      if (
        candidate.resume_dispatch_started !== false ||
        !candidate.resume_from ||
        !candidate.collected ||
        candidate.valid ||
        candidate.status !== "error" ||
        !candidate.error ||
        candidate.result ||
        candidate.artifact ||
        candidate.result_hash
      )
        return false;
      const prior = task.jobs
        .slice(0, task.jobs.indexOf(candidate))
        .find((j) => j.run_id === candidate.resume_from);
      if (
        !prior ||
        !isWriter(prior.role) ||
        isCli(prior) ||
        !prior.collected ||
        !prior.agent_id ||
        prior.agent_id !== candidate.agent_id ||
        prior.role !== candidate.role ||
        prior.transport !== candidate.transport ||
        JSON.stringify(prior.requested) !== JSON.stringify(candidate.requested) ||
        JSON.stringify(prior.owned_paths) !== JSON.stringify(candidate.owned_paths)
      )
        return false;
      const record = this.manager()?.getRecord(prior.agent_id);
      if (!record?.session || ACTIVE.has(record.status)) return false;
      try {
        assertReceipt(prior, record);
        return true;
      } catch {
        return false;
      }
    }
    // Older resume attempts shallow-copied the stopped owner's CLI binding. A
    // different run with exactly one audited original binding has no request/dispatch
    // of its own. Older observers could already have rewritten its status to stopped
    // and collection could have overwritten its error with a request/run mismatch.
    // Neither lifecycle nor diagnostic text proves preparation; immutable bytes do.
    // Never classify a prepared, attempted, copied, or merely missing owner this way.
    const retainedFailure =
      typeof candidate.resume_preparation_failure === "string" &&
      candidate.resume_preparation_failure.length > 0;
    if (
      !isCli(candidate) ||
      candidate.collected !== true ||
      candidate.valid !== false ||
      candidate.result ||
      candidate.artifact ||
      candidate.result_hash ||
      (!retainedFailure &&
        (!["unknown", "error", "unavailable", "stopped"].includes(candidate.status) ||
          typeof candidate.error !== "string" ||
          !candidate.error)) ||
      candidate.cli?.frozen !== true
    )
      return false;
    const index = task.jobs.indexOf(candidate);
    const priors = task.jobs
      .slice(0, index)
      .reverse()
      .filter(
        (j) =>
          isCli(j) &&
          j.agent_id === candidate.agent_id &&
          j.collected &&
          j.cli?.frozen &&
          j.run_id !== candidate.run_id,
      );
    const binding = (j: Job) => {
      const {
        observed: _observed,
        notified_status: _notified,
        evidence: _evidence,
        ...cli
      } = j.cli!;
      return {
        role: j.role,
        transport: j.transport,
        agent_id: j.agent_id,
        requested: j.requested,
        owned_paths: j.owned_paths,
        cli,
      };
    };
    let originals = 0;
    for (const prior of priors) {
      if (JSON.stringify(binding(prior)) !== JSON.stringify(binding(candidate))) continue;
      const inherited = prior.cli!.evidence,
        evidence = candidate.cli!.evidence;
      if (
        !Array.isArray(inherited) ||
        !Array.isArray(evidence) ||
        evidence.length < inherited.length ||
        JSON.stringify(evidence.slice(0, inherited.length)) !== JSON.stringify(inherited)
      )
        continue;
      const added = evidence.slice(inherited.length);
      if (added.some((e) => e.kind !== "stop")) continue; // Never skip request/resume/launch evidence.
      try {
        await this.io.originalRequest(task, prior);
        await this.claude.audit(candidate); // Includes inherited and all added immutable bytes.
        for (const item of added) {
          const stopped = JSON.parse(new TextDecoder().decode(await this.io.readFile(item.path)));
          if (
            stopped.returncode !== 0 ||
            typeof stopped.stdout !== "string" ||
            stopped.stdout.trim() !== `stopped ${candidate.cli!.short_id}` ||
            JSON.stringify(stopped.args) !== JSON.stringify(["stop", candidate.cli!.short_id])
          )
            throw new Error("Added stop is not an exact-owner acknowledgment.");
        }
        originals++;
      } catch {
        /* Corruption, dispatch evidence, or an unbound earlier attempt cannot prove recovery. */
      }
    }
    return originals === 1; // Duplicate original request/run bindings are ambiguous.
  }
  async resume(task: Task, job: Job, p: Command, ctx: Context, signal: AbortSignal | undefined) {
    if (!isWriter(job.role))
      throw new Error("Reviews and adjudications always use fresh sessions.");
    if (!job.collected || !p.prompt?.trim())
      throw new Error("Collect the previous run and provide a bounded follow-up prompt.");
    if (this.activeJobs(task.cwd).length)
      throw new Error("Collect/stop active work before resuming the implementation owner.");
    let latestOwner;
    for (const candidate of [...task.jobs].reverse()) {
      if (candidate.agent_id !== job.agent_id || !isWriter(candidate.role)) continue;
      if (await this.failedResumePreparation(task, candidate)) continue;
      latestOwner = candidate;
      break;
    }
    if (latestOwner !== job)
      throw new Error("Resume only the latest run of the original implementation owner.");
    if (task.jobs.some((j) => j.predecessor_run === job.run_id))
      throw new Error("Predecessor has a fresh successor; resume only the effective owner.");
    await this.auditDispositions(task, ctx);
    const followPrompt = `${p.prompt}\n\nAssess adopted findings and report-level pending matters against requirements and evidence; refute unsupported claims or propose a smaller repair rather than blindly implementing them. Preserve scope; optional ideas add no completion gate. This run is assigned these exact finding/report tokens: ${JSON.stringify(assessmentTokens(task))}. Report concrete assessment/refutation/correction and verification evidence for each within authorized scope, including unresolved matters and coverage/evidence gaps. A supported refutation or evidence-only assessment need not change code; root checks the substance. Bound adjudication reports (claims/gaps to assess, not new scope authority): ${this.pendingReportContext(task)}. Persistent decisions:\n${JSON.stringify(task.dispositions ?? [])}`;
    const decision = requireAdoptedCorrection(task);
    if (decision) {
      if ((await this.target(ctx)) !== task.target_id)
        throw new Error(
          "Target changed since adjudication; obtain fresh review before adopted fixes.",
        );
      await this.validate(decision, task, ctx);
    }
    if (isCli(job)) {
      await this.cliOperation("observe", job, task.cwd);
      if (!job.cli!.frozen)
        throw new Error("Collect/freeze the original Claude writer before resume.");
      if (job.cli!.unexpected_copy)
        throw new Error("Unexpected copy cannot be resumed as original-owner work.");
      // Correction needs exact original-owner/freeze/evidence, not successful
      // previous work. Never erase the failed run or silently repair its report.
      try {
        await this.io.originalRequest(task, job);
        if (job.artifact!) await this.readCliReport(task, job, ctx);
      } catch (error: any) {
        job.valid = false;
        job.error = String(error);
        this.save(ctx);
        throw error;
      }
      const follow: Job = {
        ...job,
        run_id: this.io.randomUUID(),
        resume_from: job.run_id,
        assessed_decisions: assessmentTokens(task),
        dispatch: "never",
        agent_id: null,
        cli: { frozen: false, evidence: [] },
        collected: false,
        valid: false,
        summary: undefined,
        result: undefined,
        artifact: undefined,
        result_hash: undefined,
        status: "queued",
        error: undefined,
      };
      task.jobs.push(follow);
      task.accepted = false;
      task.target_id = null;
      task.phase = "implementation";
      try {
        // Fresh observational baseline; preserving user work stays an instruction.
        await this.prepareCli(task, follow, ctx, job.cli!.checks!, job.cli);
        follow.agent_id = job.agent_id;
        this.save(ctx);
        follow.dispatch = "uncertain";
        this.save(ctx);
        await this.cliOperation(
          "resume",
          follow,
          task.cwd,
          await this.cliPrompt(
            task,
            follow,
            `Continue only original authorized design scope ${task.design_authorization!.scope}; preserve Opus design decisions unless explicit user/functional constraints require changes.\n${followPrompt}`,
          ),
        );
        follow.dispatch = "confirmed";
        this.save(ctx);
        return follow;
      } catch (error: any) {
        this.assertOperationActive();
        follow.status = "unknown";
        follow.error = String(error);
        follow.collected = follow.cli!.frozen === true;
        this.settlePreparationFailure(follow);
        this.save(ctx);
        throw error;
      }
    }
    const record = this.manager()?.getRecord(job.agent_id);
    if (!record?.session)
      throw new Error(
        "Original live child session unavailable. Use Tintinweb @handle session recovery; no replacement owner was launched.",
      );
    assertReceipt(job, record);
    task.accepted = false;
    task.target_id = null;
    task.phase = "implementation";
    const follow: Job = {
      ...job,
      run_id: this.io.randomUUID(),
      resume_from: job.run_id,
      assessed_decisions: assessmentTokens(task),
      resume_dispatch_started: false,
      dispatch: "never",
      cessation: undefined,
      collected: false,
      valid: false,
      summary: undefined,
      result: undefined,
      artifact: undefined,
      receipt_path: undefined,
      receipt_hash: undefined,
      result_hash: undefined,
      status: "running",
      error: undefined,
    };
    task.jobs.push(follow);
    try {
      this.save(ctx);
      follow.resume_dispatch_started = true;
      follow.dispatch = "uncertain";
      this.save(ctx);
      // Public native Agent tool supports resumption; RPC intentionally strips resume fields.
      const reply = await ctx.executeTool!(
        "Agent",
        {
          subagent_type: `astraeus-${job.role}`,
          resume: job.agent_id,
          prompt:
            job.role === "designer"
              ? `Continue only the original authorized design scope ${task.design_authorization!.scope}; preserve Opus design decisions unless explicit user or functional constraints require a change.\n${followPrompt}`
              : followPrompt,
          description: `Continue ${task.task_id}`,
          run_in_background: true,
        },
        { signal },
      );
      const updated = this.manager()?.getRecord(job.agent_id);
      if (!updated || !ACTIVE.has(updated.status))
        throw new Error(
          "Native resume did not start the original owner: " +
            JSON.stringify({ reply, status: updated?.status }),
        );
      follow.dispatch = "confirmed";
      this.save(ctx);
      return follow;
    } catch (error: any) {
      if (ACTIVE.has(this.manager()?.getRecord(follow.agent_id)?.status ?? ""))
        follow.dispatch = "confirmed";
      follow.status = "error";
      follow.error = String(error);
      follow.collected = true;
      this.save(ctx);
      throw error;
    }
  }
}
