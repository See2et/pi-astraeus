import type { Host } from "../src/application/ports.ts";
import { Type } from "typebox";
import { getAgentDir, parseFrontmatter, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { Workflow, ROOT, isWriter } from "../src/infrastructure/workflow-runtime.ts";
import { lifecycleDelivery } from "./notice-delivery.js";
import {
  modelView,
  modelToolResult,
  sanitizeContext,
  sanitizeSummaryEntries,
} from "./model-view.ts";
import { join } from "node:path";
import { realpathSync } from "node:fs";

const ops = [
  "start",
  "authorize_design",
  "status",
  "delegate",
  "collect",
  "reconcile_generated",
  "resume",
  "stop",
  "accept",
  "invalidate",
  "disposition",
] as const;
const parameters = Type.Object({
  op: Type.Union(ops.map((op) => Type.Literal(op))),
  task_id: Type.Optional(Type.String()),
  requirements: Type.Optional(Type.String()),
  acceptance: Type.Optional(Type.String()),
  design_request: Type.Optional(
    Type.String({
      description:
        "Original explicit user request for Claude design; caller-reported quote, not authenticated consent",
    }),
  ),
  design_scope: Type.Optional(
    Type.Union(
      ["design-direction", "ui-implementation", "design-direction-and-ui-implementation"].map((x) =>
        Type.Literal(x),
      ),
    ),
  ),
  constraints: Type.Optional(Type.String()),
  consequential: Type.Optional(Type.Boolean()),
  role: Type.Optional(
    Type.Union(["worker", "designer", "reviewer", "adjudicator"].map((x) => Type.Literal(x))),
  ),
  model: Type.Optional(
    Type.String({
      description: "Exact authorized provider/model ID; no fuzzy matching or fallback",
    }),
  ),
  thinking: Type.Optional(
    Type.Union(
      ["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((x) => Type.Literal(x)),
    ),
  ),
  prompt: Type.Optional(Type.String()),
  owned_paths: Type.Optional(
    Type.Array(
      Type.String({
        description:
          "Bounded assignment/scheduling scope; advisory like native GPT ownership, not CLI edit permissions",
      }),
    ),
  ),
  checks: Type.Optional(
    Type.Array(
      Type.String({
        description: "Designer-only exact simple verification commands; absent means []",
      }),
    ),
  ),
  run_id: Type.Optional(
    Type.String({
      description:
        "Required for collect/stop/resume/disposition; for delegate adjudicator optionally select original review run (default latest). Not agent_id",
    }),
  ),
  ref: Type.Optional(
    Type.String({ description: "disposition: exact review finding ref, e.g. bugs/0" }),
  ),
  action: Type.Optional(Type.Union(["adopt", "reject", "optional"].map((x) => Type.Literal(x)))),
  route: Type.Optional(Type.Union(["clear", "disputed"].map((x) => Type.Literal(x)))),
  authority: Type.Optional(
    Type.String({
      description:
        "disposition: requirement/scope authority; clear routing is an accountable root judgment",
    }),
  ),
  rationale: Type.Optional(Type.String()),
  evidence: Type.Optional(Type.String()),
  prior_decision: Type.Optional(
    Type.String({
      description:
        "Explicit stable identity mapping to saved disposition ID, including reworded/new-ID duplicates",
    }),
  ),
  prior_finding: Type.Optional(
    Type.String({
      description:
        "disposition only: exact earlier review-run/bugs/N or review-run/violations/N source for an explicit current-report mapping, including previously unmapped blockers; do not combine with prior_decision",
    }),
  ),
  reopening: Type.Optional(
    Type.String({
      description:
        "Concrete new evidence/relevant code change for reopening reject/optional; target hash/wording alone insufficient",
    }),
  ),
  predecessor_run: Type.Optional(
    Type.String({
      description:
        "delegate only: explicit fresh-owner takeover of latest collected same-role owner after verified cessation; preserve exact pins/scope",
    }),
  ),
  handoff: Type.Optional(
    Type.String({
      description:
        "Takeover: requirements, current code/check evidence, unresolved decisions and inherited responsibilities",
    }),
  ),
  reason: Type.Optional(
    Type.String({ description: "Takeover: why original owner cannot continue" }),
  ),
  generated_outputs: Type.Optional(
    Type.Array(Type.Unknown(), {
      description:
        "Deprecated compatibility input; ignored. reconcile_generated now recollects without generated-output approvals.",
    }),
  ),
});
export default function (pi: ExtensionAPI) {
  const delivery = lifecycleDelivery(pi, {
    unfinished: (ctx) =>
      Object.values(workflow.tasks).some(
        (task) => !task.accepted && task.cwd === realpathSync(ctx.cwd),
      ),
    notification: (message, ctx) => {
      if (message.customType !== "subagent-notification") return false;
      const details = message.details as { id?: string; others?: { id?: string }[] } | undefined;
      const ids = new Set([details?.id, ...(details?.others ?? []).map((other) => other.id)]);
      return Object.values(workflow.tasks).some(
        (task) =>
          !task.accepted &&
          task.cwd === realpathSync(ctx.cwd) &&
          task.jobs.some((job) => !!job.agent_id && ids.has(job.agent_id)),
      );
    },
  });
  const workflow = new Workflow({
    events: pi.events,
    appendEntry: (type: string, data: unknown) => pi.appendEntry(type, data),
    notify: (notice: unknown) =>
      delivery.notify({
        customType: "pi-astraeus:claude-lifecycle",
        display: true,
        content: JSON.stringify(modelView(notice)),
        details: modelView(notice),
      }),
    agentDir: getAgentDir,
    parseFrontmatter,
    supportedThinking: getSupportedThinkingLevels,
    manager: () =>
      (globalThis as unknown as Record<symbol, ReturnType<Host["manager"]>>)[
        Symbol.for("pi-subagents:manager")
      ],
  });
  const guidance = (state: unknown) =>
    `Apply ${join(ROOT, "skills/pi-astraeus-orchestrate/SKILL.md")} to authorized project work. Simple tasks stay solo. Root owns scope and final acceptance. Use astraeus_workflow for managed consequential work, including when root implements directly (delegate is optional). Preserve project/user constraints and native Pi authentication for GPT. Explicit designer uses only installed Claude Code --bg, never as GPT fallback. Never claim strict sandbox assurance. Current workflow view (not fresh lifecycle evidence): ${JSON.stringify(modelView(state))}. Read-only role instructions are not OS isolation.`;
  const internalResume = new Map<string, string>();
  pi.registerTool({
    name: "astraeus_workflow",
    label: "Astraeus workflow",
    exposure: "model-only",
    description: `Manage evidence-bound Astraeus work. Trivial work stays solo. For consequential work, start with requirements/acceptance/constraints, delegate only useful bounded work with exact model+thinking, collect results, use fresh reviewer with persistent finding dispositions, route clear bounded requirement-backed fixes to owner assessment or disputed scope/evidence/interpretation to fresh adjudication, resume original owner (or explicit predecessor_run succession with reason/handoff after verified cessation) for adopted fixes, and accept after evidence and current-target checks. For explicit Claude design only, record original design_request and design_scope at start/authorize_design, then use designer with matching scope and exact anthropic/claude-opus-5-5 (logical pin), installed Claude Code --bg with supported CLI effort and optional checks. GPT routes stay native; no CLI/API fallback. Designer owned_paths is advisory assignment/scheduling, with repository-scoped edit permissions and protected Git/workflow artifacts. Preserve user changes and explicit design scope. Collect freezes the exact UUID/cwd and records run-bound outcomes separately from acceptance; outside/ignored/shared-cwd deltas are not collection gates. Failed original collected runs may resume after verified identity/freeze/evidence without a successful prior report. reconcile_generated is a deprecated recollection alias for persisted failures; no cache fingerprints or new approvals. Existing Claude sessions retain saved permissions on resume and are not migrated. These are caller attestations, not authenticated user consent. Status does not infer success. Role policies: ${join(ROOT, "skills")}.`,
    parameters,
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      workflow.ensureMonitoring(ctx);
      if (params.op === "resume" && params.run_id && params.task_id) {
        const task = workflow.tasks[params.task_id];
        const job = task?.jobs.find((j) => j.run_id === params.run_id);
        if (job) internalResume.set(toolCallId, job.agent_id!);
      }
      try {
        const result = await workflow.execute(params, ctx, signal);
        return modelToolResult(result);
      } catch (error) {
        return {
          ...modelToolResult(workflow.recovery(params, error)),
          isError: true,
        };
      } finally {
        internalResume.delete(toolCallId);
      }
    },
  });
  pi.registerCommand("astraeus", {
    description: "Astraeus status and capability diagnostics (no inference)",
    async handler(args, ctx) {
      workflow.ensureMonitoring(ctx);
      try {
        const policy = await workflow.policy(ctx);
        const tasks = await workflow.execute(
          { op: "status", task_id: args.trim() || undefined },
          ctx,
        );
        const available = ctx.modelRegistry.getAvailable().map((m) => `${m.provider}/${m.id}`);
        const summary = JSON.stringify(
          modelView({
            policy,
            available_models: available,
            tasks,
            tintinweb_available: !!workflow.manager(),
            assurance_limit:
              "Pi does not attest an OS read-only sandbox; strict review is blocked.",
          }),
        );
        if (ctx.hasUI) ctx.ui.notify(summary, "info");
      } catch (error) {
        if (ctx.hasUI) ctx.ui.notify(JSON.stringify(modelView({ error: String(error) })), "error");
        else throw error;
      }
    },
  });
  pi.on("session_start", (_event, ctx) => {
    delivery.start(ctx);
    workflow.restore(ctx);
  });
  pi.on("session_tree", (_event, ctx) => {
    delivery.start(ctx);
    workflow.restore(ctx);
  });
  pi.on("session_shutdown", () => {
    delivery.dispose();
    workflow.dispose();
  });
  pi.on("agent_start", () => delivery.agentStart());
  pi.on("agent_settled", () => delivery.settled());
  pi.on("before_agent_start", async (_event, ctx) => {
    workflow.ensureMonitoring(ctx);
    const state = await workflow.execute({ op: "status" }, ctx);
    return {
      message: {
        customType: "pi-astraeus:guidance",
        display: false,
        content: guidance(state),
      },
    };
  });
  pi.on("context", (event) => {
    delivery.context(event.messages);
    return { messages: sanitizeContext(event.messages, guidance(Object.values(workflow.tasks))) };
  });
  // Pi compaction has its own summarization path, outside the context event.
  // Change only request-local preparations, not branchEntries/raw session history.
  pi.on("session_before_compact", (event) => {
    const current = guidance(Object.values(workflow.tasks));
    event.preparation.messagesToSummarize = sanitizeContext(
      event.preparation.messagesToSummarize,
      current,
    );
    event.preparation.turnPrefixMessages = sanitizeContext(
      event.preparation.turnPrefixMessages,
      current,
    );
  });
  pi.on("session_before_tree", (event, ctx) => {
    workflow.beforeTree(ctx);
    // Pi 1.0.4 retains this request-local array for generateBranchSummary;
    // replace its elements with sanitized copies, never persisted entry objects.
    const entries = event.preparation.entriesToSummarize;
    const sanitized = sanitizeSummaryEntries(entries, guidance(Object.values(workflow.tasks)));
    entries.splice(0, entries.length, ...sanitized);
  });
  pi.on("tool_call", (event, ctx) => {
    const tasks = Object.values(workflow.tasks).filter(
      (task) => task.cwd === realpathSync(ctx.cwd),
    );
    const managed = tasks.some((t) => !t.accepted);
    const internal =
      event.parentToolCallId &&
      internalResume.get(event.parentToolCallId) === (event.input as { resume?: string }).resume;
    if (managed && ["Agent", "SubagentWorkflow"].includes(event.toolName) && !internal)
      return {
        block: true,
        reason:
          "Use astraeus_workflow for tracked delegation and fresh review; native Agent resumption is routed internally.",
      };
    const frozen = tasks.some((t) =>
      t.jobs.some(
        (j) =>
          !isWriter(j.role) &&
          ["running", "queued"].includes(
            workflow.manager()?.getRecord(j.agent_id)?.status ?? j.status,
          ),
      ),
    );
    if (frozen && ["edit", "write", "bash", "powershell"].includes(event.toolName))
      return {
        block: true,
        reason:
          "Review target is frozen. Collect or stop the reviewer before changing files or running shell commands.",
      };
  });
  pi.on("agent_before_settle", (_event, ctx) => {
    const pending = Object.values(workflow.tasks).filter((t) => !t.accepted);
    if (pending.length && ctx.hasUI)
      ctx.ui.setStatus(
        "pi-astraeus",
        pending.map((t) => `${t.task_id}: ${t.phase} (incomplete)`).join(" · "),
      );
  });
}
