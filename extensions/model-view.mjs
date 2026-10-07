// One explicitly allowlisted boundary for model/UI data. Never walk arbitrary
// objects: cli.baseline (including ignored files and index) is internal state.
export const MODEL_VIEW_MAX_BYTES = 8 * 1024;
const DATA_BUDGET = 7000; // Reserve space for omission/recovery diagnostics.
const STRING_LIMIT = 1024;
const ARRAY_LIMIT = 12;
const scalar = 'scalar';
const strings = [scalar];
const evidence = {kind:scalar, path:scalar, sha256:scalar};
const settings = {model:scalar, effort:scalar, sandbox:scalar};
const observed = {id:scalar, session_id:scalar, cwd:scalar, state:scalar, status:scalar, pid:scalar, ...settings};
const finding = {location:scalar, claim:scalar, evidence:scalar};
const decision = {ref:scalar, action:scalar, basis:scalar, evidence:scalar, rationale:scalar};
const result = {
  schema_version:scalar, kind:scalar, task_id:scalar, run_id:scalar, target_id:scalar, status:scalar, verdict:scalar,
  review_sha256:scalar, summary:scalar, unresolved:strings, remaining:strings,
  violations:[finding], bugs:[finding], decisions:[decision],
  checks:[{command:scalar, outcome:scalar, evidence:scalar}], changed_files:strings,
  checked_scope:strings, evidence:strings, suggestions:strings,
};
const cli = {
  frozen:scalar, copy_frozen:scalar, short_id:scalar, session_id:scalar, notified_status:scalar,
  directory:scalar, pending:scalar, report_directory:scalar, dispatch_target:scalar,
  generated_reconciliation:{path:scalar, sha256:scalar}, ownership_failure:{error:scalar, provenance:scalar},
  observed, unexpected_copy:observed, evidence:[evidence], checks:strings,
};
const job = {
  task_id:scalar, run_id:scalar, agent_id:scalar, role:scalar, transport:scalar, status:scalar, valid:scalar, collected:scalar,
  target_id:scalar, review_run:scalar, artifact:scalar, result_hash:scalar, receipt_path:scalar, receipt_hash:scalar,
  requested:settings, diagnostic:scalar, error:scalar, note:scalar, cli, result, summary:scalar, owned_paths:strings,
};
const task = {
  task_id:scalar, cwd:scalar, phase:scalar, accepted:scalar, consequential:scalar, target_id:scalar, accepted_target:scalar,
  note:scalar, jobs:[job], requirements:scalar, acceptance:scalar, constraints:scalar,
  design_authorization:{scope:scalar, source:scalar, request:scalar},
};
const diagnostics = {
  tasks:[task], policy:{schema_version:scalar, allowed_models:strings, require_review_globs:strings, assurance:scalar},
  available_models:strings, tintinweb_available:scalar, assurance_limit:scalar, diagnostic:scalar, error:scalar,
};
const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;

export function modelView(value) {
  let remaining = DATA_BUDGET;
  const omitted = {fields:0, items:0, string_characters:0};
  // Reprojection of our own session results must not erase earlier omissions.
  for (const key of Object.keys(omitted)) omitted[key] = count(value?.projection?.omitted?.[key]);
  const spend = n => { if (n > remaining) return false; remaining -= n; return true; };
  function project(input, schema) {
    if (schema === scalar) {
      if (!(input === null || ['string','boolean','number'].includes(typeof input))) return undefined;
      let output = input;
      if (typeof input === 'string' && input.length > STRING_LIMIT) {
        omitted.string_characters += input.length - STRING_LIMIT;
        output = input.slice(0, STRING_LIMIT) + `… [${input.length - STRING_LIMIT} characters omitted]`;
      }
      return spend(bytes(output)) ? output : undefined;
    }
    if (Array.isArray(schema)) {
      if (!Array.isArray(input) || !spend(2)) return undefined;
      const output = [];
      // Current runs must remain reachable even after a long workflow history.
      // Findings/evidence retain original order (refs such as bugs/0 stay useful).
      const selected = value?.projection?.version !== 1 && (schema === task.jobs || schema === diagnostics.tasks)
        ? input.slice(-ARRAY_LIMIT).reverse() : input.slice(0, ARRAY_LIMIT);
      for (const item of selected) {
        if (remaining < 128) break;
        spend(1);
        const projected = project(item, schema[0]);
        if (projected !== undefined) output.push(projected);
      }
      omitted.items += input.length - output.length;
      return output;
    }
    if (!object(input) || !spend(2)) return undefined;
    const output = {};
    for (const [key, childSchema] of Object.entries(schema)) {
      if (input[key] === undefined) continue;
      if (!spend(bytes(key) + 2)) { omitted.fields++; continue; }
      const child = project(input[key], childSchema);
      if (child === undefined) omitted.fields++;
      else output[key] = child;
    }
    return output;
  }
  const tasks = Array.isArray(value) ? value : Array.isArray(value?.tasks) ? value.tasks : null;
  const totals = {tasks:tasks?.length ?? (value?.task_id && !value?.run_id ? 1 : 0), jobs:0, attention_jobs:0};
  const countJobs = jobs => {
    for (const j of jobs) {
      totals.jobs++;
      if (j && (j.valid !== true || j.collected !== true || j.error || j.result?.unresolved?.length || j.result?.remaining?.length || ['changes_required','inconclusive'].includes(j.result?.verdict))) totals.attention_jobs++;
    }
  };
  if (tasks) {
    for (const t of tasks) if (Array.isArray(t?.jobs)) countJobs(t.jobs);
  }
  if (!tasks && Array.isArray(value?.jobs)) countJobs(value.jobs);
  if (!tasks && value?.run_id) countJobs([value]);
  const schema = tasks ? diagnostics : value?.run_id ? job : value?.task_id ? task : diagnostics;
  const output = project(Array.isArray(value) ? {tasks:value} : value, schema) ?? {};
  output.projection = {
    version:1, internal_state_excluded:true, omitted,
    totals:object(value?.projection?.totals) ? {
      tasks:count(value.projection.totals.tasks), jobs:count(value.projection.totals.jobs), attention_jobs:count(value.projection.totals.attention_jobs),
    } : totals,
    recovery:'Bounded orchestration view, not full evidence or acceptance. Tasks/jobs show newest first, at most 12 each. Use status(task_id) to narrow omitted tasks; read referenced result/receipt/lifecycle artifacts in bounded slices. Full baseline remains in non-context custom state and designer request.json. Omissions never imply success.',
  };
  // Defense in depth for JSON escaping/multibyte input and future schema additions.
  if (bytes(output) > MODEL_VIEW_MAX_BYTES) return {
    diagnostic:'Workflow view exceeded its bound; use status(task_id) and referenced artifacts. No success inferred.',
    projection:{version:1, internal_state_excluded:true, omitted, totals},
  };
  return output;
}

/** @returns {{content: {type: 'text', text: string}[], details: object}} */
export function modelToolResult(value) {
  const details = modelView(value);
  return {content:[{type:'text', text:JSON.stringify(details)}], details};
}

// The context hook replaces only Astraeus payloads, never signed assistant
// reasoning/tool calls, unrelated tools, or raw session entries.
export function sanitizeContext(messages, guidance) {
  let guidanceSeen = false;
  return messages.flatMap(message => {
    if (message.role === 'custom' && message.customType === 'pi-astraeus:guidance') {
      if (guidanceSeen) return [];
      guidanceSeen = true;
      return [{...message, content:guidance, details:undefined}];
    }
    if (message.role !== 'toolResult' || message.toolName !== 'astraeus_workflow') return [message];
    let value = message.details;
    if (!object(value) && !Array.isArray(value)) {
      try {
        // Avoid concatenating arbitrary blocks. Normal legacy results have exactly
        // one JSON text block. Oversized malformed JSON is never echoed back.
        if (message.content?.length !== 1 || message.content[0].type !== 'text') throw new Error('not a legacy JSON result');
        if (message.content[0].text.length > 16 * 1024 * 1024) throw new Error('legacy JSON exceeds safe recovery parsing limit');
        value = JSON.parse(message.content[0].text);
        if (!object(value) && !Array.isArray(value)) throw new Error('not a workflow object');
      } catch {
        value = {diagnostic:'Legacy Astraeus result could not be recovered as workflow JSON; original payload withheld. Use status(task_id) and saved artifacts; no success inferred.'};
      }
    }
    return [{...message, ...modelToolResult(value), structuredContent:undefined}];
  });
}

// Branch summarization also bypasses the context event. Keep entry IDs and raw
// custom metadata intact, replacing only the conversation payload in preparation.
export function sanitizeSummaryEntries(entries, guidance) {
  let guidanceSeen = false;
  return entries.flatMap(entry => {
    if (entry.type === 'message') {
      const [message] = sanitizeContext([entry.message], guidance);
      return [message === entry.message ? entry : {...entry, message}];
    }
    if (entry.type === 'custom_message' && entry.customType === 'pi-astraeus:guidance') {
      if (guidanceSeen) return [];
      guidanceSeen = true;
      return [{...entry, content:guidance, details:undefined}];
    }
    return [entry];
  });
}
