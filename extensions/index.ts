import { Type } from 'typebox';
import { getAgentDir, parseFrontmatter, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import { Workflow, ROOT, ENTRY } from './core.mjs';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';

const ops = ['start', 'status', 'delegate', 'collect', 'resume', 'stop', 'accept', 'invalidate'] as const;
const parameters = Type.Object({
  op: Type.Union(ops.map(op => Type.Literal(op))),
  task_id: Type.Optional(Type.String()),
  requirements: Type.Optional(Type.String()), acceptance: Type.Optional(Type.String()),
  constraints: Type.Optional(Type.String()), consequential: Type.Optional(Type.Boolean()),
  role: Type.Optional(Type.Union(['worker', 'reviewer', 'adjudicator'].map(x => Type.Literal(x)))),
  model: Type.Optional(Type.String({description:'Exact authorized provider/model ID; no fuzzy matching or fallback'})),
  thinking: Type.Optional(Type.Union(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map(x => Type.Literal(x)))),
  prompt: Type.Optional(Type.String()), owned_paths: Type.Optional(Type.Array(Type.String())),
  run_id: Type.Optional(Type.String()),
});
export default function (pi: ExtensionAPI) {
  const workflow = new Workflow({
    events:pi.events, appendEntry:(type:string, data:unknown) => pi.appendEntry(type, data),
    agentDir:getAgentDir, parseFrontmatter,
    supportedThinking:getSupportedThinkingLevels,
    manager:() => (globalThis as any)[Symbol.for('pi-subagents:manager')],
  });
  const internalResume = new Map<string, string>();
  pi.registerTool({
    name:'astraeus_workflow', label:'Astraeus workflow', exposure:'model-only',
    description:`Manage evidence-bound Astraeus work. Trivial work stays solo. For consequential work, start with requirements/acceptance/constraints, delegate only useful bounded work with exact model+thinking, collect results, use fresh reviewer then fresh adjudicator only after complete changes_required, resume the original worker for adopted fixes, and accept after evidence and current-target checks. Status does not infer success. Role policies: ${join(ROOT, 'skills')}.`,
    parameters,
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      if (params.op === 'resume' && params.run_id && params.task_id) {
        const task = (workflow.tasks as any)[params.task_id] as any;
        const job = task?.jobs.find((j:any) => j.run_id === params.run_id);
        if (job) internalResume.set(toolCallId, job.agent_id);
      }
      try {
        const result = await workflow.execute(params, ctx, signal);
        return {content:[{type:'text',text:JSON.stringify(result, null, 2)}],details:result};
      } finally { internalResume.delete(toolCallId); }
    },
  });
  pi.registerCommand('astraeus', {
    description:'Astraeus status and capability diagnostics (no inference)',
    async handler(args, ctx) {
      try {
        const policy = await workflow.policy(ctx);
        const tasks = await workflow.execute({op:'status', task_id:args.trim() || undefined}, ctx);
        const available = ctx.modelRegistry.getAvailable().map(m => `${m.provider}/${m.id}`);
        const summary = JSON.stringify({policy, available_models:available, tasks, tintinweb_available:!!workflow.manager(), assurance_limit:'Pi does not attest an OS read-only sandbox; strict review is blocked.'}, null, 2);
        if (ctx.hasUI) ctx.ui.notify(summary, 'info');
      } catch (error) { if (ctx.hasUI) ctx.ui.notify(String(error), 'error'); else throw error; }
    },
  });
  pi.on('session_start', (_event, ctx) => workflow.restore(ctx));
  pi.on('session_tree', (_event, ctx) => workflow.restore(ctx));
  pi.on('before_agent_start', async (_event, ctx) => {
    const state = await workflow.execute({op:'status'}, ctx);
    return { message: {
      customType:'pi-astraeus:guidance', display:false,
      content:`Apply ${join(ROOT, 'skills/pi-astraeus-orchestrate/SKILL.md')} to authorized project work. Simple tasks stay solo. Root owns scope and final acceptance. Use astraeus_workflow for managed consequential work, including when root implements directly (delegate is optional). Preserve project/user constraints and native Pi authentication. Never claim strict sandbox assurance. Current workflow state: ${JSON.stringify(state)}. Read-only role instructions are not OS isolation.`,
    }};
  });
  pi.on('tool_call', (event, ctx) => {
    const tasks = (Object.values(workflow.tasks) as any[]).filter(task => task.cwd === realpathSync(ctx.cwd));
    const managed = tasks.some(t => !t.accepted);
    const internal = event.parentToolCallId && internalResume.get(event.parentToolCallId) === (event.input as any).resume;
    if (managed && ['Agent','SubagentWorkflow'].includes(event.toolName) && !internal) return {block:true,reason:'Use astraeus_workflow for tracked delegation and fresh review; native Agent resumption is routed internally.'};
    const frozen = tasks.some(t => t.jobs.some((j:any) => j.role !== 'worker' && ['running','queued'].includes(workflow.manager()?.getRecord(j.agent_id)?.status ?? j.status)));
    if (frozen && ['edit','write','bash','powershell'].includes(event.toolName)) return {block:true,reason:'Review target is frozen. Collect or stop the reviewer before changing files or running shell commands.'};
  });
  pi.on('agent_before_settle', (_event, ctx) => {
    const pending = (Object.values(workflow.tasks) as any[]).filter(t => !t.accepted);
    if (pending.length && ctx.hasUI) ctx.ui.setStatus('pi-astraeus', pending.map(t => `${t.task_id}: ${t.phase} (incomplete)`).join(' · '));
  });
}
