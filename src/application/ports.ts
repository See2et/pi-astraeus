import type { Command, ModelIdentity, Task, Thinking, Job, Baseline } from "../domain/workflow.ts";

// Versioned Pi/Tintinweb and Python JSON envelopes are validated by their
// adapters. Keep their open payloads at the integration boundary.
export type Envelope = any;
export interface EventBus {
  on(channel: string, callback: (reply: Envelope) => void): () => void;
  emit(channel: string, payload: Envelope): void;
}
export interface Host {
  events: EventBus;
  appendEntry(type: string, data: unknown): void;
  notify?(notice: unknown, ctx: Context): void;
  agentDir(): string;
  parseFrontmatter(text: string): { frontmatter: Envelope };
  supportedThinking(model: Envelope): readonly Thinking[];
  manager(): { getRecord(id: string | null): Envelope } | undefined;
}
export interface Context {
  cwd: string;
  hasUI: boolean;
  isIdle(): boolean;
  ui: { setStatus(key: string, value: string): void };
  sessionManager: {
    getSessionId(): string | undefined;
    getLeafId(): string | null;
    getBranch(): Envelope[];
  };
  modelRegistry: { getAvailable(): (ModelIdentity & Record<string, Envelope>)[] };
  executeTool?(name: string, params: Envelope, options: { signal?: AbortSignal }): Promise<unknown>;
}
export interface MonitorSession {
  ctx: Context;
  id: string | undefined;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout> | null;
  cursor: number;
  failures: number;
  treePause?: { anchor: string | null };
}
export interface FileStat {
  isFile(): boolean;
  isSymbolicLink(): boolean;
}
export interface Runtime {
  randomUUID(): string;
  hash(bytes: string | Uint8Array): string;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(
    path: string,
    bytes: string | Uint8Array,
    options: { mode?: number; flag?: string },
  ): Promise<unknown>;
  mkdir(path: string, options: { recursive: boolean; mode: number }): Promise<unknown>;
  realpath(path: string): Promise<string>;
  readdir(path: string): Promise<string[]>;
  lstat(path: string): Promise<FileStat>;
  existsSync(path: string): boolean;
  realpathSync(path: string): string;
  dirname(path: string): string;
  join(...paths: string[]): string;
  resolve(...paths: string[]): string;
  normalize(path: string): string;
  rpc(events: EventBus, method: string, payload: Envelope, timeout?: number): Promise<Envelope>;
  run(command: string, args: string[], cwd: string, signal?: AbortSignal): Promise<string>;
  snapshot(cwd: string): Promise<Baseline>;
  publish(pending: string, final: string, bytes: string): Promise<void>;
  originalRequest(task: Task, job: Job): Promise<{ path: string; sha256: string }>;
}
export interface ClaudePort {
  observe(job: Job, cwd: string, signal?: AbortSignal): Promise<Envelope>;
  stop(job: Job, cwd: string, signal?: AbortSignal): Promise<Envelope>;
  start(
    job: Job,
    cwd: string,
    prompt: string,
    checks: string[],
    signal?: AbortSignal,
  ): Promise<void>;
  resume(job: Job, cwd: string, prompt: string, signal?: AbortSignal): Promise<void>;
  audit(job: Job): Promise<void>;
}
export interface WorkflowOptions {
  root: string;
  python: string;
  claude: ClaudePort;
  pollInterval?: number;
  maxBackoff?: number;
}
export type Execute = (params: Command, ctx: Context, signal?: AbortSignal) => Promise<Envelope>;
