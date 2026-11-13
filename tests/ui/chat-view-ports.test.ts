// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
vi.mock('obsidian',async()=>{
  const fallback=await import('../utils/obsidian.mock');
  const base=await import('../__mocks__/obsidian');
  return {...fallback,...base,MarkdownRenderer:{render:async(_app:unknown,text:string,target:HTMLElement)=>{target.textContent=text;}}};
});
import { App } from 'obsidian';
import { ChatView } from '../../src/ui/chat-view';
import { EventBus } from '../../src/extensions/event-bus';
import type { RunAccess } from '../../src/contracts/run-access';
import type { RunRecord } from '../../src/runtime/types';
import type { DraftStore } from '../../src/storage/draft-store';

beforeAll(()=>{HTMLElement.prototype.scrollTo=vi.fn();});
afterEach(()=>{document.body.replaceChildren();vi.restoreAllMocks();});

describe('Chat view runtime port',()=>{
  it('renders, sends, steers and cancels through a fake RunAccess without a plugin controller',async()=>{
    const app=new App(),bus=new EventBus();
    let record:RunRecord|undefined;
    const runs:RunAccess={
      list:()=>record ? [record]:[],get:()=>record,getLiveState:()=>undefined,getDisplayMessages:()=>record?.messages || [],
      getWarnings:()=>[],hasUnsettledWork:()=>record?.status==='running',
      start:vi.fn(async(prompt,options)=>{
        record={version:1,id:'run-fake',sessionId:options.sessionId,prompt,agentId:'default-chat-agent',maxTurns:options.maxTurns,
          enableSkills:options.enableSkills,status:'running',createdAt:1,updatedAt:1,baseMessageCount:0,
          messages:[{role:'user',content:prompt,timestamp:1}],operations:{},interactions:{},events:[]};
        return record.id;
      }),
      steer:vi.fn(async()=>true),cancel:vi.fn(async()=>{if(record)record.status='cancelled';}),
      open:vi.fn(async()=>{}),resume:vi.fn(async()=>{}),respond:vi.fn(async()=>{}),reconcile:vi.fn(async()=>{}),
    };
    const drafts:DraftStore={load:async()=>null,save:async()=>{},clear:async()=>{},flush:async()=>{}};
    const plugin:any={app,eventBus:bus,manifest:{id:'mentat'},settings:{aiProviders:[],chatTheme:'terminal',skillsEnabled:true,maxTurns:20},
      chatManager:{getSessionInfo:()=>({sessionId:'s'}),getHistory:async()=>[],selectedFilesList:[]},chatOrchestrator:{},
      indexManager:{getStats:()=>({totalChunks:1})}};
    Object.defineProperty(plugin,'runController',{get:()=>{throw new Error('view crossed the runtime port');}});
    const view=new ChatView({app} as any,plugin,drafts,runs);document.body.appendChild(view.containerEl);
    try {
      await view.onOpen();
      const input=view.containerEl.querySelector('.mentat-composer-input')!;
      const send=view.containerEl.querySelector('.mentat-composer-wrapper > button') as HTMLButtonElement;
      input.textContent='new question';send.click();
      await vi.waitFor(()=>expect(runs.start).toHaveBeenCalledOnce());
      await vi.waitFor(()=>expect(send.textContent).toBe('补充指令'));
      expect(view.containerEl.textContent).toContain('new question');
      input.textContent='follow up';send.click();
      await vi.waitFor(()=>expect(runs.steer).toHaveBeenCalledWith('run-fake','follow up'));
      const stop=Array.from(view.containerEl.querySelectorAll('button')).find(button=>button.textContent==='停止任务')!;
      stop.click();await vi.waitFor(()=>expect(runs.cancel).toHaveBeenCalledWith('run-fake'));
      bus.emit({type:'run:changed',sessionId:'s',runId:'run-fake',agentId:'default-chat-agent',status:'cancelled'});
      await vi.waitFor(()=>expect(view.containerEl.querySelector('.mentat-chat-status')?.textContent).toContain('已停止'));
    } finally { await view.onClose(); }
  });
});
