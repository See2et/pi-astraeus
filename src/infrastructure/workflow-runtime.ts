import { randomUUID, createHash } from "node:crypto";
import { readFile, writeFile, mkdir, realpath, readdir, lstat } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve, posix } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Workflow as ApplicationWorkflow } from "../application/workflow.ts";
import type { Host, Runtime, EventBus, Envelope } from "../application/ports.ts";
import { ClaudeBackground, snapshot, publish } from "./claude.ts";
import { originalRequest } from "./generated-output.ts";
import { selectModel } from "../domain/workflow.ts";
import type { ModelIdentity, Policy } from "../domain/workflow.ts";
export * from "../domain/workflow.ts";
export { parseReport, assertReceipt } from "../domain/receipts.ts";
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const hash = (text: string | Uint8Array): string =>
  "sha256:" + createHash("sha256").update(text).digest("hex");
export function exactModel<M extends ModelIdentity>(
  registry: { getAvailable(): M[] },
  value: unknown,
  policy: Policy,
): M {
  return selectModel(registry.getAvailable(), value, policy);
}
export function rpc(
  events: EventBus,
  method: string,
  payload: Envelope,
  timeout = 10000,
): Promise<Envelope> {
  const requestId = randomUUID();
  const channel = `subagents:rpc:${method}`;
  return new Promise((resolveReply, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const off = events.on(`${channel}:reply:${requestId}`, (reply) => {
      clearTimeout(timer);
      off();
      if (reply?.success) resolveReply(reply.data);
      else reject(new Error(reply?.error ?? "Malformed Tintinweb RPC reply"));
    });
    timer = setTimeout(() => {
      off();
      reject(
        new Error(
          `Tintinweb ${method} unavailable or timed out; reconcile status before retrying.`,
        ),
      );
    }, timeout);
    events.emit(channel, { ...payload, requestId });
  });
}
export function run(
  command: string,
  args: string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((res, rej) => {
    const child = spawn(command, args, { cwd, signal, stdio: ["ignore", "pipe", "pipe"] });
    let out = "",
      err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("error", rej);
    child.on("close", (code) =>
      code === 0
        ? res(out)
        : rej(new Error(err.trim() || out.trim() || `${command} exited ${code}`)),
    );
  });
}

const runtime: Runtime = {
  randomUUID,
  hash,
  readFile,
  writeFile,
  mkdir,
  realpath,
  readdir,
  lstat,
  existsSync,
  realpathSync,
  dirname,
  join,
  resolve,
  normalize: posix.normalize,
  rpc,
  run,
  snapshot,
  publish,
  originalRequest,
};
export class Workflow extends ApplicationWorkflow {
  constructor(
    host: Host,
    options: Partial<ConstructorParameters<typeof ApplicationWorkflow>[1]> = {},
  ) {
    super(
      host,
      {
        root: ROOT,
        python: process.env.PI_ASTRAEUS_PYTHON || "python3",
        claude: new ClaudeBackground(),
        ...options,
      },
      runtime,
    );
  }
}
