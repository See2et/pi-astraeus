// Explicit recovery for one known verification artifact family, not source ownership.
import {createHash} from 'node:crypto';
import {readFile, lstat, realpath, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {capture, delta} from './claude.mjs';

const hash = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const owns = (job,path) => job.owned_paths.some(o => o === '.' || path === o || path.startsWith(o + '/'));
const cache = /^node_modules\/\.vite\/vitest\/[a-f0-9]{40}\/results\.json$/;
const fingerprint = value => typeof value === 'string' && /^\d{5,6}:[a-f0-9]{64}$/.test(value) && (Number(value.split(':')[0]) & 0o170000) === 0o100000;
export const snapshotHash = value => hash(JSON.stringify(value));

export async function originalRequest(task, job) {
  if (job.role !== 'designer' || job.requested.model !== 'anthropic/claude-opus-5-5' ||
      job.agent_id !== `claude:${job.cli.session_id}` || job.cli.unexpected_copy) throw new Error('Generated recovery requires the original bound designer.');
  const directory = await realpath(job.cli.directory);
  if (directory === task.cwd || directory.startsWith(task.cwd + '/')) throw new Error('Recovery artifacts must be outside managed cwd.');
  const stop = [...job.cli.evidence].reverse().find(e=>['stop','resume','launch'].includes(e.kind));
  if (stop?.kind !== 'stop') throw new Error('Original stopped lifecycle evidence missing.');
  const stopped = JSON.parse(await readFile(stop.path));
  if (stopped.returncode !== 0 || stopped.stdout.trim() !== `stopped ${job.cli.short_id}` || !same(stopped.args,['stop',job.cli.short_id])) throw new Error('Original exact stop acknowledgment missing.');
  const path = join(job.cli.directory,'request.json');
  const evidence = job.cli.evidence.find(e => e.kind === 'request' && e.path === path);
  const bytes = await readFile(path);
  if (!evidence || hash(bytes) !== `sha256:${evidence.sha256}`) throw new Error('Original request evidence changed.');
  const request = JSON.parse(bytes);
  const expected = {task_id:task.task_id, run_id:job.run_id, owned_paths:job.owned_paths, checks:job.cli.checks, baseline:job.cli.baseline, dispatch_target:job.cli.dispatch_target};
  if (!same(request,expected)) throw new Error('Original baseline/ownership/check/run binding changed.');
  const launch = job.cli.evidence.find(e => e.kind === 'launch');
  if (!launch) throw new Error('Original launch evidence missing.');
  const args = JSON.parse(await readFile(launch.path)).args;
  if (args[args.indexOf('--model')+1] !== 'claude-opus-5-5' || args[args.indexOf('--effort')+1] !== job.requested.effort) throw new Error('Original requested model/effort changed.');
  return {path, sha256:hash(bytes)};
}

async function literalGenerated(task, job, before, after, outputs) {
  if (!Array.isArray(outputs) || !outputs.length || new Set(outputs.map(o=>o.path)).size !== outputs.length) throw new Error('Explicit unique generated_outputs are required.');
  for (const output of outputs) {
    if (!output || Object.keys(output).some(k=>!['path','before','after','reason'].includes(k)) ||
        typeof output.path !== 'string' || !cache.test(output.path) || owns(job,output.path) ||
        !(output.before === null || fingerprint(output.before)) ||
        !fingerprint(output.after) ||
        typeof output.reason !== 'string' || !output.reason.trim()) throw new Error('Only literal ignored regular Vitest results cache outputs with exact fingerprints and reason are eligible.');
    if ((before.files[output.path] ?? null) !== output.before || after.files[output.path] !== output.after || output.before === output.after) throw new Error('Generated output fingerprints differ from preserved baseline/current delta.');
    // Reject every symlink component, including internal aliases; ignore status alone is insufficient.
    let path = task.cwd;
    const parts = output.path.split('/');
    for (let i=0;i<parts.length;i++) {
      path = join(path,parts[i]); const stat = await lstat(path);
      if (stat.isSymbolicLink() || (i === parts.length-1 ? !stat.isFile() : !stat.isDirectory())) throw new Error('Generated output must be a regular file with literal nonsymlink parents.');
    }
    if (await realpath(path) !== join(task.cwd,output.path)) throw new Error('Generated output escapes literal cwd.');
    const tracked = await capture('git',['ls-files','--cached','--error-unmatch','--',output.path],task.cwd);
    const ignored = await capture('git',['check-ignore','--no-index','--',output.path],task.cwd);
    if (tracked.returncode !== 1 || ignored.returncode !== 0 || ignored.stdout.trim() !== output.path) throw new Error('Generated output must be untracked and explicitly ignored.');
  }
  const adjusted = {...after, files:{...after.files}};
  for (const output of outputs) {
    if (output.before === null) delete adjusted.files[output.path];
    else adjusted.files[output.path] = output.before;
  }
  // All other outside deltas, plus HEAD/index mutations, still fail normal ownership checks.
  return delta(before,adjusted,job.owned_paths);
}

export async function requiredVitest(task, job, result, current) {
  const passed = new Set(result.checks.filter(c=>c.outcome === 'passed').map(c=>c.command));
  let scripts;
  for (const command of job.cli.checks) {
    if (!passed.has(command)) continue;
    if (/^(?:(?:npx|npm exec) )?vitest run(?: |$)/.test(command)) return command;
    const match = /^npm (?:test|run ([A-Za-z0-9:_-]+))(?: --(?: |$).*)?$/.exec(command);
    if (!match) continue;
    // Resolve an npm script only from unchanged baseline package bytes. No arbitrary caller label.
    if (!job.cli.baseline.files['package.json'] || job.cli.baseline.files['package.json'] !== current.files['package.json']) continue;
    scripts ??= JSON.parse(await readFile(join(task.cwd,'package.json'),'utf8')).scripts;
    if (typeof scripts?.[match[1] || 'test'] === 'string' && /^vitest run(?: |$)/.test(scripts[match[1] || 'test'])) return command;
  }
  throw new Error('Generated recovery requires a recorded passed required Vitest run check.');
}

export async function proposalDelta(task, job, current, outputs) {
  await originalRequest(task,job);
  return literalGenerated(task,job,job.cli.baseline,current,outputs);
}

export async function approvedDelta(task, job, current) {
  const approval = job.cli.generated_reconciliation;
  if (!approval) return delta(job.cli.baseline,current,job.owned_paths);
  if (approval.path !== join(job.cli.directory,'generated-reconciliation.json')) throw new Error('Generated reconciliation must stay in the original run artifact directory.');
  const bytes = await readFile(approval.path);
  if ((await lstat(approval.path)).isSymbolicLink() || hash(bytes) !== approval.sha256) throw new Error('Generated reconciliation receipt bytes changed.');
  const receipt = JSON.parse(bytes);
  const request = await originalRequest(task,job);
  if (receipt.task_id !== task.task_id || receipt.run_id !== job.run_id || receipt.agent_id !== job.agent_id ||
      !same(receipt.request,request) || receipt.baseline_sha256 !== snapshotHash(job.cli.baseline) ||
      receipt.current_sha256 !== snapshotHash(current) || !same(receipt.requested,job.requested) ||
      !same(receipt.owned_paths,job.owned_paths)) throw new Error('Reconciled source/baseline/owner changed.');
  const report = job.artifact || job.cli.pending;
  if ((await lstat(report)).isSymbolicLink() || hash(await readFile(report)) !== receipt.report_sha256) throw new Error('Original reconciled report bytes changed.');
  return literalGenerated(task,job,job.cli.baseline,current,receipt.generated_outputs);
}

export async function writeReconciliation(task, job, current, outputs, bytes, request, check) {
  const failure = job.cli.ownership_failure ?? {error:job.error, provenance:'Retained failed collection state; pre-recovery report/source hashes were not captured by the older collector.'};
  const captured = job.cli.evidence.find(e=>e.kind === 'ownership-failure' && e.path.startsWith(job.cli.directory + '/'));
  if (captured && !same(JSON.parse(await readFile(captured.path)),failure)) throw new Error('Historical failed collection evidence changed.');
  if (failure.report_sha256 && failure.report_sha256 !== hash(bytes)) throw new Error('Report changed since failed collection.');
  if (failure.current_sha256 && failure.current_sha256 !== snapshotHash(current)) throw new Error('Source changed since failed collection.');
  const receipt = {version:1, task_id:task.task_id, run_id:job.run_id, agent_id:job.agent_id,
    requested:job.requested, owned_paths:job.owned_paths, request, baseline_sha256:snapshotHash(job.cli.baseline),
    current_sha256:snapshotHash(current), report_sha256:hash(bytes), required_vitest_check:check,
    failure, frozen_observation:job.cli.observed, original_evidence:job.cli.evidence,
    generated_outputs:outputs};
  const path = join(job.cli.directory,'generated-reconciliation.json');
  const contents = JSON.stringify(receipt,null,2);
  await writeFile(path,contents,{mode:0o600,flag:'wx'});
  return {path,sha256:hash(contents)};
}
