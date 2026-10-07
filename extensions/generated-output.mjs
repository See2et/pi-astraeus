// Retained module path for compatibility. Generated-output approvals are retired;
// this validates only immutable original-owner request and exact stop evidence.
import {createHash} from 'node:crypto';
import {readFile, realpath} from 'node:fs/promises';
import {join} from 'node:path';
const hash = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);

export async function originalRequest(task, job) {
  if (job.role !== 'designer' || job.requested.model !== 'anthropic/claude-opus-5-5' ||
      job.agent_id !== `claude:${job.cli.session_id}` || job.cli.unexpected_copy) throw new Error('Recovery requires the original bound designer.');
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
