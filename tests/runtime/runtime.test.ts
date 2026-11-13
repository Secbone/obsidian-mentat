import { DiagnosticsExporter } from '../../src/diagnostics/diagnostics-exporter';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('obsidian');
import { TFile } from 'obsidian';
import { z } from 'zod';
import { BaseAgent } from '../../src/agents/base-agent';
import { SkillRegistry } from '../../src/skills/core/skill-registry';
import { SkillExecutor } from '../../src/skills/core/skill-executor';
import { SkillInvocationContext } from '../../src/skills/strategies/skill-invocation-strategy';
import { ChatManager } from '../../src/chat/chat-manager';
import { EventBus } from '../../src/extensions/event-bus';
import { RunController } from '../../src/runtime/run-controller';
import { RunStore } from '../../src/runtime/run-store';
import { RunBlocked } from '../../src/runtime/types';
import { ModelGateway, ModelResponseError, recentMessageUnit, validateToolPairs } from '../../src/runtime/model-gateway';
import { projectRunIncidents, renderRunFacts } from '../../src/diagnostics/run-diagnostics';
import { execute as ask, schema as askSchema } from '../../skills/ask-user/scripts';
import { execute as read, schema as readSchema } from '../../skills/read-note/scripts';
import { execute as write, schema as writeSchema } from '../../skills/write-note/scripts';
import { validateArtifact, writeVerifiedArtifact } from '../../src/skills/verified-artifact';
import { MemoryPlatformAdapter } from '../utils/memory-platform-adapter';
import { adaptTestSkillContext } from '../utils/skill-context';
import { IndexedObservationQuery } from '../../src/observability/observation-query';
import { LegacyObservationReader } from '../../src/observability/legacy-reader';
import { createRunAccess } from '../../src/runtime/run-access';

function environment(platform = new MemoryPlatformAdapter()) {
  const file = (path: string) => {
    if (!platform.getFileByPath(path)) return null;
    return Object.assign(new TFile(), platform.getFileByPath(path), { basename: path.split('/').pop()!.split('.')[0] });
  };
  const vault = { getAbstractFileByPath: file, read: async (f: any) => platform.read(f.path),
    create: async (path: string, text: string) => { await platform.write(path, text); return file(path)!; },
    modify: async (f: any, text: string) => { await platform.write(f.path,text); }, createFolder: async (path: string) => platform.mkdir(path) };
  const plugin = { platform, settings: {}, loadData: async () => ({}), saveData: async () => {}, app: { vault } } as any;
  return { platform, vault, plugin, context: adaptTestSkillContext({ vault, plugin }) };
}
function setup(env = environment(), providerOverride: Record<string, unknown> = {}) {
  const bus = new EventBus(), registry = new SkillRegistry(), manager = new ChatManager(env.plugin);
  const executor = new SkillExecutor(registry, env.context, bus);
  const provider = { id: 'fake', name: 'fake', type: 'openai', supportsSkills: () => true, getContextWindow: () => 32000, getCompactionThreshold: () => .8, getMaxOutputTokens: () => 2048,
    generateStreamWithSkills: vi.fn(async () => ({ content: 'done', finishReason: 'stop' })), ...providerOverride } as any;
  const agent = new BaseAgent({ id: 'default-chat-agent', name: 'Chat', description: '', enableSkills: true }, provider,
    { skillRegistry: registry, skillExecutor: executor, skillInvocationContext: new SkillInvocationContext('native'), eventBus: bus });
  const store = new RunStore(env.platform);
  const runtime = new RunController(store, bus, manager, async (prompt, context) => { await agent.execute(prompt, context); });
  registry.register({ name: 'ask_user', namespace: 'obsidian', description: '', schema: askSchema, metadata: { executionCategory: 'interaction' },
    execute: (input, options) => ask(input as any, { ...env.context, ...options }) });
  return { ...env, bus, registry, executor, provider, agent, runtime, store, manager };
}
async function start(s: ReturnType<typeof setup>) {
  await s.runtime.initialize();
  const id = await s.runtime.start('do work', { sessionId: s.manager.getSessionInfo().sessionId, messages: [], maxTurns: 20, enableSkills: true, providerId: 'fake' });
  await s.runtime.wait(id);
  return id;
}
const call = (id: string, name: string, args: Record<string, unknown> = {}) => ({ id, name, arguments: JSON.stringify(args) });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('Durable run execution', () => {
  it('keeps a question pending beyond 30 seconds and restores it without repeating a completed read', async () => {
    const s = setup(); let reads = 0;
    s.registry.register({ name:'read', namespace:'obsidian', description:'', schema:z.object({}), metadata:{executionCategory:'read'}, execute: async()=>({success:true,data:++reads}) });
    s.provider.generateStreamWithSkills.mockResolvedValueOnce({ content: '', toolCalls: [call('r','obsidian:read'), call('q','obsidian:ask_user',{question:'Choose',options:['A','B']})],finishReason:'tool_calls' });
    const id = await start(s);
    expect(s.runtime.get(id)?.status).toBe('waiting_for_user');
    vi.useFakeTimers(); await vi.advanceTimersByTimeAsync(600000);
    expect(s.runtime.get(id)?.interactions['q:question'].outcome).toBeUndefined(); vi.useRealTimers();
    const restored = setup(s);
    await restored.runtime.initialize();
    expect(restored.runtime.get(id)?.status).toBe('waiting_for_user');
    await restored.runtime.respond(id,'q:question',{kind:'answered',answer:'A'});
    expect(restored.runtime.get(id)?.status).toBe('completed');
    expect(reads).toBe(1);
    const history = await restored.manager.getHistory();
    expect(history.filter(m=>m.role==='user')).toHaveLength(1);
    expect(history.filter(m=>m.tool_call_id==='r')).toHaveLength(1);
    expect(history.find(m=>m.tool_call_id==='q')?.content).toContain('A');
    expect(restored.provider.generateStreamWithSkills).toHaveBeenCalledOnce();
    await expect(restored.runtime.respond(id,'q:question',{kind:'answered',answer:'B'})).rejects.toThrow();
  });

  it('makes approval persistent, invalidates it when a file changes and never writes on rejection', async () => {
    const s = setup(); s.platform.addFile('target.md','before'); const mutate = vi.fn(async()=>({success:true,data:'written'}));
    s.registry.register({name:'edit',namespace:'obsidian',description:'',schema:z.object({path:z.string()}),metadata:{executionCategory:'write',requiresConfirmation:true},execute:mutate});
    s.provider.generateStreamWithSkills.mockResolvedValueOnce({content:'',toolCalls:[call('w','obsidian:edit',{path:'target.md'})],finishReason:'tool_calls'});
    const id=await start(s);
    expect(s.runtime.get(id)?.status).toBe('waiting_for_approval');
    vi.useFakeTimers();await vi.advanceTimersByTimeAsync(600000);vi.useRealTimers();
    expect(s.runtime.get(id)?.status).toBe('waiting_for_approval');
    await s.platform.write('target.md','changed by user');
    await s.runtime.respond(id,'w:approval',{kind:'approved'});
    expect(mutate).not.toHaveBeenCalled();
    expect(s.runtime.get(id)?.status).toBe('waiting_for_approval');
    expect(s.runtime.get(id)?.events.some(e=>e.type==='interaction:invalidated')).toBe(true);
    await s.runtime.respond(id,'w:approval',{kind:'rejected'});
    expect(s.runtime.get(id)?.status).toBe('cancelled');
    expect(mutate).not.toHaveBeenCalled();
    expect(s.runtime.get(id)?.interactions['w:approval'].outcome?.kind).toBe('rejected');
  });

  it('restores a completed operation result even if its transcript checkpoint was lost', async () => {
    const s=setup();const effect=vi.fn(async()=>({success:true,data:'saved'}));
    s.registry.register({name:'write',namespace:'obsidian',description:'',schema:z.object({}),metadata:{executionCategory:'write'},execute:effect});
    s.provider.generateStreamWithSkills.mockResolvedValueOnce({content:'',toolCalls:[call('w','obsidian:write'),call('q','obsidian:ask_user',{question:'Continue?'})],finishReason:'tool_calls'});
    const id=await start(s);const record=await s.store.load(id);
    // Crash after the operation ledger was saved but before the transcript write.
    record.messages=record.messages.filter(m=>m.tool_call_id!=='w');await s.store.save(record);
    const restored=setup(s);restored.registry.register({name:'write',namespace:'obsidian',description:'',schema:z.object({}),metadata:{executionCategory:'write'},execute:effect});
    await restored.runtime.initialize();await restored.runtime.respond(id,'q:question',{kind:'answered',answer:'yes'});
    expect(effect).toHaveBeenCalledOnce();
    expect((await restored.manager.getHistory()).filter(m=>m.tool_call_id==='w')).toHaveLength(1);
  });

  it('marks an in-flight write unknown on restart and requires reconciliation before resuming', async () => {
    const s=setup();s.provider.generateStreamWithSkills.mockResolvedValueOnce({content:'',toolCalls:[call('q','obsidian:ask_user',{question:'Continue?'})],finishReason:'tool_calls'});
    const id=await start(s), record=await s.store.load(id);
    record.status='running'; record.operations.unconfirmed={id:'unconfirmed',name:'external-write',category:'external',status:'running'}; await s.store.save(record);
    const restored=setup(s);await restored.runtime.initialize();
    expect(restored.runtime.get(id)?.status).toBe('interrupted');
    expect(restored.runtime.get(id)?.operations.unconfirmed.status).toBe('unknown');
    await expect(restored.runtime.resume(id)).rejects.toThrow('未知');
    await restored.runtime.reconcile(id,'unconfirmed',{success:true,data:'user verified'});
    await restored.runtime.respond(id,'q:question',{kind:'answered',answer:'yes'});
    expect(restored.provider.generateStreamWithSkills).toHaveBeenCalledOnce();
    expect(restored.runtime.get(id)?.status).toBe('completed');
  });

  it('preserves a pending interaction on dispose and can recover it in another controller', async()=>{
    const s=setup();s.provider.generateStreamWithSkills.mockResolvedValueOnce({content:'',toolCalls:[call('q','obsidian:ask_user',{question:'Question'})],finishReason:'tool_calls'});
    const id=await start(s);await s.runtime.dispose();
    const restored=setup(s);await restored.runtime.initialize();
    await restored.runtime.respond(id,'q:question',{kind:'answered',answer:'answer'});
    expect(restored.runtime.get(id)?.status).toBe('completed');
  });

  it('keeps diagnostics usable when an unrecoverable run blocks automatic execution',async()=>{
    const s=setup();await s.platform.mkdir(s.store.folder);await s.platform.write(`${s.store.folder}/run-broken.json`,'broken');
    await s.runtime.initialize();expect(s.store.warnings).toHaveLength(1);
    await expect(s.runtime.start('work',{sessionId:s.manager.getSessionInfo().sessionId,messages:[],maxTurns:20,enableSkills:true})).rejects.toThrow('记录损坏');
    expect(s.provider.generateStreamWithSkills).not.toHaveBeenCalled();
  });

  it('includes new run failures in the global diagnostic command without a legacy log file',async()=>{
    const s=setup();s.provider.generateStreamWithSkills.mockRejectedValueOnce(new Error('new runtime failure'));const id=await start(s);
    s.plugin.runController=s.runtime;s.plugin.settings.aiProviders=[];
    s.plugin.runAccess=createRunAccess(s.runtime);
    s.plugin.observationQuery=new IndexedObservationQuery(s.plugin.runAccess,{
      store:{folder:'logs',health:{writeError:'',readError:'',dropped:0,malformed:0}},snapshot:()=>[],query:async()=>[],subscribe:()=>()=>{},sanitize:(event:any)=>event,
    } as any,new LegacyObservationReader(s.platform));
    s.plugin.app.workspace={getLeaf:()=>({openFile:async()=>{}})};
    (s.vault as any).adapter={exists:(path:string)=>s.platform.exists(path),read:(path:string)=>s.platform.read(path),write:(path:string,text:string)=>s.platform.write(path,text)} as any;
    await DiagnosticsExporter.generateAndOpenDiagnosticsLog(s.plugin);
    const report=await s.platform.read('Mentat Debug Log.md');
    expect(report).toContain(id);expect(report).toContain('new runtime failure');
    expect(report).toContain('不作为独立故障次数');
    s.plugin.observationQuery.dispose();
  });

  it('fails closed before model execution when persisting the first run fails', async()=>{
    const s=setup();await s.runtime.initialize();
    vi.spyOn(s.platform,'write').mockRejectedValueOnce(new Error('disk full'));
    await expect(s.runtime.start('work',{sessionId:s.manager.getSessionInfo().sessionId,messages:[],maxTurns:20,enableSkills:true})).rejects.toThrow('disk full');
    expect(s.provider.generateStreamWithSkills).not.toHaveBeenCalled();
    expect(s.runtime.list()[0].status).toBe('interrupted');
  });

  it('allows only one concurrent start per session', async () => {
    const s = setup(); await s.runtime.initialize();
    const options = {sessionId:s.manager.getSessionInfo().sessionId,messages:[],maxTurns:20,enableSkills:true};
    const first = s.runtime.start('first',options);
    await expect(s.runtime.start('second',options)).rejects.toThrow('未结束');
    const id = await first; await s.runtime.wait(id);
    expect(s.runtime.list()).toHaveLength(1);
  });

  it('does not replay a timed-out write when its actual completion arrives later', async () => {
    const s=setup(); let complete!: (result: any)=>void;
    const gate=new Promise<any>(resolve=>{complete=resolve;});
    const effect=vi.fn(()=>gate);
    s.registry.register({name:'run_command',namespace:'obsidian',description:'',schema:z.object({timeout:z.number()}),metadata:{executionCategory:'external'},execute:effect});
    s.provider.generateStreamWithSkills.mockResolvedValueOnce({content:'',toolCalls:[call('w','obsidian:run_command',{timeout:10})],finishReason:'tool_calls'});
    await s.runtime.initialize();
    const id=await s.runtime.start('work',{sessionId:s.manager.getSessionInfo().sessionId,messages:[],maxTurns:20,enableSkills:true});
    await vi.waitFor(()=>expect(effect).toHaveBeenCalledOnce());
    await s.runtime.wait(id);
    expect(s.runtime.get(id)?.status).toBe('interrupted');
    expect(s.runtime.get(id)?.operations.w.status).toBe('unknown');
    complete({success:true,data:'actual write completed'});
    await vi.waitFor(()=>expect(s.runtime.get(id)?.operations.w.status).toBe('finished'));
    await s.runtime.resume(id);
    expect(effect).toHaveBeenCalledOnce();expect(s.runtime.get(id)?.status).toBe('completed');
    expect((await s.manager.getHistory()).find(m=>m.tool_call_id==='w')?.content).toContain('actual write completed');
  });

  it('recovers a damaged snapshot conservatively and preserves the damaged original', async()=>{
    const s=setup();s.provider.generateStreamWithSkills.mockResolvedValueOnce({content:'',toolCalls:[call('q','obsidian:ask_user',{question:'Question'})],finishReason:'tool_calls'});
    const id=await start(s);const path=`${s.store.folder}/${id}.json`;
    await s.platform.write(path,'damaged');
    const restored=setup(s);await restored.runtime.initialize();
    expect(restored.runtime.get(id)?.status).toBe('interrupted');
    expect([...s.platform.files.keys()].some(p=>p.startsWith(path+'.corrupt-'))).toBe(true);
    expect(JSON.parse(await s.platform.read(path)).id).toBe(id);
  });

  it('resumes a nested agent question with isolated operation IDs and no repeated write', async()=>{
    const s=setup();let writes=0;
    s.registry.register({name:'write',namespace:'obsidian',description:'',schema:z.object({}),metadata:{executionCategory:'write'},execute:async()=>({success:true,data:++writes})});
    const childProvider={...s.provider,generateStreamWithSkills:vi.fn(async()=>({content:'child done',finishReason:'stop'}))} as any;
    childProvider.generateStreamWithSkills.mockResolvedValueOnce({content:'',toolCalls:[call('w','obsidian:write'),call('q','obsidian:ask_user',{question:'Child question'})],finishReason:'tool_calls'});
    const child=new BaseAgent({id:'child',name:'Child',description:'',enableSkills:true},childProvider,{skillRegistry:s.registry,skillExecutor:s.executor,skillInvocationContext:new SkillInvocationContext('native'),eventBus:s.bus});
    s.registry.register({name:'delegate_task',namespace:'obsidian',description:'',schema:z.object({}),metadata:{executionCategory:'orchestration'},execute:async(_input,options)=>{
      const state=options!.runtime!.child(options!.operationId!);
      const response=await child.execute('child work',{messages:state.messages,sessionId:options!.runtime!.sessionId,runId:options!.runtime!.runId,runtime:state.runtime,onCheckpoint:state.checkpoint,metadata:{resume:!!state.messages.length}});
      return {success:true,data:response.content,metadata:{subagentMessages:response.messages,agentId:'child'}};
    }});
    s.provider.generateStreamWithSkills.mockResolvedValueOnce({content:'',toolCalls:[call('parent','obsidian:delegate_task')],finishReason:'tool_calls'});
    const id=await start(s);
    expect(s.runtime.get(id)?.status).toBe('waiting_for_user');expect(writes).toBe(1);
    expect(s.runtime.get(id)?.interactions['parent/q:question']).toBeDefined();
    await s.runtime.respond(id,'parent/q:question',{kind:'answered',answer:'yes'});
    expect(s.runtime.get(id)?.status).toBe('completed');expect(writes).toBe(1);
    expect(s.runtime.get(id)?.operations['parent/w'].result?.success).toBe(true);
    expect(s.provider.generateStreamWithSkills.mock.calls.at(-1)[0].some((m:any)=>m.metadata?.isSubagent)).toBe(false);
  });

  it('classifies an expired approval separately and does not invoke the tool',async()=>{
    const s=setup(), effect=vi.fn();
    s.registry.register({name:'write',namespace:'obsidian',description:'',schema:z.object({}),metadata:{executionCategory:'write',requiresConfirmation:true},execute:effect});
    s.provider.generateStreamWithSkills.mockResolvedValueOnce({content:'',toolCalls:[call('w','obsidian:write')],finishReason:'tool_calls'});
    const id=await start(s);await s.runtime.respond(id,'w:approval',{kind:'expired'});
    expect(effect).not.toHaveBeenCalled();expect(s.runtime.get(id)?.interactions['w:approval'].outcome?.kind).toBe('expired');
    expect(s.runtime.get(id)?.status).toBe('cancelled');
  });


});

describe('Model context and verified artifacts',()=>{
  it('records truncation before failing and never executes the incomplete tool call',async()=>{
    const s=setup();const effect=vi.fn();
    s.registry.register({name:'write',namespace:'obsidian',description:'',schema:z.object({}),execute:effect});
    s.provider.generateStreamWithSkills.mockImplementation(async()=>{throw new ModelResponseError('truncated',{content:'partial',finishReason:'length',diagnostics:{pendingToolCalls:1},usage:{promptTokens:100,completionTokens:2048,totalTokens:2148}});});
    const id=await start(s),r=s.runtime.get(id)!;
    expect(r.status).toBe('failed');expect(effect).not.toHaveBeenCalled();
    expect(r.events.find(e=>e.type==='model:result')?.details).toMatchObject({finishReason:'length',usage:{completionTokens:2048},response:{outputLimit:2048}});
    expect(projectRunIncidents([r])).toHaveLength(1);
    expect(renderRunFacts([r])).toContain('2048');
  });
  it('keeps complete tool groups when compacting and rejects orphaned results',()=>{
    const messages:any[]=[{role:'user',content:'q'}, {role:'assistant',content:'',tool_calls:[call('a','read'),call('b','read')]},{role:'tool',tool_call_id:'a',content:'a'},{role:'tool',tool_call_id:'b',content:'b'},{role:'assistant',content:'done'}];
    const recent=recentMessageUnit(messages,2);
    expect(recent).toHaveLength(4);expect(()=>validateToolPairs(recent)).not.toThrow();
    expect(()=>validateToolPairs(messages.slice(2))).toThrow('配对');
    expect(()=>validateToolPairs(messages.slice(0,2))).toThrow('缺少');
  });
  it('reads to EOF when the requested end exceeds the file and honors length without startChar',async()=>{
    const e=environment();e.platform.addFile('note.md','first\nsecond\nthird');
    const flags={path:'note.md',includeMetadata:false,includeFrontmatter:false,includeLinks:false};
    const result=await read(readSchema.parse({...flags,startLine:2,endLine:760}),e.context);
    expect(result).toMatchObject({success:true,data:{content:'second\nthird',lineRange:{start:2,end:3,totalLines:3,requestedEnd:760}}});
    expect(await read(readSchema.parse({...flags,length:5}),e.context)).toMatchObject({success:true,data:{content:'first'}});
  });
  it('rejects invalid Canvas references and malformed Excalidraw before writing',async()=>{
    const e=environment();const result=await write(writeSchema.parse({path:'bad.canvas',content:'{"nodes":[],"edges":[{"id":"e","fromNode":"missing","toNode":"missing"}]}'}),e.context);
    expect(result.success).toBe(false);expect(e.platform.getFileByPath('bad.canvas')).toBeNull();
    expect(()=>validateArtifact('bad.excalidraw','{"type":"excalidraw","elements":[{"id":"a"}]}',null)).toThrow();
  });
  it('stages and verifies one Canvas, then preserves it when the next artifact is invalid',async()=>{
    const e=environment();const events:any[]=[];
    const context={...e.context,operationId:'one',runtime:{runId:'run-test',record:async(...args:any[])=>{events.push(args);}}};
    const content=JSON.stringify({nodes:[{id:'a',type:'text',text:'verified',x:0,y:0,width:100,height:50}],edges:[]});
    const parameters=writeSchema.parse({path:'one.canvas',content});
    const result=await write(parameters,context);
    expect(result.success).toBe(true);expect(await e.platform.read('one.canvas')).toBe(content);
    expect(events.map(e=>e[0])).toEqual(['mutation:prepared','artifact:verified']);
    expect(events[0][1].planId).toBe(events[1][1].planId);
    const next=await write(writeSchema.parse({path:'two.canvas',content:'broken'}),{...context,operationId:'two'});
    expect(next.success).toBe(false);expect(await e.platform.read('one.canvas')).toBe(content);
    const retained=await context.mutations!.prepare('obsidian:write_note',parameters,async()=>{throw new Error('The committed plan must be reused');},context);
    expect(retained.id).toBe(events[0][1].planId);
  });
  it('does not report success if reading back a written file fails verification',async()=>{
    const e=environment();e.vault.read=async()=> 'changed concurrently';
    await expect(writeVerifiedArtifact(e.context,'note.md','# Expected',null)).rejects.toBeInstanceOf(RunBlocked);
  });
});
