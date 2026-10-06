import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Workflow, ROOT, ENTRY, exactModel, hash, rpc, parseReport } from '../extensions/core.mjs';

const MODEL = {provider:'openai',id:'gpt-5.5',reasoning:true};
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
    records.set(id,record); p.options.onSpawned(record);
    events.emit(`subagents:rpc:spawn:reply:${p.requestId}`,{success:true,data:{id}});
  });
  events.on('subagents:rpc:consume', p => events.emit(`subagents:rpc:consume:reply:${p.requestId}`,{success:true}));
  events.on('subagents:rpc:stop', p => {
    records.get(p.agentId).status='stopped'; events.emit(`subagents:rpc:stop:reply:${p.requestId}`,{success:true});
  });
  const host={events,agentDir:()=>agentDir,appendEntry:(customType,data)=>entries.push({type:'custom',customType,data:structuredClone(data)}), manager:()=>({getRecord:id=>records.get(id)}), supportedThinking:()=>['off','low','medium','high'], parseFrontmatter:text=>({frontmatter:{name:/^name: (.+)$/m.exec(text)?.[1]}})};
  const ctx={cwd,hasUI:false,sessionManager:{getSessionId:()=> 'test-session',getBranch:()=>entries},modelRegistry:{getAvailable:()=>[MODEL]},executeTool:async (_name,args)=>{
    const record=records.get(args.resume); record.status='running'; record.result=''; return {content:[]};
  }};
  const workflow=new Workflow(host); const act=p=>workflow.execute({task_id:'task',...p},ctx);
  await act({op:'start',requirements:'Preserve existing behavior',acceptance:'Actual local verification passes'});
  const delegate=(role,extra={})=>act({op:'delegate',role,model:'openai/gpt-5.5',thinking:'high',prompt:'Inspect assigned behavior',...extra});
  const report=job=>({schema_version:1,kind:'review',task_id:'task',target_id:job.target_id,status:'complete',summary:'Verified source',verdict:'pass',violations:[],bugs:[],suggestions:[],checked_scope:['source.txt'],evidence:['Inspected source.txt'],unresolved:[]});
  const complete=(job,data)=>Object.assign(records.get(job.agent_id),{status:'completed',result:typeof data==='string'?data:JSON.stringify(data)});
  return {cwd,agentDir,workflow,ctx,act,delegate,report,complete,records,host};
}

test('exact model selection rejects fuzzy names, unavailable routes and prohibited models',()=>{
  const registry={getAvailable:()=>[MODEL]}; const policy={allowed_models:['gpt-5.5']};
  assert.equal(exactModel(registry,'openai/gpt-5.5',policy),MODEL);
  assert.throws(()=>exactModel(registry,'gpt-5.5',policy),/exact/);
  assert.throws(()=>exactModel(registry,'other/gpt-5.5',policy),/Unavailable/);
  assert.throws(()=>exactModel(registry,'openai/gpt-5.5',{allowed_models:['other']}),/prohibited/);
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
  await assert.rejects(restored.execute({op:'collect',task_id:'task',run_id:restored.tasks.task.jobs[0].run_id},f.ctx),/unavailable/);
});
