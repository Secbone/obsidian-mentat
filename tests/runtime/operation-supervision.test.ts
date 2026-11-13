import { describe, expect, it, vi } from 'vitest';
vi.mock('obsidian');
import { z } from 'zod';
import { BaseAgent } from '../../src/agents/base-agent';
import { SkillRegistry } from '../../src/skills/core/skill-registry';
import { SkillExecutor } from '../../src/skills/core/skill-executor';
import { SkillInvocationContext } from '../../src/skills/strategies/skill-invocation-strategy';
import { ChatManager } from '../../src/chat/chat-manager';
import { EventBus } from '../../src/extensions/event-bus';
import { RunController } from '../../src/runtime/run-controller';
import { RunStore } from '../../src/runtime/run-store';
import { RunBlocked, type OperationRecord, type RunRuntime } from '../../src/runtime/types';
import { MemoryPlatformAdapter } from '../utils/memory-platform-adapter';
import type { Observer } from '../../src/observability/observer';

function setup(observer?: Observer) {
  const platform = new MemoryPlatformAdapter(), vault = {};
  const plugin = { platform, settings: {}, loadData: async () => ({}), saveData: async () => {} };
  const manager = new ChatManager(plugin), bus = new EventBus(), registry = new SkillRegistry();
  const executor = new SkillExecutor(registry, {vault, plugin} as any, bus);
  const provider = { id:'fake', type:'openai', supportsSkills:()=>true, getContextWindow:()=>32000, getCompactionThreshold:()=>.8, getMaxOutputTokens:()=>2048,
    generateStreamWithSkills:vi.fn(async()=>({content:'done',finishReason:'stop'})) } as any;
  const agent = new BaseAgent({id:'default-chat-agent',name:'Chat',description:'',enableSkills:true},provider,
    {skillRegistry:registry,skillExecutor:executor,skillInvocationContext:new SkillInvocationContext('native'),eventBus:bus});
  const runtime = new RunController(new RunStore(platform),bus,manager,async(prompt,context)=>{await agent.execute(prompt,context);},observer);
  return {platform,manager,registry,executor,provider,runtime};
}
const toolCall = {id:'w',name:'obsidian:run_command',arguments:'{"timeout":10}'};

describe('Actual operation lifetime',()=>{
  it('reports when a failed receipt cannot be withdrawn from storage',async()=>{
    const observer={error:vi.fn(),event:vi.fn()} as unknown as Observer;
    const s=setup(observer); let finishModel!:(value:any)=>void;
    s.provider.generateStreamWithSkills.mockImplementationOnce(()=>new Promise(resolve=>{finishModel=resolve;}));
    await s.manager.getHistory(); await s.runtime.initialize();
    const id=await s.runtime.start('work',{sessionId:s.manager.getSessionInfo().sessionId,messages:[],maxTurns:20,enableSkills:true});
    await vi.waitFor(()=>expect(finishModel).toBeTypeOf('function'));
    const failure=vi.spyOn(s.runtime.store,'save').mockRejectedValue(new Error('disk unavailable'));
    await expect(s.runtime.steer(id,'do not accept')).rejects.toThrow('撤回记录也未能保存');
    expect(observer.error).toHaveBeenCalledWith('storage:instruction_rollback:failed',expect.any(Error),expect.objectContaining({runId:id}));
    expect(s.runtime.get(id)?.instructions).toEqual([]);
    failure.mockRestore(); finishModel({content:'done',finishReason:'stop'}); await s.runtime.wait(id);
    expect(s.runtime.get(id)?.messages.some(m=>m.metadata?.instructionId)).toBe(false);
  });

  it.each([true,false])('does not consume an instruction before its receipt commit settles (success=%s)',async success=>{
    const s=setup(); let finishModel!:(value:any)=>void, releaseReceipt!:()=>void, rejectReceipt!:(error:Error)=>void;
    const receiptGate=new Promise<void>((resolve,reject)=>{releaseReceipt=resolve;rejectReceipt=reject;});
    s.registry.register({name:'read',namespace:'obsidian',description:'',schema:z.object({}),metadata:{executionCategory:'read'},execute:async()=>({success:true})});
    s.provider.generateStreamWithSkills.mockImplementationOnce(()=>new Promise(resolve=>{finishModel=resolve;}));
    await s.manager.getHistory(); await s.runtime.initialize();
    const id=await s.runtime.start('work',{sessionId:s.manager.getSessionInfo().sessionId,messages:[],maxTurns:20,enableSkills:true});
    await vi.waitFor(()=>expect(finishModel).toBeTypeOf('function'));
    const save=s.runtime.store.save.bind(s.runtime.store); let held=false;
    vi.spyOn(s.runtime.store,'save').mockImplementation(async record=>{
      if(!held && record.events.at(-1)?.type==='instruction:queued') { held=true; await receiptGate; }
      await save(record);
    });
    const receipt=s.runtime.steer(id,'uncommitted instruction').then(value=>({value,error:undefined}),error=>({value:undefined,error}));
    await vi.waitFor(()=>expect(held).toBe(true));
    finishModel({content:'',toolCalls:[{id:'r',name:'obsidian:read',arguments:'{}'}],finishReason:'tool_calls'});
    await s.runtime.wait(id);
    expect(s.runtime.get(id)?.status).toBe('interrupted');
    expect(s.runtime.get(id)?.messages.some(m=>m.metadata?.instructionId)).toBe(false);
    expect(s.provider.generateStreamWithSkills.mock.calls.every(([messages]:any[])=>messages.every((m:any)=>!m.content.includes('uncommitted instruction')))).toBe(true);
    expect((await s.runtime.store.load(id)).instructions?.[0].status).toBe('queued');
    if(success) releaseReceipt(); else rejectReceipt(new Error('receipt storage failed'));
    const received=await receipt;
    if(success) {
      expect(received.value).toBe(true);
      await s.runtime.resume(id);
      expect(s.runtime.get(id)?.messages.filter(m=>m.metadata?.instructionId)).toHaveLength(1);
    } else {
      expect(received.error?.message).toBe('receipt storage failed');
      expect(s.runtime.get(id)?.instructions).toEqual([]);
      expect((await s.runtime.store.load(id)).instructions).toEqual([]);
      await s.runtime.resume(id);
      expect(s.runtime.get(id)?.messages.some(m=>m.metadata?.instructionId)).toBe(false);
    }
  });

  it('blocks reconciliation while a timed-out write is still executing, then uses its late result',async()=>{
    const s=setup(); let complete!:(value:any)=>void;
    const effect=vi.fn(()=>new Promise<any>(resolve=>{complete=resolve;}));
    s.registry.register({name:'run_command',namespace:'obsidian',description:'',schema:z.object({timeout:z.number()}),metadata:{executionCategory:'external'},execute:effect});
    s.provider.generateStreamWithSkills.mockResolvedValueOnce({content:'',toolCalls:[toolCall],finishReason:'tool_calls'});
    await s.manager.getHistory(); await s.runtime.initialize();
    const id=await s.runtime.start('work',{sessionId:s.manager.getSessionInfo().sessionId,messages:[],maxTurns:20,enableSkills:true});
    await s.runtime.wait(id);
    expect(s.runtime.get(id)?.operations.w.status).toBe('unknown');
    await expect(s.runtime.reconcile(id,'w',null)).rejects.toThrow('实际执行');
    await expect(s.runtime.reconcile(id,'w',{success:true})).rejects.toThrow('实际执行');
    expect(s.runtime.get(id)?.operations.w.status).toBe('unknown');
    complete({success:true,data:'actual result'});
    await vi.waitFor(()=>expect(s.runtime.get(id)?.operations.w.status).toBe('finished'));
    await s.runtime.resume(id);
    expect(effect).toHaveBeenCalledOnce();
    expect(s.runtime.get(id)?.status).toBe('completed');
    expect((await s.manager.getHistory()).find(m=>m.tool_call_id==='w')?.content).toContain('actual result');
  });

  it('rechecks the operation ledger inside the write barrier before executing a queued retry',async()=>{
    const registry=new SkillRegistry(); let finish!:(value:any)=>void;
    const gate=new Promise<any>(resolve=>{finish=resolve;}), effect=vi.fn(()=>gate);
    registry.register({name:'write',namespace:'obsidian',description:'',schema:z.object({}),metadata:{executionCategory:'write'},execute:effect});
    const operations:Record<string,OperationRecord>={};
    const runtime={getOperation:(id:string)=>operations[id],setOperation:async(op:OperationRecord)=>{operations[op.id]=op;}} as RunRuntime;
    const executor=new SkillExecutor(registry,{vault:{}} as any);
    const first=await executor.execute('obsidian','write',{}, {operationId:'w',runtime,timeout:10});
    expect(first.outcome).toBe('unknown');
    // Simulate an old caller accepting reconciliation before the original effect settles.
    operations.w={...operations.w,status:'planned',result:undefined};
    const retry=executor.execute('obsidian','write',{}, {operationId:'w',runtime,timeout:1000});
    await Promise.resolve(); await Promise.resolve();
    finish({success:true,data:'original result'});
    expect((await retry).data).toBe('original result');
    expect(effect).toHaveBeenCalledOnce();
  });

  it('rejects a historical response before recording its outcome or overwriting the current session',async()=>{
    const s=setup(); await s.manager.getHistory(); await s.runtime.initialize();
    const id=await s.runtime.start('old',{sessionId:s.manager.getSessionInfo().sessionId,messages:[],maxTurns:20,enableSkills:true});
    await s.runtime.wait(id);
    const record=s.runtime.get(id)!;
    record.status='waiting_for_approval';
    record.interactions.approval={id:'approval',operationId:'w',kind:'approval',question:'allow?'};
    await s.manager.clearHistory(); await s.manager.addMessage('user','new session');
    await expect(s.runtime.respond(id,'approval',{kind:'approved'})).rejects.toThrow('当前会话');
    expect(record.interactions.approval.outcome).toBeUndefined();
    await expect(s.runtime.cancel(id)).rejects.toThrow('当前会话');
    expect((await s.manager.getHistory())[0].content).toBe('new session');
  });

  it('tracks scoped child operations and isolates the root instruction queue',async()=>{
    const s=setup(); let complete!:(value:any)=>void;
    const effect=vi.fn(()=>new Promise<any>(resolve=>{complete=resolve;}));
    s.registry.register({name:'write',namespace:'obsidian',description:'',schema:z.object({}),metadata:{executionCategory:'write'},execute:effect});
    const controller=new RunController(new RunStore(s.platform),new EventBus(),s.manager,async(_prompt,context)=>{
      const root=context.runtime!, child=root.child('delegate').runtime;
      const record=controller.get(root.runId)!;
      record.instructions=[{id:'root-input',text:'root only',status:'queued'}];
      expect(await child.takeInstructions()).toEqual([]);
      await child.ackInstructions(['root-input']);
      expect((await root.takeInstructions()).map(i=>i.id)).toEqual(['root-input']);
      const result=await s.executor.execute('obsidian','write',{}, {operationId:'w',runtime:child,timeout:10});
      if(result.outcome==='unknown') throw new RunBlocked('unknown');
    });
    await s.manager.getHistory(); await controller.initialize();
    const id=await controller.start('child work',{sessionId:s.manager.getSessionInfo().sessionId,messages:[],maxTurns:20,enableSkills:true});
    await controller.wait(id);
    expect(controller.get(id)?.operations['delegate/w'].status).toBe('unknown');
    await expect(controller.reconcile(id,'delegate/w',null)).rejects.toThrow('实际执行');
    complete({success:true});
    await vi.waitFor(()=>expect(controller.get(id)?.operations['delegate/w'].status).toBe('finished'));
  });
});
