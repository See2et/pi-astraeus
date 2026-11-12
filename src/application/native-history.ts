import { ENTRY, isCli } from "../domain/workflow.ts";
import type { Job, Task } from "../domain/workflow.ts";
import type { Envelope } from "./ports.ts";

// pi-subagents 0.19 persists settled top-level lifecycle as subagents:record.
// It has no run/cwd fields: join it only to the original dispatch checkpoints
// on this active branch, never to assistant output or a collection outcome.
export function nativeHistory(
  task: Task,
  job: Job,
  entries: Envelope[],
  sessionId: string | undefined,
  hash: (bytes: string) => string,
): { cessation?: Job["cessation"]; diagnostic: string } {
  const blocked = (reason: string) => ({
    diagnostic: `Native terminal history blocked: ${reason}`,
  });
  if (
    !sessionId ||
    !job.agent_id ||
    isCli(job) ||
    !["uncertain", "confirmed"].includes(job.dispatch ?? "")
  )
    return blocked("missing original session/dispatch identity.");
  if (job.resume_from && (job.dispatch !== "confirmed" || job.resume_dispatch_started !== true))
    return blocked("uncertain resume cannot borrow predecessor terminal evidence.");

  let launch: Envelope | undefined, binding: Envelope | undefined;
  const records: Envelope[] = [];
  for (const entry of entries) {
    if (entry.type !== "custom") continue;
    if (entry.customType === ENTRY && entry.data?.version === 1) {
      const tasks = Object.values(entry.data.tasks ?? {}) as Task[];
      const runs = tasks.flatMap((t) =>
        t.jobs.filter((j) => j.run_id === job.run_id).map((j) => ({ task: t, job: j })),
      );
      if (!runs.length && !launch) continue;
      if (
        runs.length !== 1 ||
        runs[0].task.task_id !== task.task_id ||
        runs[0].task.cwd !== task.cwd ||
        runs[0].job.role !== job.role ||
        isCli(runs[0].job) ||
        runs[0].job.requested.model !== job.requested.model ||
        runs[0].job.requested.effort !== job.requested.effort ||
        (runs[0].job.agent_id && runs[0].job.agent_id !== job.agent_id)
      )
        return blocked("run/cwd/role/agent dispatch binding changed or is ambiguous.");
      const saved = runs[0].job;
      const dispatched = ["uncertain", "confirmed"].includes(saved.dispatch ?? "");
      if (dispatched && (!job.resume_from || saved.resume_dispatch_started === true))
        launch ??= entry;
      if (!launch) continue;
      // A shared agent ID is reused on resume. A later owner invalidates the
      // old run's recovery window, even if its preceding result was terminal.
      const owners = tasks.flatMap((t) => {
        const latest = t.jobs.filter((j) => j.agent_id === job.agent_id).at(-1);
        return latest ? [{ task: t, job: latest }] : [];
      });
      if (
        owners.length > 1 ||
        (owners.length === 1 &&
          (owners[0].task.task_id !== task.task_id || owners[0].job.run_id !== job.run_id))
      )
        return blocked("agent is also bound to another task or later run.");
      if (
        saved.agent_id === job.agent_id &&
        dispatched &&
        (!job.resume_from || saved.dispatch === "confirmed")
      )
        binding ??= entry;
    } else if (
      entry.customType === "subagents:record" &&
      entry.data?.id === job.agent_id &&
      launch
    ) {
      if (!binding) return blocked("terminal record precedes the exact agent binding.");
      records.push(entry);
    }
  }
  if (!launch?.id || !binding?.id || records.length !== 1)
    return blocked(
      "need exactly one host lifecycle record and its original dispatch checkpoints on this branch.",
    );
  const entry = records[0],
    record = entry.data;
  if (
    !entry.id ||
    record.type !== `astraeus-${job.role}` ||
    record.description !== `${task.task_id}: ${job.role}` ||
    !["completed", "stopped", "error", "aborted"].includes(record.status)
  )
    return blocked("host lifecycle identity mismatched or status is nonterminal.");
  const launchedAt = Date.parse(launch.timestamp),
    recordedAt = Date.parse(entry.timestamp);
  if (
    !Number.isFinite(launchedAt) ||
    !Number.isFinite(recordedAt) ||
    !Number.isFinite(record.startedAt) ||
    !Number.isFinite(record.completedAt) ||
    record.startedAt < launchedAt ||
    record.completedAt < record.startedAt ||
    recordedAt < record.completedAt
  )
    return blocked("host lifecycle timestamps do not bind to this dispatch window.");
  return {
    cessation: {
      source: "native host subagents:record on active branch",
      status: record.status,
      agent_id: job.agent_id,
      run_id: job.run_id,
      cwd: task.cwd,
      role: job.role,
      session_id: sessionId,
      entry_id: entry.id,
      dispatch_entry_id: launch.id,
      binding_entry_id: binding.id,
      evidence_hash: hash(JSON.stringify(entry.data)),
    },
    diagnostic:
      "Recovered exact historical host cessation only; existing outcome and dispatch certainty are unchanged.",
  };
}
