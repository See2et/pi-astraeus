import type { Observation, Thinking, Job, Baseline } from "../domain/workflow.ts";
import { observedStatus, CLI_EFFORTS } from "../domain/workflow.ts";
export {
  observedStatus,
  CLI_EFFORTS,
  CLAUDE_TRANSPORT,
  validatePaths,
  validateChecks,
} from "../domain/workflow.ts";
// Installed Claude Code background transport. Never reads private session storage.
import { spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { readFile, writeFile, lstat, readlink, realpath, link, unlink } from "node:fs/promises";
import { join, resolve, relative, isAbsolute } from "node:path";
import { ClaudeTrustPreflight } from "./claude-trust.ts";
import { setTimeout as delay } from "node:timers/promises";

const affirmativelyFrozen = (record: Observation) =>
  ["done", "stopped"].includes(record.state!) &&
  record.pid === null &&
  [null, "idle"].includes(record.status!);
const incompleteObservation = new Set([
  "missing-record",
  "missing-uuid",
  "invalid-uuid",
  "missing-cwd",
  "invalid-cwd",
  "cwd-unresolvable",
  "expected-cwd-unresolvable",
  "unknown-response",
  "query-unavailable",
  "query-timeout",
  "query-output-limit",
]);

const digest = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
export function launchId(stdout: string) {
  // CLI launch announcements may contain ANSI color sequences.
  // oxlint-disable-next-line no-control-regex
  const plain = stdout.replace(/\x1b\[[0-9;]*m/g, "");
  const ids = [...plain.matchAll(/^backgrounded · ([a-f0-9]{8})(?: · [^\r\n]*)?\s*$/gm)].map(
    (m) => m[1],
  );
  if (ids.length !== 1)
    throw new ObservationError(
      "Unknown or ambiguous Claude background launch output; retain evidence, do not relaunch.",
    );
  return ids[0];
}
// Public lifecycle evidence is not a freeze acknowledgment or a valid report.
export function capture(
  command: string,
  args: string[],
  cwd: string,
  { signal, timeout, maxBytes = Infinity }: CaptureOptions = {},
): Promise<CaptureResult> {
  return new Promise((resolveResult) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "",
      stderr = "",
      settled = false,
      size = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: Omit<CaptureResult, "stdout" | "stderr">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolveResult({ ...result, stdout, stderr });
    };
    // Kill only this CLI query child, never the bound background owner/PID.
    const cancel = (reason: string) => {
      child.kill("SIGKILL");
      finish({ returncode: null, diagnostic: reason });
    };
    const abort = () => cancel("Claude CLI observation cancelled");
    const chunk = (key: "stdout" | "stderr", bytes: Buffer) => {
      if (settled) return;
      const remaining = Math.max(0, maxBytes - size);
      size += bytes.length;
      const text = bytes.subarray(0, remaining).toString();
      if (key === "stdout") stdout += text;
      else stderr += text;
      if (size > maxBytes) cancel("Claude CLI output limit exceeded");
    };
    child.stdout.on("data", (c) => chunk("stdout", c));
    child.stderr.on("data", (c) => chunk("stderr", c));
    child.on("error", (error) => {
      if (!settled) stderr += String(error).slice(0, 1024);
      finish({ returncode: null });
    });
    child.on("close", (returncode, signal) => finish({ returncode, signal }));
    if (timeout !== undefined)
      timer = setTimeout(() => cancel("Claude CLI observation timed out"), timeout);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
interface CaptureOptions {
  signal?: AbortSignal;
  timeout?: number;
  maxBytes?: number;
}
export interface CaptureResult {
  returncode: number | null;
  stdout: string;
  stderr: string;
  signal?: NodeJS.Signals | null;
  diagnostic?: string;
}
class ObservationError extends Error {
  code?: string;
  reason?: string;
  evidence?: Record<string, unknown>;
}
export class ClaudeBackground {
  readonly command: string;
  readonly invoke: typeof capture;
  readonly trust: Pick<ClaudeTrustPreflight, "run">;
  readonly observationTimeout: number;
  readonly observationMaxBytes: number;
  readonly readinessTimeout: number;
  readonly readinessAttempts: number;
  readonly readinessInterval: number;
  constructor({
    command = "claude",
    invoke = capture,
    trust = new ClaudeTrustPreflight(),
    observationTimeout = 5000,
    observationMaxBytes = 256 * 1024,
    readinessTimeout = 5000,
    readinessAttempts = 10,
    readinessInterval = 100,
  } = {}) {
    this.command = command;
    this.invoke = invoke;
    this.trust = trust;
    this.observationTimeout = observationTimeout;
    this.observationMaxBytes = observationMaxBytes;
    if (
      !Number.isFinite(readinessTimeout) ||
      readinessTimeout <= 0 ||
      !Number.isInteger(readinessAttempts) ||
      readinessAttempts < 1 ||
      readinessAttempts > 100 ||
      !Number.isFinite(readinessInterval) ||
      readinessInterval < 0
    )
      throw new ObservationError("Invalid bounded Claude readiness budget.");
    this.readinessTimeout = readinessTimeout;
    this.readinessAttempts = readinessAttempts;
    this.readinessInterval = readinessInterval;
  }
  async preflight(cwd: string) {
    return this.trust.run(cwd, () => this.records(cwd));
  }
  async call(args: string[], cwd: string) {
    return this.invoke(this.command, args, cwd);
  }
  async checked(args: string[], cwd: string, options?: { signal?: AbortSignal }) {
    const result = await this.query(args, cwd, options?.signal);
    if (result.returncode !== 0) {
      const diagnostic = /timed out/.test(result.diagnostic || "")
        ? "timed out"
        : /output limit/.test(result.diagnostic || "")
          ? "output limit exceeded"
          : "failed";
      throw new ObservationError(
        `Claude CLI ${args.slice(0, 2).join(" ")} observation ${diagnostic}; no success inferred.`,
      );
    }
    return result.stdout;
  }
  async capabilities(cwd: string, effort?: string) {
    const help = await this.checked(["--help"], cwd);
    const flags = [
      "--bg",
      "--resume",
      "--model",
      "--effort",
      "--safe-mode",
      "--settings",
      "--setting-sources",
      "--permission-mode",
      "--allowedTools",
      "--disallowedTools",
      "--tools",
      "--add-dir",
      "--strict-mcp-config",
      "--mcp-config",
    ];
    if (flags.some((flag) => !help.includes(flag)))
      throw new ObservationError(
        "Installed Claude CLI lacks required safe background capabilities. No API fallback.",
      );
    // The installed CLI documents the accepted effort values; never clamp a Pi level.
    const block = /--effort\b([\s\S]*?)(?=\n\s{2}(?:--|-[A-Za-z],)|$)/.exec(help)?.[1] || "";
    if (
      effort &&
      (!CLI_EFFORTS.includes(effort as Thinking) || !new RegExp(`\\b${effort}\\b`).test(block))
    )
      throw new ObservationError(`Unsupported Claude CLI effort ${effort}; no clamping.`);
    const agents = await this.checked(["agents", "--help"], cwd);
    if (
      !agents.includes("--json") ||
      !agents.includes("--all") ||
      !(await this.checked(["stop", "--help"], cwd)).includes("stop <id>")
    )
      throw new ObservationError("Installed Claude CLI lacks exact lifecycle capabilities.");
  }
  async query(args: string[], cwd: string, signal?: AbortSignal): Promise<CaptureResult> {
    // Also bound injected transports that ignore cancellation. Late replies cannot
    // escape this promise or mutate a job; observe's caller stages its own copy.
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined, off: (() => void) | undefined;
    try {
      return await new Promise<CaptureResult>((resolveResult, reject) => {
        const fail = (reason: string) => {
          reject(new ObservationError(reason));
          controller.abort();
        };
        off = () => fail("Claude observation cancelled");
        timer = setTimeout(() => fail("Claude observation timed out"), this.observationTimeout);
        signal?.addEventListener("abort", off, { once: true });
        if (signal?.aborted) {
          off();
          return;
        }
        Promise.resolve()
          .then(() =>
            this.invoke(this.command, args, cwd, {
              signal: controller.signal,
              timeout: this.observationTimeout,
              maxBytes: this.observationMaxBytes,
            }),
          )
          .then((result) => {
            if (
              Buffer.byteLength(result.stdout || "") + Buffer.byteLength(result.stderr || "") >
              this.observationMaxBytes
            )
              fail("Claude observation output limit exceeded");
            else resolveResult(result);
          }, reject);
      });
    } finally {
      clearTimeout(timer);
      if (off) signal?.removeEventListener("abort", off);
    }
  }
  async records(cwd: string, signal?: AbortSignal): Promise<Record<string, any>[]> {
    const stdout = await this.checked(["agents", "--json", "--all"], cwd, { signal });
    let records;
    try {
      records = JSON.parse(stdout);
    } catch {
      /* Never echo a parser snippet/public record. */
    }
    if (!Array.isArray(records)) {
      const error = new ObservationError("Unknown Claude agents JSON format.");
      error.code = "CLAUDE_AGENTS_FORMAT";
      throw error;
    }
    return records;
  }
  async match(short: string, cwd: string, full?: string, signal?: AbortSignal) {
    // Keep bounded identity-only evidence in the error message: workflow state
    // persists it across restore, without retaining unrelated public records or paths.
    const evidence: Record<string, unknown> = {
      short_id: /^[a-f0-9]{8}$/.test(short) ? short : null,
      expected_uuid: uuid(full) ? full : null,
    };
    const refuse = (reason: string): never => {
      const error = new ObservationError(
        `Claude ${incompleteObservation.has(reason) ? "observation uncertain" : "full UUID/cwd binding mismatch"}: ${reason}${reason === "query-timeout" ? " (observation timed out)" : ""}; unknown is not done. ${JSON.stringify(evidence)}`,
      );
      error.code = incompleteObservation.has(reason)
        ? "CLAUDE_OBSERVATION_UNCERTAIN"
        : "CLAUDE_BINDING_REFUSED";
      error.reason = reason;
      error.evidence = { ...evidence };
      throw error;
    };
    let records: Record<string, any>[] = [];
    try {
      records = await this.records(cwd, signal);
    } catch (error: any) {
      if (signal?.aborted) throw new ObservationError("Claude observation cancelled");
      refuse(
        error.code === "CLAUDE_AGENTS_FORMAT"
          ? "unknown-response"
          : /timed out/.test(error.message)
            ? "query-timeout"
            : /output limit/.test(error.message)
              ? "query-output-limit"
              : "query-unavailable",
      );
    }
    const found = records.filter((r) => r && r.id === short);
    evidence.match_count = found.length;
    if (!found.length) refuse("missing-record");
    if (found.length !== 1) refuse("ambiguous-record");
    const record = found[0];
    const camel = Object.hasOwn(record, "sessionId"),
      snake = Object.hasOwn(record, "session_id");
    evidence.sessionId = uuid(record.sessionId) ? record.sessionId : null;
    evidence.session_id = uuid(record.session_id) ? record.session_id : null;
    if (camel && snake && record.sessionId !== record.session_id)
      refuse("conflicting-uuid-aliases");
    const id = camel ? record.sessionId : record.session_id;
    if (id === null || id === undefined) refuse("missing-uuid");
    if (!uuid(id)) refuse("invalid-uuid");
    if (!id.startsWith(short + "-")) refuse("uuid-prefix-mismatch");
    if (full !== undefined && full !== id) refuse("expected-uuid-mismatch");
    if (record.cwd === null || record.cwd === undefined) refuse("missing-cwd");
    if (typeof record.cwd !== "string" || !record.cwd) refuse("invalid-cwd");
    let expectedCwd!: string, observedCwd!: string;
    try {
      expectedCwd = await realpath(cwd);
    } catch {
      refuse("expected-cwd-unresolvable");
    }
    evidence.expected_cwd_sha256 = digest(expectedCwd);
    try {
      observedCwd = await realpath(record.cwd);
    } catch {
      refuse("cwd-unresolvable");
    }
    evidence.observed_cwd_sha256 = digest(observedCwd);
    if (observedCwd !== expectedCwd) refuse("canonical-cwd-mismatch");
    return {
      id: short,
      session_id: id,
      cwd: expectedCwd,
      state: record.state ?? null,
      status: record.status ?? null,
      pid: record.pid ?? null,
    };
  }
  async ready(short: string, cwd: string, full?: string, signal?: AbortSignal, frozen = false) {
    // Retry only public observations after one acknowledged mutation. The total
    // deadline also cancels a query/wait; conflicting identity fails immediately.
    const controller = new AbortController();
    const abort = () => controller.abort();
    const timer = setTimeout(abort, this.readinessTimeout);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    let last: ObservationError | undefined;
    try {
      for (let attempt = 0; attempt < this.readinessAttempts; attempt++) {
        if (controller.signal.aborted) break;
        try {
          const record = await this.match(short, cwd, full, controller.signal);
          if (controller.signal.aborted) break;
          if (!frozen || affirmativelyFrozen(record)) return record;
          last = new ObservationError("Claude stop acknowledged but lifecycle is not frozen.");
          last.code = "CLAUDE_OBSERVATION_UNCERTAIN";
          last.reason = "lifecycle-not-frozen";
        } catch (error: any) {
          if (error.code !== "CLAUDE_OBSERVATION_UNCERTAIN") {
            if (error.code !== "CLAUDE_BINDING_REFUSED" && controller.signal.aborted) break;
            throw error;
          }
          last = error;
        }
        if (attempt + 1 < this.readinessAttempts) {
          try {
            await delay(this.readinessInterval, undefined, { signal: controller.signal });
          } catch {
            break;
          }
        }
      }
      const error = new ObservationError(
        signal?.aborted
          ? "Claude readiness observation cancelled."
          : `Claude readiness observation exhausted; unknown is not done or frozen. ${last?.message || "Observation deadline elapsed."}`,
      );
      error.code = "CLAUDE_OBSERVATION_UNCERTAIN";
      error.reason = last?.reason ?? "readiness-deadline";
      error.evidence = last?.evidence;
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }
  async evidence(job: Job, kind: string, args: string[], cwd: string) {
    const result = await this.call(args, cwd);
    const path = join(job.cli!.directory!, `${kind}-${randomUUID()}.json`);
    const bytes = JSON.stringify({ args, ...result }, null, 2);
    await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
    job.cli!.evidence.push({ kind, path, sha256: digest(bytes) });
    return result;
  }
  async audit(job: Job) {
    for (const item of job.cli!.evidence) {
      if (
        (await lstat(item.path)).isSymbolicLink() ||
        digest(await readFile(item.path)) !== item.sha256
      )
        throw new ObservationError("Claude lifecycle evidence changed.");
    }
  }
  async observe(job: Job, cwd: string, signal?: AbortSignal) {
    await this.audit(job);
    if (!job.cli!.session_id! || !job.cli!.short_id!)
      throw new ObservationError(
        "Claude launch has no observed UUID binding; inspect retained launch evidence.",
      );
    const observed = await this.match(job.cli!.short_id!, cwd, job.cli!.session_id!, signal);
    job.cli!.observed = observed;
    if (job.cli!.unexpected_copy) {
      if (!uuid(job.cli!.unexpected_copy.session_id))
        throw new ObservationError(
          "Unexpected Claude copy binding is unverified; retained emitted ID cannot authorize cleanup or success.",
        );
      const copy = await this.match(
        job.cli!.unexpected_copy.id,
        cwd,
        job.cli!.unexpected_copy.session_id!,
        signal,
      );
      job.cli!.copy_frozen = job.cli!.copy_frozen && affirmativelyFrozen(copy);
      if (!job.cli!.copy_frozen)
        throw new ObservationError("Unexpected Claude copy is not affirmatively frozen.");
    }
    if (job.cli!.frozen && !affirmativelyFrozen(observed)) {
      job.cli!.frozen = false;
      throw new ObservationError(
        "Previously stopped Claude writer is no longer affirmatively frozen.",
      );
    }
    return observed;
  }
  async stop(job: Job, cwd: string, signal?: AbortSignal) {
    const observed = await this.observe(job, cwd, signal);
    signal?.throwIfAborted();
    job.cli!.frozen = false;
    const result = await this.evidence(job, "stop", ["stop", observed.id], cwd);
    if (result.returncode !== 0 || result.stdout.trim() !== `stopped ${observed.id}`)
      throw new ObservationError("Exact Claude stop not acknowledged; retained stop evidence.");
    const stopped = await this.ready(observed.id, cwd, observed.session_id, signal, true);
    job.cli!.frozen = true;
    job.cli!.observed = stopped;
    job.status = observedStatus(stopped);
    return stopped;
  }
  async start(job: Job, cwd: string, prompt: string, checks: string[], signal?: AbortSignal) {
    await this.capabilities(cwd, job.requested.effort);
    if (/[*?[\]()\r\n]/.test(cwd + job.cli!.directory! + job.cli!.report_directory!))
      throw new ObservationError(
        "Claude cwd/control paths contain permission-rule metacharacters.",
      );
    const allows = ["Read", "Glob", "Grep"];
    // Like native GPT ownership, owned_paths guides assignment/scheduling, not
    // per-file permissions. The CLI boundary is the managed repository.
    allows.push(`Edit(/${cwd}/**)`, `Write(/${cwd}/**)`);
    // Saved permissions survive resume. Only pending reports get a stable bounded
    // directory allow; requests, evidence and validated final reports never do.
    allows.push(
      `Edit(/${job.cli!.report_directory!}/**)`,
      `Write(/${job.cli!.report_directory!}/**)`,
      ...checks.map((c: string) => `Bash(${c})`),
    );
    const denies = [
      "Agent",
      "Task",
      "Bash(git push *)",
      "Bash(git -C * push *)",
      "Bash(gh *)",
      "Bash(glab *)",
      "Bash(curl *)",
      "Bash(wget *)",
      ...[".git", ".astraeus"].flatMap((path) => [
        `Edit(/${cwd}/${path})`,
        `Edit(/${cwd}/${path}/**)`,
        `Write(/${cwd}/${path})`,
        `Write(/${cwd}/${path}/**)`,
      ]),
    ];
    // No broad Edit/Write allow on the control directory: only this pending report.
    const settings = {
      permissions: { defaultMode: "dontAsk", allow: allows, deny: denies },
      worktree: { bgIsolation: "none" },
    };
    const args = [
      "--bg",
      "--safe-mode",
      "--model",
      "claude-opus-5-5",
      "--effort",
      job.requested.effort,
      "--permission-mode",
      "dontAsk",
      "--setting-sources",
      "",
      "--settings",
      JSON.stringify(settings),
      "--tools",
      "Read,Edit,Write,Glob,Grep,Bash",
      "--allowedTools",
      ...allows,
      "--disallowedTools",
      ...denies,
      "--add-dir",
      job.cli!.directory!,
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
      "--",
      prompt,
    ];
    await this.preflight(cwd);
    signal?.throwIfAborted();
    const result = await this.evidence(job, "launch", args, cwd);
    if (result.returncode !== 0)
      throw new ObservationError(
        "Claude background launch failed; inspect retained stdout/stderr/exit, no blind retry.",
      );
    const short = launchId(result.stdout);
    job.cli!.short_id = short;
    const observed = await this.ready(short, cwd, undefined, signal);
    job.cli!.session_id = observed.session_id!;
    job.cli!.observed = observed;
    job.agent_id = `claude:${observed.session_id}`;
    job.status = observedStatus(observed);
  }
  async resume(job: Job, cwd: string, prompt: string, signal?: AbortSignal) {
    // Live idle/done sessions also copy on --resume in 2.1.288: stop first.
    await this.stop(job, cwd, signal);
    await this.preflight(cwd);
    signal?.throwIfAborted();
    // A dispatched run is no longer safely frozen even if receipt publication
    // fails after invocation. Do not let the caller settle/stop monitoring it.
    job.cli!.frozen = false;
    const result = await this.evidence(
      job,
      "resume",
      ["--bg", "--resume", job.cli!.session_id!, "--", prompt],
      cwd,
    );
    if (result.returncode !== 0)
      throw new ObservationError("Claude resume failed; retained evidence, no retry.");
    const short = launchId(result.stdout);
    if (short !== job.cli!.short_id!) {
      // Retain failure provenance before inspection or cleanup can throw. A later
      // public record must not retroactively bind this unverified emitted writer.
      job.cli!.unexpected_copy = { id: short, session_id: null };
      job.cli!.copy_frozen = false;
    }
    // Same-short replies must prove the saved full UUID at the binding boundary.
    // A different emitted short ID is inspected only for exact copy cleanup below.
    const resumed = await this.ready(
      short,
      cwd,
      short === job.cli!.short_id! ? job.cli!.session_id! : undefined,
      signal,
    );
    if (short !== job.cli!.short_id! || resumed.session_id !== job.cli!.session_id!) {
      // Only stop the exact emitted copy after verifying UUID/cwd; never rebind owner.
      const copy = resumed;
      job.cli!.unexpected_copy = copy;
      signal?.throwIfAborted();
      const stopped = await this.evidence(job, "stop-unexpected-copy", ["stop", copy.id], cwd);
      if (stopped.returncode !== 0 || stopped.stdout.trim() !== `stopped ${copy.id}`)
        throw new ObservationError(
          "Unexpected Claude copy could not be stopped; retained evidence.",
        );
      const frozen = await this.ready(copy.id, cwd, copy.session_id, signal, true);
      job.cli!.copy_frozen = affirmativelyFrozen(frozen);
      throw new ObservationError(
        "Claude resume copied the owner; exact unexpected copy stopped, inspect changes before recovery.",
      );
    }
    job.cli!.observed = resumed;
    job.status = observedStatus(resumed);
  }
}

// Snapshot actual content, index and ignored output, not merely dirty path names.
export async function snapshot(cwd: string) {
  const git = async (args: string[]) => {
    const result = await capture("git", args, cwd);
    if (result.returncode !== 0) throw new ObservationError(result.stderr || "Git baseline failed");
    return result.stdout;
  };
  const paths = new Set<string>();
  for (const args of [
    ["ls-files", "--cached", "-z"],
    ["ls-files", "--others", "--exclude-standard", "-z"],
    ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"],
  ])
    for (const p of (await git(args)).split("\0").filter(Boolean)) paths.add(p);
  const files: Record<string, string> = {};
  for (const p of [...paths].sort()) {
    const path = join(cwd, p);
    let stat;
    try {
      stat = await lstat(path);
    } catch (error: any) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (stat.isDirectory())
      throw new ObservationError(`Submodule/directory baseline unsupported: ${p}`);
    const parent = await realpath(resolve(path, ".."));
    const rel = relative(await realpath(cwd), parent);
    if (isAbsolute(rel) || rel === ".." || rel.startsWith("../"))
      throw new ObservationError(`Baseline path escapes cwd: ${p}`);
    files[p] =
      `${stat.mode}:${digest(stat.isSymbolicLink() ? await readlink(path) : await readFile(path))}`;
  }
  const head = await capture("git", ["rev-parse", "--verify", "HEAD"], cwd);
  const dirty = new Set<string>();
  for (const args of [
    ["diff", "--name-only", "--no-renames", "--no-ext-diff", "--no-textconv", "-z"],
    ["diff", "--cached", "--name-only", "--no-renames", "--no-ext-diff", "--no-textconv", "-z"],
    ["ls-files", "--others", "--exclude-standard", "-z"],
  ])
    for (const p of (await git(args)).split("\0").filter(Boolean)) dirty.add(p);
  return {
    files,
    head: head.returncode === 0 ? head.stdout.trim() : null,
    index: await git(["ls-files", "--stage", "-z"]),
    dirty: [...dirty].sort(),
  };
}
// Observational only: shared-cwd changes cannot be attributed to one owner.
// Root judges scope, user-work preservation and staging/history in final review.
export function delta(before: Baseline, after: Baseline) {
  return [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])]
    .filter((p) => before.files[p] !== after.files[p])
    .sort();
}
export async function publish(pending: string, final: string, bytes: string | Uint8Array) {
  if (
    (await lstat(pending)).isSymbolicLink() ||
    !Buffer.from(await readFile(pending)).equals(Buffer.from(bytes))
  )
    throw new ObservationError("Pending implementation result changed.");
  // Exclusive link publishes precisely validated bytes, never overwrites a final report.
  await link(pending, final);
  // Do not leave a writable pending hardlink alias to the root-owned final report.
  await unlink(pending);
}
