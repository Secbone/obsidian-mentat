import { describe, expect, it, vi } from 'vitest';
vi.mock('obsidian');
import { z } from 'zod';
import type { RunRepository } from '../../src/contracts/run-repository';
import type { RunRecord } from '../../src/runtime/types';
import { RunStore } from '../../src/runtime/run-store';
import { fingerprint } from '../../src/runtime/fingerprint';
import { MemoryPlatformAdapter } from '../utils/memory-platform-adapter';
import { RunController } from '../../src/runtime/run-controller';
import { ChatManager } from '../../src/chat/chat-manager';
import { EventBus } from '../../src/extensions/event-bus';
import { BaseAgent } from '../../src/agents/base-agent';
import { SkillRegistry } from '../../src/skills/core/skill-registry';
import { SkillExecutor } from '../../src/skills/core/skill-executor';
import { SkillInvocationContext } from '../../src/skills/strategies/skill-invocation-strategy';

const record=(id='run-test'):RunRecord=>({version:1,id,sessionId:'session',prompt:'work',agentId:'default-chat-agent',maxTurns:20,enableSkills:true,
  status:'completed',createdAt:1,updatedAt:1,messages:[{role:'user',content:'work',timestamp:1}],baseMessageCount:0,operations:{},interactions:{},events:[]});
class ReplacePlatform extends MemoryPlatformAdapter {
  async replaceFile(temporary:string,path:string):Promise<void> {
    const value=this.files.get(temporary);if(!value) throw new Error('missing temporary');
    this.files.set(path,{...value,file:{...value.file,path}});this.files.delete(temporary);
  }
}
class MemoryRepository implements RunRepository {
  warnings:string[]=[];capabilities={safeReplace:true,externalChangeDetection:false};private values=new Map<string,RunRecord>();
  async load(id:string){const value=this.values.get(id);if(!value)throw new Error('missing');return structuredClone(value);}
  async list(){return structuredClone([...this.values.values()]);}
  async commit(value:RunRecord,expected:number){if((this.values.get(value.id)?.revision || 0)!==expected)throw new Error('revision conflict');
    const next=structuredClone({...value,revision:expected+1});this.values.set(value.id,next);return next.revision;}
  async flush(){}
}
for(const [name,create] of [['file',()=>new RunStore(new ReplacePlatform())],['memory',()=>new MemoryRepository()]] as const) {
  it(`${name} repository supports detached reads and rejects stale commits`,async()=>{
    const repo=create(),first=record();first.revision=await repo.commit(first,0);
    const old=await repo.load(first.id),next=await repo.load(first.id);next.error='new';await repo.commit(next,1);
    old.error='stale';await expect(repo.commit(old,1)).rejects.toThrow();
    const loaded=await repo.load(first.id);loaded.messages[0].content='outside mutation';
    expect((await repo.load(first.id)).messages[0].content).toBe('work');
    expect((await repo.list())[0].error).toBe('new');
  });
}

describe('File repository failure boundaries',()=>{
  it('detects same-revision external edits without replacing the external data',async()=>{
    const io=new ReplacePlatform(),store=new RunStore(io),value=record();await store.save(value);
    const path=`${store.folder}/${value.id}.json`,external={...JSON.parse(await io.read(path)),error:'external edit'};
    await io.write(path,JSON.stringify(external));
    await store.load(value.id); // A diagnostic read must not silently authorize the stale controller.
    await expect(store.commit({...value,error:'stale writer'},1)).rejects.toThrow('其他写入者');
    expect(JSON.parse(await io.read(path)).error).toBe('external edit');
  });
  it('keeps the primary readable when staging or replacement fails and exposes weaker fallback capability',async()=>{
    const io=new ReplacePlatform(),store=new RunStore(io),value=record();await store.save(value);
    const before=await io.read(`${store.folder}/${value.id}.json`);
    vi.spyOn(io,'replaceFile').mockRejectedValueOnce(new Error('replace unavailable'));
    await expect(store.commit({...value,error:'new'},1)).rejects.toThrow('replace unavailable');
    expect(await io.read(`${store.folder}/${value.id}.json`)).toBe(before);
    expect(value.revision).toBe(1);
    expect(store.capabilities.safeReplace).toBe(true);
    expect(new RunStore(new MemoryPlatformAdapter()).capabilities.safeReplace).toBe(false);
  });
  it('loads legacy full histories and new deltas without duplicating the baseline on disk',async()=>{
    const io=new ReplacePlatform(),store=new RunStore(io),base=record('run-base');
    base.messages=Array.from({length:30},(_,i)=>({role:'user' as const,content:`old ${i}`,timestamp:i}));await store.save(base);
    const next=record('run-next');next.messages=[...base.messages,{role:'user',content:'new',timestamp:31}];next.baseMessageCount=30;
    next.messageBase={runId:base.id,count:30,digest:await fingerprint(base.messages)};await store.save(next);
    const raw=JSON.parse(await io.read(`${store.folder}/${next.id}.json`));
    expect(raw.messageEncoding).toBe('delta-v1');expect(raw.messages).toHaveLength(1);
    const loaded=await new RunStore(io).load(next.id);expect(loaded.messages).toHaveLength(31);expect(loaded.messages[0].content).toBe('old 0');
  });
  it('recovers a torn primary conservatively and keeps the damaged bytes',async()=>{
    const io=new ReplacePlatform(),store=new RunStore(io),value=record();value.operations.w={id:'w',name:'write',category:'write',status:'running'};
    await store.save(value);value.operations.w.status='finished';await store.save(value);
    const path=`${store.folder}/${value.id}.json`;await io.write(path,'torn primary');
    const restored=await new RunStore(io).load(value.id);
    expect(restored.status).toBe('interrupted');expect(restored.operations.w.status).toBe('unknown');
    expect([...io.files.keys()].some(path=>path.includes('.corrupt-'))).toBe(true);
  });
});

async function controllerFixture() {
  const io=new ReplacePlatform(),plugin={platform:io,loadData:async()=>({}),saveData:async()=>{}},chat=new ChatManager(plugin);
  await chat.getHistory();const store=new RunStore(io),bus=new EventBus();
  const controller=new RunController(store,bus,chat,async(prompt,context)=>{await context.onCheckpoint?.([...context.messages,{role:'user',content:prompt,timestamp:1},{role:'assistant',content:'answer',timestamp:2}]);});
  await controller.initialize();return {io,plugin,chat,store,controller};
}
describe('Authoritative runtime commits and session projection',()=>{
  it('does not publish failed operation or approval candidates',async()=>{
    const s=await controllerFixture(),id=await s.controller.start('work',{sessionId:s.chat.getSessionInfo().sessionId,messages:[],maxTurns:20,enableSkills:true});await s.controller.wait(id);
    const value=s.controller.get(id)!,runtime=(s.controller as any).runtime(value),before=structuredClone(value);
    const failure=vi.spyOn(s.store,'save').mockRejectedValue(new Error('disk failure'));
    await expect(runtime.setOperation({id:'w',name:'write',category:'write',status:'running'})).rejects.toThrow('disk failure');
    await expect(runtime.interact({id:'approval',operationId:'w',kind:'approval',question:'allow'})).rejects.toThrow('disk failure');
    expect(value).toEqual(before);failure.mockRestore();expect(await s.store.load(id)).toEqual(before);
  });
  it('commits the instruction transcript and consumed status together, or publishes neither on failure',async()=>{
    const io=new ReplacePlatform(),chat=new ChatManager({platform:io,loadData:async()=>({}),saveData:async()=>{}});await chat.getHistory();
    const store=new RunStore(io);let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
    const controller=new RunController(store,new EventBus(),chat,async(_prompt,context)=>{
      await gate;
      const inputs=await context.runtime!.takeInstructions();
      await context.onCheckpoint?.([...context.messages,{role:'user',content:'work',timestamp:1},...inputs.map(input=>({role:'user' as const,content:`[HUMAN DYNAMIC INTERVENTION]: ${input.text}`,timestamp:2,metadata:{instructionId:input.id}}))]);
    });
    await controller.initialize();const id=await controller.start('work',{sessionId:chat.getSessionInfo().sessionId,messages:[],maxTurns:20,enableSkills:true});
    expect(await controller.steer(id,'B')).toBe(true);
    const original=store.save.bind(store),failure=vi.spyOn(store,'save').mockImplementation(async(candidate,revision)=>{
      if(candidate.messages.some(message=>message.metadata?.instructionId))throw new Error('checkpoint failed');
      await original(candidate,revision);
    });
    release();await controller.wait(id);
    expect(controller.get(id)?.instructions?.[0].status).toBe('queued');
    expect(controller.get(id)?.messages.some(message=>message.metadata?.instructionId)).toBe(false);
    const failed=await store.load(id);expect(failed.instructions?.[0].status).toBe('queued');expect(failed.messages.some(message=>message.metadata?.instructionId)).toBe(false);
    failure.mockRestore();await controller.resume(id);
    const committed=await store.load(id);expect(committed.instructions?.[0].status).toBe('consumed');expect(committed.messages.filter(message=>message.metadata?.instructionId)).toHaveLength(1);
  });

  it('retains an accepted instruction when the previous final-state commit was already in progress',async()=>{
    const io=new ReplacePlatform(),chat=new ChatManager({platform:io,loadData:async()=>({}),saveData:async()=>{}});await chat.getHistory();
    const store=new RunStore(io);let finish!:()=>void;const work=new Promise<void>(resolve=>{finish=resolve;});
    const controller=new RunController(store,new EventBus(),chat,async()=>{await work;});await controller.initialize();
    const id=await controller.start('work',{sessionId:chat.getSessionInfo().sessionId,messages:[],maxTurns:20,enableSkills:true});
    let held=false,release!:()=>void;const commitGate=new Promise<void>(resolve=>{release=resolve;}),save=store.save.bind(store);
    vi.spyOn(store,'save').mockImplementation(async(candidate,revision)=>{if(candidate.events.at(-1)?.type==='run:completed'){held=true;await commitGate;}await save(candidate,revision);});
    finish();await vi.waitFor(()=>expect(held).toBe(true));
    const accepted=controller.steer(id,'late B');release();expect(await accepted).toBe(true);await controller.wait(id);
    expect(controller.get(id)?.status).toBe('interrupted');expect((await store.load(id)).instructions?.[0]).toMatchObject({text:'late B',status:'queued'});
  });

  it('can rebuild corrupted session projection files from an intact authoritative run',async()=>{
    const s=await controllerFixture(),id=await s.controller.start('work',{sessionId:s.chat.getSessionInfo().sessionId,messages:[],maxTurns:20,enableSkills:true});await s.controller.wait(id);
    const base='.obsidian/plugins/obsidian-mentat/';await s.io.write(base+'chat_history.json','damaged legacy');await s.io.write(base+'session_projection.json','damaged cursor');
    const chat=new ChatManager(s.plugin);await expect(chat.getHistory()).resolves.toEqual([]);
    const restored=new RunController(new RunStore(s.io),new EventBus(),chat,async()=>{});await restored.initialize();await restored.open(id);
    expect(await chat.getHistory()).toEqual(s.controller.get(id)?.messages);
    expect(await s.io.read(base+'chat_history.json')).toBe('damaged legacy');
    expect([...s.io.files.keys()].some(path=>path.includes('session_projection.json.corrupt-'))).toBe(true);
    expect(JSON.parse(await s.io.read(base+'session_projection.json')).runId).toBe(id);
  });

  it('checks engine binding races and rejects context snapshots from an uncommitted source',async()=>{
    const s=await controllerFixture(),id=await s.controller.start('work',{sessionId:s.chat.getSessionInfo().sessionId,messages:[],maxTurns:20,enableSkills:true});await s.controller.wait(id);
    const record=s.controller.get(id)!,runtime=(s.controller as any).runtime(record);
    const bindings=await Promise.allSettled([runtime.bindEngine({id:'first',version:'1',codecVersion:1}),runtime.bindEngine({id:'second',version:'1',codecVersion:1})]);
    expect(bindings.map(result=>result.status)).toEqual(['fulfilled','rejected']);expect(record.engineBinding?.id).toBe('first');
    const snapshot={version:1,strategyId:'summary-v1',providerId:'fake',sourceMessageCount:record.messages.length,sourceDigest:'wrong',messages:[],estimatedTokens:0};
    await expect(runtime.saveContextSnapshot(snapshot)).rejects.toThrow('基线不一致');expect(record.contextSnapshot).toBeUndefined();
    snapshot.sourceDigest=await fingerprint(record.messages);await runtime.saveContextSnapshot(snapshot);
    expect((await s.store.load(id)).contextSnapshot?.sourceDigest).toBe(snapshot.sourceDigest);
  });

  it('keeps managed history in journals, rebuilds the cursor projection and leaves legacy history intact',async()=>{
    const s=await controllerFixture();await s.chat.addMessage('user','legacy input');
    const legacyPath='.obsidian/plugins/obsidian-mentat/chat_history.json';
    // Legacy-only callers retain their original file; managed sessions use the new cursor.
    if(!await s.io.exists(legacyPath)) await s.io.write(legacyPath,JSON.stringify({sessionId:s.chat.getSessionInfo().sessionId,messages:[],selectedFiles:[]}));
    const legacy=await s.io.read(legacyPath),messages=await s.chat.getHistory();
    const id=await s.controller.start('managed',{sessionId:s.chat.getSessionInfo().sessionId,messages,maxTurns:20,enableSkills:true});await s.controller.wait(id);
    expect(await s.io.read(legacyPath)).toBe(legacy);
    const cursor=JSON.parse(await s.io.read('.obsidian/plugins/obsidian-mentat/session_projection.json'));
    expect(cursor.runId).toBe(id);expect(cursor.messages).toBeUndefined();expect(cursor.legacyMessages).toBeUndefined();
    const restoredChat=new ChatManager(s.plugin),restored=new RunController(new RunStore(s.io),new EventBus(),restoredChat,async()=>{});
    await restoredChat.getHistory();await restored.initialize();
    expect(await restoredChat.getHistory()).toEqual(s.controller.get(id)?.messages);
    await restoredChat.clearHistory();expect(await restoredChat.getHistory()).toEqual([]);
    expect(await s.io.read(legacyPath)).toBe(legacy);
  });
});

it('restores a persisted compact context across an approval restart instead of summarizing the raw transcript again',async()=>{
  const io=new ReplacePlatform(),plugin={platform:io,loadData:async()=>({}),saveData:async()=>{}},chat=new ChatManager(plugin);
  await chat.getHistory();
  const history=Array.from({length:20},(_,i)=>({role:'user' as const,content:`${i} `+'x'.repeat(400),timestamp:i}));await chat.replaceMessages(history);
  const summary=vi.fn(async()=> 'saved summary');
  const make=()=>{
    const registry=new SkillRegistry(),bus=new EventBus(),executor=new SkillExecutor(registry,{} as any,bus);
    registry.register({name:'pause',namespace:'obsidian',description:'pause',schema:z.object({}),metadata:{executionCategory:'interaction'},execute:async(_input,options)=>{
      await options!.runtime!.interact({id:'question',operationId:'q',kind:'question',question:'Continue?'});return {success:true,data:'yes'};
    }});
    const provider={id:'fake',type:'openai',supportsSkills:()=>true,getContextWindow:()=>4000,getCompactionThreshold:()=>.2,getMaxOutputTokens:()=>100,generate:summary,
      generateStreamWithSkills:vi.fn(async()=>({content:'done',finishReason:'stop'}))} as any;
    const agent=new BaseAgent({id:'default-chat-agent',name:'Chat',description:'',enableSkills:true},provider,{skillRegistry:registry,skillExecutor:executor,skillInvocationContext:new SkillInvocationContext('native'),eventBus:bus});
    const controller=new RunController(new RunStore(io),bus,chat,async(prompt,context)=>{await agent.execute(prompt,context);});return {controller,provider};
  };
  const first=make();first.provider.generateStreamWithSkills.mockResolvedValueOnce({content:'',toolCalls:[{id:'q',name:'obsidian:pause',arguments:'{}'}],finishReason:'tool_calls'});
  await first.controller.initialize();const id=await first.controller.start('work',{sessionId:chat.getSessionInfo().sessionId,messages:history,maxTurns:20,enableSkills:true});await first.controller.wait(id);
  expect(first.controller.get(id)?.status).toBe('waiting_for_user');expect(summary).toHaveBeenCalledOnce();
  expect(first.controller.get(id)?.contextSnapshot?.messages[0].content).toContain('saved summary');
  const restored=make();await restored.controller.initialize();await restored.controller.respond(id,'question',{kind:'answered',answer:'yes'});
  expect(restored.controller.get(id)?.status).toBe('completed');expect(summary).toHaveBeenCalledOnce();
  expect(restored.provider.generateStreamWithSkills.mock.calls[0][0][0].content).toContain('saved summary');
  expect(restored.controller.get(id)?.messages.filter(message=>message.content.includes('x'.repeat(100)))).toHaveLength(20);
});

it('rebuilds context with the injected strategy instead of restoring a different strategy snapshot',async()=>{
  const history=Array.from({length:20},(_,i)=>({role:'user' as const,content:`${i} `+'x'.repeat(400),timestamp:i}));
  const registry=new SkillRegistry(),provider={id:'fake',type:'openai',supportsSkills:()=>true,getContextWindow:()=>4000,getCompactionThreshold:()=>.2,getMaxOutputTokens:()=>100,
    generateStreamWithSkills:vi.fn(async()=>({content:'done',finishReason:'stop'}))} as any;
  const builder={id:'replacement-window-v1',build:vi.fn(async()=>({messages:[{role:'user' as const,content:'replacement context',timestamp:1}],summaryLength:19}))};
  const saveContextSnapshot=vi.fn(async()=>{});
  const runtime={getContextSnapshot:()=>({version:1,strategyId:'summary-v1',providerId:'fake',sourceMessageCount:history.length,sourceDigest:'unused',messages:[{role:'user',content:'stale summary',timestamp:1}],estimatedTokens:10}),
    saveContextSnapshot,takeInstructions:async()=>[],record:async()=>{},modelResult:async()=>{}} as any;
  const summarizer={compact:vi.fn(async()=>{throw new Error('Injected builder must own context policy');})};
  const agent=new BaseAgent({id:'default-chat-agent',name:'Chat',description:'',enableSkills:true},provider,
    {skillRegistry:registry,skillExecutor:new SkillExecutor(registry,{} as any),skillInvocationContext:new SkillInvocationContext('native'),contextBuilder:builder,compactor:summarizer});
  await agent.execute('work',{messages:history,sessionId:'test',runtime,metadata:{resume:true}});
  expect(builder.build).toHaveBeenCalledOnce();expect(summarizer.compact).not.toHaveBeenCalled();
  expect(saveContextSnapshot).toHaveBeenCalledWith(expect.objectContaining({strategyId:'replacement-window-v1'}));
  expect(provider.generateStreamWithSkills.mock.calls[0][0][0].content).toBe('replacement context');
});
