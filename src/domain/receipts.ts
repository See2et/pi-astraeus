import type { Job } from "./workflow.ts";
export interface NativeReceipt {
  session?: { model?: { provider: string; id: string }; thinkingLevel?: string };
  invocation?: { modelId?: string; thinking?: string };
}
export function parseReport(text: string): string {
  const match = /^\s*```(?:json)?\s*\n([\s\S]*?)\n```\s*$/.exec(text);
  const bytes = match ? match[1] : text;
  JSON.parse(bytes); // reject prose, fragments and multiple results; validator rejects duplicate keys
  return bytes;
}
export function assertReceipt(job: Pick<Job, "requested" | "agent_id">, record: NativeReceipt) {
  const model = record.session?.model;
  const effort = record.session?.thinkingLevel;
  const observed = {
    model: model ? `${model.provider}/${model.id}` : (record.invocation?.modelId ?? null),
    effort: effort ?? record.invocation?.thinking ?? null,
    sandbox: null,
  };
  for (const key of ["model", "effort"] as const) {
    if (observed[key] !== null && observed[key] !== job.requested[key])
      throw new Error(
        `Host-observed ${key} differs from requested ${job.requested[key]}: ${observed[key]}`,
      );
  }
  return {
    requested: job.requested,
    observed,
    source: `Tintinweb manager record ${job.agent_id}; live child session when available, otherwise invocation metadata; no OS sandbox attestation`,
  };
}
