import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm, symlink, chmod, lstat, readdir, link, rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {ClaudeTrustPreflight, observeClaudeProcesses} from '../extensions/claude-trust.mjs';

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(),'astraeus-trust-')); t.after(async()=>{ await chmod(join(base,'home'),0o700); await rm(base,{recursive:true,force:true}); });
  const home = join(base,'home'), repo = join(home,'ghq','host','repo'), config = join(home,'.claude.json');
  await mkdir(repo,{recursive:true}); execFileSync('git',['init','-q'],{cwd:repo});
  const trust = new ClaudeTrustPreflight({home,env:{PATH:process.env.PATH},processes:async()=>{}});
  const records = async()=>[];
  const put = text=>writeFile(config,text,{mode:0o600});
  const run = (cwd=repo, observe=records)=>trust.run(cwd,observe);
  const artifacts = async()=>assert.deepEqual((await readdir(home)).filter(p=>/astraeus/.test(p)),[]);
  return {base,home,repo,config,trust,records,put,run,artifacts};
}

test('create absent config owner-only; exact canonical key, not parent or unrelated clones',async t=>{
  const f=await fixture(t); await mkdir(join(f.home,'ghq','unrelated'));
  const result=await f.run(); assert.deepEqual(result,{status:'trusted',repo:f.repo});
  assert.deepEqual(JSON.parse(await readFile(f.config,'utf8')),{projects:{[f.repo]:{hasTrustDialogAccepted:true}}});
  assert.equal((await lstat(f.config)).mode & 0o777,0o600); await f.artifacts();
});
test('minimal token replacement preserves unknown nested fields, auth-like fixture sentinels, permissions and number precision',async t=>{
  const f=await fixture(t);
  const text=`{\n "authFixture": {"token":"NOT-REAL-AUTH","nested":[1,{"x":null}]},"large":900719925474099312345,"projects":{${JSON.stringify(f.repo)}:{"hasTrustDialogAccepted": false,"allowedTools":["Read"],"sessionFixture":{"id":"NOT-REAL-SESSION"}},"/unrelated":{"hasTrustDialogAccepted":false}}\n}`;
  await f.put(text); await f.run();
  assert.equal(await readFile(f.config,'utf8'),text.replace('Accepted": false','Accepted": true')); await f.artifacts();
});
for (const initial of ['{}','{"other":{"x":[1,true,null]}}','{"projects":{}}','project']) test(`missing trust insertion preserves original fields (${initial})`,async t=>{
  const f=await fixture(t), text=initial==='project'?JSON.stringify({projects:{[f.repo]:{other:{x:1},allowedTools:[]}},authFixture:'FAKE'}):initial;
  await f.put(text); await f.run(); const before=JSON.parse(text),after=JSON.parse(await readFile(f.config,'utf8'));
  delete after.projects[f.repo].hasTrustDialogAccepted;
  if (!before.projects?.[f.repo]) delete after.projects[f.repo];
  if (!before.projects) delete after.projects;
  assert.deepEqual(after,before); await f.artifacts();
});
test('trusted no-op preserves inode/content/mtime and does not inspect or stop active/unknown sessions',async t=>{
  const f=await fixture(t); const text=JSON.stringify({projects:{[f.repo]:{hasTrustDialogAccepted:true}},authFixture:'FAKE'});
  await f.put(text); const before=await lstat(f.config,{bigint:true});
  f.trust.processes=()=>{throw Error('must not inspect active processes on no-op');};
  assert.equal((await f.run(f.repo,()=>{throw Error('must not inspect sessions on no-op');})).status,'already-trusted');
  const after=await lstat(f.config,{bigint:true}); assert.equal(after.ino,before.ino); assert.equal(after.mtimeNs,before.mtimeNs); assert.equal(await readFile(f.config,'utf8'),text); await f.artifacts();
});
test('canonical ghq/Git boundary: nested cwd/root, symlinks, sibling escapes and external Git parent',async t=>{
  const f=await fixture(t), nested=join(f.repo,'child'); await mkdir(nested);
  await f.run(nested); assert.deepEqual(Object.keys(JSON.parse(await readFile(f.config,'utf8')).projects),[f.repo]);
  await rm(f.config);
  const alias=join(f.home,'ghq','alias'); await symlink(f.repo,alias); await f.run(alias);
  assert.deepEqual(Object.keys(JSON.parse(await readFile(f.config,'utf8')).projects),[f.repo]); await rm(f.config);
  const external=join(f.base,'outside'); await mkdir(external); execFileSync('git',['init','-q'],{cwd:external});
  const escaped=join(f.home,'ghq','escape'); await symlink(external,escaped);
  const sibling=join(f.home,'ghq-sibling'); await mkdir(sibling); execFileSync('git',['init','-q'],{cwd:sibling});
  for (const cwd of [external,escaped,sibling,f.home]) assert.deepEqual(await f.run(cwd),{status:'manual'});
  // Directory is inside ghq, but its discovered Git root is the home directory.
  execFileSync('git',['init','-q'],{cwd:f.home}); const inherited=join(f.home,'ghq','not-a-repo'); await mkdir(inherited);
  assert.deepEqual(await f.run(inherited),{status:'manual'}); await assert.rejects(readFile(f.config),/ENOENT/);
  execFileSync('git',['init','-q'],{cwd:nested}); await f.run(nested);
  assert.deepEqual(Object.keys(JSON.parse(await readFile(f.config,'utf8')).projects),[nested]);
});
test('canonical ghq itself may be a symlink but must never alias home/filesystem; Git env cannot manufacture root',async t=>{
  const f=await fixture(t); await rename(join(f.home,'ghq'),join(f.base,'canonical-ghq')); await symlink(join(f.base,'canonical-ghq'),join(f.home,'ghq'));
  const canonical=join(f.base,'canonical-ghq','host','repo');
  f.trust.env.GIT_WORK_TREE=f.home; f.trust.env.GIT_DIR=join(f.home,'.git');
  await f.run(f.repo); assert.deepEqual(Object.keys(JSON.parse(await readFile(f.config,'utf8')).projects),[canonical]);
  await rm(join(f.home,'ghq')); await symlink(f.home,join(f.home,'ghq'));
  const child=join(f.home,'child-repo'); await mkdir(child); execFileSync('git',['init','-q'],{cwd:child});
  await assert.rejects(f.run(child),/unsafe canonical ghq/); // never trust all of home
});
for (const text of ['{"authFixture":"SECRET-SENTINEL",', 'null','[]','{"projects":null}','{"projects":[]}','{"projects":{"x":false}}','{"projects":{},"projects":{}}','{"nested":{"x":1,"\\u0078":2}}','{"x":NaN}','{"x":1,}','{"x":[1,]}','bad-trust']) test(`invalid JSON/shape fails without secret output or overwrite (${text === 'bad-trust' ? text : text.slice(0,16)})`,async t=>{
  const f=await fixture(t), bytes=text==='bad-trust'?JSON.stringify({projects:{[f.repo]:{hasTrustDialogAccepted:'SECRET-SENTINEL'}}}):text;
  await f.put(bytes); await assert.rejects(f.run(),e=>{ assert.match(e.message,/Claude trust preflight:/); assert.ok(!e.message.includes('SECRET-SENTINEL')); return true; });
  assert.equal(await readFile(f.config,'utf8'),bytes); await f.artifacts();
});
test('invalid UTF-8 and BOM are refused without silently changing unrelated bytes',async t=>{
  const f=await fixture(t);
  for (const bytes of [Buffer.from([0xff,0x7b,0x7d]),Buffer.from('\ufeff{}')]) {
    await f.put(bytes); await assert.rejects(f.run(),/Claude trust preflight:/);
    assert.deepEqual(await readFile(f.config),bytes); await f.artifacts();
  }
});
for (const mode of ['symlink','nix-symlink','readonly','public','hardlink','directory','parent-readonly','parent-writable','override']) test(`unsafe config ${mode} is refused without reset`,async t=>{
  const f=await fixture(t); const text='{"authFixture":"FAKE"}';
  if (mode==='symlink') { const target=join(f.base,'target'); await writeFile(target,text,{mode:0o600}); await symlink(target,f.config); }
  else if (mode==='nix-symlink') await symlink('/nix/store/nonexistent-fixture',f.config);
  else if (mode==='directory') await mkdir(f.config);
  else await f.put(text);
  if (mode==='readonly') await chmod(f.config,0o400);
  if (mode==='public') await chmod(f.config,0o644);
  if (mode==='hardlink') await link(f.config,join(f.base,'alias'));
  if (mode==='parent-readonly') await chmod(f.home,0o500);
  if (mode==='parent-writable') await chmod(f.home,0o777);
  if (mode==='override') f.trust.env.CLAUDE_CONFIG_DIR=join(f.base,'override');
  await assert.rejects(f.run(),/Claude trust preflight:/);
  if (!['nix-symlink','directory'].includes(mode)) assert.equal(await readFile(f.config,'utf8'),text);
  await f.artifacts();
});
for (const observation of ['active','unknown-state','unknown-format','listing-failed','process-active','process-unknown']) test(`needed mutation blocks ${observation}`,async t=>{
  const f=await fixture(t); await f.put('{}');
  let records=f.records;
  const stopped={cwd:f.repo,sessionId:'12345678-1111-2222-3333-444444444444',state:'done',pid:null,status:'idle'};
  if (observation==='active') records=async()=>[{...stopped,pid:123}];
  if (observation==='unknown-state') records=async()=>[{...stopped,state:'mystery'}];
  if (observation==='unknown-format') records=async()=>({sessions:[]});
  if (observation==='listing-failed') records=async()=>{throw Error('SECRET-SENTINEL');};
  if (observation.startsWith('process-')) f.trust.processes=async()=>{throw Error('SECRET-SENTINEL');};
  await assert.rejects(f.run(f.repo,records),e=>{ assert.ok(!e.message.includes('SECRET-SENTINEL')); return true; });
  assert.equal(await readFile(f.config,'utf8'),'{}'); await f.artifacts();
});
test('process census rejects active interactive/background Claude and incomplete visibility without inference',async()=>{
  const options={platform:'linux',pid:999,execute:async command=>({stdout:command==='findmnt'?'rw,nosuid,nodev':'1 init /sbin/init\n2 node node test.mjs\n'})};
  await observeClaudeProcesses(options);
  for (const line of ['10 claude claude --bg','10 .claude-wrapped /nix/store/pkg/bin/.claude-wrapped','10 node node /pkg/@anthropic-ai/claude-code/cli.js','10 bash bash -c claude','incomplete']) {
    await assert.rejects(observeClaudeProcesses({...options,execute:async command=>({stdout:command==='findmnt'?'rw':line})}),/active|incomplete/);
  }
  await assert.rejects(observeClaudeProcesses({...options,platform:'win32'}),/unavailable/);
  await assert.rejects(observeClaudeProcesses({...options,execute:async()=>({stdout:'rw,hidepid=2'})}),/incomplete/);
  await assert.rejects(observeClaudeProcesses({...options,execute:async()=>({stdout:''})}),/incomplete/);
});

test('Darwin observes native untruncated ps only, reusing active/incomplete guards',async()=>{
  const observe = stdout=>observeClaudeProcesses({platform:'darwin',pid:999,execute:async(command,args)=>{
    assert.equal(command,'ps','Darwin must not invoke findmnt or inspect procfs');
    assert.deepEqual(args,['-A','-ww','-o','pid=','-o','comm=','-o','command=']);
    return {stdout};
  }});
  await observe('1 /sbin/launchd /sbin/launchd\n2 /usr/bin/node node test.mjs\n999 node node fixture\n');
  for (const stdout of ['10 claude claude --bg','10 /usr/local/bin/claude /usr/local/bin/claude --resume id','10 node node /pkg/@anthropic-ai/claude-code/cli.js','', '10 claude', 'unparseable']) {
    await assert.rejects(observe(stdout),/active|incomplete/);
  }
});
test('Darwin observation failure blocks trust publication; mock native ps permits otherwise-safe update',async t=>{
  const f=await fixture(t); await f.put('{}');
  for (const output of ['10 claude claude','incomplete',null]) {
    f.trust.processes=()=>observeClaudeProcesses({platform:'darwin',execute:async()=>{
      if (output===null) throw Error('PRIVATE-FIXTURE-ERROR'); return {stdout:output};
    }});
    await assert.rejects(f.run(),e=>{ assert.ok(!e.message.includes('PRIVATE-FIXTURE-ERROR')); return true; });
    assert.equal(await readFile(f.config,'utf8'),'{}'); await f.artifacts();
  }
  let observations=0;
  f.trust.processes=()=>observeClaudeProcesses({platform:'darwin',execute:async command=>{
    assert.equal(command,'ps'); observations++; return {stdout:'1 launchd /sbin/launchd\n'};
  }});
  assert.equal((await f.run()).status,'trusted'); assert.equal(observations,2); await f.artifacts();
});

test('cooperative contention and noncooperating observed writes block publication without deleting another lock',async t=>{
  const f=await fixture(t); await f.put('{}'); const lock=f.config+'.astraeus-trust.lock'; await writeFile(lock,'held',{mode:0o600});
  await assert.rejects(f.run(),/lock unavailable/); assert.equal(await readFile(lock,'utf8'),'held'); await rm(lock);
  for (const when of ['records','processes-first','processes-second','metadata','create']) {
    await f.put('{}'); let n=0; const newer='{"authFixture":"NEW-FAKE"}';
    const records=async()=>{ if (when==='records') await f.put(newer); return []; };
    f.trust.processes=async()=>{ n++; if (when===`processes-${n===1?'first':'second'}` || (when==='create' && n===2)) await f.put(newer); if (when==='metadata' && n===2) await chmod(f.config,0o400); };
    if (when==='create') await rm(f.config);
    await assert.rejects(f.run(f.repo,records),/changed|concurrent|regular/);
    assert.equal(await readFile(f.config,'utf8'),when==='metadata'?'{}':newer);
    if (when==='metadata') await chmod(f.config,0o600); await f.artifacts();
  }
});
