import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseFrontmatter } from '@earendil-works/pi-coding-agent';
import { Workflow, ROOT, ENTRY, exactModel, hash, rpc, parseReport } from '../extensions/core.mjs';

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
    const record={id,type:p.type,status:'running',session:{model:p.options.model,thinkingLevel:p.options.thinkingLevel},result:''};
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
