// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { RunInspectorModal } from '../../src/ui/run-inspector-modal';
import { Observer } from '../../src/observability/observer';
import { LogStore } from '../../src/observability/log-store';
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
    const plugin = { platform, observer, runController:{list:(sessionId?:string) => sessionId && sessionId !== 'session' ? [] : [record],get:() => record},app:{workspace:{openLinkText}} } as any;
    const modal = new RunInspectorModal(plugin,'run-test');
    Object.assign(modal,{app:plugin.app,contentEl:document.createElement('div')});
    modal.onOpen();
    const root = (modal as any).contentEl as HTMLElement;
    await vi.waitFor(() => expect(root.textContent).toContain('model:failed'));
    expect(root.textContent).not.toContain('secret-key');
    const check = root.querySelector('input[type=checkbox]') as HTMLInputElement;
    check.checked = true; check.dispatchEvent(new Event('change'));
    expect(root.querySelectorAll('details')).toHaveLength(1);
    root.querySelector('details')!.open = true;
    observer.error('tool:failed',new Error('tool exploded'),{runId:'run-test'});
    await vi.waitFor(() => expect(root.querySelectorAll('details')).toHaveLength(2));
    expect(root.querySelector('details[open]')?.textContent).toContain('model:failed');
    const search = root.querySelector('input[type=search]') as HTMLInputElement;
    search.value='req'; search.dispatchEvent(new Event('input'));
    expect(root.querySelectorAll('details')).toHaveLength(1);
    [...root.querySelectorAll('button')].find(b => b.textContent === '导出当前筛选')!.click();
    await vi.waitFor(() => expect(openLinkText).toHaveBeenCalledOnce());
    const exported = [...platform.files.entries()].find(([p]) => p.endsWith('.md'))![1].content;
    expect(exported).toContain('model:failed'); expect(exported).not.toContain('secret-key'); expect(exported).not.toContain('tool exploded');
    modal.onClose(); observer.event('after-close'); await store.drain();
    expect(root.textContent).toBe('');
  });
});
