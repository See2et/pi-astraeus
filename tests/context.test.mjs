import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {Workflow, ROOT, ENTRY} from '../extensions/core.mjs';
import {delta} from '../extensions/claude.mjs';
import {prepareBranchEntries, convertToLlm, serializeConversation} from '@earendil-works/pi-coding-agent';

const LIMIT = 24 * 1024;
const marker = 'INTERNAL_BASELINE_NOT_MODEL_CONTEXT';
const bounded = value => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  assert.ok(Buffer.byteLength(text) <= LIMIT, `model-facing output was ${Buffer.byteLength(text)} bytes`);
  assert.ok(!text.includes(marker), 'internal baseline leaked');
  return text;
};
async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'astraeus-context-'));
  t.after(() => rm(base, {recursive:true, force:true}));
  const cwd = join(base, 'repo'), agentDir = join(base, 'agent');
  await mkdir(cwd); await mkdir(agentDir);
  const bin = join(base, 'bin'); await mkdir(bin);
  const uuid = '12345678-1111-2222-3333-444444444444';
  const record = {id:'12345678', sessionId:uuid, cwd, state:'done', status:'idle', pid:null};
  await writeFile(join(bin, 'claude'), `#!${process.execPath}\nif (JSON.stringify(process.argv.slice(2)) !== '["agents","--json","--all"]') process.exit(1);\nconsole.log(${JSON.stringify(JSON.stringify([record]))});\n`, {mode:0o755});
  const previousPath = process.env.PATH; process.env.PATH = `${bin}:${previousPath}`;
  t.after(() => { process.env.PATH = previousPath; });
  execFileSync('git', ['init', '-q'], {cwd});
  process.env.PI_CODING_AGENT_DIR = agentDir; process.env.PI_OFFLINE = '1';
  const {DefaultResourceLoader, SettingsManager, SessionManager, createAgentSession, ModelRuntime, createEventBus} = await import('@earendil-works/pi-coding-agent');
  const runtime = await ModelRuntime.create({authPath:join(agentDir,'auth.json'), modelsPath:join(agentDir,'models.json')});
  const settings = SettingsManager.inMemory({compaction:{enabled:false}, retry:{enabled:false}});
  const loader = new DefaultResourceLoader({cwd, agentDir, eventBus:createEventBus(), settingsManager:settings,
    noExtensions:true, noContextFiles:true, additionalExtensionPaths:[ROOT]});
  await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
  const baseline = {files:Object.fromEntries(Array.from({length:15173}, (_,i) => [`node_modules/${marker}/${i}.js`, `33188:${'a'.repeat(64)}`])), head:null, index:marker.repeat(20000), dirty:[]};
  const job = {run_id:'run-fixture', agent_id:`claude:${uuid}`, role:'designer', transport:'claude-code-bg-v1', status:'stopped',
    valid:false, collected:true, owned_paths:['ui'], requested:{model:'anthropic/claude-opus-5-5', effort:'high'},
    artifact:'/fixture/result.json', receipt_path:'/fixture/receipt.json',
    result:{kind:'implementation', status:'blocked', summary:'Actionable failure: out-of-ownership', remaining:['out-of-ownership']},
    cli:{baseline, directory:'/fixture/run', frozen:true, short_id:'12345678', session_id:uuid, observed:{session_id:uuid, model:null, effort:null}, evidence:[]}};
  const task = {task_id:'legacy', cwd, phase:'needs-evidence', accepted:false, requirements:'Recover bounded state', acceptance:'No baseline leakage', jobs:[job]};
  const manager = SessionManager.inMemory(cwd);
  manager.appendCustomEntry(ENTRY, {version:1, tasks:{legacy:task}});
  const {session} = await createAgentSession({cwd, agentDir, modelRuntime:runtime, model:runtime.getModel('openai','gpt-6.1-sol'), settingsManager:settings, sessionManager:manager, resourceLoader:loader});
  await session.bindExtensions({});
  t.after(async () => { await session.extensionRunner.emit({type:'session_shutdown'}); session.dispose(); });
  const tool = session.agent.state.tools.find(t => t.name === 'astraeus_workflow'); assert.ok(tool);
  return {session, manager, baseline, job, task, cwd, tool};
}

test('registered tool and startup guidance bound 15k-file restored state with observational baseline', async t => {
  const f = await fixture(t);
  const result = await f.tool.execute('status-call', {op:'status'}, new AbortController().signal);
  bounded(result); bounded(result.content); const details = bounded(result.details);
  assert.match(details, /run-fixture/); assert.match(details, /out-of-ownership/); assert.match(details, /result.json/);
  assert.deepEqual(result.details.tasks[0].jobs[0].requested, {model:'anthropic/claude-opus-5-5', effort:'high'});
  assert.equal(result.details.tasks[0].jobs[0].cli.observed.state, 'done');
  assert.equal(result.details.tasks[0].jobs[0].cli.frozen, true);
  const startup = await f.session.extensionRunner.emitBeforeAgentStart('hello', undefined, {});
  bounded(startup.messages);
  const internal = new Workflow({manager:() => undefined});
  internal.restore({cwd:f.cwd, hasUI:false, sessionManager:f.manager});
  const restored = internal.tasks.legacy.jobs[0].cli.baseline;
  assert.equal(Object.keys(restored.files).length, 15173); assert.equal(restored.index, f.baseline.index);
  const after = structuredClone(restored); after.files[Object.keys(after.files)[15172]] = 'changed';
  assert.deepEqual(delta(restored, after), [Object.keys(after.files)[15172]]);
  const collected = await f.tool.execute('collect-call', {op:'collect', task_id:'legacy', run_id:'run-fixture'}, new AbortController().signal);
  bounded(collected); assert.equal(collected.details.valid, false); assert.equal(collected.details.run_id, 'run-fixture');
  bounded(await f.tool.execute('invalidate-call', {op:'invalidate', task_id:'legacy'}, new AbortController().signal));
  const failed = await f.tool.execute('bad-call', {op:'delegate', task_id:'legacy', role:'worker', model:`openai/${'missing'.repeat(10000)}`, thinking:'high', prompt:'No inference'}, new AbortController().signal);
  bounded(failed); assert.equal(failed.isError, true);
  assert.match(failed.details.error, /Unavailable authorized model/);
  assert.ok(failed.details.projection.omitted.string_characters > 0);
  let notification;
  const ctx = {...f.session.extensionRunner.createContext(), hasUI:true, ui:{notify:message => { notification = message; }, setStatus(){}}};
  await f.session.extensionRunner.getCommand('astraeus').handler('legacy', ctx);
  bounded(notification); assert.match(notification, /run-fixture/);
});

test('registered context hook sanitizes legacy retained results/guidance without modifying history or signed assistant identity', async t => {
  const f = await fixture(t);
  const assistant = {role:'assistant', content:[{type:'thinking', thinking:'opaque', thinkingSignature:'signed'}, {type:'toolCall', id:'signed-call', name:'astraeus_workflow', arguments:{op:'status'}, thoughtSignature:'opaque-signature'}], timestamp:1};
  f.manager.appendMessage(assistant);
  const kept = f.manager.appendMessage({role:'toolResult', toolCallId:'signed-call', toolName:'astraeus_workflow', isError:false, timestamp:2,
    content:[{type:'text', text:JSON.stringify([f.task])}], details:[f.task]});
  f.manager.appendCustomMessageEntry('pi-astraeus:guidance', `Legacy state: ${JSON.stringify([f.task])}`, false, {baseline:f.baseline});
  // Real Pi context rebuilding retains the giant latest result after compaction.
  f.manager.appendCompaction('Deterministic fixture summary', kept, 999999);
  f.session.refreshContext();
  const raw = f.session.messages;
  const before = JSON.stringify(f.manager.getEntries());
  const transformed = await f.session.extensionRunner.emitContext(raw);
  const result = transformed.find(m => m.role === 'toolResult');
  bounded(result.content); bounded(result.details);
  assert.equal(result.toolCallId, 'signed-call'); assert.equal(result.isError, false); assert.equal(result.timestamp, 2);
  const guidance = transformed.find(m => m.role === 'custom'); bounded(guidance.content); bounded(guidance.details ?? null);
  assert.equal(JSON.stringify(f.manager.getEntries()), before, 'raw session history must remain unchanged');
  const unrelated = {role:'toolResult', toolName:'read', toolCallId:'read-id', content:[{type:'text',text:marker}], details:{baseline:f.baseline}, timestamp:3, isError:false};
  const malformed = {role:'toolResult', toolName:'astraeus_workflow', toolCallId:'bad-id', content:[{type:'text',text:'not-json'.repeat(300000)}], timestamp:4, isError:true};
  const textOnly = {role:'toolResult', toolName:'astraeus_workflow', toolCallId:'text-only', content:[{type:'text',text:JSON.stringify(f.job)}], timestamp:5, isError:false};
  const recovery = await f.session.extensionRunner.emitContext([assistant, unrelated, malformed, textOnly]);
  assert.deepEqual(recovery[0], assistant); assert.deepEqual(recovery[1], unrelated);
  assert.equal(recovery[2].isError, true); assert.match(bounded(recovery[2].content), /recover|legacy|diagnostic/i);
  assert.match(bounded(recovery[3].details), /run-fixture/); bounded(recovery[3].content);
  const preparation = {messagesToSummarize:raw, turnPrefixMessages:[...raw]};
  await f.session.extensionRunner.emit({type:'session_before_compact', preparation});
  for (const messages of [preparation.messagesToSummarize, preparation.turnPrefixMessages]) {
    bounded(messages.find(m => m.role === 'toolResult').content);
    bounded(messages.find(m => m.role === 'custom').content);
  }
  assert.equal(JSON.stringify(f.manager.getEntries()), before);
  // AgentSession retains this array separately from preparation, then passes it
  // to generateBranchSummary. Exercise that consumer, not a replaced property.
  const originalEntries = f.manager.getBranch();
  const branchPreparation = {entriesToSummarize:originalEntries};
  await f.session.extensionRunner.emit({type:'session_before_tree', preparation:branchPreparation});
  const branchMessages = prepareBranchEntries(originalEntries, 10_000_000).messages;
  assert.ok(branchMessages.some(m => m.role === 'custom' && m.customType === 'pi-astraeus:guidance'), 'large budget must include guidance, not silently skip it');
  const conversation = bounded(serializeConversation(convertToLlm(branchMessages)));
  assert.match(conversation, /run-fixture/);
  assert.strictEqual(branchPreparation.entriesToSummarize, originalEntries);
  bounded(originalEntries.find(e => e.type === 'message' && e.message.role === 'toolResult').message.content);
  bounded(originalEntries.find(e => e.type === 'message' && e.message.role === 'toolResult').message.details);
  bounded(branchMessages.find(m => m.role === 'custom').content);
  assert.equal(JSON.stringify(f.manager.getEntries()), before, 'branch preparation must not mutate persisted entries/raw history');
  const duplicates = await f.session.extensionRunner.emitContext([...raw, ...raw.filter(m => m.role === 'custom')]);
  assert.equal(duplicates.filter(m => m.role === 'custom').length, 1);
});

test('registered output has total bounds and explicit omissions with many tasks/jobs and long findings', async t => {
  const f = await fixture(t);
  const longResult = {kind:'review', status:'complete', verdict:'changes_required', summary:'Long findings', bugs:Array.from({length:80}, () => ({location:'ui/file', claim:'Fix this'.repeat(10000), evidence:'evidence'.repeat(10000)})), unresolved:[]};
  const tasks = Object.fromEntries(Array.from({length:90}, (_,i) => [`task-${i}`, {...f.task, task_id:`task-${i}`, requirements:'long'.repeat(10000),
    jobs:Array.from({length:50}, (_,j) => ({...f.job, transport:'pi-native', valid:true, collected:true, run_id:`run-${i}-${j}`, summary:'\\\"\n'.repeat(30000), result:longResult}))} ]));
  f.manager.appendCustomEntry(ENTRY, {version:1, tasks});
  await f.session.extensionRunner.emit({type:'session_tree', newLeafId:f.manager.getLeafId()});
  const result = await f.tool.execute('many-status', {op:'status'}, new AbortController().signal);
  bounded(result); bounded(result.content); assert.match(bounded(result.details), /omitted/);
  assert.equal(result.details.tasks[0].task_id, 'task-89');
  assert.equal(result.details.tasks[0].jobs[0].run_id, 'run-89-49');
  assert.equal(result.details.projection.totals.jobs, 4500);
  assert.equal(result.details.projection.totals.attention_jobs, 4500);
  assert.ok(result.details.projection.omitted.items > 0);
  assert.ok(result.details.projection.omitted.string_characters > 0);
  const again = await f.session.extensionRunner.emitContext([{role:'toolResult', toolName:'astraeus_workflow', toolCallId:'many-status', ...result}]);
  bounded(again[0]); assert.equal(again[0].details.tasks[0].jobs[0].run_id, 'run-89-49');
  assert.equal(again[0].details.projection.totals.jobs, 4500);
  const startup = await f.session.extensionRunner.emitBeforeAgentStart('hello', undefined, {}); bounded(startup.messages);
});
