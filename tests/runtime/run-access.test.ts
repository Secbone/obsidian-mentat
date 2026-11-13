import { describe, expect, it, vi } from 'vitest';
vi.mock('obsidian');
import type { RunAccess, RunStartOptions } from '../../src/contracts/run-access';
import type { RunRecord } from '../../src/runtime/types';
import { createRunAccess } from '../../src/runtime/run-access';
import { RunController } from '../../src/runtime/run-controller';
import { RunStore } from '../../src/runtime/run-store';
import { ChatManager } from '../../src/chat/chat-manager';
import { EventBus } from '../../src/extensions/event-bus';
import { abortable } from '../../src/utils/execution';
import { MemoryPlatformAdapter } from '../utils/memory-platform-adapter';

interface Fixture { access: RunAccess; sessionId: string; finish(): Promise<void>; }
async function realFixture() {
  const platform=new MemoryPlatformAdapter();
  const chat=new ChatManager({platform,loadData:async()=>({}),saveData:async()=>{}});
  await chat.getHistory();
  let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const controller=new RunController(new RunStore(platform),new EventBus(),chat,async(_prompt,context)=>{await abortable(gate,context.abortSignal);});
  await controller.initialize();
  const access=createRunAccess(controller);
  return {access,controller,chat,sessionId:chat.getSessionInfo().sessionId,finish:async()=>{release();await Promise.all(controller.list().map(record=>controller.wait(record.id)));}};
}

/** A second implementation for the consumer path; no controller, storage or host required. */
async function memoryFixture():Promise<Fixture> {
  let record:RunRecord|undefined;
  const copy=<T>(value:T):T=>structuredClone(value);
  const unsupported=async()=>{throw new Error('Not used by this contract consumer');};
  const access:RunAccess={
    start:async(prompt,options)=>{
      record={version:1,id:'run-memory',sessionId:options.sessionId,prompt,agentId:'test',maxTurns:options.maxTurns,enableSkills:options.enableSkills,
        status:'running',createdAt:1,updatedAt:1,messages:[...copy(options.messages),{role:'user',content:prompt,timestamp:1}],baseMessageCount:options.messages.length,
        operations:{},interactions:{},events:[]};
      return record.id;
    },
    list:sessionId=>record && (!sessionId || record.sessionId===sessionId) ? [copy(record)] : [],
    get:id=>record?.id===id ? copy(record):undefined,
    getDisplayMessages:id=>record?.id===id ? copy(record.messages):[],
    getLiveState:()=>undefined,
    getWarnings:()=>[],
    hasUnsettledWork:()=>!!record && !['completed','cancelled','failed'].includes(record.status),
    steer:async(id,text)=>{
      if(record?.id!==id || record.status!=='running') return false;
      record.instructions||=[];record.instructions.push({id:'input',text,status:'queued'});return true;
    },
    cancel:async(id)=>{if(record?.id===id) record.status='cancelled';},
    open:unsupported,resume:unsupported,respond:unsupported,reconcile:unsupported,
  };
  return {access,sessionId:'memory-session',finish:async()=>{if(record) record.status=record.instructions?.some(i=>i.status==='queued')?'interrupted':'completed';}};
}

for (const [name,factory] of [['runtime',realFixture],['memory replacement',memoryFixture]] as const) {
  describe(`RunAccess consumer contract: ${name}`,()=>{
    it('starts, queries, receives input and cancels through the same port without exposing mutable state',async()=>{
      const s=await factory(), access=s.access;
      const options:RunStartOptions={sessionId:s.sessionId,messages:[{role:'user',content:'previous',timestamp:1}],maxTurns:20,enableSkills:true};
      const id=await access.start('work',options);
      options.messages[0].content='caller mutation';
      expect(access.get(id)?.messages[0].content).toBe('previous');
      expect(access.hasUnsettledWork()).toBe(true);
      expect(await access.steer(id,'also B')).toBe(true);
      const view=access.get(id)!;
      try {view.messages[0].content='UI mutation';} catch { /* Frozen snapshots may reject writes. */ }
      try {view.instructions![0].text='UI mutation';} catch { /* A detached copy is also valid. */ }
      expect(access.get(id)?.messages[0].content).toBe('previous');
      expect(access.get(id)?.instructions?.[0].text).toBe('also B');
      expect(access.list('another-session')).toEqual([]);
      expect(access.get('missing')).toBeUndefined();
      await s.finish();
      expect(access.get(id)?.status).toBe('interrupted');
      await access.cancel(id);
      expect(access.get(id)?.status).toBe('cancelled');
      expect(access.hasUnsettledWork()).toBe(false);
    });
  });
}

describe('Runtime RunAccess snapshots',()=>{
  it('reuses settled snapshots and invalidates on checkpoint/event/partial changes',async()=>{
    const s=await realFixture(), id=await s.access.start('work',{sessionId:s.sessionId,messages:[],maxTurns:20,enableSkills:true});
    await s.finish();
    const first=s.access.get(id)!;
    expect(s.access.list()[0]).toBe(first);
    expect(s.access.get(id)).toBe(first);
    expect(Object.isFrozen(first.messages)).toBe(true);
    const record=s.controller.get(id)!;
    record.partial='new partial';
    expect(s.access.get(id)).not.toBe(first);
    const partial=s.access.get(id)!;
    record.messages=[...record.messages,{role:'assistant',content:'checkpoint',timestamp:2}];
    expect(s.access.get(id)).not.toBe(partial);
    const checkpoint=s.access.get(id)!;
    record.events.push({id:`${id}:new`,sequence:99,timestamp:3,type:'synthetic'});
    expect(s.access.get(id)).not.toBe(checkpoint);
    const messages=s.access.getDisplayMessages(id);
    expect(s.access.getDisplayMessages(id)).toBe(messages);
    record.messages.push({role:'assistant',content:'next',timestamp:4});
    expect(s.access.getDisplayMessages(id)).not.toBe(messages);
    expect(messages).toHaveLength(2);
  });

  it('isolates live display state and storage warnings',async()=>{
    const s=await realFixture(), id=await s.access.start('work',{sessionId:s.sessionId,messages:[],maxTurns:20,enableSkills:true});
    const context=s.controller.getContext(id)!;
    context.transcript=[{role:'assistant',content:'prefix',timestamp:1}];
    const shown=s.access.getDisplayMessages(id);
    context.transcript.push({role:'assistant',content:'later',timestamp:2});
    expect(shown).toHaveLength(1);
    expect(s.access.getDisplayMessages(id)).toHaveLength(2);
    s.controller.store.warnings.push('original warning');
    const warnings=s.access.getWarnings();warnings[0]='UI mutation';
    expect(s.access.getWarnings()).toEqual(['original warning']);
    await s.finish();
  });

  it('keeps the reconfiguration guard active for waiting, unknown, interrupted and actual in-flight work',async()=>{
    const s=await realFixture();
    expect(s.controller.hasUnsettledWork()).toBe(false);
    const id=await s.access.start('work',{sessionId:s.sessionId,messages:[],maxTurns:20,enableSkills:true});
    expect(s.controller.hasUnsettledWork()).toBe(true);
    await s.finish();
    const record=s.controller.get(id)!;
    expect(s.controller.hasUnsettledWork()).toBe(false);
    for(const status of ['waiting_for_user','waiting_for_approval','interrupted'] as const) {
      record.status=status;expect(s.controller.hasUnsettledWork()).toBe(true);
    }
    record.status='completed';
    record.operations.w={id:'w',name:'write',category:'write',status:'unknown'};
    expect(s.controller.hasUnsettledWork()).toBe(true);
    delete record.operations.w;
    let finish!:()=>void;
    const promise=new Promise<void>(resolve=>{finish=resolve;});
    const runtime=(s.controller as any).runtime(record);
    runtime.trackOperation('late',promise);
    expect(s.controller.hasUnsettledWork()).toBe(true);
    finish();await promise;await Promise.resolve();
    expect(s.controller.hasUnsettledWork()).toBe(false);
  });
});
