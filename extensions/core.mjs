import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, realpath, readdir, lstat } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, posix } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { ClaudeBackground, observedStatus, CLAUDE_TRANSPORT, CLI_EFFORTS, validatePaths, validateChecks, snapshot, publish } from './claude.mjs';
import { originalRequest } from './generated-output.mjs';
export const isCli = job => job.transport === CLAUDE_TRANSPORT;
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const ENTRY = 'pi-astraeus:state-v1';
export const ROLES = ['worker', 'designer', 'reviewer', 'adjudicator'];
export const isWriter = role => role === 'worker' || role === 'designer';
export const DESIGN_MODEL = 'anthropic/claude-opus-5-5';
export const DESIGN_SCOPES = ['design-direction', 'ui-implementation', 'design-direction-and-ui-implementation'];
export function designAuthorization(p) {
  if (!p.design_request?.trim() || !DESIGN_SCOPES.includes(p.design_scope)) throw new Error('Explicit design_request original user quote and a bounded design_scope are required.');
  return { request:p.design_request.trim(), scope:p.design_scope, source:'root-reported user request; not authenticated user consent' };
}
export function designModel(registry, value) {
  if (value !== DESIGN_MODEL) throw new Error(`Designer requires exact ${DESIGN_MODEL}; no lower-family or provider fallback.`);
  // Logical pin: the installed CLI owns authentication and capability checks.
  return {provider:'anthropic', id:'claude-opus-5-5'};
}
const ACTIVE = new Set(['running', 'queued']);
export const hash = text => 'sha256:' + createHash('sha256').update(text).digest('hex');
export function parseReport(text) {
  const match = /^\s*```(?:json)?\s*\n([\s\S]*?)\n```\s*$/.exec(text);
  const bytes = match ? match[1] : text;
  JSON.parse(bytes); // reject prose, fragments and multiple results; validator rejects duplicate keys
  return bytes;
}
export function exactModel(registry, value, policy) {
  if (typeof value !== 'string' || !value.includes('/')) throw new Error('Use an exact provider/model ID; fuzzy model selection is disabled.');
  const model = registry.getAvailable().find(m => `${m.provider}/${m.id}` === value);
  if (!model) throw new Error(`Unavailable authorized model: ${value}. No fallback was launched.`);
  if (model.provider === 'anthropic') throw new Error('Anthropic is reserved for explicitly authorized designer scope, never general worker/reviewer/adjudicator routing.');
  if (!policy.allowed_models.some(id => id === value || id === model.id)) throw new Error(`Model prohibited by astraeus.toml: ${value}`);
  return model;
}
export function assertReceipt(job, record) {
  const model = record.session?.model;
  const effort = record.session?.thinkingLevel;
  const observed = {
    model: model ? `${model.provider}/${model.id}` : record.invocation?.modelId ?? null,
    effort: effort ?? record.invocation?.thinking ?? null,
    sandbox: null,
  };
  for (const key of ['model', 'effort']) {
    if (observed[key] !== null && observed[key] !== job.requested[key]) throw new Error(`Host-observed ${key} differs from requested ${job.requested[key]}: ${observed[key]}`);
  }
  return { requested: job.requested, observed, source: `Tintinweb manager record ${job.agent_id}; live child session when available, otherwise invocation metadata; no OS sandbox attestation` };
}
export function overlapping(a, b) {
  return a.some(x => b.some(y => x === '.' || y === '.' || x === y || x.startsWith(y + '/') || y.startsWith(x + '/')));
}
export function rpc(events, method, payload, timeout = 10000) {
  const requestId = randomUUID();
  const channel = `subagents:rpc:${method}`;
  return new Promise((resolveReply, reject) => {
    let timer;
    const off = events.on(`${channel}:reply:${requestId}`, reply => {
      clearTimeout(timer); off();
      reply?.success ? resolveReply(reply.data) : reject(new Error(reply?.error ?? 'Malformed Tintinweb RPC reply'));
    });
    timer = setTimeout(() => { off(); reject(new Error(`Tintinweb ${method} unavailable or timed out; reconcile status before retrying.`)); }, timeout);
    events.emit(channel, { ...payload, requestId });
  });
}
export function run(command, args, cwd, signal) {
  return new Promise((res, rej) => {
    const child = spawn(command, args, { cwd, signal, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', c => out += c);
    child.stderr.on('data', c => err += c);
    child.on('error', rej);
    child.on('close', code => code === 0 ? res(out) : rej(new Error(err.trim() || out.trim() || `${command} exited ${code}`)));
  });
}
export class Workflow {
  constructor(host, { root = ROOT, python = process.env.PI_ASTRAEUS_PYTHON || 'python3', claude = new ClaudeBackground(), pollInterval = 3000, maxBackoff = 30000 } = {}) {
    this.host = host; this.root = root; this.python = python; this.claude = claude; this.tasks = {}; this.queue = Promise.resolve();
    this.pollInterval = pollInterval; this.maxBackoff = maxBackoff; this.session = null;
  }
  dispose() {
    const session = this.session;
    if (!session) return;
    this.session = null; clearTimeout(session.timer); session.controller.abort();
  }
  current(session) {
    if (session !== this.session || session?.controller.signal.aborted) return false;
    // Pi context accessors throw when their owning runtime/session is retired.
    try {
      if (session.ctx.sessionManager.getSessionId() !== session.id) return false;
      const anchor = session.treePause?.anchor;
      return anchor == null || session.ctx.sessionManager.getBranch().some(entry => entry.id === anchor);
    } catch { return false; }
  }
  ensureMonitoring(ctx) {
    if (!this.session || !this.current(this.session)) this.startMonitoring(ctx);
  }
  startMonitoring(ctx) {
    this.dispose();
    const session = {ctx, id:ctx.sessionManager.getSessionId(), controller:new AbortController(), timer:null, cursor:0, failures:0};
    this.session = session; this.schedule(session, 0);
  }
  beforeTree(ctx) {
    // Retire in-flight reads, but keep a session-owned timer: Pi emits no
    // session_tree on cancellation, summary abort, or summary error.
    this.startMonitoring(ctx);
    this.session.treePause = {anchor:ctx.sessionManager.getLeafId()};
  }
  latestCli(tasks = Object.values(this.tasks)) {
    return [...new Map(tasks.flatMap(task => task.jobs.filter(isCli).map(job => [job.agent_id || job.run_id, {task, job}]))).values()];
  }
  lifecycleSignature(job) {
    return JSON.stringify({status:job.status, valid:job.valid, error:job.error, frozen:job.cli.frozen,
      copy_frozen:job.cli.copy_frozen, observed:job.cli.observed, notified_status:job.cli.notified_status});
  }
  schedule(session, delay = this.pollInterval) {
    if (!this.current(session) || !this.host.notify) return;
    clearTimeout(session.timer);
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
        const owners = this.latestCli().filter(({job}) => !job.collected);
        if (!owners.length) return;
        const {task, job} = owners[session.cursor++ % owners.length];
        // One owner per tick bounds occupation of the operation queue.
        const before = this.lifecycleSignature(job);
        const ok = await this.refreshCli(task, job, session.ctx, session);
        if (!this.current(session)) return;
        session.failures = ok ? 0 : Math.min(session.failures + 1, 5);
        // Stable polls must not append full baselines to the session every tick.
        if (before !== this.lifecycleSignature(job)) this.save(session.ctx);
      });
      this.queue = next.catch(() => {});
      next.catch(() => {}).finally(() => this.schedule(session, Math.min(this.maxBackoff, this.pollInterval * 2 ** session.failures)));
    }, delay);
    session.timer.unref?.();
  }
  notice(task, job, ctx, session) {
    if (!session || !this.current(session) || session.treePause || !this.host.notify || job.cli.notified_status === job.status) return;
    // Running clears the transition baseline but does not wake an idle parent.
    if (['work-ended', 'blocked', 'stopped', 'unknown'].includes(job.status)) {
      const meaning = job.status === 'work-ended' ? 'Observed work ended; ready to attempt collect, NOT implementation success.' : 'Needs attention; NOT successful completion.';
      this.host.notify({task_id:task.task_id, run_id:job.run_id, status:job.status,
        diagnostic:meaning, error:job.error?.slice(0, 1024)}, ctx);
    }
    job.cli.notified_status = job.status; return true;
  }
  assertOperationActive() {
    if (this.operationSession && !this.current(this.operationSession)) throw new Error('Operation belongs to retired session.');
  }
  settlePreparationFailure(job) {
    // prepareCli replaces this exact initial shape before start is reachable.
    // A missing UUID alone is NOT proof: prepared/attempted/unknown fields fail closed.
    const cli = job.cli;
    const settled = job.status === 'prelaunch-failed' && cli?.frozen === true &&
      typeof cli.preparation_failure === 'string' && cli.preparation_failure === job.error;
    if (!isCli(job) || job.role !== 'designer' || job.agent_id !== null || job.valid !== false || job.result || job.artifact ||
        !['unknown','error','unavailable','prelaunch-failed'].includes(job.status) || typeof job.error !== 'string' || !job.error ||
        !cli || (!settled && (cli.frozen !== false || Object.hasOwn(cli,'preparation_failure'))) || !Array.isArray(cli.evidence) || cli.evidence.length ||
        Object.keys(cli).some(key => !['frozen','evidence','notified_status','preparation_failure'].includes(key))) return false;
    cli.preparation_failure ??= job.error;
    cli.frozen = true;
    job.status = 'prelaunch-failed'; job.collected = true; job.valid = false;
    // This is settlement of an unsuccessful attempt, never an implementation result.
    return true;
  }
  async cliOperation(method, job, ...args) {
    const session = this.operationSession;
    this.assertOperationActive();
    if (['observe','stop'].includes(method) && this.settlePreparationFailure(job)) return {prelaunch_failed:true};
    const staged = structuredClone(job);
    let result, error;
    try { result = await this.claude[method](staged, ...args, ...(method === 'observe' ? [session?.controller.signal] : [])); }
    catch (caught) { error = caught; }
    this.assertOperationActive();
    Object.assign(job, staged);
    if (method === 'observe') {
      job.status = error ? 'unknown' : observedStatus(job.cli.observed);
      if (error) { job.cli.observation_failure ??= String(error).slice(0, 1024); job.cli.frozen = false; job.valid = false; job.error = String(error).slice(0, 1024); }
    }
    if (error) throw error;
    return result;
  }
  async refreshCli(task, job, ctx, session = this.session) {
    if (session && !this.current(session)) return false;
    if (this.settlePreparationFailure(job)) return true;
    const staged = structuredClone(job);
    let error;
    try { await this.claude.observe(staged, task.cwd, session?.controller.signal); }
    catch (caught) { error = caught; }
    // Never mutate a retired job reference, including from an ignored abort.
    if (session && !this.current(session)) return false;
    job.cli = staged.cli;
    if (!job.cli.ownership_failure && /^Error: Out-of-ownership baseline delta: /.test(job.error || '')) {
      job.cli.ownership_failure = {error:job.error, provenance:'Retained failed collection state; pre-recovery report/source hashes were not captured by the older collector.'};
    }
    if (error) {
      job.cli.observation_failure ??= String(error).slice(0, 1024);
      job.status = 'unknown'; job.cli.frozen = false; job.valid = false; job.error = String(error).slice(0, 1024);
    } else {
      job.status = observedStatus(job.cli.observed); delete job.error;
    }
    this.notice(task, job, ctx, session); return !error;
  }
  bridge(args, ctx) { return run(this.python, [join(this.root, 'scripts/astraeus.py'), ...args], ctx.cwd); }
  async policy(ctx) { return JSON.parse(await this.bridge(['policy', '--repo', ctx.cwd], ctx)); }
  async target(ctx) {
    return (await this.bridge(['target', '--repo', ctx.cwd], ctx)).trim();
  }
  manager() { return this.host.manager(); }
  restore(ctx) {
    this.dispose();
    this.tasks = {};
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === 'custom' && entry.customType === ENTRY && entry.data?.version === 1) this.tasks = structuredClone(entry.data.tasks);
    }
    for (const task of Object.values(this.tasks)) {
      for (const job of task.jobs) if (!isCli(job) && ACTIVE.has(job.status) && !this.manager()?.getRecord(job.agent_id)) job.status = 'unavailable';
    }
    this.show(ctx);
    if (this.host.notify) this.startMonitoring(ctx);
  }
  save(ctx) {
    this.assertOperationActive();
    this.host.appendEntry(ENTRY, { version: 1, tasks: structuredClone(this.tasks) }); this.show(ctx);
  }
  show(ctx) {
    if (ctx.hasUI) ctx.ui.setStatus('pi-astraeus', Object.values(this.tasks).map(t => `${t.task_id}: ${t.phase}`).join(' · ') || 'Astraeus ready');
  }
  task(id, ctx) {
    const task = this.tasks[id];
    if (!task) throw new Error(`Unknown task: ${id}`);
    if (task.cwd !== realpathSync(ctx.cwd)) throw new Error('This task belongs to another working directory.');
    return task;
  }
  activeJobs(cwd) {
    return Object.values(this.tasks).filter(task => task.cwd === cwd).flatMap(task => {
      const latest = new Map(task.jobs.map(job => [job.agent_id || job.run_id, job]));
      return [...latest.values()].filter(job => isCli(job) ? !job.cli.frozen || (job.cli.unexpected_copy && !job.cli.copy_frozen) : ACTIVE.has(this.manager()?.getRecord(job.agent_id)?.status ?? job.status));
    });
  }
  async status(ctx, id) {
    const session = this.session;
    const tasks = id ? [this.task(id, ctx)] : Object.values(this.tasks);
    for (const {task, job} of this.latestCli(tasks)) {
      await this.refreshCli(task, job, ctx, session);
      if (session && !this.current(session)) throw new Error('Session retired during observation.');
    }
    for (const task of tasks) {
      for (const job of task.jobs.filter(j => !isCli(j))) {
        const record = this.manager()?.getRecord(job.agent_id);
        if (ACTIVE.has(job.status)) job.status = record?.status ?? 'unavailable';
      }
      if (task.target_id && task.cwd === realpathSync(ctx.cwd)) {
        const target = await this.target(ctx);
        if (session && !this.current(session)) throw new Error('Session retired during status.');
        if (target !== task.target_id) { task.phase = 'stale'; task.accepted = false; }
      }
    }
    this.save(ctx); return structuredClone(tasks);
  }
  execute(params, ctx, signal) {
    const session = this.session;
    const next = this.queue.then(async () => {
      if (session && !this.current(session)) throw new Error('Queued operation belongs to retired session.');
      this.operationSession = session;
      try { return await this.action(params, ctx, signal); }
      finally {
        try {
          if (session && this.current(session)) {
            let changed = false;
            for (const {task, job} of this.latestCli()) changed = this.notice(task, job, ctx, session) || changed;
            if (changed) this.save(ctx);
          }
        } finally { this.operationSession = null; }
      }
    });
    this.queue = next.catch(() => {}); return next;
  }
  async artifacts(task, ctx) {
    // Outside the source tree: receipts never invalidate a Git target or modify .gitignore.
    const session = ctx.sessionManager.getSessionId();
    if (!/^[\w-]+$/.test(session)) throw new Error('Invalid session ID');
    const path = join(this.host.agentDir(), 'astraeus', session, task.task_id);
    await mkdir(path, { recursive: true, mode: 0o700 }); return path;
  }
  async validate(job, task, ctx, accept = false) {
    if (job.result_hash !== hash(await readFile(job.artifact, 'utf8'))) throw new Error('Saved result bytes changed; run a fresh review.');
    if (job.receipt_hash !== hash(await readFile(job.receipt_path, 'utf8'))) throw new Error('Saved host receipt bytes changed.');
    const args = ['validate-result', job.artifact, '--kind', job.role === 'reviewer' ? 'review' : 'adjudication', '--task-id', task.task_id, '--target-id', task.target_id, '--assurance', 'reported'];
    if (job.receipt_path) args.push('--receipt', job.receipt_path);
    if (job.role === 'adjudicator') {
      const source = task.jobs.find(j => j.run_id === job.review_run);
      if (!source || source.result_hash !== hash(await readFile(source.artifact, 'utf8'))) throw new Error('Original review bytes changed; adjudication is stale.');
      args.push('--review-result', source.artifact);
      if (source.receipt_path) args.push('--review-receipt', source.receipt_path);
    }
    if (accept) args.push('--accept');
    return JSON.parse(await this.bridge(args, ctx)).result;
  }
  async roleCheck(role, ctx) {
    const name = `astraeus-${role}.md`;
    const bundled = await readFile(join(this.root, 'agents', name), 'utf8');
    // Match Tintinweb's supported discovery precedence; changed managed roles fail closed.
    const directories = [join(this.host.agentDir(), 'agents'), join(ctx.cwd, '.agents/agents'), join(ctx.cwd, '.pi/agents')];
    let found = false;
    for (const directory of directories) {
      if (!existsSync(directory)) continue;
      for (const file of await readdir(directory)) {
        if (!file.endsWith('.md')) continue;
        const path = join(directory, file);
        const contents = await readFile(path, 'utf8');
        const {frontmatter} = this.host.parseFrontmatter(contents);
        const declaredName = typeof frontmatter.name === 'string' ? frontmatter.name.trim() : '';
        const declared = declaredName || file.slice(0, -3);
        if (declared.toLowerCase() === `astraeus-${role}`) {
          if (contents !== bundled) throw new Error(`Role definition differs from bundled contract: ${path}`);
          found = true;
        }
      }
    }
    if (!found) throw new Error(`Missing ${name}. Install the bundled agent definitions (Nix Home Manager does this).`);
  }
  async action(p, ctx, signal) {
    if (p.op === 'status') return this.status(ctx, p.task_id);
    if (!p.task_id || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(p.task_id)) throw new Error('task_id must be a short path-safe identifier.');
    if (p.op === 'start') {
      if (this.tasks[p.task_id]) throw new Error('Task already exists; use status/resume rather than replacing history.');
      if (!p.requirements?.trim() || !p.acceptance?.trim()) throw new Error('start requires requirements and acceptance conditions.');
      await this.policy(ctx); await this.target(ctx);
      const design_authorization = p.design_request !== undefined || p.design_scope !== undefined ? designAuthorization(p) : null;
      const task = { design_authorization, task_id: p.task_id, cwd: await realpath(ctx.cwd), requirements: p.requirements, acceptance: p.acceptance, constraints: p.constraints || '', consequential: p.consequential !== false, phase: 'implementation', jobs: [], target_id: null, accepted: false };
      this.tasks[p.task_id] = task; this.save(ctx); return task;
    }
    const task = this.task(p.task_id, ctx);
    if (p.op === 'authorize_design') {
      if (task.design_authorization) throw new Error('Design authorization is already recorded for this task; do not replace its scope.');
      task.design_authorization = designAuthorization(p); this.save(ctx); return task;
    }
    if (p.op === 'invalidate') {
      task.phase = 'stale'; task.accepted = false; task.target_id = null; this.save(ctx); return task;
    }
    if (p.op === 'delegate') return this.delegate(task, p, ctx, signal);
    const job = task.jobs.find(j => j.run_id === p.run_id);
    if (['collect', 'stop', 'resume', 'reconcile_generated'].includes(p.op) && !job) throw new Error('Unknown run_id');
    if (p.op === 'reconcile_generated') return this.reconcileGenerated(task, job, p, ctx);
    if (p.op === 'collect') return this.collect(task, job, ctx);
    if (p.op === 'stop') {
      if (this.settlePreparationFailure(job)) { this.save(ctx); return job; }
      try {
        if (isCli(job)) await this.cliOperation('stop', job, task.cwd);
        else await rpc(this.host.events, 'stop', { agentId: job.agent_id });
        job.status = isCli(job) ? observedStatus(job.cli.observed) : 'stopped'; job.collected = false; job.valid = false; return job;
      } finally { this.save(ctx); }
    }
    if (p.op === 'resume') return this.resume(task, job, p, ctx, signal);
    if (p.op === 'accept') {
      // Re-observe external writers: a missing native manager is not freeze evidence.
      const cliOwners = new Map(Object.values(this.tasks).filter(t => t.cwd === task.cwd).flatMap(t => t.jobs.filter(isCli)).map(j => [j.agent_id || j.run_id,j]));
      for (const writer of cliOwners.values()) {
        try { await this.cliOperation('observe', writer, task.cwd); }
        catch (error) { task.accepted = false; task.phase = 'needs-evidence'; this.save(ctx); throw error; }
        if (!writer.cli.frozen || (writer.cli.unexpected_copy && !writer.cli.copy_frozen)) throw new Error('Freeze exact Claude writer before acceptance.');
        if (writer.valid && writer.cli.unexpected_copy) throw new Error('Unexpected Claude copy cannot be accepted as successful work.');
        if (writer.valid) {
          try {
            if (writer.result_hash !== hash(await readFile(writer.artifact, 'utf8'))) throw new Error('Saved implementation report bytes changed.');
            await this.claude.audit(writer);
            const ownerTask = Object.values(this.tasks).find(t=>t.jobs.includes(writer));
            const before = await snapshot(task.cwd);
            await originalRequest(ownerTask, writer);
            const {bytes,result} = await this.readCliReport(ownerTask, writer, ctx);
            this.requireCliComplete(writer, result);
            await this.cliOperation('observe', writer, task.cwd);
            if (!writer.cli.frozen || JSON.stringify(await snapshot(task.cwd)) !== JSON.stringify(before) || hash(await readFile(writer.artifact)) !== hash(bytes)) throw new Error('Claude writer/source/report changed during final audit.');
          } catch (error) {
            writer.valid = false; writer.error = String(error); task.accepted = false; task.phase = 'needs-evidence';
            this.save(ctx); throw error;
          }
        }
      }
      if (this.activeJobs(task.cwd).length || task.jobs.some(j => !j.collected || (!isCli(j) && ACTIVE.has(this.manager()?.getRecord(j.agent_id)?.status ?? j.status)))) throw new Error('Collect every managed result before acceptance.');
      const latestWorkers = new Map(task.jobs.filter(j => isWriter(j.role)).map(j => [j.agent_id, j]));
      if ([...latestWorkers.values()].some(j => !j.valid)) throw new Error('Implementation owner has unresolved failed or incomplete work.');
      const matches = JSON.parse(await this.bridge(['matches-review', '--repo', ctx.cwd], ctx));
      const existingReview = [...task.jobs].reverse().find(j => j.role === 'reviewer');
      const needsReview = task.consequential || matches.requires_review || !!existingReview;
      if (needsReview) {
        if (await this.target(ctx) !== task.target_id) throw new Error('Review target changed. Run a fresh review.');
        const last = [...task.jobs].reverse().find(j => j.role === 'reviewer');
        if (!last?.result || !last.valid) throw new Error('A complete validated review is required.');
        if (last.result.verdict === 'pass') await this.validate(last, task, ctx, true);
        else {
          const adjudication = [...task.jobs].reverse().find(j => j.role === 'adjudicator' && j.review_run === last.run_id && j.valid);
          if (!adjudication) throw new Error('Review does not pass; complete changes_required needs adjudication, inconclusive needs evidence.');
          await this.validate(adjudication, task, ctx, true);
        }
      }
      // This tool checks process evidence; root remains responsible for truth and scope.
      task.accepted = true; task.phase = 'accepted'; task.accepted_target = await this.target(ctx); this.save(ctx);
      return { ...task, note: 'Procedure checks passed. Root must independently judge evidence, scope and final acceptance; this is not system activation.' };
    }
    throw new Error(`Unknown operation: ${p.op}`);
  }
  async delegate(task, p, ctx, signal) {
    const role = p.role;
    if (!ROLES.includes(role) || !p.prompt?.trim()) throw new Error('delegate requires role and a bounded prompt.');
    const policy = await this.policy(ctx);
    if (!isWriter(role) && policy.assurance === 'strict') throw new Error('strict review requires verified OS read-only sandbox; Pi/Tintinweb does not supply that receipt. No review launched.');
    if (role === 'designer' && (!task.design_authorization || p.design_scope !== task.design_authorization.scope)) throw new Error('Designer requires recorded explicit design authorization and matching design_scope.');
    const model = role === 'designer' ? designModel(ctx.modelRegistry, p.model) : exactModel(ctx.modelRegistry, p.model, policy);
    if (!p.thinking) throw new Error('Specify thinking explicitly.');
    const levels = role === 'designer' ? CLI_EFFORTS : this.host.supportedThinking(model);
    if (!levels.includes(p.thinking)) throw new Error(`Unsupported thinking ${p.thinking}; available: ${levels.join(', ')}. No clamping allowed.`);
    await this.roleCheck(role, ctx);
    if (role !== 'designer') {
      const ping = await rpc(this.host.events, 'ping', {});
      if (ping?.version !== 2) throw new Error('Unsupported Tintinweb RPC version');
    }
    const currentTarget = await this.target(ctx);
    // External writer state must be current even without a native manager.
    const cliOwners = new Map(Object.values(this.tasks).filter(t => t.cwd === task.cwd).flatMap(t => t.jobs.filter(isCli)).map(j => [j.agent_id || j.run_id,j]));
    for (const writer of cliOwners.values()) {
      try { await this.cliOperation('observe', writer,task.cwd); }
      catch (error) { this.assertOperationActive(); writer.cli.frozen = false; writer.valid = false; writer.error = String(error); this.save(ctx); }
    }
    const running = this.activeJobs(task.cwd);
    if (!isWriter(role) && running.length) throw new Error('Freeze writers and collect outstanding work before review/adjudication.');
    if (!isWriter(role) && task.jobs.some(j => !j.collected)) throw new Error('Collect existing runs first.');
    let review;
    if (role === 'adjudicator') {
      review = [...task.jobs].reverse().find(j => j.role === 'reviewer');
      if (!review?.valid || review.result?.status !== 'complete' || review.result?.verdict !== 'changes_required' || review.result?.unresolved?.length || !review.result?.checked_scope?.length || !review.result?.evidence?.length) throw new Error('Only complete changes_required review with complete scope/evidence triggers adjudication.');
      if (task.target_id !== currentTarget) throw new Error('Review target changed; adjudication cannot repair a stale review.');
      if (task.jobs.some(j => j.role === 'adjudicator' && j.review_run === review.run_id && j.valid)) throw new Error('This review already has an adjudication. Investigate unresolved evidence instead of a debate loop.');
    }
    let owned = p.owned_paths || ['.'];
    if (!owned.length) throw new Error('owned_paths must identify at least one owned path.');
    if (owned.some(x => !x || x.startsWith('/') || x.split('/').includes('..') || x.includes('*'))) throw new Error('owned_paths must be literal repository-relative paths (or .), no globs.');
    owned = owned.map(path => posix.normalize(path).replace(/\/+$/, '') || '.');
    if (isWriter(role)) {
      if (running.some(j => !isWriter(j.role) || overlapping(owned, j.owned_paths))) throw new Error('Concurrent writers need disjoint ownership; no writes during review.');
      if (task.jobs.some(j => isWriter(j.role) && j.collected && !this.settlePreparationFailure(j))) throw new Error('Resume the original implementation owner; do not replace it for fixes.');
      task.target_id = null; task.accepted = false;
    } else task.target_id = currentTarget;
    const run_id = randomUUID();
    if (role === 'designer') { validatePaths(owned); validateChecks(p.checks ?? []); }
    const job = { run_id, role, transport:role === 'designer' ? CLAUDE_TRANSPORT : 'pi-native', agent_id: null, status: 'queued', collected: false, valid: false, owned_paths: owned, requested: {model:p.model, effort:p.thinking}, review_run: review?.run_id ?? null, target_id: task.target_id };
    if (role === 'designer') job.cli = {frozen:false, evidence:[]};
    task.jobs.push(job); task.accepted = false; task.phase = isWriter(role) ? 'implementation' : role === 'reviewer' ? 'review' : 'adjudication'; this.save(ctx);
    const designText = task.design_authorization ? await readFile(join(this.root, 'references/claude-design.md'), 'utf8') : '';
    const policyText = await readFile(join(this.root, 'skills', `pi-astraeus-${isWriter(role) ? 'orchestrate' : role === 'reviewer' ? 'review' : 'adjudicate'}`, 'SKILL.md'), 'utf8');
    const contract = !isWriter(role) ? await readFile(join(this.root, 'schemas', `${role === 'reviewer' ? 'review' : 'adjudication'}.json`), 'utf8') : '';
    const prompt = [
      `Task ${task.task_id}. Role ${role}. Work only on assigned scope; no child delegation.`,
      `Requirements:\n${task.requirements}\nAcceptance conditions:\n${task.acceptance}\nConstraints/non-goals/preserved contracts:\n${task.constraints}`,
      task.design_authorization ? `Design authorization (root-reported, not authenticated): ${JSON.stringify(task.design_authorization)}\nDesign handoff policy:\n${designText}` : '',
      `Assignment:\n${p.prompt}\nOwned paths:\n${owned.join('\n')}`,
      `Role policy:\n${policyText}\nRead relevant references under ${join(this.root, 'references')} when needed.`,
      !isWriter(role) ? `Stable target_id: ${task.target_id}. task_id: ${task.task_id}. Reported assurance: built-in read-only tools only, no OS sandbox or generation-time schema guarantee. Return exactly one JSON object matching this schema, no additional prose:\n${contract}` : 'Return actual edits, verification outcomes and remaining issues. Keep implementation and ordinary verification together.',
      review ? `Original review bytes:\n${await readFile(review.artifact, 'utf8')}\nreview_sha256: ${review.result_hash}` : '',
    ].filter(Boolean).join('\n\n');
    try {
      if (role === 'designer') {
        await this.prepareCli(task, job, ctx, p.checks ?? []);
        this.save(ctx); // Persist binding before launch; failures must never invite a blind retry.
        await this.cliOperation('start', job, task.cwd, await this.cliPrompt(task, job, prompt), job.cli.checks);
        this.save(ctx); return job;
      }
      const response = await rpc(this.host.events, 'spawn', { type: `astraeus-${role}`, prompt, options: { description:`${task.task_id}: ${role}`, model, thinkingLevel:p.thinking, inheritContext:false, isBackground:true, cwd:ctx.cwd, onSpawned: id => { job.agent_id = id; this.save(ctx); } } });
      job.agent_id = response.id; job.status = this.manager()?.getRecord(response.id)?.status ?? 'running'; this.save(ctx);
      return job;
    } catch (error) { this.assertOperationActive(); job.status = isCli(job) ? 'unknown' : this.manager()?.getRecord(job.agent_id)?.status ?? (job.agent_id ? 'unavailable' : 'error'); job.error = String(error); this.save(ctx); throw error; }
  }
  async prepareCli(task, job, ctx, checks, prior) {
    for (const owned of job.owned_paths) {
      let path = resolve(task.cwd,owned);
      while (!existsSync(path)) { const parent = dirname(path); if (parent === path) throw new Error('Cannot resolve owned path'); path = parent; }
      const canonical = await realpath(path);
      if (canonical !== task.cwd && !canonical.startsWith(task.cwd + '/')) throw new Error(`Designer ownership escapes cwd through symlink: ${owned}`);
    }
    const directory = join(await this.artifacts(task, ctx), job.run_id);
    if (directory === task.cwd || directory.startsWith(task.cwd + '/')) throw new Error('Claude control artifacts must be outside the managed cwd.');
    await mkdir(directory, {recursive:true, mode:0o700});
    const baseline = await snapshot(task.cwd);
    // Ownership remains bounded assignment; preserve dirty user work by instruction.
    for (const path of Object.keys(baseline.files)) {
      if (!job.owned_paths.some(o => o === '.' || path === o || path.startsWith(o + '/'))) continue;
      if ((await lstat(join(task.cwd,path))).isSymbolicLink()) {
        const canonical = await realpath(join(task.cwd,path));
        if (canonical !== task.cwd && !canonical.startsWith(task.cwd + '/')) throw new Error(`Designer owned symlink escapes cwd: ${path}`);
      }
    }
    const dirty = prior ? prior.user_dirty : baseline.dirty;
    const report_directory = prior ? prior.report_directory : join(directory,'pending');
    await mkdir(report_directory,{recursive:true, mode:0o700});
    job.cli = {directory, report_directory, pending:join(report_directory,`${job.run_id}.json`), checks, baseline, dispatch_target:await this.target(ctx), user_dirty:dirty, evidence:prior ? [...prior.evidence] : [], frozen:false,
      ...(prior ? {short_id:prior.short_id, session_id:prior.session_id, observed:prior.observed} : {})};
    const bytes = JSON.stringify({task_id:task.task_id, run_id:job.run_id, owned_paths:job.owned_paths, checks, baseline, dispatch_target:job.cli.dispatch_target},null,2);
    const path = join(directory,'request.json');
    await writeFile(path, bytes, {mode:0o600, flag:'wx'});
    job.cli.evidence.push({kind:'request', path, sha256:hash(bytes).slice(7)});
  }
  async cliPrompt(task, job, prompt) {
    const schema = await readFile(join(this.root,'schemas/implementation.json'),'utf8');
    const role = await readFile(join(this.root,'agents/astraeus-designer.md'),'utf8');
    return `${prompt}\n\nDesigner role contract (native frontmatter is not CLI isolation):\n${role}\n\nInstalled Claude Code background task, exact requested model claude-opus-5-5. Do not launch nested agents, create worktrees, commit/stage/reset/stash, push, publish, or edit workflow control metadata. Stay within the assigned paths and explicitly authorized design scope; owned_paths is advisory assignment, not a permission sandbox. Preserve existing user changes. Permissions are not an OS sandbox. Run required checks exactly: ${JSON.stringify(job.cli.checks)}. Report failed/denied checks truthfully. Missing checks means checks: [].\nWrite one JSON implementation result only to ${job.cli.pending}; do not edit control metadata or publish a final result. task_id=${JSON.stringify(task.task_id)}, run_id=${JSON.stringify(job.run_id)}, target_id=${JSON.stringify(job.cli.dispatch_target)}. changed_files reports your actual edits for this run, not preexisting or other writers' changes; shared-cwd baseline deltas are not exact attribution. Complete requires completed authorized work, all required checks passed, remaining: []. Schema:\n${schema}`;
  }
  async readCliReport(task, job, ctx) {
    const candidate = job.artifact || job.cli.pending;
    if (!(await lstat(candidate)).isFile() || (await lstat(candidate)).isSymbolicLink()) throw new Error('Symlinked/nonregular implementation report.');
    const bytes = await readFile(candidate,'utf8');
    if (job.artifact && job.result_hash !== hash(bytes)) throw new Error('Saved implementation report bytes changed.');
    // Validate captured bytes, not a mutable child path reopened by Python.
    const validation = join(job.cli.directory,`validation-${randomUUID()}.json`);
    await writeFile(validation,bytes,{mode:0o600, flag:'wx'});
    const result = JSON.parse(await this.bridge(['validate-result',validation,'--kind','implementation','--task-id',task.task_id,'--target-id',job.cli.dispatch_target],ctx)).result;
    if (result.run_id !== job.run_id) throw new Error('Implementation report has wrong run binding.');
    return {bytes,result};
  }
  requireCliComplete(job, result) {
    if (result.status !== 'complete' || result.remaining.length) throw new Error('Implementation report has incomplete work or remaining issues.');
    const checks = new Map(result.checks.map(c => [c.command,c]));
    if (checks.size !== result.checks.length || result.checks.some(c => c.outcome !== 'passed') || job.cli.checks.some(c => !checks.has(c))) throw new Error('Required checks missing, failed or not run.');
  }
  async reconcileGenerated(task, job, p, ctx) {
    // Compatibility operation for persisted ownership failures. No new approval,
    // cache fingerprints or Vitest receipt is needed under advisory ownership.
    if (!isCli(job) || job.role !== 'designer' || !job.collected || !job.cli.frozen ||
        [...task.jobs].reverse().find(j=>isWriter(j.role)) !== job) throw new Error('Recollect only the latest original frozen designer.');
    if (job.error && !job.cli.ownership_failure && /^Error: Out-of-ownership baseline delta: /.test(job.error)) {
      job.cli.ownership_failure = {error:job.error, provenance:'Historical failed collection; no historical hashes reconstructed.'};
    }
    return this.collectCli(task,job,ctx);
  }
  async collectCli(task, job, ctx) {
    if (this.settlePreparationFailure(job)) { this.save(ctx); return job; }
    job.valid = false;
    let before;
    try {
      const observed = await this.cliOperation('observe', job, task.cwd);
      if (!job.cli.frozen) {
        if (!(['done','stopped'].includes(observed.state) || (observed.state === 'blocked' && observed.status === 'idle'))) {
          if (observed.state === 'working' && ['running','busy','working'].includes(observed.status)) return {...job, note:'Claude still working; unknown lifecycle is not completion.'};
          throw new Error('Claude lifecycle not collectable; explicitly stop exact writer or obtain evidence.');
        }
        await this.cliOperation('stop', job, task.cwd);
      }
      if (job.cli.unexpected_copy) throw new Error('Unexpected copy cannot produce a successful implementation report, even after exact cleanup.');
      job.collected = true;
      before = await snapshot(task.cwd);
      await originalRequest(task,job);
      const {bytes,result} = await this.readCliReport(task,job,ctx);
      job.result = result;
      await this.cliOperation('observe', job,task.cwd);
      if (!job.cli.frozen || JSON.stringify(await snapshot(task.cwd)) !== JSON.stringify(before)) throw new Error('Claude writer/source changed during collection.');
      if (!job.artifact) {
        const final = join(job.cli.directory,'result.json');
        await publish(job.cli.pending,final,bytes); job.artifact = final;
      } else if (job.result_hash !== hash(bytes)) throw new Error('Published implementation result changed.');
      job.result_hash = hash(bytes); job.summary = result.summary;
      // Publication records the outcome, including blocked/failed checks. It is
      // not acceptance and cannot promote incomplete work to success.
      this.requireCliComplete(job, result);
      job.valid = true;
      task.phase = 'verification'; task.target_id = null; delete job.error;
    } catch (error) {
      this.assertOperationActive(); job.collected = true; job.error = String(error); task.phase = 'needs-evidence';
    }
    this.save(ctx); return job;
  }
  async collect(task, job, ctx) {
    if (isCli(job)) return this.collectCli(task,job,ctx);
    const record = this.manager()?.getRecord(job.agent_id);
    if (!record) {
      if (job.collected) return job;
      job.status = 'unavailable'; job.collected = true; job.valid = false;
      job.error = 'Native child record unavailable: attempt settled as unsuccessful, not completed. A fresh reviewer/adjudicator may retry; implementation ownership still requires original-session recovery.';
      task.phase = 'needs-evidence'; this.save(ctx); return job;
    }
    job.status = record.status;
    if (ACTIVE.has(record.status)) { this.save(ctx); return { ...job, note: 'Still running. Continue independent work or collect later.' }; }
    job.collected = true; job.valid = false;
    try {
      if (record.type !== `astraeus-${job.role}`) throw new Error('Resolved child role differs from requested role.');
      const receipt = assertReceipt(job, record);
      const directory = await this.artifacts(task, ctx);
      job.receipt_path = join(directory, `${job.run_id}.receipt.json`);
      const receiptBytes = JSON.stringify(receipt, null, 2);
      await writeFile(job.receipt_path, receiptBytes, { mode:0o600 }); job.receipt_hash = hash(receiptBytes);
      if (record.status !== 'completed') throw new Error(`Child ${record.status}: ${record.error || 'incomplete output'}`);
      if (isWriter(job.role)) {
        job.summary = record.result || ''; job.valid = true; task.phase = 'verification'; task.target_id = null;
      } else {
        if (await this.target(ctx) !== job.target_id || task.target_id !== job.target_id) throw new Error('Review target changed while child was running.');
        const bytes = parseReport(record.structuredJson ?? record.result ?? '');
        job.artifact = join(directory, `${job.run_id}.json`);
        await writeFile(job.artifact, bytes, { mode:0o600 }); job.result_hash = hash(bytes);
        job.result = await this.validate(job, task, ctx); job.valid = true;
        task.phase = job.result.verdict === 'pass' || job.result.verdict === 'accept' ? 'ready-for-root' : job.result.verdict === 'changes_required' ? (job.role === 'reviewer' ? 'needs-adjudication' : 'needs-fixes') : 'needs-evidence';
      }
      await rpc(this.host.events, 'consume', {agentId:job.agent_id});
      delete job.error;
    } catch (error) { job.error = String(error); task.phase = 'needs-evidence'; }
    this.save(ctx); return job;
  }
  async resume(task, job, p, ctx, signal) {
    if (!isWriter(job.role)) throw new Error('Reviews and adjudications always use fresh sessions.');
    if (!job.collected || !p.prompt?.trim()) throw new Error('Collect the previous run and provide a bounded follow-up prompt.');
    if (this.activeJobs(task.cwd).length) throw new Error('Collect/stop active work before resuming the implementation owner.');
    const latestOwner = [...task.jobs].reverse().find(j => j.agent_id === job.agent_id && isWriter(j.role));
    if (latestOwner !== job) throw new Error('Resume only the latest run of the original implementation owner.');
    const latestReview = [...task.jobs].reverse().find(j => j.role === 'reviewer');
    if (latestReview?.valid && latestReview.result?.verdict === 'changes_required') {
      const decision = [...task.jobs].reverse().find(j => j.role === 'adjudicator' && j.review_run === latestReview.run_id && j.valid);
      if (!decision || decision.result?.verdict !== 'changes_required') throw new Error('Only adopted fixes from a complete adjudication may return to the implementer.');
      if (await this.target(ctx) !== task.target_id) throw new Error('Target changed since adjudication; obtain fresh review before adopted fixes.');
      await this.validate(decision, task, ctx);
    }
    if (isCli(job)) {
      await this.cliOperation('observe', job,task.cwd);
      if (!job.cli.frozen) throw new Error('Collect/freeze the original Claude writer before resume.');
      if (job.cli.unexpected_copy) throw new Error('Unexpected copy cannot be resumed as original-owner work.');
      // Correction needs exact original-owner/freeze/evidence, not successful
      // previous work. Never erase the failed run or silently repair its report.
      try {
        await originalRequest(task,job);
        if (job.artifact) await this.readCliReport(task,job,ctx);
      } catch (error) { job.valid = false; job.error = String(error); this.save(ctx); throw error; }
      const follow = {...job, run_id:randomUUID(), collected:false, valid:false, result:undefined, artifact:undefined, result_hash:undefined, status:'queued', error:undefined};
      task.jobs.push(follow); task.accepted = false; task.target_id = null; task.phase = 'implementation';
      try {
        // Fresh observational baseline; preserving user work stays an instruction.
        await this.prepareCli(task,follow,ctx,job.cli.checks,job.cli);
        this.save(ctx);
        await this.cliOperation('resume', follow,task.cwd,await this.cliPrompt(task,follow,`Continue only original authorized design scope ${task.design_authorization.scope}; preserve Opus design decisions unless explicit user/functional constraints require changes.\n${p.prompt}`));
        this.save(ctx); return follow;
      } catch (error) { this.assertOperationActive(); follow.status = 'unknown'; follow.error = String(error); follow.collected = true; this.save(ctx); throw error; }
    }
    const record = this.manager()?.getRecord(job.agent_id);
    if (!record?.session) throw new Error('Original live child session unavailable. Use Tintinweb @handle session recovery; no replacement owner was launched.');
    assertReceipt(job, record);
    task.accepted = false; task.target_id = null; task.phase = 'implementation';
    const follow = { ...job, run_id:randomUUID(), collected:false, valid:false, result:undefined, artifact:undefined, receipt_path:undefined, receipt_hash:undefined, result_hash:undefined, status:'running', error:undefined };
    task.jobs.push(follow); this.save(ctx);
    try {
      // Public native Agent tool supports resumption; RPC intentionally strips resume fields.
      const reply = await ctx.executeTool('Agent', { subagent_type:`astraeus-${job.role}`, resume:job.agent_id, prompt:job.role === 'designer' ? `Continue only the original authorized design scope ${task.design_authorization.scope}; preserve Opus design decisions unless explicit user or functional constraints require a change.\n${p.prompt}` : p.prompt, description:`Continue ${task.task_id}`, run_in_background:true }, {signal});
      const updated = this.manager()?.getRecord(job.agent_id);
      if (!updated || !ACTIVE.has(updated.status)) throw new Error('Native resume did not start the original owner: ' + JSON.stringify({reply,status:updated?.status}));
      return follow;
    } catch (error) { follow.status = 'error'; follow.error = String(error); follow.collected = true; this.save(ctx); throw error; }
  }
}
