import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseFrontmatter } from '@earendil-works/pi-coding-agent';
import { Workflow, ROOT, ENTRY, exactModel, hash, rpc, parseReport } from '../extensions/core.mjs';
import { ClaudeBackground } from '../extensions/claude.mjs';
import { originalRequest } from '../extensions/generated-output.mjs';

const CLAUDE = {provider:'anthropic',id:'claude-opus-5-5',reasoning:true};
const MODEL = {provider:'openai',id:'gpt-6.1-sol',reasoning:true};
class Bus {
  handlers = new Map();
  on(name, fn) { const values = this.handlers.get(name) || new Set(); values.add(fn); this.handlers.set(name,values); return () => values.delete(fn); }
  emit(name, data) { for (const fn of this.handlers.get(name) || []) fn(data); }
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(),'pi-astraeus-test-'));
  t.after(() => rm(directory,{recursive:true,force:true}));
  const cwd=join(directory,'repo'), agentDir=join(directory,'agent');
  await mkdir(cwd); await mkdir(agentDir); await cp(join(ROOT,'agents'),join(agentDir,'agents'),{recursive:true});
  execFileSync('git',['init','-q'],{cwd});
  await writeFile(join(cwd,'source.txt'),'initial\n');
  const records=new Map(), entries=[], events=new Bus(); let count=0;
  events.on('subagents:rpc:ping', p => events.emit(`subagents:rpc:ping:reply:${p.requestId}`,{success:true,data:{version:2}}));
  events.on('subagents:rpc:spawn', p => {
    const id=`child-${++count}`;
    const record={id,type:p.type,description:p.options.description,isBackground:p.options.isBackground,status:'running',session:{model:p.options.model,thinkingLevel:p.options.thinkingLevel},result:''};
    records.set(id,record); p.options.onSpawned(id);
    events.emit(`subagents:rpc:spawn:reply:${p.requestId}`,{success:true,data:{id}});
  });
  events.on('subagents:rpc:consume', p => events.emit(`subagents:rpc:consume:reply:${p.requestId}`,{success:true}));
  events.on('subagents:rpc:stop', p => {
    records.get(p.agentId).status='stopped'; events.emit(`subagents:rpc:stop:reply:${p.requestId}`,{success:true});
  });
  const host={events,agentDir:()=>agentDir,appendEntry:(customType,data)=>entries.push({type:'custom',customType,data:structuredClone(data)}), manager:()=>({getRecord:id=>records.get(id)}), supportedThinking:()=>['off','low','medium','high'], parseFrontmatter};
  const ctx={cwd,hasUI:false,sessionManager:{getSessionId:()=> 'test-session',getBranch:()=>entries},modelRegistry:{getAvailable:()=>[MODEL, CLAUDE]},executeTool:async (_name,args)=>{
    const record=records.get(args.resume); assert.equal(args.subagent_type,record.type); record.status='running'; record.result=''; return {content:[]};
  }};
  const workflow=new Workflow(host); const act=p=>workflow.execute({task_id:'task',...p},ctx);
  await act({op:'start',requirements:'Preserve existing behavior',acceptance:'Actual local verification passes'});
  const delegate=(role,extra={})=>act({op:'delegate',role,model:'openai/gpt-6.1-sol',thinking:'high',prompt:'Inspect assigned behavior',...extra});
  const report=job=>({schema_version:1,kind:'review',task_id:'task',target_id:job.target_id,status:'complete',summary:'Verified source',verdict:'pass',violations:[],bugs:[],suggestions:[],checked_scope:['source.txt'],evidence:['Inspected source.txt'],unresolved:[]});
  const complete=(job,data)=>Object.assign(records.get(job.agent_id),{status:'completed',result:typeof data==='string'?data:JSON.stringify(data)});
  return {cwd,agentDir,workflow,ctx,act,delegate,report,complete,records,host};
}

test('exact model selection rejects fuzzy names, unavailable routes and prohibited models',()=>{
  const registry={getAvailable:()=>[MODEL]}; const policy={allowed_models:['gpt-6.1-sol']};
  assert.equal(exactModel(registry,'openai/gpt-6.1-sol',policy),MODEL);
  assert.throws(()=>exactModel(registry,'gpt-6.1-sol',policy),/exact/);
  assert.throws(()=>exactModel(registry,'other/gpt-6.1-sol',policy),/Unavailable/);
  assert.throws(()=>exactModel(registry,'openai/gpt-6.1-sol',{allowed_models:['other']}),/prohibited/);
});
test('legacy pin requires explicit policy and unavailable pin never substitutes a default',async t=>{
  const f=await fixture(t);
  const legacy={provider:'openai',id:'gpt-5.5',reasoning:true};
  const policy=await f.workflow.policy(f.ctx);
  const registry={getAvailable:()=>[MODEL,legacy]};
  assert.throws(()=>exactModel(registry,'openai/gpt-5.5',policy),/prohibited/);
  await writeFile(join(f.cwd,'astraeus.toml'),'allowed_models = ["openai/gpt-5.5"]\n');
  const explicit=await f.workflow.policy(f.ctx);
  assert.equal(exactModel(registry,'openai/gpt-5.5',explicit),legacy);
  f.ctx.modelRegistry=registry;
  const job=await f.delegate('worker',{model:'openai/gpt-5.5',thinking:'medium'});
  assert.equal(f.records.get(job.agent_id).session.model,legacy);
  assert.equal(f.records.get(job.agent_id).session.thinkingLevel,'medium');
  f.complete(job,'Verified explicitly pinned legacy route');
  assert.equal((await f.act({op:'collect',run_id:job.run_id})).valid,true);
  assert.throws(()=>exactModel({getAvailable:()=>[MODEL]},'openai/gpt-5.5',explicit),/Unavailable/);
});
test('native delegation supplies a task-specific description for background completion delivery',async t=>{
  const f=await fixture(t), job=await f.delegate('worker');
  const record=f.records.get(job.agent_id);
  assert.equal(record.description,'task: worker');
  assert.equal(record.isBackground,true);
});
test('RPC times out and removes its reply listener',async()=>{
  const bus=new Bus(); await assert.rejects(rpc(bus,'ping',{},5),/timed out/);
  assert.equal([...bus.handlers.values()].reduce((n,s)=>n+s.size,0),0);
});
test('report parser accepts one JSON/fenced object and rejects surrounding prose',()=>{
  assert.equal(parseReport('```json\n{"x":1}\n```'),'{"x":1}');
  assert.throws(()=>parseReport('Result: {"x":1}'));
  assert.throws(()=>parseReport('{}\n{}'));
});
test('fresh pass proceeds to root acceptance and receipt artifacts do not change target',async t=>{
  const f=await fixture(t), before=await f.workflow.target(f.ctx);
  const job=await f.delegate('reviewer'); f.complete(job,f.report(job));
  const collected=await f.act({op:'collect',run_id:job.run_id}); assert.equal(collected.valid,true,collected.error);
  assert.equal(await f.workflow.target(f.ctx),before);
  assert.equal((await f.act({op:'accept'})).accepted,true);
  await writeFile(join(f.cwd,'source.txt'),'changed\n');
  assert.equal((await f.act({op:'status'}))[0].phase,'stale');
});
test('acceptance rejects stale targets and tampered review bytes',async t=>{
  const f=await fixture(t); const job=await f.delegate('reviewer'); f.complete(job,f.report(job)); await f.act({op:'collect',run_id:job.run_id});
  await writeFile(job.artifact,'{}'); await assert.rejects(f.act({op:'accept'}),/bytes changed/);
  await writeFile(join(f.cwd,'source.txt'),'changed'); await assert.rejects(f.act({op:'accept'}),/target changed/);
});
test('malformed contract, duplicate keys, missing coverage and model mismatch never pass',async t=>{
  const f=await fixture(t);
  let job=await f.delegate('reviewer'); f.complete(job,'{"kind":"review","kind":"review"}');
  assert.equal((await f.act({op:'collect',run_id:job.run_id})).valid,false);
  await assert.rejects(f.act({op:'accept'}),/validated review/);
  job=await f.delegate('reviewer'); const data=f.report(job); data.checked_scope=[]; f.complete(job,data);
  assert.equal((await f.act({op:'collect',run_id:job.run_id})).valid,false);
  job=await f.delegate('reviewer'); f.complete(job,f.report(job)); f.records.get(job.agent_id).session.model={...MODEL,provider:'other'};
  assert.match((await f.act({op:'collect',run_id:job.run_id})).error,/Host-observed model/);
});
test('strict assurance blocks dispatch before launching a reviewer',async t=>{
  const f=await fixture(t); await writeFile(join(f.cwd,'astraeus.toml'),'assurance = "strict"\n');
  await assert.rejects(f.delegate('reviewer'),/OS read-only/); assert.equal(f.records.size,0);
});
test('unsupported thinking does not launch or clamp',async t=>{
  const f=await fixture(t); await assert.rejects(f.delegate('reviewer',{thinking:'max'}),/Unsupported thinking/); assert.equal(f.records.size,0);
});
test('alternate filenames cannot shadow managed role definitions',async t=>{
  const f=await fixture(t); await mkdir(join(f.cwd,'.pi/agents'),{recursive:true});
  await writeFile(join(f.cwd,'.pi/agents','other.md'),'---\nname: astraeus-reviewer\ntools: bash\n---\n');
  await assert.rejects(f.delegate('reviewer'),/Role definition differs/); assert.equal(f.records.size,0);
});
test('writers require disjoint ownership and all results collected before acceptance',async t=>{
  const f=await fixture(t); const first=await f.delegate('worker',{owned_paths:['src']});
  await assert.rejects(f.delegate('worker',{owned_paths:['src/a']}),/disjoint/);
  await f.delegate('worker',{owned_paths:['docs']});
  await assert.rejects(f.delegate('reviewer'),/Freeze writers/);
  await assert.rejects(f.act({op:'accept'}),/Collect every/);
  f.complete(first,'Implemented and verified'); assert.equal((await f.act({op:'collect',run_id:first.run_id})).valid,true);
});
test('changes_required requires fresh adjudication; rejected findings can accept exact review',async t=>{
  const f=await fixture(t); const review=await f.delegate('reviewer');
  const report=f.report(review); report.verdict='changes_required'; report.bugs=[{location:'source.txt',claim:'Contract violation',evidence:'Example'}];
  f.complete(review,report); await f.act({op:'collect',run_id:review.run_id});
  await assert.rejects(f.act({op:'accept'}),/adjudication/);
  const job=await f.delegate('adjudicator'); assert.notEqual(job.agent_id,review.agent_id);
  f.complete(job,{schema_version:1,kind:'adjudication',task_id:'task',target_id:job.target_id,status:'complete',summary:'Disproven claim',verdict:'accept',review_sha256:review.result_hash,decisions:[{ref:'bugs/0',action:'reject',basis:'Original requirement',evidence:'Source behavior',rationale:'Claim disproven'}],checked_scope:['source.txt'],evidence:['Examined requirement'],unresolved:[]});
  const result=await f.act({op:'collect',run_id:job.run_id}); assert.equal(result.valid,true,result.error);
  assert.equal((await f.act({op:'accept'})).accepted,true);
  await assert.rejects(f.delegate('adjudicator'),/already has/);
});
test('inconclusive review cannot be waived through adjudication',async t=>{
  const f=await fixture(t); const job=await f.delegate('reviewer'); const data=f.report(job); data.verdict='inconclusive'; data.unresolved=['Need evidence'];
  f.complete(job,data); await f.act({op:'collect',run_id:job.run_id});
  await assert.rejects(f.delegate('adjudicator'),/Only complete/);
  await assert.rejects(f.act({op:'accept'}),/inconclusive/);
});
test('follow-up work resumes the original implementation owner and invalidates prior target',async t=>{
  const f=await fixture(t); const job=await f.delegate('worker'); f.complete(job,'Implemented; tests passed'); await f.act({op:'collect',run_id:job.run_id});
  await assert.rejects(f.delegate('worker'),/Resume the original/);
  const follow=await f.act({op:'resume',run_id:job.run_id,prompt:'Bounded follow-up'});
  assert.equal(follow.agent_id,job.agent_id); assert.notEqual(follow.run_id,job.run_id); assert.equal(f.workflow.tasks.task.target_id,null);
});
test('native pre-dispatch failure permits original owner retry but attempted dispatch does not',async t=>{
  const f=await fixture(t), job=await f.delegate('worker');
  f.complete(job,'Original bounded work'); await f.act({op:'collect',run_id:job.run_id});
  const append=f.host.appendEntry;
  f.host.appendEntry=(type,data)=>{
    if(data.tasks.task.jobs.at(-1).resume_dispatch_started===false) {
      f.host.appendEntry=append; throw new Error('fixture preparation persistence failure');
    }
    append(type,data);
  };
  await assert.rejects(f.act({op:'resume',run_id:job.run_id,prompt:'Bounded follow-up'}),/preparation persistence/);
  assert.equal(f.records.get(job.agent_id).status,'completed');
  f.workflow.restore(f.ctx);
  const failure=f.workflow.tasks.task.jobs.at(-1), diagnostic=failure.error;
  const failed=await f.act({op:'collect',run_id:failure.run_id});
  assert.equal(failed.valid,false); assert.equal(failed.status,'error'); assert.equal(failed.error,diagnostic);
  assert.equal(failed.summary,undefined); assert.equal(failed.receipt_path,undefined);
  await f.act({op:'stop',run_id:failure.run_id});
  assert.equal(f.records.get(job.agent_id).status,'completed','an undispatched attempt must not stop the shared original owner');
  await assert.rejects(f.act({op:'accept'}),/unresolved failed or incomplete/);
  await f.act({op:'status'}); f.workflow.restore(f.ctx);
  const follow=await f.act({op:'resume',run_id:job.run_id,prompt:'Retry original owner'});
  assert.equal(follow.agent_id,job.agent_id);
  f.complete(follow,'Completed correction'); await f.act({op:'collect',run_id:follow.run_id});
  f.ctx.executeTool=async()=>{throw new Error('ambiguous dispatch failure');};
  await assert.rejects(f.act({op:'resume',run_id:follow.run_id,prompt:'Attempted correction'}),/ambiguous dispatch/);
  await assert.rejects(f.act({op:'resume',run_id:follow.run_id,prompt:'Do not skip attempt'}),/latest run/);
});

// Public CLI/manager fixtures only: no inference, trust/config writes or real sessions.
async function legacyStoppedFixture(t) {
  const f=await fixture(t), task=f.workflow.tasks.task;
  await f.act({op:'authorize_design',...auth});
  const uuid='12345678-1111-2222-3333-444444444444', calls=[];
  const record={id:uuid.slice(0,8),sessionId:uuid,cwd:f.cwd,state:'stopped',status:'idle',pid:null};
  const records=[record];
  f.workflow.claude=new ClaudeBackground({trust:{run:async()=>{}},invoke:async(_command,args,cwd)=>{
    assert.equal(cwd,f.cwd); calls.push(args);
    if(args[0]==='agents') return {returncode:0,stdout:JSON.stringify(records),stderr:''};
    if(args[0]==='stop') return {returncode:0,stdout:`stopped ${record.id}\n`,stderr:''};
    assert.equal(args[0],'--bg');
    if(args[1]==='--resume') { assert.equal(args[2],uuid); record.state='working'; record.status='running'; record.pid=123; }
    return {returncode:0,stdout:`backgrounded · ${record.id} · Fixture\n`,stderr:''};
  }});
  const job={run_id:'d2f9d8b5-85df-4b25-bf7d-68191f2e0863',role:'designer',transport:'claude-code-bg-v1',
    agent_id:`claude:${uuid}`,status:'stopped',collected:false,valid:false,owned_paths:['source.txt'],requested:{model:'anthropic/claude-opus-5-5',effort:'high'}};
  task.jobs.push(job);
  await f.workflow.prepareCli(task,job,f.ctx,[]);
  Object.assign(job.cli,{short_id:record.id,session_id:uuid,frozen:true});
  await f.workflow.claude.evidence(job,'launch',['--bg','--model','claude-opus-5-5','--effort','high','--','Fixture original'],f.cwd);
  await f.workflow.claude.evidence(job,'stop',['stop',record.id],f.cwd);
  await writeFile(job.cli.pending,JSON.stringify({schema_version:1,kind:'implementation',task_id:'task',run_id:job.run_id,
    target_id:job.cli.dispatch_target,status:'complete',summary:'Fixture original work',changed_files:[],checks:[],remaining:[]}));
  assert.equal((await f.act({op:'collect',run_id:job.run_id})).valid,true);
  // Old runtime observed the shallow-copy failure as stopped, then an attempted
  // recovery overwrote its preparation error with originalRequest's run mismatch.
  const failed={...structuredClone(job),run_id:'cec98fd8-eee4-4c83-987b-ba7bc565aaaa',valid:false,collected:true,
    status:'stopped',summary:undefined,result:undefined,artifact:undefined,result_hash:undefined,
    error:'Error: Submodule/directory baseline unsupported: captured-workspace/'};
  try { await originalRequest(task,failed); assert.fail('Inherited request must not bind this failed run'); }
  catch(error) { assert.match(String(error),/baseline\/ownership\/check\/run binding changed/); failed.error=String(error); }
  return {...f,task,job,failed,calls,record,cliRecords:records};
}
test('legacy already-stopped preparation failure resumes only the original owner under adopted-fix gate',async t=>{
  const f=await legacyStoppedFixture(t), {job,failed}=f;
  const review=await f.delegate('reviewer'), report=f.report(review);
  report.verdict='changes_required'; report.bugs=[{location:'source.txt',claim:'Fixture defect',evidence:'Fixture requirement'}];
  f.complete(review,report); assert.equal((await f.act({op:'collect',run_id:review.run_id})).valid,true);
  f.task.jobs.push(failed); f.workflow.save(f.ctx); f.workflow.restore(f.ctx);
  let retained=f.workflow.tasks.task.jobs.find(j=>j.run_id===failed.run_id);
  assert.equal(retained.status,'stopped'); assert.equal(retained.resume_preparation_failure,undefined);
  assert.match(retained.error,/baseline\/ownership\/check\/run binding changed/);
  const count=f.calls.filter(a=>a[0]==='--bg').length, evidence=structuredClone(retained.cli.evidence);
  await assert.rejects(f.act({op:'resume',run_id:job.run_id,prompt:'Do not bypass adjudication'}),/adopted fixes/);
  assert.equal(f.calls.filter(a=>a[0]==='--bg').length,count);
  const judge=await f.delegate('adjudicator');
  f.complete(judge,{schema_version:1,kind:'adjudication',task_id:'task',target_id:judge.target_id,status:'complete',summary:'Fixture adopted fix',
    verdict:'changes_required',review_sha256:review.result_hash,decisions:[{ref:'bugs/0',action:'fix',basis:'Original requirement',evidence:'Fixture evidence',rationale:'Authorized correction'}],
    checked_scope:['source.txt'],evidence:['Fixture requirement'],unresolved:[]});
  const decision=await f.act({op:'collect',run_id:judge.run_id}); assert.equal(decision.valid,true,decision.error);
  await f.act({op:'status'}); f.workflow.restore(f.ctx);
  retained=f.workflow.tasks.task.jobs.find(j=>j.run_id===failed.run_id);
  assert.equal(retained.resume_preparation_failure,failed.error,'observation retains verified unsuccessful provenance');
  const follow=await f.act({op:'resume',run_id:job.run_id,prompt:'Apply only adopted correction'});
  assert.equal(follow.resume_from,job.run_id); assert.equal(follow.agent_id,job.agent_id);
  assert.deepEqual(f.calls.filter(a=>a[0]==='--bg').at(-1).slice(0,4),['--bg','--resume',job.cli.session_id,'--']);
  assert.equal(retained.valid,false); assert.equal(retained.error,failed.error); assert.equal(retained.result,undefined);
  assert.equal(retained.artifact,undefined); assert.deepEqual(retained.cli.evidence,evidence);
  assert.equal(f.workflow.tasks.task.accepted,false);
});
test('stopped inherited candidates with preparation, dispatch, copy or ambiguous binding still block recovery',async t=>{
  const f=await legacyStoppedFixture(t), {job,failed}=f;
  const request=join(job.cli.directory,'request.json'), requestBytes=await readFile(request);
  const mutations=[
    ['prepared binding',candidate=>{ candidate.cli.directory=join(f.agentDir,'prepared'); }],
    ['attempted dispatch',candidate=>{ candidate.cli.evidence.push({...candidate.cli.evidence.at(-1),kind:'resume'}); }],
    ['copy',candidate=>{ candidate.cli.unexpected_copy={id:'abcdef12',session_id:'abcdef12-1111-2222-3333-444444444444'}; }],
    ['mutated request',async()=>{ await writeFile(request,'{}'); }],
    ['mutated evidence',candidate=>{ candidate.cli.evidence[0].sha256='0'.repeat(64); }],
    ['ambiguous original binding',(_candidate,task)=>{ task.jobs.unshift(structuredClone(job)); }],
  ];
  const count=f.calls.filter(a=>a[0]==='--bg').length;
  for(const [label,mutate] of mutations) {
    const candidate=structuredClone(failed); f.task.jobs=[job,candidate];
    await mutate(candidate,f.task);
    await assert.rejects(f.act({op:'resume',run_id:job.run_id,prompt:label}),/latest run|Collect\/stop active work/,label);
    assert.equal(candidate.valid,false); assert.equal(candidate.resume_preparation_failure,undefined);
    assert.equal(f.calls.filter(a=>a[0]==='--bg').length,count,label);
    await writeFile(request,requestBytes);
  }
  const frozenOriginal=structuredClone(job);
  for(const listing of [
    [{...f.record,sessionId:'12345678-9999-2222-3333-444444444444'}],
    [f.record,f.record],
    [{...f.record,cwd:f.agentDir}],
  ]) {
    Object.assign(job,structuredClone(frozenOriginal));
    f.task.jobs=[job,structuredClone(failed)];
    f.cliRecords.splice(0,f.cliRecords.length,...listing);
    await assert.rejects(f.act({op:'resume',run_id:job.run_id,prompt:'Do not dispatch on ambiguous identity'}),/full UUID\/cwd binding mismatch/);
    assert.equal(f.calls.filter(a=>a[0]==='--bg').length,count);
  }
});

test('branch restore marks lost active children unavailable, not successful',async t=>{
  const f=await fixture(t); await f.delegate('worker'); f.records.clear();
  const restored=new Workflow(f.host); restored.restore(f.ctx);
  assert.equal(restored.tasks.task.jobs[0].status,'unavailable');
  const lost=await restored.execute({op:'collect',task_id:'task',run_id:restored.tasks.task.jobs[0].run_id},f.ctx);
  assert.equal(lost.collected,true); assert.equal(lost.valid,false);
  await assert.rejects(restored.execute({op:'accept',task_id:'task'},f.ctx),/unresolved/);
});

test('optional rejected or inconclusive reviews cannot be ignored at acceptance',async t=>{
  const f=await fixture(t); f.workflow.tasks.task.consequential=false;
  let job=await f.delegate('reviewer'); let report=f.report(job); report.verdict='changes_required'; report.bugs=[{location:'source.txt',claim:'Defect',evidence:'Concrete example'}];
  f.complete(job,report); await f.act({op:'collect',run_id:job.run_id});
  await assert.rejects(f.act({op:'accept'}),/adjudication/);
  job=await f.delegate('reviewer'); report=f.report(job); report.verdict='inconclusive'; report.unresolved=['Missing evidence'];
  f.complete(job,report); await f.act({op:'collect',run_id:job.run_id});
  await assert.rejects(f.act({op:'accept'}),/inconclusive/);
});
test('review freezing and writer ownership apply across tasks in the same repository',async t=>{
  const f=await fixture(t);
  await f.act({op:'start',task_id:'other',requirements:'Second bounded task',acceptance:'Verified'});
  const review=await f.delegate('reviewer');
  await assert.rejects(f.act({op:'delegate',task_id:'other',role:'worker',model:'openai/gpt-6.1-sol',thinking:'high',prompt:'Write source',owned_paths:['.']}),/no writes during review/);
  f.complete(review,f.report(review)); await f.act({op:'collect',run_id:review.run_id});
  const worker=await f.act({op:'delegate',task_id:'other',role:'worker',model:'openai/gpt-6.1-sol',thinking:'high',prompt:'Implement src',owned_paths:['./src/']});
  await assert.rejects(f.delegate('worker',{owned_paths:['src/a']}),/disjoint/);
  f.complete(worker,'Implemented and verified'); await f.act({op:'collect',task_id:'other',run_id:worker.run_id});
  const active=await f.delegate('reviewer');
  await assert.rejects(f.act({op:'resume',task_id:'other',run_id:worker.run_id,prompt:'Apply follow-up'}),/active work/);
});
test('whitespace and non-string names use runner filename fallback and cannot replace reviewer tools',async t=>{
  const f=await fixture(t); await mkdir(join(f.cwd,'.pi/agents'),{recursive:true});
  for (const name of ['" "','12','false']) {
    await writeFile(join(f.cwd,'.pi/agents/astraeus-reviewer.md'),`---\nname: ${name}\ntools: bash\n---\nWritable override`);
    await assert.rejects(f.delegate('reviewer'),/Role definition differs/);
  }
  assert.equal(f.records.size,0);
});
test('actual string onSpawned ID survives startup rejection and permits collecting failed attempt',async t=>{
  const f=await fixture(t); f.host.events.handlers.set('subagents:rpc:spawn',new Set([p=>{
    const record={id:'failed-child',type:p.type,status:'error',session:{model:p.options.model,thinkingLevel:p.options.thinkingLevel},error:'Fixture startup failed'};
    f.records.set(record.id,record); p.options.onSpawned(record.id);
    f.host.events.emit(`subagents:rpc:spawn:reply:${p.requestId}`,{success:false,error:'Fixture startup failed'});
  }]));
  await assert.rejects(f.delegate('reviewer'),/startup failed/);
  const job=f.workflow.tasks.task.jobs[0]; assert.equal(job.agent_id,'failed-child');
  const result=await f.act({op:'collect',run_id:job.run_id}); assert.equal(result.collected,true); assert.equal(result.valid,false);
});
test('lost reviewer can settle as failed and fresh evidence can complete the same task',async t=>{
  const f=await fixture(t); const lost=await f.delegate('reviewer'); f.records.delete(lost.agent_id);
  f.workflow.restore(f.ctx);
  const attempt=await f.act({op:'collect',run_id:lost.run_id}); assert.equal(attempt.valid,false); assert.equal(attempt.status,'unavailable');
  await assert.rejects(f.act({op:'accept'}),/validated review/);
  const fresh=await f.delegate('reviewer'); f.complete(fresh,f.report(fresh));
  assert.equal((await f.act({op:'collect',run_id:fresh.run_id})).valid,true);
  assert.equal((await f.act({op:'accept'})).accepted,true);
});
for (const role of ['worker']) test(`${role} adopted fixes return to original owner and require fresh review afterward`,async t=>{
  const f=await fixture(t); if (role === 'designer') await f.act({op:'authorize_design',...auth});
  const worker=await f.delegate(role,role === 'designer' ? designer : {}); f.complete(worker,'Implemented and verified'); await f.act({op:'collect',run_id:worker.run_id});
  const review=await f.delegate('reviewer'); const report=f.report(review); report.verdict='changes_required'; report.bugs=[{location:'source.txt',claim:'Defect',evidence:'Concrete example'}];
  f.complete(review,report); await f.act({op:'collect',run_id:review.run_id});
  await assert.rejects(f.act({op:'resume',run_id:worker.run_id,prompt:'Fix defect'}),/adopted fixes/);
  const judge=await f.delegate('adjudicator'); f.complete(judge,{schema_version:1,kind:'adjudication',task_id:'task',target_id:judge.target_id,status:'complete',summary:'Fix within authorized scope',verdict:'changes_required',review_sha256:review.result_hash,decisions:[{ref:'bugs/0',action:'fix',basis:'Original requirement',evidence:'Source behavior',rationale:'Reproduced defect'}],checked_scope:['source.txt'],evidence:['Examined requirement'],unresolved:[]});
  const decision=await f.act({op:'collect',run_id:judge.run_id}); assert.equal(decision.valid,true,decision.error);
  const follow=await f.act({op:'resume',run_id:worker.run_id,prompt:'Apply the adopted fix'}); assert.equal(follow.agent_id,worker.agent_id);
  await writeFile(join(f.cwd,'source.txt'),'fixed'); f.complete(follow,'Fixed and verified'); await f.act({op:'collect',run_id:follow.run_id});
  await assert.rejects(f.act({op:'accept'}),/target changed/);
  const fresh=await f.delegate('reviewer'); f.complete(fresh,f.report(fresh)); await f.act({op:'collect',run_id:fresh.run_id});
  assert.equal((await f.act({op:'accept'})).accepted,true);
});
test('managed work in unrelated repositories remains independent',async t=>{
  const f=await fixture(t); await f.delegate('reviewer');
  const cwd=join(f.agentDir,'other-repository'); await mkdir(cwd); execFileSync('git',['init','-q'],{cwd});
  const ctx={...f.ctx,cwd};
  await f.workflow.execute({op:'start',task_id:'independent',requirements:'Other repository',acceptance:'Verified'},ctx);
  const worker=await f.workflow.execute({op:'delegate',task_id:'independent',role:'worker',model:'openai/gpt-6.1-sol',thinking:'high',prompt:'Bounded independent work',owned_paths:['.']},ctx);
  assert.equal(worker.role,'worker'); assert.equal(worker.status,'running');
});

const auth = {design_request:'Use Claude for this design and related UI implementation',design_scope:'design-direction-and-ui-implementation'};
const designer = {model:'anthropic/claude-opus-5-5',design_scope:auth.design_scope};
test('designer fails closed without explicit quote/scope; no general Anthropic routing or fallback', async t=>{
  const f=await fixture(t);
  await assert.rejects(f.delegate('designer',designer),/explicit design authorization/);
  await assert.rejects(f.act({op:'authorize_design',design_scope:auth.design_scope}),/original user quote/);
  await f.act({op:'authorize_design',...auth});
  await assert.rejects(f.act({op:'authorize_design',...auth}),/already recorded/);
  await assert.rejects(f.delegate('designer',{...designer,design_scope:'ui-implementation'}),/matching design_scope/);
  for (const model of ['anthropic/claude-opus-4-6','anthropic/claude-sonnet-5','other/claude-opus-5-5']) await assert.rejects(f.delegate('designer',{...designer,model}),/exact anthropic/);
  await writeFile(join(f.cwd,'astraeus.toml'),'allowed_models = ["anthropic/claude-opus-5-5"]\n');
  for (const role of ['worker','reviewer','adjudicator']) await assert.rejects(f.delegate(role,{model:designer.model}),/reserved/);
  f.ctx.modelRegistry={getAvailable:()=>[MODEL]};
  await assert.rejects(f.delegate('designer',{...designer,thinking:'off'}),/Unsupported thinking/);
  assert.equal(f.records.size,0);
});
test('preparation failure settles unsuccessfully and releases other tasks for review, including after restore',async t=>{
  const f=await fixture(t);
  await f.act({op:'authorize_design',...auth});
  f.workflow.prepareCli=async()=>{ throw new Error('ENOENT: fixture snapshot preparation failed'); };
  await assert.rejects(f.delegate('designer',designer),/snapshot preparation failed/);
  const job=f.workflow.tasks.task.jobs[0], original=job.error;
  f.workflow.restore(f.ctx);
  await f.act({op:'start',task_id:'root-takeover',requirements:'Explicit root ownership',acceptance:'Fresh independent review'});
  const review=await f.delegate('reviewer',{task_id:'root-takeover'});
  const failed=f.workflow.tasks.task.jobs[0];
  assert.equal(failed.status,'prelaunch-failed'); assert.equal(failed.valid,false);
  assert.equal(failed.collected,true); assert.equal(failed.error,original);
  assert.equal(failed.cli.frozen,true);
  f.complete(review,{...f.report(review),task_id:'root-takeover'});
  assert.equal((await f.act({op:'collect',task_id:'root-takeover',run_id:review.run_id})).valid,true);
  assert.equal((await f.act({op:'accept',task_id:'root-takeover'})).accepted,true);
  await assert.rejects(f.act({op:'accept'}),/unresolved failed/);
});
test('legacy unavailable prelaunch shape releases review in one operation without losing preparation diagnostic',async t=>{
  const f=await fixture(t), original='Submodule/directory baseline unsupported: captured-workspace/';
  const job={run_id:'legacy-prelaunch',role:'designer',transport:'claude-code-bg-v1',agent_id:null,status:'unavailable',valid:false,collected:false,error:original,cli:{frozen:false,evidence:[]}};
  f.workflow.tasks.task.jobs.push(job);
  f.workflow.save(f.ctx); f.workflow.restore(f.ctx);
  await f.act({op:'start',task_id:'root-takeover',requirements:'Explicit root ownership',acceptance:'Fresh independent review'});
  const review=await f.delegate('reviewer',{task_id:'root-takeover'});
  const recovered=f.workflow.tasks.task.jobs[0];
  assert.equal(recovered.status,'prelaunch-failed'); assert.equal(recovered.error,original);
  assert.equal(recovered.cli.preparation_failure,original); assert.equal(recovered.valid,false);
  f.complete(review,{...f.report(review),task_id:'root-takeover'});
  assert.equal((await f.act({op:'collect',task_id:'root-takeover',run_id:review.run_id})).valid,true);
  assert.equal((await f.act({op:'accept',task_id:'root-takeover'})).accepted,true);
  await assert.rejects(f.act({op:'accept'}),/unresolved failed/);
});
test('unbound potentially launched jobs never use preparation-only recovery',async t=>{
  const f=await fixture(t);
  for (const cli of [
    {evidence:[]},
    {frozen:null,evidence:[]},
    {frozen:'false',evidence:[]},
    {frozen:false,evidence:[],directory:'/prepared'},
    {frozen:false,evidence:[],short_id:'12345678'},
    {frozen:false,evidence:[],launch_attempted:true},
    {frozen:false,evidence:[{kind:'launch',path:'/evidence',sha256:'x'}]},
  ]) {
    const job={run_id:'unbound',role:'designer',transport:'claude-code-bg-v1',agent_id:null,status:'unknown',valid:false,collected:true,error:'Unbound launch',cli};
    f.workflow.tasks.task.jobs=[job];
    f.workflow.claude.observe=async()=>{ throw new Error('UUID binding unavailable'); };
    // Repeating observation must not normalize malformed state into a prelaunch proof.
    await assert.rejects(f.delegate('reviewer'),/Freeze writers/);
    await assert.rejects(f.delegate('reviewer'),/Freeze writers/);
    assert.equal(job.cli.frozen,false); assert.equal(job.valid,false);
  }
});
// Designer lifecycle now lives in claude.test.mjs with no native Anthropic stub.
test('new task does not inherit design authorization; lost designer still blocks acceptance', async t=>{
  const f=await fixture(t);
  await f.act({op:'start',task_id:'authorized',requirements:'UI task',acceptance:'Verified',...auth});
  await assert.rejects(f.delegate('designer',designer),/explicit design authorization/);
  // A recorded legacy native designer retains native recovery semantics, never migrates.
  const job=await f.delegate('worker',{task_id:'authorized'});
  job.role='designer'; job.transport='pi-native'; f.records.clear();
  const lost=await f.act({op:'collect',task_id:'authorized',run_id:job.run_id});
  assert.equal(lost.valid,false);
  await assert.rejects(f.act({op:'accept',task_id:'authorized'}),/unresolved/);
  await assert.rejects(f.act({op:'resume',task_id:'authorized',run_id:job.run_id,prompt:'Recover'}),/Original live child session unavailable/);
});
