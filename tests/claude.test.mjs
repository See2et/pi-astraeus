import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, cp, writeFile, readFile, rm, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {parseFrontmatter} from '@earendil-works/pi-coding-agent';
import {Workflow, ROOT} from '../extensions/core.mjs';
import {ClaudeBackground, launchId, snapshot} from '../extensions/claude.mjs';
import {ClaudeTrustPreflight} from '../extensions/claude-trust.mjs';
import {modelView} from '../extensions/model-view.mjs';

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
    const record = {id:id.slice(0,8),sessionId:id,cwd,state:'working',status:'running',pid:123,...state.initialLifecycle};
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

test('legacy ownership failure recollects without cache approvals, retaining historical evidence',async t=>{
  const f=await fixture(t), job=await f.delegate();
  await writeFile(join(f.cwd,'ui.txt'),'designed'); await f.report(job); f.idle();
  await f.act({op:'stop',run_id:job.run_id});
  job.collected=true; job.error='Error: Out-of-ownership baseline delta: build/results.json';
  const historical=join(job.cli.directory,'ownership-failure-old.json');
  const bytes=JSON.stringify({error:job.error}); await writeFile(historical,bytes);
  const {createHash}=await import('node:crypto');
  job.cli.evidence.push({kind:'ownership-failure',path:historical,sha256:createHash('sha256').update(bytes).digest('hex')});
  job.cli.ownership_failure={error:job.error};
  // Old approval metadata remains evidence, but its obsolete source fingerprints
  // do not create a delta gate after deployment.
  job.cli.generated_reconciliation={path:'/obsolete/receipt',sha256:'obsolete'};
  f.workflow.save(f.ctx); f.workflow.restore(f.ctx);
  const result=await f.act({op:'reconcile_generated',run_id:job.run_id});
  assert.equal(result.valid,true,result.error);
  assert.equal(await readFile(historical,'utf8'),bytes);
  assert.equal(result.cli.ownership_failure.error,JSON.parse(bytes).error);
  assert.equal(modelView(result).cli.baseline,undefined);
  await writeFile(join(f.cwd,'outside.txt'),'shared-cwd later edit');
  await mkdir(join(f.cwd,'build')); await writeFile(join(f.cwd,'build/results.json'),'generated');
  assert.equal((await f.act({op:'collect',run_id:job.run_id})).valid,true);
  f.workflow.tasks.design.consequential=false;
  assert.equal((await f.act({op:'accept'})).accepted,true);
  const review={run_id:'old-review',role:'reviewer',valid:true,collected:true,result:{verdict:'changes_required'}};
  f.workflow.tasks.design.jobs.push(review);
  await assert.rejects(f.act({op:'resume',run_id:job.run_id,prompt:'Do not bypass review'}),/adopted fixes/);
});

test('failed original run resumes with exact freeze and no successful report, retaining failure',async t=>{
  for(const report of ['missing','malformed','blocked','failed-check']) await t.test(report,async t=>{
    const f=await fixture(t),job=await f.delegate({checks:['npm test']});
    if(report==='malformed') await writeFile(job.cli.pending,'not JSON');
    if(report==='blocked') await f.report(job,{status:'blocked',remaining:['unfinished']});
    if(report==='failed-check') await f.report(job,{checks:[{command:'npm test',outcome:'failed',evidence:'Fixture failed'}]});
    f.idle(); const collected=await f.act({op:'collect',run_id:job.run_id});
    assert.equal(collected.valid,false); assert.equal(collected.cli.frozen,true);
    const error=job.error;
    if(['blocked','failed-check'].includes(report)) {
      assert.ok(job.artifact); assert.equal(job.result.status,report==='blocked'?'blocked':'complete');
    }
    await assert.rejects(f.act({op:'accept'}),/unresolved failed or incomplete/);
    f.workflow.save(f.ctx); f.workflow.restore(f.ctx);
    const follow=await f.act({op:'resume',run_id:job.run_id,prompt:'Correct original bounded design work'});
    assert.equal(follow.agent_id,job.agent_id); assert.notEqual(follow.run_id,job.run_id);
    assert.equal(f.workflow.tasks.design.jobs[0].error,error);
    assert.equal(f.workflow.tasks.design.jobs[0].valid,false);
    assert.deepEqual(f.calls.filter(a=>a[0]==='--bg').at(-1).slice(0,4),['--bg','--resume',ID,'--']);
    await f.report(follow); f.idle(); assert.equal((await f.act({op:'collect',run_id:follow.run_id})).valid,true);
    await assert.rejects(f.act({op:'accept'}),/Review target changed|complete validated review/);
  });
});

test('preparation failure preserves the frozen owner and permits retry after restore',async t=>{
  const f=await fixture(t), job=await f.delegate(); await f.report(job); f.idle();
  assert.equal((await f.act({op:'collect',run_id:job.run_id})).valid,true);
  const original=structuredClone(job), prepare=f.workflow.prepareCli.bind(f.workflow);
  f.workflow.prepareCli=async()=>{throw new Error('fixture baseline preparation failed');};
  await assert.rejects(f.act({op:'resume',run_id:job.run_id,prompt:'Bounded fix'}),/preparation failed/);
  assert.deepEqual(job,original,'failed preparation must not alias or change the original binding');
  const failed=f.workflow.tasks.design.jobs.at(-1), launches=f.calls.filter(a=>a[0]==='--bg').length;
  f.workflow.save(f.ctx); f.workflow.restore(f.ctx); f.workflow.prepareCli=prepare;
  const follow=await f.act({op:'resume',run_id:job.run_id,prompt:'Retry bounded fix'});
  assert.equal(follow.agent_id,job.agent_id);
  assert.equal(f.calls.filter(a=>a[0]==='--bg').length,launches+1);
  assert.equal(f.workflow.tasks.design.jobs.find(j=>j.run_id===failed.run_id).valid,false);
  await f.report(follow); f.idle(); assert.equal((await f.act({op:'collect',run_id:follow.run_id})).valid,true);
  f.workflow.tasks.design.consequential=false;
  assert.equal((await f.act({op:'accept'})).accepted,true,'failed preparation is not a separate unresolved owner');
  await assert.rejects(f.act({op:'resume',run_id:job.run_id,prompt:'Stale owner'}),/latest run/);
});

test('legacy inherited preparation binding is skipped only with intact original evidence',async t=>{
  const f=await fixture(t), job=await f.delegate(); await f.report(job); f.idle();
  assert.equal((await f.act({op:'collect',run_id:job.run_id})).valid,true);
  // Persisted shape produced by the old shallow-cloned resume before prepareCli returned.
  const failed={...structuredClone(job),run_id:'legacy-failed-resume',collected:true,valid:false,
    result:undefined,artifact:undefined,result_hash:undefined,status:'unknown',error:'fixture preparation failed'};
  f.workflow.tasks.design.jobs.push(failed,{...structuredClone(failed),run_id:'legacy-second-preparation-failure'});
  f.workflow.save(f.ctx); f.workflow.restore(f.ctx);
  await f.act({op:'status'});
  f.workflow.save(f.ctx); f.workflow.restore(f.ctx);
  await f.act({op:'status'});
  const observedFailure=f.workflow.tasks.design.jobs.at(-1);
  assert.equal(observedFailure.resume_preparation_failure,'fixture preparation failed');
  assert.equal(observedFailure.error,'fixture preparation failed'); assert.equal(observedFailure.valid,false);
  await assert.rejects(f.act({op:'resume',run_id:failed.run_id,prompt:'Wrong request run'}));
  const path=join(job.cli.directory,'request.json'), bytes=await readFile(path);
  await writeFile(path,'{}');
  await assert.rejects(f.act({op:'resume',run_id:job.run_id,prompt:'Do not bypass evidence'}));
  await writeFile(path,bytes);
  const follow=await f.act({op:'resume',run_id:job.run_id,prompt:'Recover original bounded fix'});
  assert.equal(follow.agent_id,job.agent_id); assert.notEqual(follow.run_id,failed.run_id);
  assert.equal(f.workflow.tasks.design.jobs.find(j=>j.run_id===failed.run_id).valid,false);
});

test('failed acceptance before status retains legacy preparation recovery',async t=>{
  const f=await fixture(t), job=await f.delegate(); await f.report(job); f.idle();
  assert.equal((await f.act({op:'collect',run_id:job.run_id})).valid,true);
  const failed={...structuredClone(job),run_id:'legacy-accept-first',collected:true,valid:false,
    result:undefined,artifact:undefined,result_hash:undefined,status:'unknown',error:'fixture preparation failed'};
  f.workflow.tasks.design.jobs.push(failed); f.workflow.save(f.ctx); f.workflow.restore(f.ctx);
  await assert.rejects(f.act({op:'accept'}),/unresolved failed or incomplete/);
  assert.equal(f.workflow.tasks.design.accepted,false);
  f.workflow.save(f.ctx); f.workflow.restore(f.ctx);
  const follow=await f.act({op:'resume',run_id:job.run_id,prompt:'Recover original after failed acceptance'});
  assert.equal(follow.agent_id,job.agent_id); assert.notEqual(follow.run_id,failed.run_id);
  const retained=f.workflow.tasks.design.jobs.find(j=>j.run_id===failed.run_id);
  assert.equal(retained.resume_preparation_failure,'fixture preparation failed');
  assert.equal(retained.valid,false); assert.equal(retained.error,'fixture preparation failed');
});

test('legacy stop and collection retain recovery without ignoring new lifecycle evidence',async t=>{
  const f=await fixture(t), job=await f.delegate(); await f.report(job); f.idle();
  assert.equal((await f.act({op:'collect',run_id:job.run_id})).valid,true);
  const failed={...structuredClone(job),run_id:'legacy-stopped-failure',collected:true,valid:false,
    result:undefined,artifact:undefined,result_hash:undefined,status:'unknown',error:'fixture preparation failed'};
  f.workflow.tasks.design.jobs.push(failed);
  await f.act({op:'stop',run_id:failed.run_id});
  const stopped=failed.cli.evidence.at(-1), count=failed.cli.evidence.length;
  assert.equal(stopped.kind,'stop'); assert.equal(count,job.cli.evidence.length+1);
  const collected=await f.act({op:'collect',run_id:failed.run_id});
  assert.equal(collected.valid,false); assert.equal(collected.collected,true);
  assert.equal(collected.resume_preparation_failure,'fixture preparation failed');
  f.workflow.save(f.ctx); f.workflow.restore(f.ctx);
  const retained=f.workflow.tasks.design.jobs.find(j=>j.run_id===failed.run_id);
  const extra=retained.cli.evidence.at(-1), bytes=await readFile(extra.path);
  await writeFile(extra.path,'changed stop evidence');
  await assert.rejects(f.act({op:'resume',run_id:job.run_id,prompt:'Do not ignore corrupted stop evidence'}));
  await writeFile(extra.path,bytes);
  extra.kind='resume';
  await assert.rejects(f.act({op:'resume',run_id:job.run_id,prompt:'Do not skip a dispatch receipt'}));
  extra.kind='stop';
  const follow=await f.act({op:'resume',run_id:job.run_id,prompt:'Recover original after legacy stop/collect'});
  assert.equal(follow.agent_id,job.agent_id); assert.notEqual(follow.run_id,failed.run_id);
  assert.equal(retained.valid,false); assert.equal(retained.cli.evidence.length,count);
  assert.deepEqual(await readFile(extra.path),bytes,'recovery retains original lifecycle evidence bytes');
});

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
  assert.equal((await restored.execute({op:'status',task_id:'design'},f.ctx))[0].jobs[0].status,'work-ended');
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
test('initial permissions are repo-scoped with Git/control protections; exact pins and shared cwd remain',async t=>{
  const f=await fixture(t),job=await f.delegate({checks:['npm test']});
  const args=f.calls.find(a=>a[0]==='--bg');
  const allows=['Read','Glob','Grep',`Edit(/${f.cwd}/**)`,`Write(/${f.cwd}/**)`,
    `Edit(/${job.cli.report_directory}/**)`,`Write(/${job.cli.report_directory}/**)`,'Bash(npm test)'];
  const denies=['Agent','Task','Bash(git push *)','Bash(git -C * push *)','Bash(gh *)','Bash(glab *)','Bash(curl *)','Bash(wget *)',
    `Edit(/${f.cwd}/.git)`,`Edit(/${f.cwd}/.git/**)`,`Write(/${f.cwd}/.git)`,`Write(/${f.cwd}/.git/**)`,
    `Edit(/${f.cwd}/.astraeus)`,`Edit(/${f.cwd}/.astraeus/**)`,`Write(/${f.cwd}/.astraeus)`,`Write(/${f.cwd}/.astraeus/**)`];
  const originalSettings={permissions:{defaultMode:'dontAsk',allow:allows,deny:denies}};
  const settings=JSON.parse(args[args.indexOf('--settings')+1]);
  assert.deepEqual(settings,{...originalSettings,worktree:{bgIsolation:'none'}});
  const originalArgs=[...args]; delete settings.worktree;
  originalArgs[originalArgs.indexOf('--settings')+1]=JSON.stringify(settings);
  assert.deepEqual(originalArgs,['--bg','--safe-mode','--model','claude-opus-5-5','--effort','high','--permission-mode','dontAsk','--setting-sources','','--settings',JSON.stringify(originalSettings),
    '--tools','Read,Edit,Write,Glob,Grep,Bash','--allowedTools',...allows,'--disallowedTools',...denies,'--add-dir',job.cli.directory,'--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--',args.at(-1)]);
  assert.equal(f.ctx.modelRegistry.getAvailable().length,0,'installed CLI, not Pi Anthropic credentials/catalog');
});
test('binding requires one exact UUID and canonical cwd, with minimal refusal evidence',async t=>{
  const f=await fixture(t),record={id:'12345678',sessionId:ID,cwd:f.cwd,state:'stopped',pid:null};
  f.state.records=[record];
  assert.equal((await f.cli.match(record.id,f.cwd,ID)).session_id,ID);
  const alias=join(f.agentDir,'cwd-alias'); await symlink(f.cwd,alias);
  f.state.records=[{...record,cwd:alias,session_id:ID}];
  assert.equal((await f.cli.match(record.id,f.cwd,ID)).cwd,f.cwd);
  const wrongFull='12345678-9999-2222-3333-444444444444';
  const cases=[
    ['missing-record',[]],['ambiguous-record',[record,record]],
    ['missing-uuid',[{...record,sessionId:undefined}]],
    ['invalid-uuid',[{...record,sessionId:'PRIVATE-INVALID-UUID'}]],
    ['uuid-prefix-mismatch',[{...record,sessionId:COPY}]],
    ['expected-uuid-mismatch',[{...record,sessionId:wrongFull}]],
    ['conflicting-uuid-aliases',[{...record,session_id:wrongFull}]],
    ['missing-cwd',[{...record,cwd:undefined}]],
    ['invalid-cwd',[{...record,cwd:17}]],
    ['cwd-unresolvable',[{...record,cwd:join(f.cwd,'nonexistent')}]],
    ['canonical-cwd-mismatch',[{...record,cwd:f.agentDir}]],
    ['unknown-response',{records:[record],private:'PRIVATE-RESPONSE'}],
  ];
  for(const [reason,records] of cases) {
    f.state.records=records;
    const count=f.calls.length;
    await assert.rejects(f.cli.match(record.id,f.cwd,ID),error=>{
      const uncertainty = ['missing-record','missing-uuid','invalid-uuid','missing-cwd','invalid-cwd','cwd-unresolvable','unknown-response'].includes(reason);
      assert.equal(error.code,uncertainty ? 'CLAUDE_OBSERVATION_UNCERTAIN' : 'CLAUDE_BINDING_REFUSED'); assert.equal(error.reason,reason);
      assert.equal(error.evidence.short_id,record.id); assert.equal(error.evidence.expected_uuid,ID);
      assert.ok(error.message.includes(reason)); assert.ok(error.message.length<1024);
      assert.ok(!error.message.includes('PRIVATE')); assert.ok(!error.message.includes('nonexistent'));
      return true;
    });
    assert.equal(f.calls.length-count,1,'ordinary match is one public read, never a mutation');
    if (['ambiguous-record','uuid-prefix-mismatch','expected-uuid-mismatch','conflicting-uuid-aliases','canonical-cwd-mismatch'].includes(reason)) {
      const before=f.calls.length;
      await assert.rejects(f.cli.ready(record.id,f.cwd,ID),error => error.code==='CLAUDE_BINDING_REFUSED' && error.reason===reason);
      assert.equal(f.calls.length-before,1,'genuine conflict fails immediately even in readiness observation');
    }
  }
  f.cli.invoke=async()=>({returncode:0,stdout:'{"private":"PRIVATE-MALFORMED',stderr:''});
  await assert.rejects(f.cli.match(record.id,f.cwd,ID),error=>{
    assert.equal(error.reason,'unknown-response'); assert.ok(!error.message.includes('PRIVATE')); return true;
  });
});
// Post-mutation readiness may lag the acknowledged command. These fixtures
// change only public observations; never repeat a mutating invocation to recover.
function delayedPublicRecords(f, observations) {
  const invoke=f.cli.invoke;
  let pending=[];
  f.cli.readinessAttempts=3; f.cli.readinessInterval=1; f.cli.readinessTimeout=1000;
  f.cli.invoke=async(command,args,cwd,...rest)=>{
    if(args[0]==='agents'&&args[1]==='--json'&&pending.length) {
      f.calls.push([...args]);
      return {returncode:0,stdout:JSON.stringify(pending.shift()),stderr:''};
    }
    const result=await invoke(command,args,cwd,...rest);
    if(args[0]==='--bg'||args[0]==='stop'&&args[1]!=='--help') pending=observations(args,structuredClone(f.state.records));
    return result;
  };
}

test('launch, stop, resume and exact copy cleanup tolerate bounded incomplete public readiness without repeated mutations',async t=>{
  const f=await fixture(t);
  delayedPublicRecords(f,(args,records)=> args[0]==='stop' ? [[],records.map(r=>({...r,pid:123,state:'working',status:'running'}))] :
    [[],records.map(r=>({...r,sessionId:undefined,cwd:undefined}))]);
  const job=await f.delegate(); assert.equal(job.cli.session_id,ID);
  await f.report(job,{changed_files:[]}); f.idle();
  assert.equal((await f.act({op:'collect',run_id:job.run_id})).valid,true);
  const follow=await f.act({op:'resume',run_id:job.run_id,prompt:'Bounded unattended fix'});
  assert.equal(follow.agent_id,job.agent_id); assert.equal(follow.collected,false);
  await f.report(follow,{changed_files:[]}); f.idle();
  assert.equal((await f.act({op:'collect',run_id:follow.run_id})).valid,true);
  assert.equal(f.calls.filter(a=>a[0]==='--bg').length,2);
  assert.equal(f.calls.filter(a=>a[0]==='stop'&&a[1]!=='--help').length,3,'one stop per collect and the required pre-resume stop');
  f.state.copy=true;
  await assert.rejects(f.act({op:'resume',run_id:follow.run_id,prompt:'Exact copy remains forbidden'}),/copied the owner/);
  const refused=f.workflow.tasks.design.jobs.at(-1);
  assert.equal(refused.cli.copy_frozen,true); assert.equal(refused.cli.session_id,ID); assert.equal(refused.valid,false);
  assert.equal(f.calls.filter(a=>a[0]==='stop'&&a[1]===COPY.slice(0,8)).length,1);
  assert.equal(f.calls.filter(a=>a[0]==='--bg'&&a[1]==='--resume').length,2);
});

for(const boundary of ['launch','stop','resume']) test(`${boundary} readiness exhaustion stays uncertain and unfrozen without repeated mutations`,async t=>{
  const f=await fixture(t);
  const invoke=f.cli.invoke; let failing=false, reads=0;
  f.cli.readinessAttempts=3; f.cli.readinessInterval=1; f.cli.readinessTimeout=1000;
  f.cli.invoke=async(command,args,cwd,...rest)=>{
    if(failing&&args[0]==='agents'&&args[1]==='--json') {reads++; f.calls.push([...args]); return {returncode:0,stdout:'[]',stderr:''};}
    const result=await invoke(command,args,cwd,...rest);
    if(boundary==='launch'&&args[0]==='--bg'||boundary==='stop'&&args[0]==='stop'&&args[1]!=='--help'||boundary==='resume'&&args[0]==='--bg'&&args[1]==='--resume') failing=true;
    return result;
  };
  let job;
  if(boundary==='launch') await assert.rejects(f.delegate(),/readiness observation exhausted/);
  else {
    job=await f.delegate(); await f.report(job,{changed_files:[]}); f.idle();
    if(boundary==='stop') {
      const failed=await f.act({op:'collect',run_id:job.run_id});
      assert.equal(failed.collected,false); assert.match(failed.error,/readiness observation exhausted/);
    } else {
      assert.equal((await f.act({op:'collect',run_id:job.run_id})).valid,true);
      await assert.rejects(f.act({op:'resume',run_id:job.run_id,prompt:'Same original owner only'}),/readiness observation exhausted/);
    }
  }
  const failed=f.workflow.tasks.design.jobs.at(-1);
  assert.equal(failed.cli.frozen,false); assert.equal(failed.valid,false); assert.equal(failed.collected,false);
  assert.equal(reads,3,'readiness query count is bounded');
  assert.equal(f.calls.filter(a=>a[0]==='--bg').length,boundary==='resume'?2:1);
  assert.equal(f.calls.filter(a=>a[0]==='stop'&&a[1]!=='--help').length,boundary==='launch'?0:boundary==='stop'?1:2);
  if(boundary==='resume') {
    const notices=[]; f.host.notify=n=>notices.push(n);
    f.workflow.pollInterval=10; f.workflow.maxBackoff=100;
    f.workflow.startMonitoring(f.ctx); t.after(()=>f.workflow.dispose());
    // Recover solely from monitor ticks after a dispatched resume's exhausted
    // readiness window. No parent tool/user input rescues the obligation.
    failing=false; f.idle();
    const deadline=Date.now()+2000;
    while(!notices.length&&Date.now()<deadline) await delay(10);
    assert.equal(notices.length,1); assert.equal(notices[0].run_id,failed.run_id); assert.equal(notices[0].status,'work-ended');
    assert.equal(failed.collected,false); assert.equal(failed.cli.frozen,false);
    await delay(40); assert.equal(notices.length,1);
    assert.equal(f.calls.filter(a=>a[0]==='--bg'&&a[1]==='--resume').length,1);
    await f.report(failed,{changed_files:[]});
    assert.equal((await f.act({op:'collect',run_id:failed.run_id})).valid,true);
  }
});

test('resume invocation followed by receipt failure remains uncollected and monitored, not inherited freeze',async t=>{
  const f=await fixture(t), job=await f.delegate(); await f.report(job,{changed_files:[]}); f.idle();
  await f.act({op:'collect',run_id:job.run_id});
  const evidence=f.cli.evidence.bind(f.cli);
  f.cli.evidence=async(...args)=>{
    const result=await evidence(...args);
    if(args[1]==='resume') throw new Error('Fixture post-invocation receipt failure');
    return result;
  };
  await assert.rejects(f.act({op:'resume',run_id:job.run_id,prompt:'Original owner fix'}),/receipt failure/);
  const follow=f.workflow.tasks.design.jobs.at(-1);
  assert.equal(follow.cli.frozen,false); assert.equal(follow.collected,false); assert.equal(follow.valid,false);
  assert.equal(f.state.records[0].state,'working');
  assert.equal(f.calls.filter(a=>a[0]==='--bg'&&a[1]==='--resume').length,1);
});

test('readiness deadline and cancellation bound observation-only queries',async t=>{
  const cwd=await mkdtemp(join(tmpdir(),'astraeus-readiness-')); t.after(()=>rm(cwd,{recursive:true,force:true}));
  const calls=[], cli=new ClaudeBackground({readinessAttempts:100,readinessTimeout:40,readinessInterval:100,
    invoke:async(_command,args)=>{calls.push(args); return {returncode:0,stdout:'[]',stderr:''};}});
  await assert.rejects(cli.ready('12345678',cwd,ID),/exhausted/);
  assert.equal(calls.length,1);
  cli.readinessTimeout=1000;
  const controller=new AbortController(), pending=cli.ready('12345678',cwd,ID,controller.signal);
  setTimeout(()=>controller.abort(),20);
  await assert.rejects(pending,/cancelled/); assert.equal(calls.length,2);
  cli.readinessTimeout=30;
  cli.invoke=async(_command,args)=>{calls.push(args); return new Promise(()=>{});};
  const started=Date.now();
  await assert.rejects(cli.ready('12345678',cwd,ID),/exhausted/);
  assert.ok(Date.now()-started<300,'total readiness deadline also bounds a transport ignoring cancellation');
  assert.equal(calls.length,3);
  assert.ok(calls.every(a=>JSON.stringify(a)==='["agents","--json","--all"]'));
});

test('noninteractive designer contract accompanies both initial and original-owner follow-up handoffs',async t=>{
  const f=await fixture(t),job=await f.delegate(); await f.report(job,{changed_files:[]}); f.idle();
  await f.act({op:'collect',run_id:job.run_id});
  const follow=await f.act({op:'resume',run_id:job.run_id,prompt:'Bounded original scope fix'});
  const contract=await readFile(join(ROOT,'agents/astraeus-designer.md'),'utf8');
  for(const args of f.calls.filter(a=>a[0]==='--bg')) {
    const prompt=args.at(-1);
    assert.ok(prompt.includes(contract),'canonical role is included, not just repository AGENTS guidance');
    assert.match(prompt,/Never ask the user questions, request interactive input\/approval, or wait for chat/);
    assert.match(prompt,/AskUserQuestion, plan approval, or interactive commands/);
    assert.match(prompt,/safe assumptions within the original authorized scope/);
    assert.match(prompt,/status: blocked/); assert.match(prompt,/options for root/);
    assert.match(prompt,/not guaranteed runtime enforcement/);
  }
  const resume=f.calls.find(a=>a[0]==='--bg'&&a[1]==='--resume');
  assert.deepEqual(resume,['--bg','--resume',ID,'--',resume.at(-1)],'no saved-setting or permission overrides');
  assert.ok(resume.at(-1).includes(follow.cli.pending)); assert.ok(resume.at(-1).includes(follow.run_id));
});

test('same-short resume mismatch remains bound to original UUID and retains diagnostic across restore',async t=>{
  const f=await fixture(t),job=await f.delegate(); await f.report(job,{changed_files:[]}); f.idle();
  assert.equal((await f.act({op:'collect',run_id:job.run_id})).valid,true);
  const invoke=f.cli.invoke,wrongFull='12345678-9999-2222-3333-444444444444';
  f.cli.invoke=async(...args)=>{
    const result=await invoke(...args);
    if(args[1][0]==='--bg' && args[1][1]==='--resume') f.state.records[0].sessionId=wrongFull;
    return result;
  };
  await assert.rejects(f.act({op:'resume',run_id:job.run_id,prompt:'Same owner fix'}),/expected-uuid-mismatch/);
  const follow=f.workflow.tasks.design.jobs.at(-1);
  assert.equal(follow.cli.session_id,ID); assert.equal(follow.agent_id,job.agent_id);
  assert.equal(follow.valid,false); assert.equal(follow.cli.unexpected_copy,undefined);
  assert.equal(f.calls.filter(a=>a[0]==='--bg'&&a[1]==='--resume').length,1);
  const resumeArgs=f.calls.find(a=>a[0]==='--bg'&&a[1]==='--resume');
  assert.deepEqual(resumeArgs,['--bg','--resume',ID,'--',resumeArgs.at(-1)]);
  assert.match(resumeArgs.at(-1),/Same owner fix/);
  assert.equal(f.calls.some(a=>a[0]==='stop'&&a[1]===wrongFull.slice(0,8)&&f.calls.indexOf(a)>f.calls.indexOf(resumeArgs)),false,'never stop a conflicting same-short identity');
  const restored=new Workflow(f.host,{claude:f.cli}); restored.restore(f.ctx);
  const saved=restored.tasks.design.jobs.at(-1);
  assert.match(saved.error,/expected-uuid-mismatch/); assert.match(saved.error,new RegExp(ID)); assert.match(saved.error,new RegExp(wrongFull));
  assert.equal(restored.activeJobs(f.cwd).length,1);
});
test('initial terminal launch and real same-owner resume notify separately without auto-freezing or collection',async t=>{
  for (const state of ['done','blocked','stopped','mystery']) {
    const f=await fixture(t), notices=[];
    f.host.notify=n=>notices.push(n); f.workflow.startMonitoring(f.ctx); t.after(()=>f.workflow.dispose());
    f.state.initialLifecycle={state,status:'idle'};
    const job=await f.delegate();
    assert.equal(notices.length,1); assert.equal(notices[0].status,state==='done'?'work-ended':state==='mystery'?'unknown':state);
    assert.equal(job.cli.frozen,false); assert.equal(job.valid,false); assert.equal(job.collected,false);
    assert.equal(f.calls.filter(a=>a[0]==='stop'&&a[1]!=='--help').length,0);
    if(state!=='done') continue;
    await f.report(job,{changed_files:[]}); await f.act({op:'collect',run_id:job.run_id});
    f.state.initialLifecycle={state:'working',status:'running'};
    const follow=await f.act({op:'resume',run_id:job.run_id,prompt:'Bounded fixture follow-up'});
    assert.equal(follow.agent_id,job.agent_id); f.idle();
    await f.act({op:'status'}); await f.act({op:'status'});
    assert.equal(notices.length,2); assert.equal(notices[1].run_id,follow.run_id); assert.equal(notices[1].status,'work-ended');
    assert.equal(job.cli.frozen,true); assert.equal(job.valid,true,'old frozen run must not poison latest resumed writer');
  }
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
  assert.deepEqual(resumeArgs,['--bg','--resume',ID,'--',resumeArgs.at(-1)]);
  assert.match(resumeArgs.at(-1),/Bounded fix/);
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
  const status=await f.act({op:'status'}); assert.equal(status[0].jobs[0].status,'unknown');
  await assert.rejects(f.act({op:'accept'}),/missing/);
  assert.equal(f.workflow.activeJobs(f.cwd).length,1);
});
for (const mode of ['checks','remaining','binding','symlink','stop']) test(`collection rejects ${mode}, retaining failed evidence`,async t=>{
  const f=await fixture(t),job=await f.delegate({checks:['npm test']});
  await writeFile(join(f.cwd,'ui.txt'),'new UI');
  let extra={};
  if(mode==='checks') extra={checks:[]};
  if(mode==='remaining') extra={remaining:['unfinished']};
  if(mode==='binding') extra={target_id:'wrong'};
  await f.report(job,extra); f.idle();
  if(mode==='symlink') { const path=job.cli.pending; await rm(path); const external=join(f.agentDir,'report'); await writeFile(external,'{}'); await symlink(external,path); }
  if(mode==='stop') f.state.failStop=true;
  const result=await f.act({op:'collect',run_id:job.run_id}); assert.equal(result.valid,false); assert.ok(result.error);
  if(['checks','remaining'].includes(mode)) assert.ok(result.artifact,'incomplete outcome is recorded, not accepted');
  else assert.equal(result.artifact,undefined);
  assert.ok(job.cli.evidence.some(e=>e.kind==='stop'));
});
test('outside and ignored deltas collect without exact full-repo changed_files attribution',async t=>{
  const f=await fixture(t),job=await f.delegate();
  await writeFile(join(f.cwd,'ui.txt'),'new UI'); await writeFile(join(f.cwd,'outside.txt'),'escape');
  await f.report(job); f.idle();
  await mkdir(join(f.cwd,'build')); await writeFile(join(f.cwd,'build/result'),'ignored generated output');
  assert.equal((await f.act({op:'collect',run_id:job.run_id})).valid,true);
  const baseline=structuredClone(job.cli.baseline);
  // Later shared-cwd changes, staging and history are root scope-review evidence,
  // not ownership-only collection failure or exact changed_files attribution.
  execFileSync('git',['add','outside.txt'],{cwd:f.cwd});
  execFileSync('git',['-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','shared writer'],{cwd:f.cwd});
  await writeFile(join(f.cwd,'ui.txt'),'later shared-cwd change');
  assert.equal((await f.act({op:'collect',run_id:job.run_id})).valid,true);
  const follow=await f.act({op:'resume',run_id:job.run_id,prompt:'Bounded follow-up'});
  assert.equal(follow.agent_id,job.agent_id); assert.deepEqual(job.cli.baseline,baseline);
  assert.equal(await readFile(join(f.cwd,'outside.txt'),'utf8'),'escape');
});
for(const mutation of ['report','evidence','request']) test(`resume revalidates collected ${mutation} rather than trusting saved valid flag`,async t=>{
  const f=await fixture(t),job=await f.delegate(); await f.report(job,{changed_files:[]}); f.idle();
  assert.equal((await f.act({op:'collect',run_id:job.run_id})).valid,true);
  if(mutation==='report') await writeFile(job.artifact,'{}');
  if(mutation==='evidence') await writeFile(job.cli.evidence.find(e=>e.kind==='stop').path,'{}');
  if(mutation==='request') await writeFile(join(job.cli.directory,'request.json'),'{}');
  const restored=new Workflow(f.host,{claude:f.cli}); restored.restore(f.ctx);
  await assert.rejects(restored.execute({op:'resume',task_id:'design',run_id:job.run_id,prompt:'Bounded follow-up'},f.ctx));
  assert.equal(restored.tasks.design.jobs.length,1); assert.equal(restored.tasks.design.jobs[0].valid,false);
  assert.equal(f.calls.filter(a=>a[0]==='--bg'&&a[1]==='--resume').length,0);
});
test('dirty assigned source is advisory; symlink scope escapes remain refused',async t=>{
  const f=await fixture(t);
  const job=await f.delegate({owned_paths:['user.txt']});
  assert.equal(await readFile(join(f.cwd,'user.txt'),'utf8'),'existing user changes');
  assert.match(f.calls.find(a=>a[0]==='--bg').at(-1),/Preserve existing user changes/);
  await f.report(job,{status:'blocked',remaining:['Fix required'],checks:[]}); f.idle();
  assert.equal((await f.act({op:'collect',run_id:job.run_id})).valid,false);
  await assert.rejects(f.act({op:'accept'}),/unresolved failed or incomplete/);
  const follow=await f.act({op:'resume',run_id:job.run_id,prompt:'Correct the blocked run'});
  assert.equal(follow.agent_id,job.agent_id);
  await f.act({op:'stop',run_id:follow.run_id});
  const other=await fixture(t);
  await symlink(other.agentDir,join(other.cwd,'escape'));
  await assert.rejects(other.delegate({owned_paths:['escape']}),/escapes cwd through symlink/);
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
  await f.report(follow,{changed_files:[]});
  const collected=await f.act({op:'collect',run_id:follow.run_id});
  assert.equal(collected.valid,false); assert.match(collected.error,/Unexpected copy/);
  assert.equal(follow.artifact,undefined); assert.equal(follow.cli.copy_frozen,true);
  assert.equal(f.workflow.activeJobs(f.cwd).length,0,'Exact cleanup remains effective, not successful work');
  const restored=new Workflow(f.host,{claude:f.cli}); restored.restore(f.ctx);
  const act=params=>restored.execute({task_id:'design',...params},f.ctx);
  assert.equal((await act({op:'collect',run_id:follow.run_id})).valid,false);
  await assert.rejects(act({op:'resume',run_id:follow.run_id,prompt:'Retry copied work'}));
  assert.equal(restored.tasks.design.jobs.length,2);
  assert.equal(f.calls.filter(a=>a[0]==='--bg'&&a[1]==='--resume').length,1);
  // Older versions could persist a successful flag after copy cleanup.
  const legacy=restored.tasks.design.jobs.at(-1); legacy.valid=true; restored.save(f.ctx);
  const legacyRestored=new Workflow(f.host,{claude:f.cli}); legacyRestored.restore(f.ctx);
  await assert.rejects(legacyRestored.execute({op:'accept',task_id:'design'},f.ctx),/Unexpected Claude copy/);
  await assert.rejects(legacyRestored.execute({op:'resume',task_id:'design',run_id:follow.run_id,prompt:'Legacy copied work'},f.ctx),/Unexpected copy/);
  assert.equal(legacyRestored.tasks.design.jobs.length,2);
});
test('unexpected emitted copy with mismatched cwd is never stopped blindly, rebound or accepted',async t=>{
  const f=await fixture(t),job=await f.delegate(); await f.report(job,{changed_files:[]}); f.idle();
  assert.equal((await f.act({op:'collect',run_id:job.run_id})).valid,true);
  f.state.copy=true; const invoke=f.cli.invoke;
  f.cli.invoke=async(...args)=>{
    const result=await invoke(...args);
    if(args[1][0]==='--bg'&&args[1][1]==='--resume') f.state.records.find(r=>r.sessionId===COPY).cwd=f.agentDir;
    return result;
  };
  await assert.rejects(f.act({op:'resume',run_id:job.run_id,prompt:'Bounded follow-up'}),/canonical-cwd-mismatch/);
  const follow=f.workflow.tasks.design.jobs.at(-1);
  assert.equal(follow.cli.session_id,ID); assert.equal(follow.agent_id,job.agent_id); assert.equal(follow.valid,false);
  assert.equal(f.calls.some(a=>a[0]==='stop'&&a[1]===COPY.slice(0,8)),false);
  assert.equal(f.calls.filter(a=>a[0]==='--bg'&&a[1]==='--resume').length,1);
  assert.equal(f.workflow.activeJobs(f.cwd).length,1);
  await f.report(follow,{changed_files:[]});
  assert.equal((await f.act({op:'collect',run_id:follow.run_id})).valid,false,'Matching report cannot erase refused emitted binding');
  assert.equal(follow.artifact,undefined);
  assert.deepEqual(follow.cli.unexpected_copy,{id:COPY.slice(0,8),session_id:null});
  assert.equal(follow.cli.copy_frozen,false);
  // A later matching public listing is not proof of the earlier writer identity.
  f.state.records.find(r=>r.sessionId===COPY).cwd=f.cwd;
  follow.valid=true; f.workflow.save(f.ctx); // legacy/stale success flag
  const restored=new Workflow(f.host,{claude:f.cli}); restored.restore(f.ctx);
  const act=params=>restored.execute({task_id:'design',...params},f.ctx);
  await assert.rejects(act({op:'accept'}),/copy binding is unverified/);
  assert.equal((await act({op:'collect',run_id:follow.run_id})).valid,false);
  await assert.rejects(act({op:'resume',run_id:follow.run_id,prompt:'Retry unverified copy'}));
  assert.equal(restored.tasks.design.jobs.length,2); assert.equal(restored.activeJobs(f.cwd).length,1);
  assert.equal(f.calls.some(a=>a[0]==='stop'&&a[1]===COPY.slice(0,8)),false);
  assert.equal(f.calls.filter(a=>a[0]==='--bg'&&a[1]==='--resume').length,1);
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
  await writeFile(join(f.cwd,'outside.txt'),'later shared-cwd edit');
  await mkdir(join(f.cwd,'build')); await writeFile(join(f.cwd,'build/output'),'ignored generated');
  await assert.rejects(f.act({op:'accept'}),/Review target changed/);
  // Fresh current-target native review replaces stale evidence, without forcing
  // full-repository attribution back into the original designer report.
  const current=await reviewer(); complete(current,reviewReport(current));
  assert.equal((await f.act({op:'collect',run_id:current.run_id})).valid,true);
  assert.equal((await f.act({op:'accept'})).accepted,true);
  await writeFile(follow.artifact,'{}'); await assert.rejects(f.act({op:'accept'}),/report bytes changed/);
});
