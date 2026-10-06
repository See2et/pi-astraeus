import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, cp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {rpc} from '../extensions/core.mjs';

test('Pi 1.0.4 loads both factories and runs real fresh/reused children with only a local stub',async t=>{
  const base=await mkdtemp(join(tmpdir(),'pi-astraeus-native-'));
  t.after(()=>rm(base,{recursive:true,force:true}));
  const cwd=join(base,'repo'), agentDir=join(base,'agent');
  await mkdir(cwd); await mkdir(agentDir); await cp(resolve('agents'),join(agentDir,'agents'),{recursive:true});
  execFileSync('git',['init','-q'],{cwd});
  process.env.PI_CODING_AGENT_DIR=agentDir; process.env.PI_OFFLINE='1';
  const {DefaultResourceLoader,SettingsManager,SessionManager,createAgentSession,ModelRuntime,createEventBus}=await import('@earendil-works/pi-coding-agent');
  const runtime=await ModelRuntime.create({authPath:join(agentDir,'auth.json'),modelsPath:join(agentDir,'models.json')});
  const settings=SettingsManager.inMemory({compaction:{enabled:false},retry:{enabled:false}});
  const upstream=process.env.PI_ASTRAEUS_SUBAGENTS || resolve('node_modules/@tintinweb/pi-subagents');
  await writeFile(join(cwd,'astraeus.toml'),'allowed_models = ["local-test/stub"]\n');
  const {createAssistantMessageEventStream,getCurrentTools}=await import('@earendil-works/pi-ai');
  let requests=0;
  const target=execFileSync(process.env.PI_ASTRAEUS_PYTHON || 'python3',[resolve('scripts/astraeus.py'),'target','--repo',cwd],{encoding:'utf8'}).trim();
  const fake=pi=> {
    for (const [provider, id] of [['local-test','stub'], ['anthropic','claude-opus-5-5']]) pi.registerProvider(provider,{
    api:'local-test-api',apiKey:'local-fixture-only',baseUrl:'http://invalid.local',
    models:[{id,name:'Local stub',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:32000,maxTokens:4000}],
    streamSimple:(model,context)=>{
      requests++;
      const tools=getCurrentTools(context.messages).map(t=>t.name).sort();
      assert.deepEqual(tools,tools.includes('bash') ? ['bash','edit','find','grep','ls','read','write'] : ['find','grep','ls','read']);
      const result={schema_version:1,kind:'review',task_id:'native',target_id:target,status:'complete',summary:'Local fixture report',verdict:'pass',violations:[],bugs:[],suggestions:[],checked_scope:['fixture'],evidence:['Deterministic local provider exercised real child session'],unresolved:[]};
      const stream=createAssistantMessageEventStream();
      const message={role:'assistant',provider:model.provider,api:model.api,model:model.id,content:[{type:'text',text:JSON.stringify(result)}],stopReason:'stop',timestamp:Date.now(),usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
      queueMicrotask(()=>{stream.push({type:'done',reason:'stop',message});stream.end(message);});
      return stream;
    }
  });
  };
  const events=createEventBus();
  const loader=new DefaultResourceLoader({eventBus:events,cwd,agentDir,settingsManager:settings,noExtensions:true,noContextFiles:true,extensionFactories:[fake],additionalExtensionPaths:[upstream,resolve('.')],disabledBuiltinExtensions:['mcp']});
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors,[]);
  assert.deepEqual(loader.getSkills().skills.map(s=>s.name).filter(n=>n.startsWith('pi-astraeus-')).sort(),['pi-astraeus-adjudicate','pi-astraeus-orchestrate','pi-astraeus-review']);
  const model=runtime.getModel('openai','gpt-6.1-sol'); assert.ok(model);
  const sessionManager=SessionManager.inMemory(cwd);
  const {session}=await createAgentSession({cwd,agentDir,modelRuntime:runtime,model,settingsManager:settings,sessionManager,resourceLoader:loader});
  try {
    await session.bindExtensions({});
    assert.ok(session.getActiveToolNames().includes('astraeus_workflow'));
    assert.ok(session.getActiveToolNames().includes('Agent'));
    const extension=session.extensionRunner;
    assert.ok(extension.getCommand('astraeus')); assert.ok(extension.getCommand('agents'));
    assert.equal((await rpc(events,'ping',{})).version,2);
    const tool=session.agent.state.tools.find(t=>t.name==='astraeus_workflow'); assert.ok(tool);
    const invoke=async params=>{
      const callId=`native-call-${sessionManager.getEntries().length}`;
      sessionManager.appendMessage({role:'assistant',provider:'local-test',api:'local-test-api',model:'stub',content:[{type:'toolCall',id:callId,name:'astraeus_workflow',arguments:params}],stopReason:'toolUse',timestamp:Date.now(),usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}});
      session.refreshContext();
      const reply=await tool.execute(callId,params,new AbortController().signal);
      return JSON.parse(reply.content.find(c=>c.type==='text').text);
    };
    await invoke({op:'start',task_id:'native',requirements:'Exercise actual Pi child runtime',acceptance:'Fresh readonly child and target-bound report'});
    const job=await invoke({op:'delegate',task_id:'native',role:'reviewer',model:'local-test/stub',thinking:'off',prompt:'Return fixture review'});
    const record=globalThis[Symbol.for('pi-subagents:manager')].getRecord(job.agent_id);
    if(record.promise) await record.promise;
    const collected=await invoke({op:'collect',task_id:'native',run_id:job.run_id});
    assert.equal(collected.valid,true,collected.error);
    assert.equal(requests,1);
    assert.equal((await invoke({op:'accept',task_id:'native'})).accepted,true);
    await invoke({op:'start',task_id:'native-worker',requirements:'Exercise owner resumption',acceptance:'Same child session resumes'});
    const worker=await invoke({op:'delegate',task_id:'native-worker',role:'worker',model:'local-test/stub',thinking:'off',prompt:'Return deterministic fixture'});
    const owner=globalThis[Symbol.for('pi-subagents:manager')].getRecord(worker.agent_id);
    await owner.promise;
    assert.equal((await invoke({op:'collect',task_id:'native-worker',run_id:worker.run_id})).valid,true);
    const follow=await invoke({op:'resume',task_id:'native-worker',run_id:worker.run_id,prompt:'Continue the bounded fixture task'});
    assert.equal(follow.agent_id,worker.agent_id);
    await owner.promise;
    const followResult=await invoke({op:'collect',task_id:'native-worker',run_id:follow.run_id});
    assert.equal(followResult.valid,true,followResult.error);
    assert.equal(requests,3);
    await invoke({op:'start',task_id:'native-designer',requirements:'Exercise Pi-native designer',acceptance:'Same Anthropic session resumes',design_request:'Use Claude for this design',design_scope:'design-direction'});
    const designer=await invoke({op:'delegate',task_id:'native-designer',role:'designer',model:'anthropic/claude-opus-5-5',thinking:'off',design_scope:'design-direction',prompt:'Return deterministic design fixture'});
    const designOwner=globalThis[Symbol.for('pi-subagents:manager')].getRecord(designer.agent_id);
    await designOwner.promise;
    assert.equal(designOwner.session.model.provider,'anthropic');
    assert.equal(designOwner.session.model.id,'claude-opus-5-5');
    assert.equal((await invoke({op:'collect',task_id:'native-designer',run_id:designer.run_id})).valid,true);
    const designFollow=await invoke({op:'resume',task_id:'native-designer',run_id:designer.run_id,prompt:'Preserve design and return bounded follow-up'});
    assert.equal(designFollow.agent_id,designer.agent_id);
    await designOwner.promise;
    assert.equal((await invoke({op:'collect',task_id:'native-designer',run_id:designFollow.run_id})).valid,true);
    assert.equal(requests,5);
  } finally { await session.extensionRunner.emit({type:'session_shutdown'}); session.dispose(); }
});
