// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { RunInspectorModal } from '../../src/ui/run-inspector-modal';
import { Observer } from '../../src/observability/observer';
import { LogStore } from '../../src/observability/log-store';
import { IndexedObservationQuery } from '../../src/observability/observation-query';
import { MemoryPlatformAdapter } from '../utils/memory-platform-adapter';

// Obsidian DOM helpers, backed by actual DOM nodes for interaction assertions.
Object.assign(HTMLElement.prototype, {
  createEl(this: HTMLElement, tag: string, options: any = {}) {
    const el = document.createElement(tag);
    if (options.text) el.textContent = options.text;
    if (options.cls) el.className = options.cls;
    for (const [key,value] of Object.entries(options.attr || {})) el.setAttribute(key,String(value));
    if (options.value !== undefined) (el as HTMLInputElement).value = options.value;
    if (options.type) el.setAttribute('type',options.type);
    this.appendChild(el); return el;
  },
  createDiv(this: HTMLElement) { const el = document.createElement('div'); this.appendChild(el); return el; },
  empty(this: HTMLElement) { this.replaceChildren(); },
  appendText(this: HTMLElement, value: string) { this.appendChild(document.createTextNode(value)); },
});

describe('Run inspector', () => {
  it('bounds each page, loads summaries on demand, and preserves an older page during live updates',async()=>{
    let emit!:(event:any)=>void;
    const record:any={id:'run-many',status:'running',sessionId:'s',events:Array.from({length:601},(_,index)=>({
      id:`run-many:${index+1}`,sequence:index+1,timestamp:index,type:'checkpoint',details:{index},
    }))};
    const runs={list:()=>[record],get:()=>record,getWarnings:()=>[]};
    const source:any={store:{folder:'logs',health:{writeError:'',readError:'',dropped:0,malformed:0}},
      snapshot:()=>[],query:async()=>[],sanitize:(event:any)=>event,subscribe:(listener:any)=>{emit=listener;return ()=>{};}};
    const observations=new IndexedObservationQuery(runs,source),summary=vi.spyOn(observations,'summary');
    const host:any={app:{},runs,observations,reportError:vi.fn(),writeLog:vi.fn(async()=>{})};
    const modal=new RunInspectorModal(host,record.id),root=document.createElement('div');Object.assign(modal,{contentEl:root});modal.onOpen();
    try {
      await vi.waitFor(()=>expect(root.querySelectorAll('details')).toHaveLength(200));
      expect(root.querySelectorAll('pre')).toHaveLength(0);expect(summary).not.toHaveBeenCalled();
      Array.from(root.querySelectorAll('button')).find(button=>button.textContent==='较早一页')!.click();
      expect(root.querySelector('details')?.dataset.eventId).toBe('run-many:401');
      record.events.push({id:'run-many:602',sequence:602,timestamp:602,type:'checkpoint'});
      emit({schemaVersion:1,eventId:'run-many:602',timestamp:602,sequence:602,name:'checkpoint',runId:record.id,sessionId:'s',level:'info',component:'runtime'});
      await vi.waitFor(()=>expect(root.textContent).toContain('602 条匹配'));
      expect(root.querySelectorAll('details')).toHaveLength(200);expect(root.querySelector('details')?.dataset.eventId).toBe('run-many:401');
      Array.from(root.querySelectorAll('button')).find(button=>button.textContent==='显示运行摘要')!.click();
      expect(summary).toHaveBeenCalledOnce();
    } finally {modal.onClose();observations.dispose();}
  });
  it('shows historical and live evidence, filters errors, exports safely and unsubscribes on close', async () => {
    const platform = new MemoryPlatformAdapter();
    const store = new LogStore({ exists:p => platform.exists(p), mkdir:p => platform.mkdir(p), read:p => platform.read(p), list:p => platform.list(p),
      remove:p => platform.delete(p), append:async(p,data) => platform.write(p,(await platform.exists(p) ? await platform.read(p) : '')+data) }, '.obsidian/plugins/mentat/logs');
    const observer = new Observer(store, () => ['secret-key']);
    const record = { id:'run-test', sessionId:'session', status:'failed', events: [
      { id:'run-test:1',sequence:1,type:'run:started',timestamp:1 },
      { id:'run-test:2',sequence:2,type:'model:failed',timestamp:2,details:{message:'secret-key failure',requestId:'req'} },
    ] } as any;
    const openLinkText = vi.fn(async () => {});
    const runs={list:(sessionId?:string) => sessionId && sessionId !== 'session' ? [] : [record],get:() => record,getWarnings:()=>[]};
    const observations=new IndexedObservationQuery(runs,observer);
    const host={app:{workspace:{openLinkText}},runs,observations,reportError:vi.fn(),writeLog:async(text:string)=>{
      await platform.write('export.md',text);await openLinkText();
    }} as any;
    const modal = new RunInspectorModal(host,'run-test');
    // Obsidian Modal owns an undocumented selection property at runtime.
    Object.assign(modal,{selection:null,app:host.app,contentEl:document.createElement('div')});
    modal.onOpen();
    const root = (modal as any).contentEl as HTMLElement;
    await vi.waitFor(() => expect(root.textContent).toContain('model:failed'));
    expect(root.textContent).not.toContain('secret-key');
    const check = root.querySelector('input[type=checkbox]') as HTMLInputElement;
    check.checked = true; check.dispatchEvent(new Event('change'));
    await vi.waitFor(()=>expect(root.querySelectorAll('details')).toHaveLength(1));
    root.querySelector('details')!.open = true;
    observer.error('tool:failed',new Error('tool exploded'),{runId:'run-test'});
    await vi.waitFor(() => expect(root.querySelectorAll('details')).toHaveLength(2));
    expect(root.querySelector('details[open]')?.textContent).toContain('model:failed');
    const search = root.querySelector('input[type=search]') as HTMLInputElement;
    search.value='req'; search.dispatchEvent(new Event('input'));
    await vi.waitFor(()=>expect(root.querySelectorAll('details')).toHaveLength(1));
    [...root.querySelectorAll('button')].find(b => b.textContent === '导出当前筛选')!.click();
    await vi.waitFor(() => expect(openLinkText).toHaveBeenCalledOnce());
    const exported = [...platform.files.entries()].find(([p]) => p.endsWith('.md'))![1].content;
    expect(exported).toContain('model:failed'); expect(exported).not.toContain('secret-key'); expect(exported).not.toContain('tool exploded');
    modal.onClose();observations.dispose();observer.event('after-close'); await store.drain();
    expect(root.textContent).toBe('');
  });
});
