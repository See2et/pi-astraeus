import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {Workflow, ROOT, ENTRY} from '../extensions/core.mjs';
import {ClaudeBackground, capture, observedStatus} from '../extensions/claude.mjs';

const uuid = '12345678-1111-2222-3333-444444444444';
const job = (run = 'run-one') => ({run_id:run, agent_id:`claude:${uuid}`, role:'designer', transport:'claude-code-bg-v1',
  status:'running', collected:false, valid:false, cli:{short_id:'12345678', session_id:uuid, evidence:[], frozen:false}});
const task = (cwd, jobs = [job()]) => ({task_id:'fixture', cwd, phase:'implementation', accepted:false, jobs});
const context = (cwd, tasks, id = 'fixture') => ({cwd, hasUI:false, sessionManager:{getSessionId:() => id,
  getBranch:() => [{type:'custom', customType:ENTRY, data:{version:1, tasks}}]}});
async function until(predicate, timeout = 2000) {
  const end = Date.now() + timeout;
  while (!predicate() && Date.now() < end) await delay(10);
  assert.ok(predicate(), 'bounded wait for expected lifecycle event');
}

test('public classification distinguishes readiness/non-success from frozen/report validity', async () => {
  const samples = [
    [{state:'working',status:'running'},'running'], [{state:'done',status:'idle'},'work-ended'],
    [{state:'idle',status:'idle'},'work-ended'], [{state:'blocked',status:'idle'},'blocked'],
    [{state:'stopped',status:'idle'},'stopped'], [{state:'mystery',status:'running'},'unknown'],
    [null,'unknown'], [{state:'done',status:'busy'},'unknown'],
  ];
  for (const [record, expected] of samples) assert.equal(observedStatus(record), expected);
  const workflow = new Workflow({manager:() => undefined, appendEntry(){}}, {claude:{async observe(j) {j.cli.observed={state:'done',status:'idle',pid:42};}}});
  workflow.tasks = {fixture:task('/tmp')};
  const result = await workflow.execute({op:'status'}, context('/tmp', {}));
  assert.equal(result[0].jobs[0].status, 'work-ended');
  assert.equal(result[0].jobs[0].cli.frozen, false);
  assert.equal(result[0].jobs[0].valid, false);
  assert.equal(workflow.activeJobs('/tmp').length, 1, 'readiness must not unlock writers');
});

test('latest owner only; repeated observations dedup, resume and running-to-ended re-notify', async t => {
  const notices = [], saves = [], records = {state:'done',status:'idle',pid:42};
  const workflow = new Workflow({manager:() => undefined, appendEntry:(...args) => saves.push(args), notify:n => notices.push(n)},
    {pollInterval:10, claude:{async observe(j) {j.cli.observed={...records};}}});
  t.after(() => workflow.dispose());
  workflow.restore(context('/tmp', {fixture:task('/tmp')}));
  await until(() => notices.length === 1);
  await delay(50); assert.equal(saves.length, 1, 'unchanged polls do not append repeated baselines');
  for (let i=0;i<3;i++) await workflow.execute({op:'status'}, workflow.session.ctx);
  assert.equal(notices.length, 1);
  Object.assign(records,{state:'working',status:'running'});
  await workflow.execute({op:'status'}, workflow.session.ctx);
  Object.assign(records,{state:'done',status:'idle'});
  await workflow.execute({op:'status'}, workflow.session.ctx);
  assert.equal(notices.length, 2);
  const old = workflow.tasks.fixture.jobs[0]; old.cli.frozen = true; old.collected = true; old.valid = true;
  workflow.tasks.fixture.jobs.push(job('resumed-run'));
  await until(() => notices.length === 3);
  assert.equal(notices[2].run_id, 'resumed-run');
  assert.equal(old.cli.frozen, true, 'old frozen runs are not observed against resumed owner');
  assert.equal(old.valid, true);
  assert.equal(workflow.activeJobs('/tmp').length, 1);
});

test('hung observation is bounded, reports unknown once, backs off, leaves queue responsive', async t => {
  let calls=0;
  const cli = new ClaudeBackground({observationTimeout:30, invoke:() => {calls++; return new Promise(() => {});}});
  const notices=[];
  const workflow = new Workflow({manager:() => undefined, appendEntry(){}, notify:n => notices.push(n)},
    {claude:cli, pollInterval:10, maxBackoff:100});
  t.after(() => workflow.dispose());
  workflow.restore(context('/tmp', {fixture:task('/tmp')}));
  await until(() => notices.length === 1);
  assert.equal(notices[0].status, 'unknown'); assert.match(notices[0].error, /timed out/);
  const start=Date.now();
  await workflow.execute({op:'invalidate', task_id:'fixture'}, workflow.session.ctx);
  assert.ok(Date.now()-start < 300, 'queue not held by hung query');
  await delay(220);
  assert.equal(notices.length, 1); assert.ok(calls <= 5, 'failure backoff bounds repeated queries');
});

for (const reason of ['replacement','tree','shutdown']) test(`${reason} retires late observations and queued monitor operations`, async t => {
  let release, started=false;
  const notices=[], saves=[];
  const workflow = new Workflow({manager:() => undefined, appendEntry:(...args) => saves.push(args), notify:n => notices.push(n)},
    {pollInterval:10, claude:{async observe(j) {started=true; await new Promise(r => {release=r;}); j.cli.observed={state:'done',status:'idle'};}}});
  t.after(() => workflow.dispose());
  workflow.restore(context('/tmp', {fixture:task('/tmp')}));
  await until(() => started);
  const retired = workflow.tasks.fixture.jobs[0];
  const pending = workflow.execute({op:'status'}, workflow.session.ctx).catch(e => e);
  workflow.dispose();
  if (reason !== 'shutdown') workflow.restore(context('/tmp', {}, 'replacement'));
  release(); await pending; await delay(40);
  assert.equal(retired.status, 'running'); assert.equal(retired.cli.observed, undefined);
  assert.equal(notices.length, 0); assert.equal(saves.length, 0);
});

test('fake observation child timeout/output/cancellation are bounded without stopping owner', async t => {
  const cwd=await mkdtemp(join(tmpdir(),'astraeus-capture-')); t.after(() => rm(cwd,{recursive:true,force:true}));
  const start=Date.now();
  const timeout = await capture(process.execPath, ['-e','setInterval(()=>{},1000)'], cwd, {timeout:50,maxBytes:1024});
  assert.match(timeout.diagnostic,/timed out/); assert.ok(Date.now()-start < 1000);
  const output = await capture(process.execPath, ['-e','process.stdout.write("x".repeat(100000)); setInterval(()=>{},1000)'], cwd, {timeout:1000,maxBytes:1024});
  assert.match(output.diagnostic,/output limit/); assert.ok(Buffer.byteLength(output.stdout)+Buffer.byteLength(output.stderr) <= 1024);
  const controller=new AbortController();
  const pending=capture(process.execPath,['-e','setInterval(()=>{},1000)'],cwd,{signal:controller.signal,timeout:1000});
  controller.abort(); assert.match((await pending).diagnostic,/cancelled/);
});

async function notificationFixture(t, initialState = 'done', holdStartup = false) {
  const base=await mkdtemp(join(tmpdir(),'astraeus-notices-')); t.after(() => rm(base,{recursive:true,force:true}));
  const cwd=join(base,'repo'), agentDir=join(base,'agent'), bin=join(base,'bin'), recordPath=join(base,'records.json'), startedPath=join(base,'query-started');
  await Promise.all([mkdir(cwd),mkdir(agentDir),mkdir(bin)]);
  const record={id:'12345678',sessionId:uuid,cwd,state:initialState,status:initialState==='working'?'running':'idle',pid:42};
  await writeFile(recordPath,JSON.stringify([record]));
  await writeFile(join(bin,'claude'), `#!${process.execPath}\nimport fs from 'node:fs';\nif(JSON.stringify(process.argv.slice(2)) !== '["agents","--json","--all"]') process.exit(1);\nconst records=JSON.parse(fs.readFileSync(${JSON.stringify(recordPath)},'utf8'));\nif(records[0]?.fixtureDelay) {fs.writeFileSync(${JSON.stringify(startedPath)},'started'); setTimeout(()=>console.log(JSON.stringify(records)),500);} else console.log(JSON.stringify(records));\n`,{mode:0o755});
  const oldPath=process.env.PATH; process.env.PATH=`${bin}:${oldPath}`;
  const oldDir=process.env.PI_CODING_AGENT_DIR, oldOffline=process.env.PI_OFFLINE;
  process.env.PI_CODING_AGENT_DIR=agentDir; process.env.PI_OFFLINE='1';
  t.after(() => {process.env.PATH=oldPath; if(oldDir===undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR=oldDir; if(oldOffline===undefined) delete process.env.PI_OFFLINE; else process.env.PI_OFFLINE=oldOffline;});
  const {DefaultResourceLoader,SettingsManager,SessionManager,createAgentSession,ModelRuntime,createEventBus}=await import('@earendil-works/pi-coding-agent');
  const {createAssistantMessageEventStream}=await import('@earendil-works/pi-ai');
  let parentRequests=0;
  const prompts={hold:false, finishes:[], contexts:[], input:null, commands:0, attempts:0};
  const navigation={cancel:false, treeEvents:0, summaryMode:null, summaryRequests:0, finish:null};
  const compaction={gate:null, started:false};
  const fake=pi => {
    pi.registerCommand('fixture-immediate',{description:'Deterministic command',handler:async () => {prompts.commands++;}});
    pi.on('input', async () => {
      if (!prompts.input) return;
      const input=prompts.input; prompts.input=null; input.started=true;
      await input.promise; return input.result;
    });
    pi.on('session_before_compact', async () => {
      if (!compaction.gate) return;
      compaction.started=true;
      await compaction.gate;
      return {cancel:true};
    });
    pi.on('session_before_tree', () => navigation.cancel ? {cancel:true} : undefined);
    pi.on('session_tree', () => {navigation.treeEvents++;});
    pi.registerProvider('local-notice', {api:'local-notice-api', apiKey:'fixture-only',baseUrl:'http://invalid.local',
    models:[{id:'stub',name:'Fixture',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:32000,maxTokens:1000}],
    streamSimple:(model, _context, options) => {
      const stream=createAssistantMessageEventStream();
      const message={role:'assistant',provider:model.provider,api:model.api,model:model.id,content:[{type:'text',text:'Observed, not accepted.'}],stopReason:'stop',timestamp:Date.now(),usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
      if (navigation.summaryMode) {
        navigation.summaryRequests++;
        navigation.finish=reason => {
          options?.signal?.removeEventListener('abort', abort);
          message.stopReason=reason;
          if(reason==='error') message.errorMessage='Fixture summary error';
          stream.push(reason==='stop' ? {type:'done',reason,message} : {type:'error',reason,error:message});
          stream.end(message); navigation.summaryMode=null;
        };
        const abort=() => navigation.finish('aborted');
        options?.signal?.addEventListener('abort', abort, {once:true});
        if(options?.signal?.aborted) abort();
      } else {
        parentRequests++;
        prompts.contexts.push(structuredClone(_context.messages));
        const finish=() => {stream.push({type:'done',reason:'stop',message}); stream.end(message);};
        if(prompts.hold) prompts.finishes.push(finish); else queueMicrotask(finish);
      }
      return stream;
    }});
  };
  const runtime=await ModelRuntime.create({authPath:join(agentDir,'auth.json'),modelsPath:join(agentDir,'models.json')});
  const settings=SettingsManager.inMemory({compaction:{enabled:false,keepRecentTokens:16},retry:{enabled:false}});
  const startup={extension:join(base,'startup.ts'),started:join(base,'startup-started'),release:join(base,'startup-release')};
  if (holdStartup) await writeFile(startup.extension, `
    import {existsSync, writeFileSync} from 'node:fs';
    import {setTimeout as delay} from 'node:timers/promises';
    export default function(pi) {
      let held=false;
      pi.on('agent_start', async (_event, ctx) => {
        if (held) return; held=true;
        writeFileSync(${JSON.stringify(startup.started)}, 'started');
        const end=Date.now()+10000;
        while (!existsSync(${JSON.stringify(startup.release)}) && !ctx.signal?.aborted && Date.now()<end) await delay(10);
      });
    }
  `);
  const loader=new DefaultResourceLoader({cwd,agentDir,eventBus:createEventBus(),settingsManager:settings,noExtensions:true,noContextFiles:true,extensionFactories:[fake],additionalExtensionPaths:holdStartup?[startup.extension,ROOT]:[ROOT],disabledBuiltinExtensions:['mcp']});
  await loader.reload(); assert.deepEqual(loader.getExtensions().errors,[]);
  if (holdStartup) assert.equal(loader.getExtensions().extensions[0].path,startup.extension,'gate extension must run before Astraeus, not an appended inline factory');
  const manager=SessionManager.inMemory(cwd); manager.appendCustomEntry(ENTRY,{version:1,tasks:{fixture:task(cwd)}});
  const {session}=await createAgentSession({cwd,agentDir,modelRuntime:runtime,model:runtime.getModel('openai','gpt-6.1-sol'),settingsManager:settings,sessionManager:manager,resourceLoader:loader});
  const notices=[], errors=[];
  const prompt=session.agent.prompt.bind(session.agent);
  session.agent.prompt=(...args) => {prompts.attempts++; return prompt(...args);};
  const send=session.sendCustomMessage.bind(session);
  session.sendCustomMessage=(message,options) => {notices.push({message,options}); return send(message,options);};
  t.after(async () => {await session.extensionRunner.emit({type:'session_shutdown',reason:'quit'}); session.dispose();});
  await session.bindExtensions({onError:error => errors.push(error)}); await session.setModel(runtime.getModel('local-notice','stub'));
  const status=() => session.agent.state.tools.find(t => t.name==='astraeus_workflow').execute('fixture-status',{op:'status'},new AbortController().signal);
  return {session, manager, notices, errors, navigation, compaction, startup, prompts, runtime, record, recordPath, startedPath, status, parentRequests:() => parentRequests,
    publish:() => writeFile(recordPath,JSON.stringify([record]))};
}

for (const state of ['done','blocked']) test(`actual prompt ${state} refresh preserves the user run instead of racing agent.prompt`, async t => {
  const f=await notificationFixture(t,'working');
  await until(() => f.manager.getBranch().filter(e => e.type==='custom'&&e.customType===ENTRY).at(-1).data.tasks.fixture.jobs[0].cli.notified_status==='running');
  // Actual resource/runtime reload must install a fresh owner without stacking
  // observers or losing the per-session prompt reservation.
  if(state==='done') await f.session.reload();
  f.record.state=state; f.record.status='idle'; await f.publish();
  f.prompts.hold=true;
  const user='Original user input, exactly once';
  const outcome=f.session.prompt(user).then(() => ({ok:true}),error => ({error}));
  await until(() => f.parentRequests()===1);
  // Hold the deterministic provider so the old lifecycle wake remains active
  // when the user's preflight attempts its own low-level agent.prompt.
  await delay(30);
  f.prompts.hold=false; f.prompts.finishes.splice(0).forEach(finish => finish());
  const result=await outcome;
  assert.equal(result.error,undefined,`user prompt rejected: ${result.error?.message}`);
  await f.session.waitForIdle();
  const messages=f.manager.buildSessionContext().messages;
  assert.equal(messages.filter(m => m.role==='user'&&m.content.some(c => c.type==='text'&&c.text===user)).length,1);
  assert.equal(messages.filter(m => m.customType==='pi-astraeus:claude-lifecycle').length,1);
  assert.equal(f.notices[0].message.details.status,state==='done'?'work-ended':'blocked');
  assert.deepEqual(f.notices[0].options,{deliverAs:'followUp',triggerTurn:false});
  assert.equal(f.parentRequests(),1,'notice is included in the original request, not a duplicate parent run');
  assert.equal(f.prompts.attempts,1,'no competing low-level agent.prompt attempt');
  assert.deepEqual(f.errors,[]);
  assert.ok(JSON.stringify(f.prompts.contexts[0]).includes(user));
  assert.ok(JSON.stringify(f.prompts.contexts[0]).includes(f.notices[0].message.details.diagnostic));
  await f.status(); assert.equal(f.parentRequests(),1,'unchanged observation cannot loop');
});

test('actual monitor during awaited authentication adds attention to the upcoming user context', async t => {
  const f=await notificationFixture(t,'working');
  await until(() => f.manager.getBranch().filter(e => e.type==='custom'&&e.customType===ENTRY).at(-1).data.tasks.fixture.jobs[0].cli.notified_status==='running');
  let release, authenticating=false;
  const configured=f.runtime.hasConfiguredAuth, check=f.runtime.checkAuth;
  f.runtime.hasConfiguredAuth=() => false;
  f.runtime.checkAuth=async () => {authenticating=true; return new Promise(resolve => {release=resolve;});};
  const user='User held during authentication';
  const outcome=f.session.prompt(user).then(() => ({ok:true}),error => ({error}));
  await until(() => authenticating);
  f.record.state='blocked'; f.record.status='idle'; await f.publish();
  // No explicit status refresh: the actual session monitor ticks in the gap.
  await until(() => f.notices.length===1,6500);
  assert.equal(f.parentRequests(),0,'isIdle during preflight is not permission to wake');
  assert.equal(f.prompts.attempts,0);
  assert.deepEqual(f.notices[0].options,{deliverAs:'followUp',triggerTurn:false});
  f.runtime.hasConfiguredAuth=configured; f.runtime.checkAuth=check; release('fixture-only');
  assert.equal((await outcome).error,undefined);
  assert.equal(f.parentRequests(),1);
  assert.ok(JSON.stringify(f.prompts.contexts[0]).includes(user));
  assert.ok(JSON.stringify(f.prompts.contexts[0]).includes('Needs attention; NOT successful completion.'));
  assert.equal(f.manager.getBranch().filter(e => e.customType==='pi-astraeus:claude-wake').length,0);
});

for (const exit of ['handled','auth-error']) test(`actual ${exit} preflight releases notification reservation without masking errors`, async t => {
  const f=await notificationFixture(t,'working');
  await until(() => f.manager.getBranch().filter(e => e.type==='custom'&&e.customType===ENTRY).at(-1).data.tasks.fixture.jobs[0].cli.notified_status==='running');
  let release;
  const gate={promise:new Promise(resolve => {release=resolve;}),started:false,result:{action:'handled'}};
  const configured=f.runtime.hasConfiguredAuth, check=f.runtime.checkAuth;
  if(exit==='handled') f.prompts.input=gate;
  else {
    f.runtime.hasConfiguredAuth=() => false;
    f.runtime.checkAuth=async () => {gate.started=true; await gate.promise; return undefined;};
  }
  const outcome=f.session.prompt('Unaccepted fixture input').then(() => ({ok:true}),error => ({error}));
  await until(() => gate.started);
  f.record.state='done'; f.record.status='idle'; await f.publish(); await f.status();
  assert.equal(f.parentRequests(),0);
  f.runtime.hasConfiguredAuth=configured; f.runtime.checkAuth=check; release();
  const result=await outcome;
  if(exit==='handled') assert.equal(result.ok,true);
  else assert.match(result.error.message,/No API key found/,'unrelated auth error is propagated, not caught or retried');
  await until(() => f.parentRequests()===1); await f.session.waitForIdle();
  assert.equal(f.manager.buildSessionContext().messages.filter(m => m.role==='user').length,0,'handled/failed input is not resubmitted');
  assert.equal(f.manager.getBranch().filter(e => e.customType==='pi-astraeus:claude-lifecycle').length,1);
  assert.equal(f.manager.getBranch().filter(e => e.customType==='pi-astraeus:claude-wake').length,1);
  assert.ok(JSON.stringify(f.prompts.contexts[0]).includes('ready to attempt collect, NOT implementation success.'));
  f.record.state='blocked'; await f.publish(); await f.status();
  await until(() => f.parentRequests()===2); await f.session.waitForIdle();
  assert.deepEqual(f.notices.at(-1).options,{deliverAs:'followUp',triggerTurn:true},'future idle notifications remain enabled');
  await f.status(); assert.equal(f.parentRequests(),2);
});

for (const exit of ['handled','auth-error']) test(`notification-owned ${exit} preparation retries autonomously until an actual parent run`, async t => {
  const f=await notificationFixture(t,'working');
  await until(() => f.manager.getBranch().filter(e => e.type==='custom'&&e.customType===ENTRY).at(-1).data.tasks.fixture.jobs[0].cli.notified_status==='running');
  const send=f.session.sendCustomMessage.bind(f.session);
  const configured=f.runtime.hasConfiguredAuth, check=f.runtime.checkAuth;
  let attempts=0, release;
  const started=[];
  // Pi 1.0.4's default custom-message dispatch bypasses input/auth preflight.
  // Model a host that does prepare notification turns through public prompt(),
  // exercising real handled/auth-failure completion with the pinned SDK. The
  // notice is appended once before preparation, never resubmitted as user work.
  f.session.sendCustomMessage=async (message,options) => {
    if (!options?.triggerTurn || attempts>=2) return send(message,options);
    started.push(Date.now()); attempts++;
    if (message.customType==='pi-astraeus:claude-lifecycle') await send(message,{...options,triggerTurn:false});
    if(exit==='handled') {
      const gate={promise:attempts===1 ? new Promise(resolve => {release=resolve;}) : Promise.resolve(),started:false,result:{action:'handled'}};
      f.prompts.input=gate;
      return f.session.prompt('Fixture notification preflight consumed by host');
    }
    f.runtime.hasConfiguredAuth=() => false;
    f.runtime.checkAuth=async () => undefined;
    try { return await f.session.prompt('Fixture notification auth preflight'); }
    finally { f.runtime.hasConfiguredAuth=configured; f.runtime.checkAuth=check; }
  };
  f.record.state='done'; f.record.status='idle'; await f.publish(); await f.status();
  if(exit==='handled') {
    await until(() => attempts===1); await delay(250);
    assert.equal(attempts,1,'a held preparation owns the wake; timer cannot compete');
    release();
  }
  // No new user prompt, tool call or record change after the original dispatch.
  await until(() => f.parentRequests()===1); await f.session.waitForIdle();
  assert.equal(attempts,2,'both original dispatch and hidden wake can fail/handle before recovery');
  assert.ok(started[1]-started[0]>=80,'failed/handled wakes back off rather than hot-looping');
  await delay(350); assert.equal(f.parentRequests(),1,'actual agent_start consumes the pending obligation');
  assert.equal(f.manager.getBranch().filter(e => e.customType==='pi-astraeus:claude-lifecycle').length,1);
  assert.equal(f.manager.buildSessionContext().messages.filter(m => m.role==='user').length,0);
  assert.ok(JSON.stringify(f.prompts.contexts[0]).includes('ready to attempt collect, NOT implementation success.'));
  if(exit==='handled') assert.deepEqual(f.errors,[]);
  else {assert.equal(f.errors.length,2); assert.ok(f.errors.every(e=>/No API key found/.test(e.error)));}
});

async function heldCompaction(f) {
  // Enough persisted conversation for Pi's actual manual compaction entry point.
  f.manager.appendMessage({role:'user',content:'Older fixture conversation to compact. '.repeat(10),timestamp:Date.now()});
  f.manager.appendMessage({role:'user',content:'Recent fixture conversation to keep. '.repeat(10),timestamp:Date.now()});
  f.session.refreshContext();
  let release;
  f.compaction.started=false;
  f.compaction.gate=new Promise(resolve => {release=resolve;});
  const outcome=f.session.compact().then(result => ({result}),error => ({error}));
  await until(() => f.compaction.started);
  return {release, outcome};
}

test('pending preflight attention wakes autonomously after compaction, not at the next user message', async t => {
  const f=await notificationFixture(t,'working');
  await until(() => f.manager.getBranch().filter(e => e.type==='custom'&&e.customType===ENTRY).at(-1).data.tasks.fixture.jobs[0].cli.notified_status==='running');
  let release;
  const gate={promise:new Promise(resolve => {release=resolve;}),started:false,result:{action:'handled'}};
  f.prompts.input=gate;
  const input=f.session.prompt('Handled fixture input');
  await until(() => gate.started);
  f.record.state='done'; f.record.status='idle'; await f.publish(); await f.status();
  assert.equal(f.parentRequests(),0);
  const compacting=await heldCompaction(f);
  release(); await input;
  await delay(150);
  assert.equal(f.parentRequests(),0,'no wake while manual compaction owns the runtime');
  compacting.release(); assert.match((await compacting.outcome).error.message,/Compaction cancelled/);
  // No prompt/status call after the idle boundary. Unchanged observations dedup
  // at Workflow.notice, so they cannot rescue a lost delivery obligation.
  await until(() => f.parentRequests()===1); await f.session.waitForIdle();
  await delay(150);
  assert.equal(f.parentRequests(),1);
  assert.equal(f.manager.getBranch().filter(e => e.customType==='pi-astraeus:claude-lifecycle').length,1);
  assert.equal(f.manager.getBranch().filter(e => e.customType==='pi-astraeus:claude-wake').length,1);
  assert.deepEqual(f.errors,[]);
});

test('background notices during manual compaction wait for idle and retired deferred wakes are cancelled', async t => {
  const f=await notificationFixture(t,'working');
  await until(() => f.manager.getBranch().filter(e => e.type==='custom'&&e.customType===ENTRY).at(-1).data.tasks.fixture.jobs[0].cli.notified_status==='running');
  const compacting=await heldCompaction(f);
  f.record.state='blocked'; f.record.status='idle'; await f.publish();
  await until(() => f.notices.length===1,6500); // The real monitor, no user input/status.
  await delay(150);
  assert.equal(f.parentRequests(),0,'compaction is busy but not streaming; triggerTurn would start competing inference');
  assert.deepEqual(f.notices[0].options,{deliverAs:'followUp',triggerTurn:false});
  compacting.release(); assert.match((await compacting.outcome).error.message,/Compaction cancelled/);
  await until(() => f.parentRequests()===1); await f.session.waitForIdle();
  assert.ok(JSON.stringify(f.prompts.contexts[0]).includes('Needs attention; NOT successful completion.'));
  const retired=await heldCompaction(f);
  f.record.state='done'; await f.publish(); await f.status();
  assert.equal(f.parentRequests(),1);
  await f.session.extensionRunner.emit({type:'session_shutdown',reason:'reload'});
  retired.release(); await retired.outcome; await delay(200);
  assert.equal(f.parentRequests(),1,'retired pending timer cannot wake the old branch/runtime');
  assert.equal(f.manager.getBranch().filter(e => e.customType==='pi-astraeus:claude-wake').length,1);
  assert.deepEqual(f.errors,[]);
});

test('complete reload retains appended pending attention on the same branch until an actual parent run', async t => {
  const f=await notificationFixture(t,'working');
  await until(() => f.manager.getBranch().filter(e => e.type==='custom'&&e.customType===ENTRY).at(-1).data.tasks.fixture.jobs[0].cli.notified_status==='running');
  let release;
  const gate={promise:new Promise(resolve => {release=resolve;}),started:false,result:{action:'handled'}};
  f.prompts.input=gate;
  const input=f.session.prompt('Handled input held across complete reload');
  await until(() => gate.started);
  f.record.state='done'; f.record.status='idle'; await f.publish(); await f.status();
  const notice=f.manager.getBranch().find(e => e.customType==='pi-astraeus:claude-lifecycle');
  assert.ok(notice);
  assert.notEqual(f.manager.getLeafId(),notice.id,'workflow save entries follow the appended notice');
  await f.session.reload();
  await delay(150); assert.equal(f.parentRequests(),0,'retained preparation still reserves the runtime');
  release(); await input;
  // No user prompt, tool/status call, or public lifecycle transition after reload.
  await until(() => f.parentRequests()===1); await f.session.waitForIdle();
  assert.ok(JSON.stringify(f.prompts.contexts[0]).includes('ready to attempt collect, NOT implementation success.'));
  assert.equal(f.manager.getBranch().filter(e => e.customType==='pi-astraeus:claude-lifecycle').length,1);
  assert.equal(f.manager.getBranch().filter(e => e.customType==='pi-astraeus:claude-wake').length,1);
  await delay(350); assert.equal(f.parentRequests(),1,'actual agent_start consumes retained attention once');
  assert.equal(f.prompts.attempts,1); assert.deepEqual(f.errors,[]);
});

test('navigation retaining an earlier unconsumed notice recovers attention even when a later notice is excluded', async t => {
  const f=await notificationFixture(t,'working');
  await until(() => f.manager.getBranch().filter(e => e.type==='custom'&&e.customType===ENTRY).at(-1).data.tasks.fixture.jobs[0].cli.notified_status==='running');
  let release;
  const gate={promise:new Promise(resolve => {release=resolve;}),started:false,result:{action:'handled'}};
  f.prompts.input=gate;
  const input=f.session.prompt('Handled input holding two lifecycle notices');
  await until(() => gate.started);
  f.record.state='done'; f.record.status='idle'; await f.publish(); await f.status();
  const noticeA=f.manager.getBranch().find(e => e.customType==='pi-astraeus:claude-lifecycle');
  const saveB=f.manager.getLeafId();
  assert.notEqual(saveB,noticeA.id);
  f.record.state='blocked'; await f.publish(); await f.status();
  const noticeC=f.manager.getBranch().filter(e => e.customType==='pi-astraeus:claude-lifecycle').at(-1);
  assert.notEqual(noticeA.id,noticeC.id); assert.equal(f.notices.length,2);
  // Restored saveB already marks done as notified: no fresh transition should
  // rescue a lost obligation after selecting the branch that retains noticeA.
  f.record.state='done'; await f.publish();
  assert.equal((await f.session.navigateTree(saveB,{summarize:false})).cancelled,false);
  assert.ok(f.manager.getBranch().some(e => e.id===noticeA.id));
  assert.ok(!f.manager.getBranch().some(e => e.id===noticeC.id));
  release(); await input;
  // No further input/status/public transition to recover the retained notice.
  await until(() => f.parentRequests()===1); await f.session.waitForIdle();
  const selected=JSON.stringify(f.prompts.contexts[0]);
  assert.ok(selected.includes(noticeA.details.diagnostic));
  assert.ok(!selected.includes(noticeC.details.diagnostic),'excluded notice is not sent in the selected context');
  assert.equal(f.notices.filter(n => n.message.customType==='pi-astraeus:claude-lifecycle').length,2,'navigation does not append duplicate lifecycle notices');
  assert.equal(f.manager.getBranch().filter(e => e.customType==='pi-astraeus:claude-lifecycle').length,1);
  assert.equal(f.manager.getBranch().filter(e => e.customType==='pi-astraeus:claude-wake').length,1);
  await delay(350); assert.equal(f.parentRequests(),1,'actual agent_start consumes the obligation once');
  assert.equal(f.prompts.attempts,1); assert.deepEqual(f.errors,[]);
});

test('pending appended notice does not transfer to a navigated branch that excludes it', async t => {
  const f=await notificationFixture(t,'working');
  await until(() => f.manager.getBranch().filter(e => e.type==='custom'&&e.customType===ENTRY).at(-1).data.tasks.fixture.jobs[0].cli.notified_status==='running');
  const target=f.manager.getLeafId();
  let release;
  const gate={promise:new Promise(resolve => {release=resolve;}),started:false,result:{action:'handled'}};
  f.prompts.input=gate;
  const input=f.session.prompt('Handled input on the abandoned branch');
  await until(() => gate.started);
  f.record.state='done'; f.record.status='idle'; await f.publish(); await f.status();
  const notice=f.manager.getBranch().find(e => e.customType==='pi-astraeus:claude-lifecycle');
  // The selected branch's restored running baseline must not generate a new
  // genuine attention transition and obscure an incorrectly transferred wake.
  f.record.state='working'; f.record.status='running'; await f.publish();
  const navigation=await f.session.navigateTree(target,{summarize:false});
  assert.equal(navigation.cancelled,false);
  assert.ok(!f.manager.getBranch().some(e => e.id===notice.id));
  release(); await input; await delay(350);
  assert.equal(f.parentRequests(),0); assert.equal(f.prompts.attempts,0);
  assert.equal(f.manager.getBranch().filter(e => e.customType==='pi-astraeus:claude-wake').length,0);
  assert.equal(f.notices.length,1,'the abandoned notice was appended only once');
  assert.deepEqual(f.errors,[]);
});

test('actual reload shutdown retires the pending preparation wake without an old-owner run', async t => {
  const f=await notificationFixture(t,'working');
  await until(() => f.manager.getBranch().filter(e => e.type==='custom'&&e.customType===ENTRY).at(-1).data.tasks.fixture.jobs[0].cli.notified_status==='running');
  let release;
  const gate={promise:new Promise(resolve => {release=resolve;}),started:false,result:{action:'handled'}};
  f.prompts.input=gate;
  const prompt=f.session.prompt('Input consumed by fixture extension');
  await until(() => gate.started);
  f.record.state='done'; f.record.status='idle'; await f.publish(); await f.status();
  assert.equal(f.notices.length,1); assert.equal(f.prompts.attempts,0);
  await f.session.extensionRunner.emit({type:'session_shutdown',reason:'reload'});
  release(); await prompt; await delay(30);
  assert.equal(f.prompts.attempts,0,'retired delivery does not wake when preflight finally exits');
  assert.equal(f.manager.getBranch().filter(e => e.customType==='pi-astraeus:claude-wake').length,0);
  assert.deepEqual(f.errors,[]);
});

test('actual monitor during an earlier awaited agent_start handler retains autonomous lifecycle attention', async t => {
  const f=await notificationFixture(t,'working',true);
  await until(() => f.manager.getBranch().filter(e => e.type==='custom'&&e.customType===ENTRY).at(-1).data.tasks.fixture.jobs[0].cli.notified_status==='running');
  const user='Original input held at agent startup';
  const outcome=f.session.prompt(user).then(() => ({ok:true}),error => ({error}));
  await until(() => existsSync(f.startup.started));
  assert.equal(f.session.isIdle,false); assert.equal(f.session.isStreaming,true);
  f.record.state='done'; f.record.status='idle'; await f.publish();
  await until(() => f.notices.length===1,6500); // Actual monitor, not a tool/status refresh.
  assert.equal(f.parentRequests(),0,'no inference while the earlier startup handler owns the run');
  await writeFile(f.startup.release,'release'); assert.equal((await outcome).error,undefined); await f.session.waitForIdle();
  // No further prompt/status calls. Attention must enter a model request, not
  // merely be appended as context at turn_end after the request snapshot.
  const diagnostic=f.notices[0].message.details.diagnostic;
  await until(() => f.prompts.contexts.some(messages => JSON.stringify(messages).includes(diagnostic)));
  assert.equal(f.parentRequests(),2,'one original request and one autonomous native followUp');
  assert.equal(f.prompts.attempts,1,'no competing low-level prompt');
  assert.ok(!JSON.stringify(f.prompts.contexts[0]).includes(diagnostic));
  assert.equal(f.manager.getBranch().filter(e => e.customType==='pi-astraeus:claude-lifecycle').length,1);
  assert.equal(f.manager.getBranch().filter(e => e.customType==='pi-astraeus:claude-wake').length,0);
  assert.equal(f.manager.buildSessionContext().messages.filter(m => m.role==='user'&&m.content.some(c => c.text===user)).length,1);
  await delay(150); assert.equal(f.parentRequests(),2,'stable polls cannot duplicate attention');
  assert.deepEqual(f.errors,[]);
});

test('actual streaming lifecycle notice across reload remains a native followUp, not a competing prompt', async t => {
  const f=await notificationFixture(t,'working');
  f.prompts.hold=true;
  const user='Streaming original input';
  const outcome=f.session.prompt(user).then(() => ({ok:true}),error => ({error}));
  await until(() => f.parentRequests()===1);
  await assert.rejects(f.session.prompt('Ordinary concurrent input'),/Specify streamingBehavior/,'ordinary prompt errors are not masked');
  await f.session.reload(); // A new delivery owner must retain the active run, not infer streaming from isIdle.
  f.record.state='blocked'; f.record.status='idle'; await f.publish(); await f.status();
  assert.deepEqual(f.notices[0].options,{deliverAs:'followUp',triggerTurn:true});
  assert.equal(f.parentRequests(),1,'followUp waits for the streaming turn');
  f.prompts.hold=false; f.prompts.finishes.splice(0).forEach(finish => finish());
  assert.equal((await outcome).error,undefined); await f.session.waitForIdle();
  assert.equal(f.parentRequests(),2,'one legitimate queued followUp, no loop');
  assert.equal(f.prompts.attempts,1,'followUp remains inside the same low-level run');
  assert.deepEqual(f.errors,[]);
  assert.equal(f.manager.buildSessionContext().messages.filter(m => m.role==='user'&&m.content.some(c => c.text===user)).length,1);
  assert.equal(f.manager.getBranch().filter(e => e.customType==='pi-astraeus:claude-lifecycle').length,1);
  await f.status(); assert.equal(f.parentRequests(),2);
});

test('actual user arriving after an idle notification wake waits before submission, without retry', async t => {
  const f=await notificationFixture(t,'working');
  await until(() => f.manager.getBranch().filter(e => e.type==='custom'&&e.customType===ENTRY).at(-1).data.tasks.fixture.jobs[0].cli.notified_status==='running');
  f.prompts.hold=true;
  f.record.state='done'; f.record.status='idle'; await f.publish(); await f.status();
  await until(() => f.parentRequests()===1);
  // A slash command remains immediate even while the notification provider is held.
  const command=f.session.prompt('/fixture-immediate');
  await until(() => f.prompts.commands===1); await command;
  const user='User after notification-owned wake';
  const outcome=f.session.prompt(user).then(() => ({ok:true}),error => ({error}));
  await delay(30); assert.equal(f.parentRequests(),1);
  f.prompts.hold=false; f.prompts.finishes.splice(0).forEach(finish => finish());
  assert.equal((await outcome).error,undefined); await f.session.waitForIdle();
  assert.equal(f.parentRequests(),2);
  assert.equal(f.manager.buildSessionContext().messages.filter(m => m.role==='user'&&m.content.some(c => c.text===user)).length,1);
  assert.equal(f.manager.getBranch().filter(e => e.customType==='pi-astraeus:claude-lifecycle').length,1);
});

test('actual extension lifecycle wiring wakes idle parent with followUp + triggerTurn using only fake public CLI/local provider', async t => {
  const f=await notificationFixture(t);
  const {session, manager, notices, record, recordPath, startedPath, status, parentRequests}=f;
  await until(() => parentRequests() === 1); await session.waitForIdle();
  assert.equal(notices[0].message.customType,'pi-astraeus:claude-lifecycle');
  assert.deepEqual(notices[0].options,{deliverAs:'followUp',triggerTurn:true});
  assert.equal(notices[0].message.details.status,'work-ended');
  assert.equal(notices[0].message.details.task_id,'fixture');
  await status(); await session.extensionRunner.emitBeforeAgentStart('fixture',undefined,{});
  assert.equal(notices.length,1,'before_agent_start refresh does not repeat the wakeup');
  for (const state of ['blocked','stopped','mystery']) {
    record.state=state; record.status='idle'; await writeFile(recordPath,JSON.stringify([record]));
    const result=await status(); await until(() => parentRequests() === notices.length); await session.waitForIdle();
    const current=result.details.tasks[0].jobs[0];
    assert.equal(current.status,state==='mystery' ? 'unknown' : state);
    assert.equal(current.valid,false); assert.equal(current.cli.frozen,false);
    assert.match(notices.at(-1).message.details.diagnostic,/NOT successful/);
    assert.deepEqual(notices.at(-1).options,{deliverAs:'followUp',triggerTurn:true});
  }
  assert.equal(parentRequests(),4);
  // Real extension event wiring cancels an in-flight CLI observation, not just
  // a timer. The staged result would be done; saved mystery state must survive.
  const {existsSync}=await import('node:fs');
  for (const reason of ['replacement','tree','reload']) {
    record.state='done'; record.fixtureDelay=true;
    await writeFile(recordPath,JSON.stringify([record])); await rm(startedPath,{force:true});
    const pending=status();
    await until(() => existsSync(startedPath));
    const saved=JSON.stringify(manager.getBranch().filter(e => e.type==='custom'&&e.customType===ENTRY).at(-1).data);
    if(reason==='tree') {
      await session.extensionRunner.emit({type:'session_before_tree',preparation:{entriesToSummarize:[]}});
      await session.extensionRunner.emit({type:'session_tree'});
    } else if(reason==='replacement') await session.extensionRunner.emit({type:'session_start'});
    else await session.extensionRunner.emit({type:'session_shutdown',reason:'reload'});
    const result=await pending; assert.equal(result.isError,true);
    await session.extensionRunner.emit({type:'session_shutdown',reason:'reload'});
    await delay(50);
    assert.equal(notices.length,4);
    assert.equal(JSON.stringify(manager.getBranch().filter(e => e.type==='custom'&&e.customType===ENTRY).at(-1).data),saved);
  }
});

async function navigationBranch(f) {
  await until(() => f.manager.getBranch().filter(e => e.type==='custom'&&e.customType===ENTRY).at(-1).data.tasks.fixture.jobs[0].cli.notified_status==='running');
  const target=f.manager.getLeafId();
  const user=f.manager.appendMessage({role:'user',content:'Fixture abandoned work',timestamp:Date.now()});
  f.manager.appendCustomMessageEntry('fixture-work','Local fixture work to summarize',false);
  f.session.refreshContext();
  return {target, user, oldLeaf:f.manager.getLeafId()};
}

for (const exit of ['cancel','aborted','error']) test(`actual navigateTree ${exit} without session_tree autonomously resumes idle notices`, async t => {
  const f=await notificationFixture(t,'working');
  const {target, oldLeaf}=await navigationBranch(f);
  f.navigation.cancel=exit==='cancel'; f.navigation.summaryMode=exit==='cancel'?null:exit;
  const navigating=f.session.navigateTree(target,{summarize:true});
  // Observe rejection immediately, while holding the deterministic summary open.
  const settled=navigating.then(result => ({result}),error => ({error}));
  if(exit!=='cancel') {
    await until(() => f.navigation.summaryRequests===1);
    f.record.state='done'; f.record.status='idle'; await f.publish();
    await delay(3200); // A real monitor tick occurs while public ctx.isIdle() is false.
    assert.equal(f.notices.length,0,'no notification/inference or branch mutation during summary');
    assert.equal(f.manager.getLeafId(),oldLeaf);
    if(exit==='aborted') f.session.abortBranchSummary(); else f.navigation.finish('error');
  }
  const outcome=await settled;
  if(exit==='error') assert.match(outcome.error.message,/Fixture summary error/);
  else {assert.equal(outcome.result.cancelled,true); if(exit==='aborted') assert.equal(outcome.result.aborted,true);}
  assert.equal(f.navigation.treeEvents,0); assert.equal(f.manager.getLeafId(),oldLeaf);
  f.record.state='done'; f.record.status='idle'; await f.publish();
  // No tool, prompt, or before_agent_start is issued by the test to restart monitoring.
  await until(() => f.parentRequests()===1,6500); await f.session.waitForIdle();
  assert.equal(f.notices.length,1); assert.equal(f.notices[0].message.details.status,'work-ended');
  assert.deepEqual(f.notices[0].options,{deliverAs:'followUp',triggerTurn:true});
  assert.equal(f.navigation.treeEvents,0);
});

test('actual successful navigateTree retires in-flight old query and notifies only the selected branch after summary', async t => {
  const f=await notificationFixture(t,'working');
  const {target,user,oldLeaf}=await navigationBranch(f);
  const {existsSync}=await import('node:fs');
  f.record.state='done'; f.record.status='idle'; f.record.fixtureDelay=true; await f.publish();
  const observation=f.status(); await until(() => existsSync(f.startedPath));
  f.navigation.summaryMode='success';
  const navigating=f.session.navigateTree(target,{summarize:true});
  await until(() => f.navigation.summaryRequests===1);
  assert.equal((await observation).isError,true,'before_tree retires the old observation generation');
  f.record.fixtureDelay=false; await f.publish();
  await delay(3200);
  assert.equal(f.notices.length,0); assert.equal(f.manager.getLeafId(),oldLeaf);
  f.navigation.finish('stop'); const result=await navigating;
  assert.equal(result.cancelled,false); assert.ok(result.summaryEntry);
  assert.equal(f.navigation.treeEvents,1);
  assert.ok(!f.manager.getBranch().some(e => e.id===user),'abandoned branch is no longer active');
  await until(() => f.parentRequests()===1,6500); await f.session.waitForIdle();
  assert.equal(f.notices.length,1); assert.deepEqual(f.notices[0].options,{deliverAs:'followUp',triggerTurn:true});
  assert.ok(f.manager.getBranch().some(e => e.id===result.summaryEntry.id));
  assert.ok(f.manager.getBranch().some(e => e.customType==='pi-astraeus:claude-lifecycle'));
});
