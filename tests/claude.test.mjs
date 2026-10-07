import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, cp, writeFile, readFile, rm, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
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

const CACHE = 'node_modules/.vite/vitest/da39a3ee5e6b4b0d3255bfef95601890afd80709/results.json';
async function generatedFixture(t,{existing=true,script='vitest run --root .',checks=['npm test','npm run typecheck']}={}) {
  const f=await fixture(t);
  await writeFile(join(f.cwd,'.gitignore'),'build/\nnode_modules/\n');
  await writeFile(join(f.cwd,'package.json'),JSON.stringify({scripts:{test:script,typecheck:'tsc --noEmit'}}));
  execFileSync('git',['add','.gitignore','package.json'],{cwd:f.cwd});
  execFileSync('git',['-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','verification fixture'],{cwd:f.cwd});
  const path=join(f.cwd,CACHE); await mkdir(join(path,'..'),{recursive:true});
  if(existing) await writeFile(path,'{"old":"fixture results"}');
  const job=await f.delegate({checks});
  await writeFile(join(f.cwd,'ui.txt'),'designed'); await writeFile(path,'{"new":"fixture results"}');
  await f.report(job); f.idle();
  const bytes=await readFile(job.cli.pending,'utf8');
  assert.equal((await f.act({op:'collect',run_id:job.run_id})).valid,false);
  assert.match(job.error,/Out-of-ownership baseline delta/);
  const current=await snapshot(f.cwd);
  const outputs=[{path:CACHE,before:job.cli.baseline.files[CACHE]??null,after:current.files[CACHE],reason:'Required npm test resolved to Vitest; its generated results cache is not UI source.'}];
  return {...f,job,bytes,outputs,recover:extra=>f.act({op:'reconcile_generated',run_id:job.run_id,generated_outputs:outputs,...extra})};
}

test('explicit cache reconciliation preserves original failed evidence/report/ownership across restore, then resumes same owner',async t=>{
  const f=await generatedFixture(t), job=f.job, baseline=structuredClone(job.cli.baseline), error=job.error;
  const failure=job.cli.evidence.find(e=>e.kind==='ownership-failure'), failureBytes=await readFile(failure.path,'utf8');
  f.workflow.save(f.ctx);
  const restored=new Workflow(f.host,{claude:f.cli}); restored.restore(f.ctx);
  const act=p=>restored.execute({task_id:'design',...p},f.ctx);
  const recovered=await act({op:'reconcile_generated',run_id:job.run_id,generated_outputs:f.outputs});
  assert.equal(recovered.valid,true,recovered.error); assert.deepEqual(recovered.cli.baseline,baseline);
  assert.deepEqual(recovered.owned_paths,['ui.txt']); assert.equal(recovered.agent_id,job.agent_id);
  assert.equal(await readFile(recovered.artifact,'utf8'),f.bytes);
  assert.equal(await readFile(failure.path,'utf8'),failureBytes);
  const receipt=JSON.parse(await readFile(recovered.cli.generated_reconciliation.path,'utf8'));
  assert.equal(receipt.failure.error,error); assert.equal(receipt.report_sha256,recovered.result_hash);
  assert.deepEqual(receipt.generated_outputs,f.outputs); assert.equal(receipt.required_vitest_check,'npm test');
  assert.ok(recovered.cli.generated_reconciliation.path.startsWith(f.agentDir+'/'));
  const view=modelView(recovered);
  assert.deepEqual(view.cli.generated_reconciliation,recovered.cli.generated_reconciliation);
  assert.equal(view.cli.ownership_failure.error,error); assert.equal(view.cli.baseline,undefined);
  assert.equal((await act({op:'collect',run_id:job.run_id})).valid,true);
  // Final audit has to check ignored output too, not merely the native Git review target.
  restored.tasks.design.consequential=false;
  assert.equal((await act({op:'accept'})).accepted,true);
  const follow=await act({op:'resume',run_id:job.run_id,prompt:'Bounded original UI fix'});
  assert.equal(follow.agent_id,job.agent_id); assert.deepEqual(follow.owned_paths,job.owned_paths);
  assert.equal(follow.cli.baseline.files[CACHE],f.outputs[0].after);
  assert.equal(follow.cli.generated_reconciliation,undefined,'approval never grants blanket cache ownership on a later run');
  const initial=f.calls.find(a=>a[0]==='--bg'), settings=JSON.parse(initial[initial.indexOf('--settings')+1]);
  assert.ok(!settings.permissions.allow.some(a=>a.includes('node_modules')));
  assert.deepEqual(f.calls.filter(a=>a[0]==='--bg').at(-1).slice(0,4),['--bg','--resume',ID,'--']);
  await writeFile(join(f.cwd,'ui.txt'),'bounded fix'); await writeFile(join(f.cwd,CACHE),'follow-up verification');
  await f.report(follow); f.idle();
  const failed=await act({op:'collect',run_id:follow.run_id}); assert.equal(failed.valid,false);
  assert.match(failed.error,/Out-of-ownership/);
  await assert.rejects(act({op:'resume',run_id:follow.run_id,prompt:'No implicit reapproval'}),/validated implementation/);
  const current=await snapshot(f.cwd);
  const again=await act({op:'reconcile_generated',run_id:follow.run_id,generated_outputs:[{...f.outputs[0],before:follow.cli.baseline.files[CACHE],after:current.files[CACHE],reason:'Explicit follow-up required Vitest results'}]});
  assert.equal(again.valid,true,again.error); assert.deepEqual(again.owned_paths,['ui.txt']);
});

test('legacy failed collection with newly created cache is revalidated without inventing historical hashes',async t=>{
  const f=await generatedFixture(t,{existing:false});
  delete f.job.cli.ownership_failure; // Older collector persisted only error + baseline/lifecycle evidence.
  f.job.cli.evidence=f.job.cli.evidence.filter(e=>e.kind!=='ownership-failure');
  f.workflow.save(f.ctx); f.workflow.restore(f.ctx);
  const job=f.workflow.tasks.design.jobs[0];
  assert.equal((await f.act({op:'status'}))[0].jobs[0].cli.ownership_failure.error,f.job.error);
  const result=await f.act({op:'reconcile_generated',run_id:job.run_id,generated_outputs:f.outputs});
  assert.equal(result.valid,true,result.error); assert.equal(f.outputs[0].before,null);
  const receipt=JSON.parse(await readFile(result.cli.generated_reconciliation.path,'utf8'));
  assert.match(receipt.failure.provenance,/not captured/); assert.equal(receipt.failure.report_sha256,undefined);
  assert.equal(await readFile(result.artifact,'utf8'),f.bytes);
  const review={run_id:'old-procedural-review',role:'reviewer',valid:true,collected:true,result:{verdict:'changes_required',unresolved:['Missing collection evidence']}};
  f.workflow.tasks.design.jobs.push(review);
  await assert.rejects(f.act({op:'resume',run_id:job.run_id,prompt:'Do not bypass old review'}),/adopted fixes/);
  assert.deepEqual(f.workflow.tasks.design.jobs.at(-1),review,'reconciliation does not waive or rewrite review gates');
});

test('reconciliation refuses unsupported paths, changed evidence, source escapes, and unfrozen lifecycle',async t=>{
  const cases={
    'fingerprint':async f=>{f.outputs[0].after='33188:'+ '0'.repeat(64);},
    'blank reason':async f=>{f.outputs[0].reason=' ';},
    'glob':async f=>{f.outputs[0].path='node_modules/.vite/vitest/*/results.json';},
    'arbitrary ignored source':async f=>{await mkdir(join(f.cwd,'build')); await writeFile(join(f.cwd,'build/source.mjs'),'source'); const s=await snapshot(f.cwd); f.outputs.push({path:'build/source.mjs',before:null,after:s.files['build/source.mjs'],reason:'not verification'});},
    'extra unowned source':async f=>writeFile(join(f.cwd,'outside.txt'),'escape'),
    'owned source changed after failure':async f=>writeFile(join(f.cwd,'ui.txt'),'later tamper'),
    'report changed after failure':async f=>f.report(f.job,{summary:'different bytes'}),
    'missing checks':async f=>f.report(f.job,{checks:[]}),
    'failed check':async f=>f.report(f.job,{checks:[{command:'npm test',outcome:'failed',evidence:'Fixture failure'}]}),
    'request tamper':async f=>writeFile(join(f.job.cli.directory,'request.json'),'{}'),
    'baseline tamper':async f=>{f.job.cli.baseline.files[CACHE]=f.outputs[0].after;},
    'historical failure tamper':async f=>{delete f.job.cli.ownership_failure.report_sha256;},
    'tracked cache':async f=>execFileSync('git',['add','-f',CACHE],{cwd:f.cwd}),
    'nonignored cache':async f=>writeFile(join(f.cwd,'.gitignore'),'build/\n'),
    'deletion':async f=>rm(join(f.cwd,CACHE)),
    'symlink':async f=>{await rm(join(f.cwd,CACHE)); await symlink(join(f.cwd,'ui.txt'),join(f.cwd,CACHE));},
    'symlink parent':async f=>{await rm(join(f.cwd,'node_modules/.vite/vitest'),{recursive:true}); await symlink(f.agentDir,join(f.cwd,'node_modules/.vite/vitest'));},
    'directory':async f=>{await rm(join(f.cwd,CACHE)); await mkdir(join(f.cwd,CACHE));},
    'index':async f=>execFileSync('git',['add','ui.txt'],{cwd:f.cwd}),
    'HEAD':async f=>execFileSync('git',['-c','user.name=Test','-c','user.email=test@example.invalid','commit','--allow-empty','-qm','tamper'],{cwd:f.cwd}),
    'live owner':async f=>Object.assign(f.state.records[0],{state:'working',status:'running',pid:321}),
    'unknown owner':async f=>Object.assign(f.state.records[0],{state:'mystery',status:null}),
    'missing owner':async f=>{f.state.records=[];},
    'copy':async f=>{f.job.cli.unexpected_copy={id:COPY.slice(0,8),session_id:null};},
  };
  for(const [name,mutate] of Object.entries(cases)) await t.test(name,async t=>{
    const f=await generatedFixture(t),count=f.calls.filter(a=>a[0]==='--bg').length;
    await mutate(f);
    await assert.rejects(f.recover());
    assert.equal(f.job.valid,false); assert.equal(f.job.artifact,undefined);
    assert.deepEqual(f.job.owned_paths,['ui.txt']); assert.equal(f.job.cli.generated_reconciliation,undefined);
    assert.equal(f.calls.filter(a=>a[0]==='--bg').length,count,'recovery never launches inference');
  });
});

test('reconciliation requires an actual passed required Vitest command, not arbitrary verification',async t=>{
  for(const options of [{script:'node test.mjs'}, {checks:[]}]) {
    const f=await generatedFixture(t,options);
    await assert.rejects(f.recover(),/required Vitest/);
    assert.equal(f.job.cli.generated_reconciliation,undefined);
  }
});

test('recollect, resume and final audit pin approved cache/source/report/receipt bytes',async t=>{
  for(const mutation of ['cache','source','report','receipt']) await t.test(mutation,async t=>{
    const f=await generatedFixture(t); assert.equal((await f.recover()).valid,true);
    f.workflow.tasks.design.consequential=false;
    if(mutation==='cache') await writeFile(join(f.cwd,CACHE),'later ignored mutation');
    if(mutation==='source') await writeFile(join(f.cwd,'ui.txt'),'later owned mutation');
    if(mutation==='report') await writeFile(f.job.artifact,'{}');
    if(mutation==='receipt') await writeFile(f.job.cli.generated_reconciliation.path,'{}');
    f.workflow.save(f.ctx); f.workflow.restore(f.ctx);
    const count=f.calls.filter(a=>a[0]==='--bg').length;
    await assert.rejects(f.act({op:'accept'}));
    assert.equal(f.workflow.tasks.design.accepted,false);
    await assert.rejects(f.act({op:'resume',run_id:f.job.run_id,prompt:'Must not trust saved valid'}));
    const result=await f.act({op:'collect',run_id:f.job.run_id}); assert.equal(result.valid,false);
    assert.equal(f.calls.filter(a=>a[0]==='--bg').length,count); assert.equal(f.workflow.tasks.design.jobs.length,1);
  });
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
test('initial shared-cwd setting is the only launch argv change; exact model and permission/auth route remain',async t=>{
  const f=await fixture(t),job=await f.delegate({checks:['npm test']});
  const args=f.calls.find(a=>a[0]==='--bg');
  const allows=['Read','Glob','Grep',`Edit(/${f.cwd}/ui.txt)`,`Edit(/${f.cwd}/ui.txt/**)`,`Write(/${f.cwd}/ui.txt)`,`Write(/${f.cwd}/ui.txt/**)`,
    `Edit(/${job.cli.report_directory}/**)`,`Write(/${job.cli.report_directory}/**)`,'Bash(npm test)'];
  const denies=['Agent','Task','Bash(git push *)','Bash(git -C * push *)','Bash(gh *)','Bash(glab *)','Bash(curl *)','Bash(wget *)',
    `Edit(/${f.cwd}/.git)`,`Edit(/${f.cwd}/.git/**)`,`Write(/${f.cwd}/.git)`,`Write(/${f.cwd}/.git/**)`];
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
      assert.equal(error.code,'CLAUDE_BINDING_REFUSED'); assert.equal(error.reason,reason);
      assert.equal(error.evidence.short_id,record.id); assert.equal(error.evidence.expected_uuid,ID);
      assert.ok(error.message.includes(reason)); assert.ok(error.message.length<1024);
      assert.ok(!error.message.includes('PRIVATE')); assert.ok(!error.message.includes('nonexistent'));
      return true;
    });
    assert.equal(f.calls.length-count,1,'one public read, never readiness retry or mutation');
  }
  f.cli.invoke=async()=>({returncode:0,stdout:'{"private":"PRIVATE-MALFORMED',stderr:''});
  await assert.rejects(f.cli.match(record.id,f.cwd,ID),error=>{
    assert.equal(error.reason,'unknown-response'); assert.ok(!error.message.includes('PRIVATE')); return true;
  });
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
test('failed owned-delta collection cannot be erased by a resume baseline',async t=>{
  const f=await fixture(t),job=await f.delegate();
  await writeFile(join(f.cwd,'ui.txt'),'new UI'); await writeFile(join(f.cwd,'outside.txt'),'escape');
  await f.report(job); f.idle();
  assert.equal((await f.act({op:'collect',run_id:job.run_id})).valid,false);
  const baseline=structuredClone(job.cli.baseline), count=f.workflow.tasks.design.jobs.length;
  await assert.rejects(f.act({op:'resume',run_id:job.run_id,prompt:'Bounded follow-up'}),/validated implementation/);
  assert.equal(f.workflow.tasks.design.jobs.length,count); assert.deepEqual(job.cli.baseline,baseline);
  assert.equal(f.calls.filter(a=>a[0]==='--bg'&&a[1]==='--resume').length,0);
  assert.equal(await readFile(join(f.cwd,'outside.txt'),'utf8'),'escape');
});
for(const mutation of ['source','report','evidence']) test(`resume revalidates collected ${mutation} rather than trusting saved valid flag`,async t=>{
  const f=await fixture(t),job=await f.delegate(); await f.report(job,{changed_files:[]}); f.idle();
  assert.equal((await f.act({op:'collect',run_id:job.run_id})).valid,true);
  if(mutation==='source') await writeFile(join(f.cwd,'outside.txt'),'late outside mutation');
  if(mutation==='report') await writeFile(job.artifact,'{}');
  if(mutation==='evidence') await writeFile(job.cli.evidence.find(e=>e.kind==='stop').path,'{}');
  const restored=new Workflow(f.host,{claude:f.cli}); restored.restore(f.ctx);
  await assert.rejects(restored.execute({op:'resume',task_id:'design',run_id:job.run_id,prompt:'Bounded follow-up'},f.ctx));
  assert.equal(restored.tasks.design.jobs.length,1); assert.equal(restored.tasks.design.jobs[0].valid,false);
  assert.equal(f.calls.filter(a=>a[0]==='--bg'&&a[1]==='--resume').length,0);
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
  await writeFile(follow.artifact,'{}'); await assert.rejects(f.act({op:'accept'}),/report bytes changed/);
});
