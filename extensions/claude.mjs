// Installed Claude Code background transport. Never reads private session storage.
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile, lstat, readlink, realpath, link, unlink } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { ClaudeTrustPreflight } from './claude-trust.mjs';

export const CLAUDE_TRANSPORT = 'claude-code-bg-v1';
export const CLI_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
export function launchId(stdout) {
  const plain = stdout.replace(/\x1b\[[0-9;]*m/g, '');
  const ids = [...plain.matchAll(/^backgrounded · ([a-f0-9]{8})(?: · [^\r\n]*)?\s*$/gm)].map(m => m[1]);
  if (ids.length !== 1) throw new Error('Unknown or ambiguous Claude background launch output; retain evidence, do not relaunch.');
  return ids[0];
}
// Public lifecycle evidence is not a freeze acknowledgment or a valid report.
export function observedStatus(record) {
  const {state, status} = record ?? {};
  if (state === 'stopped' && [null, undefined, 'idle'].includes(status)) return 'stopped';
  if (state === 'blocked' && [null, undefined, 'idle', 'blocked', 'waiting', 'input-wait'].includes(status)) return 'blocked';
  if (['done', 'idle'].includes(state) && [null, undefined, 'idle'].includes(status)) return 'work-ended';
  if (state === 'working' && ['running', 'busy', 'working'].includes(status)) return 'running';
  return 'unknown';
}
export function capture(command, args, cwd, {signal, timeout, maxBytes = Infinity} = {}) {
  return new Promise(resolveResult => {
    const child = spawn(command, args, {cwd, stdio:['ignore','pipe','pipe']});
    let stdout = '', stderr = '', settled = false, size = 0;
    let timer;
    const finish = result => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      resolveResult({...result, stdout, stderr});
    };
    // Kill only this CLI query child, never the bound background owner/PID.
    const cancel = reason => { child.kill('SIGKILL'); finish({returncode:null, diagnostic:reason}); };
    const abort = () => cancel('Claude CLI observation cancelled');
    const chunk = (key, bytes) => {
      if (settled) return;
      const remaining = Math.max(0, maxBytes - size); size += bytes.length;
      const text = bytes.subarray(0, remaining).toString();
      if (key === 'stdout') stdout += text; else stderr += text;
      if (size > maxBytes) cancel('Claude CLI output limit exceeded');
    };
    child.stdout.on('data', c => chunk('stdout', c)); child.stderr.on('data', c => chunk('stderr', c));
    child.on('error', error => { if (!settled) stderr += String(error).slice(0, 1024); finish({returncode:null}); });
    child.on('close', (returncode, signal) => finish({returncode, signal}));
    if (timeout !== undefined) timer = setTimeout(() => cancel('Claude CLI observation timed out'), timeout);
    signal?.addEventListener('abort', abort, {once:true});
    if (signal?.aborted) abort();
  });
}
export class ClaudeBackground {
  constructor({command = 'claude', invoke = capture, trust = new ClaudeTrustPreflight(), observationTimeout = 5000, observationMaxBytes = 256 * 1024} = {}) {
    this.command = command; this.invoke = invoke; this.trust = trust;
    this.observationTimeout = observationTimeout; this.observationMaxBytes = observationMaxBytes;
  }
  async preflight(cwd) { return this.trust.run(cwd, () => this.records(cwd)); }
  async call(args, cwd) { return this.invoke(this.command, args, cwd); }
  async checked(args, cwd, options) {
    const result = await this.query(args, cwd, options?.signal);
    if (result.returncode !== 0) throw new Error(`Claude CLI ${args.slice(0,2).join(' ')} failed: ${result.diagnostic || result.stderr}`);
    return result.stdout;
  }
  async capabilities(cwd, effort) {
    const help = await this.checked(['--help'], cwd);
    const flags = ['--bg','--resume','--model','--effort','--safe-mode','--settings','--setting-sources','--permission-mode','--allowedTools','--disallowedTools','--tools','--add-dir','--strict-mcp-config','--mcp-config'];
    if (flags.some(flag => !help.includes(flag))) throw new Error('Installed Claude CLI lacks required safe background capabilities. No API fallback.');
    // The installed CLI documents the accepted effort values; never clamp a Pi level.
    const block = /--effort\b([\s\S]*?)(?=\n\s{2}(?:--|-[A-Za-z],)|$)/.exec(help)?.[1] || '';
    if (effort && (!CLI_EFFORTS.includes(effort) || !new RegExp(`\\b${effort}\\b`).test(block))) throw new Error(`Unsupported Claude CLI effort ${effort}; no clamping.`);
    const agents = await this.checked(['agents','--help'], cwd);
    if (!agents.includes('--json') || !agents.includes('--all') || !(await this.checked(['stop','--help'], cwd)).includes('stop <id>')) throw new Error('Installed Claude CLI lacks exact lifecycle capabilities.');
  }
  async query(args, cwd, signal) {
    // Also bound injected transports that ignore cancellation. Late replies cannot
    // escape this promise or mutate a job; observe's caller stages its own copy.
    const controller = new AbortController();
    let timer, off;
    try {
      return await new Promise((resolveResult, reject) => {
        const fail = reason => { reject(new Error(reason)); controller.abort(); };
        off = () => fail('Claude observation cancelled');
        timer = setTimeout(() => fail('Claude observation timed out'), this.observationTimeout);
        signal?.addEventListener('abort', off, {once:true});
        if (signal?.aborted) { off(); return; }
        Promise.resolve().then(() => this.invoke(this.command, args, cwd, {signal:controller.signal, timeout:this.observationTimeout, maxBytes:this.observationMaxBytes})).then(result => {
          if (Buffer.byteLength(result.stdout || '') + Buffer.byteLength(result.stderr || '') > this.observationMaxBytes) fail('Claude observation output limit exceeded');
          else resolveResult(result);
        }, reject);
      });
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', off); }
  }
  async records(cwd, signal) {
    const stdout = await this.checked(['agents','--json','--all'], cwd, {signal});
    let records;
    try { records = JSON.parse(stdout); } catch { /* Never echo a parser snippet/public record. */ }
    if (!Array.isArray(records)) {
      const error = new Error('Unknown Claude agents JSON format.');
      error.code = 'CLAUDE_AGENTS_FORMAT'; throw error;
    }
    return records;
  }
  async match(short, cwd, full, signal) {
    // Keep bounded identity-only evidence in the error message: workflow state
    // persists it across restore, without retaining unrelated public records or paths.
    const evidence = {short_id:/^[a-f0-9]{8}$/.test(short) ? short : null, expected_uuid:uuid(full) ? full : null};
    const refuse = reason => {
      const error = new Error(`Claude full UUID/cwd binding mismatch: ${reason}; unknown is not done. ${JSON.stringify(evidence)}`);
      error.code = 'CLAUDE_BINDING_REFUSED'; error.reason = reason; error.evidence = {...evidence};
      throw error;
    };
    let records;
    try { records = await this.records(cwd, signal); }
    catch (error) { if (error.code === 'CLAUDE_AGENTS_FORMAT') refuse('unknown-response'); throw error; }
    const found = records.filter(r => r && r.id === short);
    evidence.match_count = found.length;
    if (!found.length) refuse('missing-record');
    if (found.length !== 1) refuse('ambiguous-record');
    const record = found[0];
    const camel = Object.hasOwn(record,'sessionId'), snake = Object.hasOwn(record,'session_id');
    evidence.sessionId = uuid(record.sessionId) ? record.sessionId : null;
    evidence.session_id = uuid(record.session_id) ? record.session_id : null;
    if (camel && snake && record.sessionId !== record.session_id) refuse('conflicting-uuid-aliases');
    const id = camel ? record.sessionId : record.session_id;
    if (id === null || id === undefined) refuse('missing-uuid');
    if (!uuid(id)) refuse('invalid-uuid');
    if (!id.startsWith(short + '-')) refuse('uuid-prefix-mismatch');
    if (full !== undefined && full !== id) refuse('expected-uuid-mismatch');
    if (record.cwd === null || record.cwd === undefined) refuse('missing-cwd');
    if (typeof record.cwd !== 'string' || !record.cwd) refuse('invalid-cwd');
    let expectedCwd, observedCwd;
    try { expectedCwd = await realpath(cwd); } catch { refuse('expected-cwd-unresolvable'); }
    evidence.expected_cwd_sha256 = digest(expectedCwd);
    try { observedCwd = await realpath(record.cwd); } catch { refuse('cwd-unresolvable'); }
    evidence.observed_cwd_sha256 = digest(observedCwd);
    if (observedCwd !== expectedCwd) refuse('canonical-cwd-mismatch');
    return {id:short, session_id:id, cwd:expectedCwd, state:record.state ?? null, status:record.status ?? null, pid:record.pid ?? null};
  }
  async evidence(job, kind, args, cwd) {
    const result = await this.call(args, cwd);
    const path = join(job.cli.directory, `${kind}-${randomUUID()}.json`);
    const bytes = JSON.stringify({args, ...result}, null, 2);
    await writeFile(path, bytes, {mode:0o600, flag:'wx'});
    job.cli.evidence.push({kind, path, sha256:digest(bytes)});
    return result;
  }
  async audit(job) {
    for (const item of job.cli.evidence) {
      if ((await lstat(item.path)).isSymbolicLink() || digest(await readFile(item.path)) !== item.sha256) throw new Error('Claude lifecycle evidence changed.');
    }
  }
  async observe(job, cwd, signal) {
    await this.audit(job);
    if (!job.cli.session_id || !job.cli.short_id) throw new Error('Claude launch has no observed UUID binding; inspect retained launch evidence.');
    const observed = await this.match(job.cli.short_id, cwd, job.cli.session_id, signal);
    job.cli.observed = observed;
    if (job.cli.unexpected_copy) {
      if (!uuid(job.cli.unexpected_copy.session_id)) throw new Error('Unexpected Claude copy binding is unverified; retained emitted ID cannot authorize cleanup or success.');
      const copy = await this.match(job.cli.unexpected_copy.id,cwd,job.cli.unexpected_copy.session_id, signal);
      job.cli.copy_frozen = job.cli.copy_frozen && ['done','stopped'].includes(copy.state) && copy.pid === null && [null,'idle'].includes(copy.status);
      if (!job.cli.copy_frozen) throw new Error('Unexpected Claude copy is not affirmatively frozen.');
    }
    if (job.cli.frozen && !(['done','stopped'].includes(observed.state) && observed.pid === null && (observed.status === null || observed.status === 'idle'))) {
      job.cli.frozen = false;
      throw new Error('Previously stopped Claude writer is no longer affirmatively frozen.');
    }
    return observed;
  }
  async stop(job, cwd) {
    const observed = await this.observe(job, cwd);
    const result = await this.evidence(job, 'stop', ['stop', observed.id], cwd);
    job.cli.frozen = false;
    if (result.returncode !== 0 || result.stdout.trim() !== `stopped ${observed.id}`) throw new Error('Exact Claude stop not acknowledged; retained stop evidence.');
    const stopped = await this.match(observed.id, cwd, observed.session_id);
    if (!['done','stopped'].includes(stopped.state) || stopped.pid !== null || ![null,'idle'].includes(stopped.status)) throw new Error('Claude stop acknowledged but lifecycle is not frozen.');
    job.cli.frozen = true; job.cli.observed = stopped; job.status = observedStatus(stopped);
    return stopped;
  }
  async start(job, cwd, prompt, checks) {
    await this.capabilities(cwd, job.requested.effort);
    if (/[*?\[\]()\r\n]/.test(cwd + job.cli.directory + job.cli.report_directory)) throw new Error('Claude cwd/control paths contain permission-rule metacharacters.');
    const allows = ['Read','Glob','Grep'];
    // Like native GPT ownership, owned_paths guides assignment/scheduling, not
    // per-file permissions. The CLI boundary is the managed repository.
    allows.push(`Edit(/${cwd}/**)`, `Write(/${cwd}/**)`);
    // Saved permissions survive resume. Only pending reports get a stable bounded
    // directory allow; requests, evidence and validated final reports never do.
    allows.push(`Edit(/${job.cli.report_directory}/**)`, `Write(/${job.cli.report_directory}/**)`, ...checks.map(c => `Bash(${c})`));
    const denies = ['Agent','Task','Bash(git push *)','Bash(git -C * push *)','Bash(gh *)','Bash(glab *)','Bash(curl *)','Bash(wget *)',
      ...['.git','.astraeus'].flatMap(path => [`Edit(/${cwd}/${path})`, `Edit(/${cwd}/${path}/**)`, `Write(/${cwd}/${path})`, `Write(/${cwd}/${path}/**)`])];
    // No broad Edit/Write allow on the control directory: only this pending report.
    const settings = {permissions:{defaultMode:'dontAsk', allow:allows, deny:denies}, worktree:{bgIsolation:'none'}};
    const args = ['--bg','--safe-mode','--model','claude-opus-5-5','--effort',job.requested.effort,'--permission-mode','dontAsk','--setting-sources','','--settings',JSON.stringify(settings),'--tools','Read,Edit,Write,Glob,Grep,Bash','--allowedTools',...allows,'--disallowedTools',...denies,'--add-dir',job.cli.directory,'--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--',prompt];
    await this.preflight(cwd);
    const result = await this.evidence(job, 'launch', args, cwd);
    if (result.returncode !== 0) throw new Error('Claude background launch failed; inspect retained stdout/stderr/exit, no blind retry.');
    const short = launchId(result.stdout);
    job.cli.short_id = short;
    const observed = await this.match(short, cwd);
    job.cli.session_id = observed.session_id; job.cli.observed = observed; job.agent_id = `claude:${observed.session_id}`; job.status = observedStatus(observed);
  }
  async resume(job, cwd, prompt) {
    // Live idle/done sessions also copy on --resume in 2.1.288: stop first.
    await this.stop(job, cwd);
    await this.preflight(cwd);
    const result = await this.evidence(job, 'resume', ['--bg','--resume',job.cli.session_id,'--',prompt], cwd);
    job.cli.frozen = false;
    if (result.returncode !== 0) throw new Error('Claude resume failed; retained evidence, no retry.');
    const short = launchId(result.stdout);
    if (short !== job.cli.short_id) {
      // Retain failure provenance before inspection or cleanup can throw. A later
      // public record must not retroactively bind this unverified emitted writer.
      job.cli.unexpected_copy = {id:short, session_id:null};
      job.cli.copy_frozen = false;
    }
    // Same-short replies must prove the saved full UUID at the binding boundary.
    // A different emitted short ID is inspected only for exact copy cleanup below.
    const resumed = await this.match(short,cwd,short === job.cli.short_id ? job.cli.session_id : undefined);
    if (short !== job.cli.short_id || resumed.session_id !== job.cli.session_id) {
      // Only stop the exact emitted copy after verifying UUID/cwd; never rebind owner.
      const copy = resumed;
      job.cli.unexpected_copy = copy;
      const stopped = await this.evidence(job, 'stop-unexpected-copy', ['stop',copy.id], cwd);
      if (stopped.returncode !== 0 || stopped.stdout.trim() !== `stopped ${copy.id}`) throw new Error('Unexpected Claude copy could not be stopped; retained evidence.');
      const frozen = await this.match(copy.id, cwd, copy.session_id);
      job.cli.copy_frozen = ['done','stopped'].includes(frozen.state) && frozen.pid === null && [null,'idle'].includes(frozen.status);
      throw new Error('Claude resume copied the owner; exact unexpected copy stopped, inspect changes before recovery.');
    }
    job.cli.observed = resumed; job.status = observedStatus(resumed);
  }
}

export function validatePaths(paths) {
  if (!Array.isArray(paths) || !paths.length || new Set(paths).size !== paths.length || paths.some(p => typeof p !== 'string' || !p || p.startsWith('/') || p.split('/').some(x => x === '..' || x === '.git') || /[\\*?\[\]()\r\n]/.test(p) || (p !== '.' && p !== p.split('/').filter(x => x && x !== '.').join('/')))) throw new Error('Designer owned_paths must be normalized literal paths (or .), not globs or Git metadata.');
}
export function validateChecks(checks) {
  if (!Array.isArray(checks) || new Set(checks).size !== checks.length || checks.some(c => typeof c !== 'string' || !c.trim() || /[*?\[\]();&|$`<>\r\n]/.test(c) || /\b(?:gh|glab|curl|wget|rm)\b|\bgit\b.*\b(?:push|commit)\b/.test(c))) throw new Error('Designer checks must be unique simple verification commands, not shell operators or publication.');
}
// Snapshot actual content, index and ignored output, not merely dirty path names.
export async function snapshot(cwd) {
  const git = async args => {
    const result = await capture('git', args, cwd);
    if (result.returncode !== 0) throw new Error(result.stderr || 'Git baseline failed');
    return result.stdout;
  };
  const paths = new Set();
  for (const args of [['ls-files','--cached','-z'],['ls-files','--others','--exclude-standard','-z'],['ls-files','--others','--ignored','--exclude-standard','-z']]) for (const p of (await git(args)).split('\0').filter(Boolean)) paths.add(p);
  const files = {};
  for (const p of [...paths].sort()) {
    const path = join(cwd,p);
    let stat; try { stat = await lstat(path); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (stat.isDirectory()) throw new Error(`Submodule/directory baseline unsupported: ${p}`);
    const parent = await realpath(resolve(path,'..'));
    const rel = relative(await realpath(cwd), parent);
    if (isAbsolute(rel) || rel === '..' || rel.startsWith('../')) throw new Error(`Baseline path escapes cwd: ${p}`);
    files[p] = `${stat.mode}:${digest(stat.isSymbolicLink() ? await readlink(path) : await readFile(path))}`;
  }
  const head = await capture('git',['rev-parse','--verify','HEAD'],cwd);
  const dirty = new Set();
  for (const args of [['diff','--name-only','--no-renames','--no-ext-diff','--no-textconv','-z'],['diff','--cached','--name-only','--no-renames','--no-ext-diff','--no-textconv','-z'],['ls-files','--others','--exclude-standard','-z']]) for (const p of (await git(args)).split('\0').filter(Boolean)) dirty.add(p);
  return {files, head:head.returncode === 0 ? head.stdout.trim() : null, index:await git(['ls-files','--stage','-z']), dirty:[...dirty].sort()};
}
// Observational only: shared-cwd changes cannot be attributed to one owner.
// Root judges scope, user-work preservation and staging/history in final review.
export function delta(before, after) {
  return [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])].filter(p => before.files[p] !== after.files[p]).sort();
}
export async function publish(pending, final, bytes) {
  if ((await lstat(pending)).isSymbolicLink() || !Buffer.from(await readFile(pending)).equals(Buffer.from(bytes))) throw new Error('Pending implementation result changed.');
  // Exclusive link publishes precisely validated bytes, never overwrites a final report.
  await link(pending, final);
  // Do not leave a writable pending hardlink alias to the root-owned final report.
  await unlink(pending);
}
