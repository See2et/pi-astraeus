export const ENTRY = "pi-astraeus:state-v1";
export const ROLES = ["worker", "designer", "reviewer", "adjudicator"] as const;
export type Role = (typeof ROLES)[number];
export type Thinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export const DESIGN_MODEL = "anthropic/claude-opus-5-5";
export const DESIGN_SCOPES = [
  "design-direction",
  "ui-implementation",
  "design-direction-and-ui-implementation",
] as const;
export type DesignScope = (typeof DESIGN_SCOPES)[number];
export const CLAUDE_TRANSPORT = "claude-code-bg-v1";
export const CLI_EFFORTS: readonly Thinking[] = ["low", "medium", "high", "xhigh", "max"];
export const ACTIVE = new Set(["running", "queued"]);
export const isWriter = (role: string) => role === "worker" || role === "designer";
export const isCli = (job: Pick<Job, "transport">) => job.transport === CLAUDE_TRANSPORT;
export interface DesignAuthorization {
  request: string;
  scope: DesignScope;
  source: string;
}
export interface Settings {
  model: string;
  effort: Thinking;
  sandbox?: null;
}
export interface Policy {
  allowed_models: string[];
  assurance: "reported" | "strict";
  require_review_globs: string[];
  schema_version: number;
}
export interface Evidence {
  kind: string;
  path: string;
  sha256: string;
}
export interface Observation {
  id: string;
  session_id: string | null;
  cwd?: string;
  state?: string | null;
  status?: string | null;
  pid?: number | null;
}
export interface Baseline {
  files: Record<string, string>;
  head: string | null;
  index: string;
  dirty: string[];
}
export interface CliState {
  frozen: boolean;
  evidence: Evidence[];
  short_id?: string;
  session_id?: string;
  observed?: Observation;
  directory?: string;
  report_directory?: string;
  pending?: string;
  checks?: string[];
  baseline?: Baseline;
  dispatch_target?: string;
  user_dirty?: string[];
  unexpected_copy?: Observation;
  copy_frozen?: boolean;
  preparation_failure?: string;
  observation_failure?: string;
  notified_status?: string;
  ownership_failure?: { error: string; provenance: string };
}
export interface Check {
  command: string;
  outcome: string;
  evidence?: string;
}
// Reports cross a versioned, Python-schema-validated boundary. Optional fields
// reflect the three distinct upstream result kinds, not new validation policy.
export interface Report {
  status: string;
  verdict?: string;
  summary: string;
  run_id?: string;
  remaining?: string[];
  unresolved?: string[];
  checked_scope?: string[];
  evidence?: string[];
  checks?: Check[];
}
export interface Job {
  task_id?: string;
  run_id: string;
  agent_id: string | null;
  role: Role;
  transport?: string;
  status: string;
  collected: boolean;
  valid: boolean;
  owned_paths: string[];
  requested: Settings;
  cli?: CliState;
  target_id?: string | null;
  review_run?: string | null;
  resume_from?: string;
  resume_dispatch_started?: boolean;
  resume_preparation_failure?: string;
  error?: string;
  summary?: string;
  result?: Report;
  artifact?: string;
  result_hash?: string;
  receipt_path?: string;
  receipt_hash?: string;
}
export interface Task {
  task_id: string;
  cwd: string;
  requirements: string;
  acceptance: string;
  constraints: string;
  consequential: boolean;
  phase: string;
  jobs: Job[];
  target_id: string | null;
  accepted: boolean;
  accepted_target?: string;
  design_authorization: DesignAuthorization | null;
}
export interface Command {
  op: string;
  task_id?: string;
  requirements?: string;
  acceptance?: string;
  constraints?: string;
  consequential?: boolean;
  design_request?: string;
  design_scope?: DesignScope;
  role?: Role;
  model?: string;
  thinking?: Thinking;
  prompt?: string;
  owned_paths?: string[];
  checks?: string[];
  run_id?: string;
  generated_outputs?: unknown[];
}
export interface ModelIdentity {
  provider: string;
  id: string;
}
export function designAuthorization(
  p: Pick<Command, "design_request" | "design_scope">,
): DesignAuthorization {
  if (!p.design_request?.trim() || !DESIGN_SCOPES.includes(p.design_scope!))
    throw new Error(
      "Explicit design_request original user quote and a bounded design_scope are required.",
    );
  return {
    request: p.design_request.trim(),
    scope: p.design_scope!,
    source: "root-reported user request; not authenticated user consent",
  };
}
export function designModel(_registry: unknown, value: unknown): ModelIdentity {
  if (value !== DESIGN_MODEL)
    throw new Error(
      `Designer requires exact ${DESIGN_MODEL}; no lower-family or provider fallback.`,
    );
  return { provider: "anthropic", id: "claude-opus-5-5" };
}
export function selectModel<M extends ModelIdentity>(
  available: readonly M[],
  value: unknown,
  policy: Policy,
): M {
  if (typeof value !== "string" || !value.includes("/"))
    throw new Error("Use an exact provider/model ID; fuzzy model selection is disabled.");
  const model = available.find((m) => `${m.provider}/${m.id}` === value);
  if (!model) throw new Error(`Unavailable authorized model: ${value}. No fallback was launched.`);
  if (model.provider === "anthropic")
    throw new Error(
      "Anthropic is reserved for explicitly authorized designer scope, never general worker/reviewer/adjudicator routing.",
    );
  if (!policy.allowed_models.some((id) => id === value || id === model.id))
    throw new Error(`Model prohibited by astraeus.toml: ${value}`);
  return model;
}
export function overlapping(a: readonly string[], b: readonly string[]): boolean {
  return a.some((x) =>
    b.some(
      (y) => x === "." || y === "." || x === y || x.startsWith(y + "/") || y.startsWith(x + "/"),
    ),
  );
}
export function observedStatus(
  record: Pick<Observation, "state" | "status"> | null | undefined,
): string {
  const { state, status } = record ?? {};
  if (state === "stopped" && [null, undefined, "idle"].includes(status)) return "stopped";
  if (
    state === "blocked" &&
    [null, undefined, "idle", "blocked", "waiting", "input-wait"].includes(status)
  )
    return "blocked";
  if (["done", "idle"].includes(state!) && [null, undefined, "idle"].includes(status))
    return "work-ended";
  if (state === "working" && ["running", "busy", "working"].includes(status!)) return "running";
  return "unknown";
}
export function validatePaths(paths: unknown): asserts paths is string[] {
  if (
    !Array.isArray(paths) ||
    !paths.length ||
    new Set(paths).size !== paths.length ||
    paths.some(
      (p) =>
        typeof p !== "string" ||
        !p ||
        p.startsWith("/") ||
        p.split("/").some((x: string) => x === ".." || x === ".git") ||
        /[\\*?[\]()\r\n]/.test(p) ||
        (p !== "." &&
          p !==
            p
              .split("/")
              .filter((x: string) => x && x !== ".")
              .join("/")),
    )
  )
    throw new Error(
      "Designer owned_paths must be normalized literal paths (or .), not globs or Git metadata.",
    );
}
export function validateChecks(checks: unknown): asserts checks is string[] {
  if (
    !Array.isArray(checks) ||
    new Set(checks).size !== checks.length ||
    checks.some(
      (c) =>
        typeof c !== "string" ||
        !c.trim() ||
        /[*?[\]();&|$`<>\r\n]/.test(c) ||
        /\b(?:gh|glab|curl|wget|rm)\b|\bgit\b.*\b(?:push|commit)\b/.test(c),
    )
  )
    throw new Error(
      "Designer checks must be unique simple verification commands, not shell operators or publication.",
    );
}
export function phaseAfterReport(role: Role, result: Report): string {
  return result.verdict === "pass" || result.verdict === "accept"
    ? "ready-for-root"
    : result.verdict === "changes_required"
      ? role === "reviewer"
        ? "needs-adjudication"
        : "needs-fixes"
      : "needs-evidence";
}
export function requireCompleteChecks(required: readonly string[], result: Report): void {
  if (result.status !== "complete" || result.remaining!.length)
    throw new Error("Implementation report has incomplete work or remaining issues.");
  const checks = new Map(result.checks!.map((c) => [c.command, c]));
  if (
    checks.size !== result.checks!.length ||
    result.checks!.some((c) => c.outcome !== "passed") ||
    required.some((c) => !checks.has(c))
  )
    throw new Error("Required checks missing, failed or not run.");
}
