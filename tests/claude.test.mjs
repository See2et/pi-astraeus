import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, cp, writeFile, readFile, rm, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {parseFrontmatter} from '@earendil-works/pi-coding-agent';
import {Workflow, ROOT} from '../extensions/core.mjs';
import {ClaudeBackground, launchId} from '../extensions/claude.mjs';
import {ClaudeTrustPreflight} from '../extensions/claude-trust.mjs';

const ID = '12345678-1111-2222-3333-444444444444', COPY = 'abcdef12-1111-2222-3333-444444444444';
const auth = {design_request:'Use Claude to design and implement this UI', design_scope:'design-direction-and-ui-implementation'};
const help = '--bg --resume --model --safe-mode --settings --setting-sources --permission-mode --allowedTools --disallowedTools --tools --add-dir --strict-mcp-config --mcp-config\n--effort <value> low medium high xhigh max';
async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(),'astraeus-cli-')); t.after(()=>rm(base,{recursive:true,force:true}));
  const home = join(base,'home'), cwd = join(home,'ghq','repo'), agentDir = join(base,'agent'), config = join(home,'.claude.json');
  await mkdir(cwd,{recursive:true}); await mkdir(agentDir); await cp(join(ROOT,'agents'),join(agentDir,'agents'),{recursive:true});
  execFileSync('git',['init','-q'],{cwd});
  await writeFile(join(cwd,'ui.txt'),'initial'); await writeFile(join(cwd,'user.txt'),'user initial'); await writeFile(join(cwd,'.gitignore'),'build/\n');
  execFileSync('git',['add','.'],{cwd}); execFileSync('git',['-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','fixture'],{cwd});
  await writeFile(join(cwd,'user.txt'),'existing user changes');
  const entries = [], calls = [], state = {records:[],launchOutput:null,failLaunch:false,failStop:false,copy:false,afterStop:null,manual:false};
  const trust = new ClaudeTrustPreflight({home,env:process.env.CLAUDE_CONFIG_DIR === undefined ? process.env : {...process.env,CLAUDE_CONFIG_DIR:undefined},processes:async()=>{}});
  const cli = new ClaudeBackground({trust,invoke:async (command,args,dir)=>{
    assert.equal(command,'claude'); assert.equal(dir,cwd); calls.push([...args]);
    const ok = stdout=>({returncode:0,stdout,stderr:''});
    if (args[0] === '--help') return ok(help);
    if (args[0] === 'agents' && args[1] === '--help') return ok('--json --all');
    if (args[0] === 'stop' && args[1] === '--help') return ok('stop <id>');
    if (args[0] === 'agents') return ok(JSON.stringify(state.records));
    if (args[0] === 'stop') {
      if (state.failStop) return {returncode:1,stdout:'',stderr:'fixture stop denied'};
      const record = state.records.find(r=>r.id === args[1]);
      assert.ok(record); record.state = 'done'; delete record.status; delete record.pid;
      if (state.afterStop) await state.afterStop();
      return ok(`stopped ${args[1]}\n`);
    }
    assert.equal(args[0],'--bg');
    if (!state.manual) assert.equal(JSON.parse(await readFile(config,'utf8')).projects[cwd].hasTrustDialogAccepted,true,'GPT preflight must publish exact trust before every mock background launch');
    if (state.failLaunch) return {returncode:1,stdout:'',stderr:'Workspace not trusted'};
    const resume = args[1] === '--resume';
    if (resume) {
      assert.deepEqual(args.slice(0,4),['--bg','--resume',ID,'--']);
      assert.equal(state.records.find(r=>r.sessionId === ID).pid,undefined,'Must stop live idle/done owner before resume');
    } else {
      assert.ok(args.includes('--safe-mode')); assert.ok(args.includes('claude-opus-5-5'));
      assert.ok(!args.includes('--session-id')); assert.ok(!args.includes('-p'));
      assert.ok(!args.some(a=>a.includes('dangerously-skip-permissions')));
    }
    const id = resume && state.copy ? COPY : ID;
    const record = {id:id.slice(0,8),sessionId:id,cwd,state:'working',status:'running',pid:123};
    state.records = state.records.filter(r=>r.id !== record.id); state.records.push(record);
    return ok(state.launchOutput ?? `backgrounded · ${record.id} · Claude\n`);
  }});
  const host = {agentDir:()=>agentDir,manager:()=>undefined,parseFrontmatter,supportedThinking:()=>['high'],appendEntry:(customType,data)=>entries.push({type:'custom',customType,data:structuredClone(data)}),events:{on(){throw Error('Designer must not use RPC');},emit(){throw Error('Designer must not use RPC');}}};
  const ctx = {cwd,hasUI:false,sessionManager:{getSessionId:()=> 'fixture',getBranch:()=>entries},modelRegistry:{getAvailable:()=>[]}};
  const workflow = new Workflow(host,{claude:cli});
  const act = params=>workflow.execute({task_id:'design',...params},ctx);
  await act({op:'start',requirements:'Authorized UI work',acceptance:'Owned delta and checks',...auth});
  const delegate = extra=>act({op:'delegate',role:'designer',model:'anthropic/claude-opus-5-5',thinking:'high',design_scope:auth.design_scope,prompt:'Implement UI within scope',owned_paths:['ui.txt'],...extra});
  const report = async (job,extra={})=>{
    const data = {schema_version:1,kind:'implementation',task_id:'design',run_id:job.run_id,target_id:job.cli.dispatch_target,status:'complete',summary:'Designed UI',changed_files:['ui.txt'],checks:job.cli.checks.map(command=>({command,outcome:'passed',evidence:'Fixture verification'})),remaining:[],...extra};
    await writeFile(job.cli.pending,JSON.stringify(data));
  };
  const idle = ()=>{ const record=state.records.find(r=>r.sessionId===ID); record.state='done'; record.status='idle'; }; // PID is deliberately still live.
  return {cwd,home,config,trust,agentDir,workflow,ctx,act,delegate,report,idle,state,calls,host,cli};
}

test('documented unique launch short ID only; unknown/ambiguous output fails closed',()=>{
  assert.equal(launchId('\x1b[32mbackgrounded · 12345678 · Foo\x1b[0m\n'),'12345678');
  for (const value of ['session 12345678','backgrounded · 12345678\nbackgrounded · abcdef12\n','backgrounded · not-a-uuid']) assert.throws(()=>launchId(value),/Unknown or ambiguous/);
});
test('public CLI lifecycle binds observed UUID, preserves user baseline, freezes before collection, restores and resumes same owner',async t=>{
  const f=await fixture(t), job=await f.delegate({checks:['npm test']});
  assert.equal(job.cli.session_id,ID); assert.equal(f.workflow.activeJobs(f.cwd).length,1);
  await f.act({op:'start',task_id:'other',requirements:'Other work',acceptance:'Verified'});
  await assert.rejects(f.act({op:'delegate',task_id:'other',role:'designer',model:'anthropic/claude-opus-5-5',thinking:'high',prompt:'Unauthorized',design_scope:auth.design_scope}),/authorization/);
  await writeFile(join(f.cwd,'ui.txt'),'designed'); await f.report(job); f.idle();
  const collected=await f.act({op:'collect',run_id:job.run_id});
  assert.equal(collected.valid,true,collected.error); assert.equal(job.cli.frozen,true);
  assert.ok(job.cli.evidence.some(e=>e.kind==='stop')); assert.equal(f.workflow.activeJobs(f.cwd).length,0);
  assert.equal(await readFile(join(f.cwd,'user.txt'),'utf8'),'existing user changes');
  const restored=new Workflow(f.host,{claude:f.cli}); restored.restore(f.ctx);
  assert.equal(restored.tasks.design.jobs[0].transport,'claude-code-bg-v1');
  assert.equal((await restored.execute({op:'status',task_id:'design'},f.ctx))[0].jobs[0].status,'stopped');
  const follow=await restored.execute({op:'resume',task_id:'design',run_id:job.run_id,prompt:'Fix bounded UI overflow'},f.ctx);
  assert.equal(follow.agent_id,job.agent_id); assert.notEqual(follow.cli.pending,job.cli.pending);
  assert.equal(follow.cli.report_directory,job.cli.report_directory);
  const args=f.calls.find(a=>a[0]==='--bg'&&a.includes('--settings'));
  const settings=JSON.parse(args[args.indexOf('--settings')+1]);
  assert.ok(settings.permissions.allow.includes(`Write(/${follow.cli.report_directory}/**)`));
  await assert.rejects(readFile(job.cli.pending),/ENOENT/); // no writable hardlink to final
  assert.notEqual(follow.cli.dispatch_target,job.cli.dispatch_target);
  f.idle();
  // Prior report cannot complete the new run.
  const missing=await restored.execute({op:'collect',task_id:'design',run_id:follow.run_id},f.ctx);
  assert.equal(missing.valid,false); assert.match(missing.error,/ENOENT/);
  await f.report(follow,{changed_files:[],run_id:job.run_id});
  assert.match((await restored.execute({op:'collect',task_id:'design',run_id:follow.run_id},f.ctx)).error,/run binding/);
  await writeFile(join(f.cwd,'ui.txt'),'fixed'); await f.report(follow);
  const fixed=await restored.execute({op:'collect',task_id:'design',run_id:follow.run_id},f.ctx); assert.equal(fixed.valid,true,fixed.error);
  await assert.rejects(restored.execute({op:'resume',task_id:'design',run_id:job.run_id,prompt:'Stale run'},f.ctx),/latest run/);
});
test('outside canonical ghq retains manual-trust launch and never reads/modifies config',async t=>{
  const f=await fixture(t); f.trust.home=f.agentDir; f.state.manual=true;
  const bytes='not-json:FAKE'; await writeFile(f.config,bytes,{mode:0o600});
  const job=await f.delegate(); assert.equal(job.cli.session_id,ID); assert.equal(await readFile(f.config,'utf8'),bytes);
  assert.equal(f.calls.filter(a=>a[0]==='--bg').length,1);
});
test('start preflight blocks active/unknown sessions without config overwrite, launch or unrelated stop',async t=>{
  const f=await fixture(t); const bytes='{"authFixture":"FAKE"}'; await writeFile(f.config,bytes,{mode:0o600});
  f.state.records=[{id:'abcdef12',sessionId:COPY,cwd:f.cwd,state:'working',status:'running',pid:321}];
  await assert.rejects(f.delegate(),/active or unknown/);
  assert.equal(await readFile(f.config,'utf8'),bytes);
  assert.equal(f.calls.filter(a=>a[0]==='--bg'||a[0]==='stop'&&a[1]!=='--help').length,0);
});
test('resume takes fresh trust snapshot after stop saves config, preserving saved flags and UUID',async t=>{
  const f=await fixture(t),job=await f.delegate(); await f.report(job,{changed_files:[]}); f.idle();
  assert.equal((await f.act({op:'collect',run_id:job.run_id})).valid,true);
  f.state.afterStop=async()=>writeFile(f.config,JSON.stringify({authFixture:{fresh:'FAKE'},projects:{[f.cwd]:{hasTrustDialogAccepted:false,allowedTools:['Read']}}}),{mode:0o600});
  const follow=await f.act({op:'resume',run_id:job.run_id,prompt:'Bounded fix'});
  assert.equal(follow.cli.session_id,ID);
  assert.deepEqual(JSON.parse(await readFile(f.config,'utf8')),{authFixture:{fresh:'FAKE'},projects:{[f.cwd]:{hasTrustDialogAccepted:true,allowedTools:['Read']}}});
  const launch=f.calls.findIndex(a=>a[0]==='--bg');
  assert.ok(f.calls.slice(0,launch).some(a=>a[0]==='agents'&&a[1]==='--json'));
  const resumeArgs=f.calls.filter(a=>a[0]==='--bg').at(-1);
  assert.equal(resumeArgs.length,5); assert.deepEqual(resumeArgs.slice(0,4),['--bg','--resume',ID,'--']);
});
test('resume preflight failure leaves exact owner stopped and never launches or changes unsafe config',async t=>{
  const f=await fixture(t),job=await f.delegate(); await f.report(job,{changed_files:[]}); f.idle();
  assert.equal((await f.act({op:'collect',run_id:job.run_id})).valid,true);
  const bytes='{"authFixture":"FAKE",'; f.state.afterStop=async()=>writeFile(f.config,bytes);
  const count=f.calls.filter(a=>a[0]==='--bg').length;
  await assert.rejects(f.act({op:'resume',run_id:job.run_id,prompt:'Bounded fix'}),/invalid JSON/);
  assert.equal(f.calls.filter(a=>a[0]==='--bg').length,count); assert.equal(await readFile(f.config,'utf8'),bytes);
  assert.equal(f.state.records.find(r=>r.sessionId===ID).state,'done');
});
test('launch failure retains stdout stderr exit and never blindly retries or falls back',async t=>{
  const f=await fixture(t); f.state.failLaunch=true;
  await assert.rejects(f.delegate(),/launch failed/);
  const job=f.workflow.tasks.design.jobs[0], launch=job.cli.evidence.find(e=>e.kind==='launch');
  const evidence=JSON.parse(await readFile(launch.path)); assert.equal(evidence.returncode,1); assert.match(evidence.stderr,/not trusted/);
  const failed=await f.act({op:'collect',run_id:job.run_id}); assert.equal(failed.valid,false);
  assert.equal(f.calls.filter(a=>a[0]==='--bg').length,1); assert.equal(f.workflow.activeJobs(f.cwd).length,1);
});
test('unknown/missing/changed-cwd session cannot collect, accept, or be declared done',async t=>{
  const f=await fixture(t),job=await f.delegate(); await f.report(job,{changed_files:[]});
  f.state.records[0].state='mystery'; delete f.state.records[0].status;
  assert.equal((await f.act({op:'collect',run_id:job.run_id})).valid,false);
  f.state.records[0].cwd=f.agentDir;
  assert.match((await f.act({op:'collect',run_id:job.run_id})).error,/binding mismatch/);
  f.state.records=[];
  const status=await f.act({op:'status'}); assert.equal(status[0].jobs[0].status,'unavailable');
  await assert.rejects(f.act({op:'accept'}),/missing/);
  assert.equal(f.workflow.activeJobs(f.cwd).length,1);
});
for (const mode of ['outside','ignored','dirty','files','checks','remaining','binding','symlink','stop']) test(`collection rejects ${mode}, retaining failed evidence`,async t=>{
  const f=await fixture(t),job=await f.delegate({checks:['npm test']});
  await writeFile(join(f.cwd,'ui.txt'),'new UI');
  let extra={};
  if(mode==='outside') await writeFile(join(f.cwd,'outside.txt'),'escape');
  if(mode==='ignored') { await mkdir(join(f.cwd,'build')); await writeFile(join(f.cwd,'build/result'),'output'); }
  if(mode==='dirty') await writeFile(join(f.cwd,'user.txt'),'clobbered');
  if(mode==='files') extra={changed_files:[]};
  if(mode==='checks') extra={checks:[]};
  if(mode==='remaining') extra={remaining:['unfinished']};
  if(mode==='binding') extra={target_id:'wrong'};
  await f.report(job,extra); f.idle();
  if(mode==='symlink') { const path=job.cli.pending; await rm(path); const external=join(f.agentDir,'report'); await writeFile(external,'{}'); await symlink(external,path); }
  if(mode==='stop') f.state.failStop=true;
  const result=await f.act({op:'collect',run_id:job.run_id}); assert.equal(result.valid,false); assert.ok(result.error); assert.equal(result.artifact,undefined);
  assert.ok(job.cli.evidence.some(e=>e.kind==='stop'));
});
test('overlapping preexisting user changes and symlink scope are refused without changing files',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.delegate({owned_paths:['user.txt']}),/existing user changes/);
  assert.equal(await readFile(join(f.cwd,'user.txt'),'utf8'),'existing user changes'); assert.equal(f.calls.filter(a=>a[0]==='--bg').length,0);
  await symlink(f.agentDir,join(f.cwd,'escape'));
  await assert.rejects(f.delegate({owned_paths:['escape']}),/escapes cwd through symlink/);
});
test('resume copy is stopped exactly, retained and never rebound to original owner',async t=>{
  const f=await fixture(t),job=await f.delegate(); await f.report(job,{changed_files:[]}); f.idle();
  assert.equal((await f.act({op:'collect',run_id:job.run_id})).valid,true);
  f.state.copy=true;
  await assert.rejects(f.act({op:'resume',run_id:job.run_id,prompt:'Same owner fix'}),/copied the owner/);
  const follow=f.workflow.tasks.design.jobs.at(-1);
  assert.equal(follow.cli.session_id,ID); assert.equal(follow.cli.unexpected_copy.session_id,COPY); assert.equal(follow.cli.copy_frozen,true);
  assert.ok(f.calls.some(a=>a[0]==='stop'&&a[1]==='abcdef12'));
  assert.equal(follow.valid,false); assert.equal(f.workflow.activeJobs(f.cwd).length,1);
});
test('capability absence and invalid effort/checks never launch; no Pi Anthropic catalog required',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.delegate({thinking:'off'}),/Unsupported thinking/);
  await assert.rejects(f.delegate({checks:['npm test; curl bad']}),/simple verification/);
  f.cli.invoke=async()=>({returncode:0,stdout:'old cli',stderr:''});
  await assert.rejects(f.delegate(),/capabilities/);
  assert.equal(f.calls.filter(a=>a[0]==='--bg').length,0);
});
test('tampered evidence invalidates collection',async t=>{
  const f=await fixture(t),job=await f.delegate(); await f.report(job,{changed_files:[]}); f.idle(); await f.act({op:'collect',run_id:job.run_id});
  await writeFile(job.cli.evidence.find(e=>e.kind==='stop').path,'{}');
  assert.equal((await f.act({op:'collect',run_id:job.run_id})).valid,false);
  assert.match(job.error,/evidence changed/);
});
test('restored stopped writer that restarts invalidates freeze and remains active',async t=>{
  const f=await fixture(t),job=await f.delegate(); await f.report(job,{changed_files:[]}); f.idle(); await f.act({op:'collect',run_id:job.run_id});
  const restored=new Workflow(f.host,{claude:f.cli}); restored.restore(f.ctx);
  Object.assign(f.state.records[0],{state:'working',status:'running',pid:456});
  const status=await restored.execute({op:'status',task_id:'design'},f.ctx);
  assert.equal(status[0].jobs[0].cli.frozen,false); assert.equal(status[0].jobs[0].valid,false);
  assert.equal(restored.activeJobs(f.cwd).length,1);
});
test('CLI designer integrates with native GPT fresh review/adjudication and current-target acceptance gates',async t=>{
  const f=await fixture(t),native=new Map(),handlers=new Map(); let count=0;
  const events={on(name,fn){const set=handlers.get(name)||new Set(); set.add(fn); handlers.set(name,set); return ()=>set.delete(fn);},emit(name,data){for(const fn of handlers.get(name)||[]) fn(data);}};
  events.on('subagents:rpc:ping',p=>events.emit(`subagents:rpc:ping:reply:${p.requestId}`,{success:true,data:{version:2}}));
  events.on('subagents:rpc:spawn',p=>{
    const id=`gpt-${++count}`; native.set(id,{id,type:p.type,status:'running',session:{model:p.options.model,thinkingLevel:p.options.thinkingLevel}});
    p.options.onSpawned(id); events.emit(`subagents:rpc:spawn:reply:${p.requestId}`,{success:true,data:{id}});
  });
  events.on('subagents:rpc:consume',p=>events.emit(`subagents:rpc:consume:reply:${p.requestId}`,{success:true}));
  f.host.events=events; f.host.manager=()=>({getRecord:id=>native.get(id)});
  f.ctx.modelRegistry={getAvailable:()=>[{provider:'openai',id:'gpt-6.1-sol'}]};
  const reviewer=()=>f.act({op:'delegate',role:'reviewer',model:'openai/gpt-6.1-sol',thinking:'high',prompt:'Fresh independent bounded review'});
  const reviewReport=job=>({schema_version:1,kind:'review',task_id:'design',target_id:job.target_id,status:'complete',summary:'Fixture review',verdict:'pass',violations:[],bugs:[],suggestions:[],checked_scope:['ui.txt'],evidence:['Fixture source inspected'],unresolved:[]});
  const complete=(job,result)=>Object.assign(native.get(job.agent_id),{status:'completed',result:JSON.stringify(result)});
  const job=await f.delegate();
  await assert.rejects(reviewer(),/Freeze writers/); assert.equal(native.size,0);
  await f.act({op:'start',task_id:'other',requirements:'Other UI task',acceptance:'Verified',...auth});
  await assert.rejects(f.act({op:'delegate',task_id:'other',role:'designer',model:'anthropic/claude-opus-5-5',thinking:'high',design_scope:auth.design_scope,prompt:'Overlap',owned_paths:['ui.txt']}),/disjoint/);
  await writeFile(join(f.cwd,'ui.txt'),'designed'); await f.report(job); f.idle(); await f.act({op:'collect',run_id:job.run_id});
  const review=await reviewer(),data=reviewReport(review); data.verdict='changes_required'; data.bugs=[{location:'ui.txt',claim:'Required overflow fix',evidence:'Fixture evidence'}];
  complete(review,data); assert.equal((await f.act({op:'collect',run_id:review.run_id})).valid,true);
  await assert.rejects(f.act({op:'resume',run_id:job.run_id,prompt:'Fix adopted issue'}),/adopted fixes/);
  const judge=await f.act({op:'delegate',role:'adjudicator',model:'openai/gpt-6.1-sol',thinking:'high',prompt:'Fresh independent disposition'});
  assert.notEqual(judge.agent_id,review.agent_id);
  complete(judge,{schema_version:1,kind:'adjudication',task_id:'design',target_id:judge.target_id,status:'complete',summary:'Adopt bounded fix',verdict:'changes_required',review_sha256:review.result_hash,decisions:[{ref:'bugs/0',action:'fix',basis:'Authorized requirement',evidence:'Fixture behavior',rationale:'Required fix'}],checked_scope:['ui.txt'],evidence:['Fixture requirement examined'],unresolved:[]});
  const decision=await f.act({op:'collect',run_id:judge.run_id}); assert.equal(decision.valid,true,decision.error);
  const follow=await f.act({op:'resume',run_id:job.run_id,prompt:'Apply adopted fix'});
  assert.equal(follow.agent_id,job.agent_id); assert.equal(count,2,'Designer resume must not spawn a native child');
  await writeFile(join(f.cwd,'ui.txt'),'fixed'); await f.report(follow); f.idle();
  const fixed=await f.act({op:'collect',run_id:follow.run_id}); assert.equal(fixed.valid,true,fixed.error);
  await assert.rejects(f.act({op:'accept'}),/target changed/);
  const fresh=await reviewer(); assert.notEqual(fresh.agent_id,review.agent_id); complete(fresh,reviewReport(fresh));
  assert.equal((await f.act({op:'collect',run_id:fresh.run_id})).valid,true);
  assert.equal((await f.act({op:'accept'})).accepted,true);
  await writeFile(follow.artifact,'{}'); await assert.rejects(f.act({op:'accept'}),/report bytes changed/);
});
