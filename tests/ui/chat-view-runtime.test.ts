// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
vi.mock('obsidian',async()=>{
  const fallback=await import('../utils/obsidian.mock');
  const base=await import('../__mocks__/obsidian');
  return {...fallback,...base,MarkdownRenderer:{render:async(_app:unknown,text:string,target:HTMLElement)=>{target.textContent=text;}}};
});
import { App } from 'obsidian';
import { ChatView } from '../../src/ui/chat-view';
import { RunController } from '../../src/runtime/run-controller';
import { RunStore } from '../../src/runtime/run-store';
import { ChatManager } from '../../src/chat/chat-manager';
import { EventBus } from '../../src/extensions/event-bus';
import { MemoryPlatformAdapter } from '../utils/memory-platform-adapter';
import type { AgentContext } from '../../src/agents/agent-types';

beforeAll(()=>{HTMLElement.prototype.scrollTo=vi.fn();});
const cleanups:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0)) await cleanup(); document.body.replaceChildren();vi.restoreAllMocks();});
async function fixture(execute:(prompt:string,context:AgentContext)=>Promise<void>) {
  const platform=new MemoryPlatformAdapter(),bus=new EventBus(),app=new App();
  const plugin:any={platform,eventBus:bus,app,manifest:{id:'mentat'},settings:{aiProviders:[],chatTheme:'terminal',skillsEnabled:true,maxTurns:20},
    loadData:async()=>({}),saveData:async()=>{},indexManager:{getStats:()=>({totalChunks:1})},chatOrchestrator:{}};
  const manager=new ChatManager(plugin);plugin.chatManager=manager; await manager.getHistory();
  const runtime=new RunController(new RunStore(platform),bus,manager,execute);plugin.runController=runtime;await runtime.initialize();
  cleanups.push(()=>runtime.dispose());
  const open=async()=>{const view=new ChatView({app} as any,plugin);document.body.appendChild(view.containerEl);await view.onOpen();cleanups.unshift(()=>view.onClose());return view;};
  const start=()=>runtime.start('question',{sessionId:manager.getSessionInfo().sessionId,messages:[],maxTurns:20,enableSkills:true});
  return {plugin,runtime,manager,bus,open,start};
}

describe('Card view with plugin-owned runtime',()=>{
  it('reattaches to the complete live prefix without replay and finalizes the same reply card',async()=>{
    let finish!:()=>void;
    const gate=new Promise<void>(resolve=>{finish=resolve;});
    let executions=0;
    const s=await fixture(async(prompt,context)=>{
      executions++;
      context.transcript=[...context.messages,{role:'user',content:prompt,timestamp:100}];
      await context.onCheckpoint?.(context.transcript);
      const identity={runId:context.runId,sessionId:context.sessionId,agentId:'default-chat-agent'};
      s.bus.emit({type:'message:start',role:'assistant',...identity});
      s.bus.emit({type:'message:update',delta:'prefix ',accumulatedText:'prefix ',...identity});
      s.bus.emit({type:'message:update',delta:'suffix',accumulatedText:'prefix suffix',...identity});
      await gate;
      context.transcript.push({role:'assistant',content:'prefix suffix',timestamp:200});
      await context.onCheckpoint?.(context.transcript);
      // agent:end is advisory; the controller has not committed completion yet.
      s.bus.emit({type:'agent:end',messages:context.transcript,...identity});
    });
    const id=await s.start();await vi.waitFor(()=>expect(s.runtime.getLiveState(id)?.message?.content).toBe('prefix suffix'));
    const a=await s.open();expect(a.containerEl.textContent).toContain('prefix suffix');await a.onClose();a.containerEl.remove();
    const b=await s.open(),before=b.containerEl.querySelector('[data-kind=reply]');
    expect(before?.textContent).toContain('prefix suffix');expect(executions).toBe(1);
    s.bus.emit({type:'message:update',delta:'SHOULD NOT APPEAR',sessionId:s.manager.getSessionInfo().sessionId,runId:'stale',agentId:'default-chat-agent'});
    finish();await s.runtime.wait(id);
    await vi.waitFor(()=>expect(b.containerEl.querySelector('.mentat-chat-status')?.textContent).toContain('已完成'));
    expect(b.containerEl.querySelector('[data-kind=reply]')).toBe(before);
    expect(b.containerEl.querySelectorAll('[data-kind=reply]')).toHaveLength(1);
    expect(b.containerEl.textContent).not.toContain('SHOULD NOT APPEAR');
  });
  it('reopens an approval inline, disables normal send and applies approval once',async()=>{
    let effects=0;
    const s=await fixture(async(_prompt,context)=>{
      const outcome=await context.runtime!.interact({id:'approval',operationId:'write',kind:'approval',question:'允许写入？',fingerprint:'same'});
      if(outcome.kind==='approved')effects++;
    });
    const id=await s.start();await s.runtime.wait(id);
    const view=await s.open();
    expect(view.containerEl.querySelector('.mentat-chat-status')?.textContent).toContain('等待你的授权');
    expect((view.containerEl.querySelector('.mentat-composer-wrapper > button') as HTMLButtonElement).disabled).toBe(true);
    const approve=Array.from(view.containerEl.querySelectorAll<HTMLButtonElement>('[data-kind=interaction] button')).find(b=>b.textContent==='批准')!;
    approve.click();approve.click();await vi.waitFor(()=>expect(s.runtime.get(id)?.status).toBe('completed'));
    expect(effects).toBe(1);expect(s.runtime.get(id)?.interactions.approval.outcome?.kind).toBe('approved');
  });
  it('keeps the input draft when starting a run fails',async()=>{
    const s=await fixture(async()=>{}),view=await s.open();
    vi.spyOn(s.runtime,'start').mockRejectedValueOnce(new Error('checkpoint disk full'));
    const input=view.containerEl.querySelector('.mentat-composer-input')!;input.textContent='keep this draft';
    (view.containerEl.querySelector('.mentat-composer-wrapper > button') as HTMLButtonElement).click();
    await vi.waitFor(()=>expect(view.containerEl.textContent).toContain('checkpoint disk full'));
    expect(input.textContent).toBe('keep this draft');expect(s.runtime.list()).toHaveLength(0);
  });
});
