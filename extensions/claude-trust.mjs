// Narrow GPT-owned workspace trust preflight. Never returns config bytes/values.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {homedir} from 'node:os';
import {constants} from 'node:fs';
import {open, lstat, realpath, rename, link, unlink} from 'node:fs/promises';
import {join, relative, isAbsolute, dirname} from 'node:path';
import {randomUUID} from 'node:crypto';

const exec = promisify(execFile);
const fail = message => { throw new Error(`Claude trust preflight: ${message}`); };
const inside = (parent, child) => { const r = relative(parent, child); return !!r && !isAbsolute(r) && r !== '..' && !r.startsWith('../'); };
const nix = path => path === '/nix/store' || path.startsWith('/nix/store/');
const same = (a, b) => a === null || b === null ? a === b : ['dev','ino','mode','uid','gid','nlink','size','mtimeNs','ctimeNs'].every(k => a[k] === b[k]);
const sameSnapshot = (a, b) => same(a.stat, b.stat) && a.text === b.text;

// Retain token spans, not a stringify round trip (large numbers and unrelated
// formatting must survive). Reject duplicate decoded keys at every depth.
function parse(text) {
  let i = 0;
  const ws = () => { while (/[ \t\r\n]/.test(text[i] ?? '\0')) i++; };
  const string = () => {
    const start = i;
    if (text[i++] !== '"') fail('invalid JSON.');
    while (i < text.length) {
      const c = text[i++];
      if (c === '\\') i++;
      else if (c === '"') {
        try { return JSON.parse(text.slice(start, i)); } catch { fail('invalid JSON.'); }
      }
    }
    fail('invalid JSON.');
  };
  const value = (depth = 0) => {
    if (depth > 128) fail('JSON nesting exceeds the supported bound.');
    ws(); const start = i, c = text[i];
    if (c === '{' || c === '[') {
      i++; ws(); const object = c === '{', end = object ? '}' : ']', fields = new Map();
      let count = 0;
      if (text[i] !== end) while (true) {
        let key;
        if (object) { key = string(); ws(); if (text[i++] !== ':') fail('invalid JSON.'); if (fields.has(key)) fail('duplicate JSON keys.'); }
        const node = value(depth + 1); if (object) fields.set(key, node); count++;
        ws(); if (text[i] === end) break;
        if (text[i++] !== ',') fail('invalid JSON.'); ws();
      }
      if (text[i++] !== end) fail('invalid JSON.');
      return {start, end:i, type:object ? 'object' : 'array', fields, count};
    }
    if (c === '"') { string(); return {start, end:i, type:'string'}; }
    const token = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(i))?.[0];
    if (!token) fail('invalid JSON.'); i += token.length;
    return {start, end:i, type:token === 'true' || token === 'false' ? 'boolean' : 'primitive'};
  };
  const root = value(); ws(); if (i !== text.length) fail('invalid JSON.'); return root;
}
function patch(text, repo) {
  const root = parse(text);
  const object = node => { if (node.type !== 'object') fail('invalid config object shape.'); };
  object(root);
  const projects = root.fields.get('projects');
  const insert = (node, key, value) => text.slice(0, node.end - 1) + (node.count ? ',' : '') + JSON.stringify(key) + ':' + value + text.slice(node.end - 1);
  if (!projects) return insert(root, 'projects', JSON.stringify({[repo]:{hasTrustDialogAccepted:true}}));
  object(projects);
  for (const project of projects.fields.values()) object(project);
  const project = projects.fields.get(repo);
  if (!project) return insert(projects, repo, '{"hasTrustDialogAccepted":true}');
  const trust = project.fields.get('hasTrustDialogAccepted');
  if (!trust) return insert(project, 'hasTrustDialogAccepted', 'true');
  if (trust.type !== 'boolean') fail('invalid trust flag shape.');
  if (text.slice(trust.start, trust.end) === 'true') return null;
  return text.slice(0, trust.start) + 'true' + text.slice(trust.end);
}
function safeFile(stat, uid) {
  if (!stat.isFile() || stat.uid !== BigInt(uid) || stat.nlink !== 1n || (stat.mode & 0o177n) !== 0n || (stat.mode & 0o7000n) !== 0n || (stat.mode & 0o600n) !== 0o600n) fail('config must be a regular, owner-only readable/writable file without aliases.');
}
async function snapshot(path, uid) {
  let stat;
  try { stat = await lstat(path, {bigint:true}); } catch (e) { if (e.code === 'ENOENT') return {stat:null, text:'{}'}; throw e; }
  safeFile(stat, uid);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat({bigint:true}); safeFile(before, uid);
    if (!same(stat, before) || before.size > 16n * 1024n * 1024n) fail('config changed or exceeds the supported size bound.');
    const bytes = await file.readFile();
    const text = new TextDecoder('utf-8', {fatal:true, ignoreBOM:true}).decode(bytes);
    if (!same(before, await file.stat({bigint:true})) || !same(before, await lstat(path, {bigint:true}))) fail('config changed while reading.');
    return {stat:before, text};
  } finally { await file.close(); }
}

// Native Linux/Darwin ps observation supplements the public background listing:
// interactive Claude sessions do not necessarily appear there. Incomplete output
// blocks mutation. This observes visible processes, NOT exclusion or a sandbox.
export async function observeClaudeProcesses({execute = exec, platform = process.platform, pid:ownPid = process.pid} = {}) {
  if (!['linux','darwin'].includes(platform)) fail('native process observation unavailable on this platform; trust manually.');
  if (platform === 'linux') {
    // hidepid prevents a complete census even if ps succeeds.
    const mount = await execute('findmnt', ['-n','-o','OPTIONS','/proc']);
    if (!mount.stdout.trim() || /(?:^|,)hidepid=(?!0(?:,|$))/.test(mount.stdout)) fail('process visibility is incomplete.');
  }
  // BSD/macOS ps uses its native command column; -ww requests untruncated argv.
  // Darwin has no findmnt/procfs dependency. Native visibility is not global proof.
  const result = await execute('ps', ['-A','-ww','-o','pid=','-o','comm=','-o',platform === 'darwin' ? 'command=' : 'args='], {maxBuffer:16 * 1024 * 1024});
  const lines = result.stdout.trim().split('\n');
  if (!lines.length || lines.some(line => !/^\s*\d+\s+\S+\s+\S/.test(line))) fail('process observation is incomplete.');
  for (const line of lines) {
    const [, pid, comm, args] = /^\s*(\d+)\s+(\S+)\s+(.+)$/.exec(line);
    if (Number(pid) === ownPid) continue;
    if (/^(?:\.?claude(?:-wrapped)?)(?:$|[-.])/.test(comm) || /(?:^|[\s/])\.?claude(?:-wrapped)?(?:\s|$)|@anthropic-ai\/claude-code/.test(args)) fail('another Claude process is active; close it or trust manually.');
  }
}

export class ClaudeTrustPreflight {
  constructor({home = homedir(), env = process.env, processes = observeClaudeProcesses} = {}) { this.home = home; this.env = env; this.processes = processes; }
  async repository(cwd) {
    const home = await realpath(this.home), dir = await realpath(cwd);
    let ghq;
    try { ghq = await realpath(join(home, 'ghq')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    if (!inside(ghq, dir)) return null;
    if (ghq === home || inside(ghq, home) || nix(ghq)) fail('unsafe canonical ghq boundary.');
    // Git environment overrides must not manufacture a root unrelated to cwd.
    const env = Object.fromEntries(Object.entries(this.env).filter(([key]) => !key.startsWith('GIT_')));
    const result = await exec('git', ['-C',dir,'rev-parse','--show-toplevel'], {env});
    const repo = await realpath(result.stdout.trim());
    if (!inside(ghq, repo)) return null;
    return repo;
  }
  async run(cwd, records) {
    try { return await this.prepare(cwd, records); }
    catch (error) {
      // Never propagate parser snippets, command output, paths, or config values.
      if (error instanceof Error && error.message.startsWith('Claude trust preflight:')) throw error;
      fail('unable to safely establish trust; resolve configuration/visibility manually.');
    }
  }
  async prepare(cwd, records) {
    const repo = await this.repository(cwd);
    if (!repo) return {status:'manual'};
    if (this.env.CLAUDE_CONFIG_DIR !== undefined) fail('CLAUDE_CONFIG_DIR mapping is not established; refusing to update the default config.');
    if (typeof process.getuid !== 'function' || constants.O_NOFOLLOW === undefined) fail('safe file capabilities unavailable.');
    const uid = process.getuid(), home = await realpath(this.home), path = join(home, '.claude.json');
    const parent = await lstat(home, {bigint:true});
    if (nix(home) || !parent.isDirectory() || parent.uid !== BigInt(uid) || (parent.mode & 0o022n) !== 0n || (parent.mode & 0o300n) !== 0o300n) fail('unsafe or read-only config directory.');
    const initial = await snapshot(path, uid);
    if (patch(initial.text, repo) === null) return {status:'already-trusted', repo};
    const lockPath = path + '.astraeus-trust.lock';
    let lock;
    try { lock = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); }
    catch { fail('cooperative trust lock unavailable; do not remove another writer\'s lock.'); }
    const lockStat = await lock.stat({bigint:true});
    let temp = null, tempStat = null;
    try {
      const sessions = await records();
      if (!Array.isArray(sessions) || sessions.some(r => !r || typeof r.cwd !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(r.sessionId ?? r.session_id ?? '') || !['done','stopped'].includes(r.state) || r.pid != null || ![undefined,null,'idle'].includes(r.status))) fail('active or unknown Claude sessions; close them or trust manually.');
      await this.processes();
      // CLI inspection can itself save config. Never merge a stale pre-command snapshot.
      const current = await snapshot(path, uid);
      if (!sameSnapshot(initial, current)) fail('config changed during session observation; retry only after writers are quiescent.');
      const updated = patch(current.text, repo);
      temp = join(home, `.claude.json.astraeus-${randomUUID()}.tmp`);
      const file = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { tempStat = await file.stat({bigint:true}); await file.writeFile(updated); await file.sync(); tempStat = await file.stat({bigint:true}); } finally { await file.close(); }
      // A second process census catches sessions appearing during preparation.
      await this.processes();
      // Directory mtime changes from our lock/temp are expected; compare identity/safety only.
      const now = await lstat(home, {bigint:true});
      if (await realpath(dirname(path)) !== home || now.dev !== parent.dev || now.ino !== parent.ino || now.mode !== parent.mode || now.uid !== parent.uid) fail('config directory changed.');
      if (!sameSnapshot({stat:tempStat, text:updated}, await snapshot(temp, uid))) fail('temporary config changed.');
      if (!sameSnapshot(current, await snapshot(path, uid))) fail('observed concurrent config update; nothing published.');
      // No real shared lock with Claude: a noncooperating write after this comparison
      // can still race rename. Do not claim strict CAS/exclusion.
      if (current.stat === null) await link(temp, path); // exclusive creation, never replace a newly appearing file
      else await rename(temp, path);
      return {status:'trusted', repo};
    } finally {
      // Remove only artifacts we own, never unlink substituted paths.
      if (temp && tempStat) {
        const stat = await lstat(temp, {bigint:true}).catch(() => null);
        if (stat?.dev === tempStat.dev && stat?.ino === tempStat.ino) await unlink(temp);
      }
      await lock.close();
      const stat = await lstat(lockPath, {bigint:true}).catch(() => null);
      if (stat?.dev === lockStat.dev && stat?.ino === lockStat.ino) await unlink(lockPath);
    }
  }
}
