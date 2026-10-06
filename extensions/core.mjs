import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, realpath, readdir } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, posix } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const ENTRY = 'pi-astraeus:state-v1';
export const ROLES = ['worker', 'reviewer', 'adjudicator'];
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
  constructor(host, { root = ROOT, python = process.env.PI_ASTRAEUS_PYTHON || 'python3' } = {}) {
    this.host = host; this.root = root; this.python = python; this.tasks = {}; this.queue = Promise.resolve();
  }
  bridge(args, ctx) { return run(this.python, [join(this.root, 'scripts/astraeus.py'), ...args], ctx.cwd); }
  async policy(ctx) { return JSON.parse(await this.bridge(['policy', '--repo', ctx.cwd], ctx)); }
  async target(ctx) {
    return (await this.bridge(['target', '--repo', ctx.cwd], ctx)).trim();
  }
  manager() { return this.host.manager(); }
  restore(ctx) {
    this.tasks = {};
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === 'custom' && entry.customType === ENTRY && entry.data?.version === 1) this.tasks = structuredClone(entry.data.tasks);
    }
    for (const task of Object.values(this.tasks)) {
      for (const job of task.jobs) if (ACTIVE.has(job.status) && !this.manager()?.getRecord(job.agent_id)) job.status = 'unavailable';
    }
    this.show(ctx);
  }
  save(ctx) {
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
      return [...latest.values()].filter(job => ACTIVE.has(this.manager()?.getRecord(job.agent_id)?.status ?? job.status));
    });
  }
  async status(ctx, id) {
    const tasks = id ? [this.task(id, ctx)] : Object.values(this.tasks);
    for (const task of tasks) {
      for (const job of task.jobs) {
        const record = this.manager()?.getRecord(job.agent_id);
        if (ACTIVE.has(job.status)) job.status = record?.status ?? 'unavailable';
      }
      if (task.target_id && task.cwd === realpathSync(ctx.cwd) && await this.target(ctx) !== task.target_id) {
        task.phase = 'stale'; task.accepted = false;
      }
    }
    this.save(ctx); return structuredClone(tasks);
  }
  execute(params, ctx, signal) {
    const next = this.queue.then(() => this.action(params, ctx, signal));
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
      const task = { task_id: p.task_id, cwd: await realpath(ctx.cwd), requirements: p.requirements, acceptance: p.acceptance, constraints: p.constraints || '', consequential: p.consequential !== false, phase: 'implementation', jobs: [], target_id: null, accepted: false };
      this.tasks[p.task_id] = task; this.save(ctx); return task;
    }
    const task = this.task(p.task_id, ctx);
    if (p.op === 'invalidate') {
      task.phase = 'stale'; task.accepted = false; task.target_id = null; this.save(ctx); return task;
    }
    if (p.op === 'delegate') return this.delegate(task, p, ctx, signal);
    const job = task.jobs.find(j => j.run_id === p.run_id);
    if (['collect', 'stop', 'resume'].includes(p.op) && !job) throw new Error('Unknown run_id');
    if (p.op === 'collect') return this.collect(task, job, ctx);
    if (p.op === 'stop') {
      await rpc(this.host.events, 'stop', { agentId: job.agent_id });
      job.status = 'stopped'; job.collected = false; this.save(ctx); return job;
    }
    if (p.op === 'resume') return this.resume(task, job, p, ctx, signal);
    if (p.op === 'accept') {
      if (task.jobs.some(j => !j.collected || ACTIVE.has(this.manager()?.getRecord(j.agent_id)?.status ?? j.status))) throw new Error('Collect every managed result before acceptance.');
      const latestWorkers = new Map(task.jobs.filter(j => j.role === 'worker').map(j => [j.agent_id, j]));
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
    if (role !== 'worker' && policy.assurance === 'strict') throw new Error('strict review requires verified OS read-only sandbox; Pi/Tintinweb does not supply that receipt. No review launched.');
    const model = exactModel(ctx.modelRegistry, p.model, policy);
    if (!p.thinking) throw new Error('Specify thinking explicitly.');
    const levels = this.host.supportedThinking(model);
    if (!levels.includes(p.thinking)) throw new Error(`Unsupported thinking ${p.thinking}; available: ${levels.join(', ')}. No clamping allowed.`);
    await this.roleCheck(role, ctx);
    const ping = await rpc(this.host.events, 'ping', {});
    if (ping?.version !== 2) throw new Error('Unsupported Tintinweb RPC version');
    const currentTarget = await this.target(ctx);
    const running = this.activeJobs(task.cwd);
    if (role !== 'worker' && running.length) throw new Error('Freeze writers and collect outstanding work before review/adjudication.');
    if (role !== 'worker' && task.jobs.some(j => !j.collected)) throw new Error('Collect existing runs first.');
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
    if (role === 'worker') {
      if (running.some(j => j.role !== 'worker' || overlapping(owned, j.owned_paths))) throw new Error('Concurrent writers need disjoint ownership; no writes during review.');
      if (task.jobs.some(j => j.role === 'worker' && j.collected)) throw new Error('Resume the original implementation owner; do not replace it for fixes.');
      task.target_id = null; task.accepted = false;
    } else task.target_id = currentTarget;
    const run_id = randomUUID();
    const job = { run_id, role, agent_id: null, status: 'queued', collected: false, valid: false, owned_paths: owned, requested: {model:p.model, effort:p.thinking}, review_run: review?.run_id ?? null, target_id: task.target_id };
    task.jobs.push(job); task.accepted = false; task.phase = role === 'worker' ? 'implementation' : role === 'reviewer' ? 'review' : 'adjudication'; this.save(ctx);
    const policyText = await readFile(join(this.root, 'skills', `pi-astraeus-${role === 'worker' ? 'orchestrate' : role === 'reviewer' ? 'review' : 'adjudicate'}`, 'SKILL.md'), 'utf8');
    const contract = role !== 'worker' ? await readFile(join(this.root, 'schemas', `${role === 'reviewer' ? 'review' : 'adjudication'}.json`), 'utf8') : '';
    const prompt = [
      `Task ${task.task_id}. Role ${role}. Work only on assigned scope; no child delegation.`,
      `Requirements:\n${task.requirements}\nAcceptance conditions:\n${task.acceptance}\nConstraints/non-goals/preserved contracts:\n${task.constraints}`,
      `Assignment:\n${p.prompt}\nOwned paths:\n${owned.join('\n')}`,
      `Role policy:\n${policyText}\nRead relevant references under ${join(this.root, 'references')} when needed.`,
      role !== 'worker' ? `Stable target_id: ${task.target_id}. task_id: ${task.task_id}. Reported assurance: built-in read-only tools only, no OS sandbox or generation-time schema guarantee. Return exactly one JSON object matching this schema, no additional prose:\n${contract}` : 'Return actual edits, verification outcomes and remaining issues. Keep implementation and ordinary verification together.',
      review ? `Original review bytes:\n${await readFile(review.artifact, 'utf8')}\nreview_sha256: ${review.result_hash}` : '',
    ].filter(Boolean).join('\n\n');
    try {
      const response = await rpc(this.host.events, 'spawn', { type: `astraeus-${role}`, prompt, options: { model, thinkingLevel:p.thinking, inheritContext:false, isBackground:true, cwd:ctx.cwd, onSpawned: id => { job.agent_id = id; this.save(ctx); } } });
      job.agent_id = response.id; job.status = this.manager()?.getRecord(response.id)?.status ?? 'running'; this.save(ctx);
      return job;
    } catch (error) { job.status = this.manager()?.getRecord(job.agent_id)?.status ?? (job.agent_id ? 'unavailable' : 'error'); job.error = String(error); this.save(ctx); throw error; }
  }
  async collect(task, job, ctx) {
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
      if (job.role === 'worker') {
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
    if (job.role !== 'worker') throw new Error('Reviews and adjudications always use fresh sessions.');
    if (!job.collected || !p.prompt?.trim()) throw new Error('Collect the previous run and provide a bounded follow-up prompt.');
    if (this.activeJobs(task.cwd).length) throw new Error('Collect/stop active work before resuming the implementation owner.');
    const latestReview = [...task.jobs].reverse().find(j => j.role === 'reviewer');
    if (latestReview?.valid && latestReview.result?.verdict === 'changes_required') {
      const decision = [...task.jobs].reverse().find(j => j.role === 'adjudicator' && j.review_run === latestReview.run_id && j.valid);
      if (!decision || decision.result?.verdict !== 'changes_required') throw new Error('Only adopted fixes from a complete adjudication may return to the implementer.');
      if (await this.target(ctx) !== task.target_id) throw new Error('Target changed since adjudication; obtain fresh review before adopted fixes.');
      await this.validate(decision, task, ctx);
    }
    const record = this.manager()?.getRecord(job.agent_id);
    if (!record?.session) throw new Error('Original live child session unavailable. Use Tintinweb @handle session recovery; no replacement owner was launched.');
    assertReceipt(job, record);
    task.accepted = false; task.target_id = null; task.phase = 'implementation';
    const follow = { ...job, run_id:randomUUID(), collected:false, valid:false, result:undefined, artifact:undefined, receipt_path:undefined, receipt_hash:undefined, result_hash:undefined, status:'running', error:undefined };
    task.jobs.push(follow); this.save(ctx);
    try {
      // Public native Agent tool supports resumption; RPC intentionally strips resume fields.
      const reply = await ctx.executeTool('Agent', { subagent_type:'astraeus-worker', resume:job.agent_id, prompt:p.prompt, description:`Continue ${task.task_id}`, run_in_background:true }, {signal});
      const updated = this.manager()?.getRecord(job.agent_id);
      if (!updated || !ACTIVE.has(updated.status)) throw new Error('Native resume did not start the original owner: ' + JSON.stringify({reply,status:updated?.status}));
      return follow;
    } catch (error) { follow.status = 'error'; follow.error = String(error); follow.collected = true; this.save(ctx); throw error; }
  }
}
