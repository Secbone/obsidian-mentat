// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { RunHistoryModal } from '../../src/ui/run-history-modal';

Object.assign(HTMLElement.prototype,{
  createEl(this:HTMLElement,tag:string,options:any={}){const el=document.createElement(tag);if(options.text)el.textContent=options.text;this.appendChild(el);return el;},
  createDiv(this:HTMLElement){const el=document.createElement('div');this.appendChild(el);return el;},
  empty(this:HTMLElement){this.replaceChildren();},
});

describe('Run history host port',()=>{
  it('paginates records and opens them through injected commands and navigation callbacks',async()=>{
    const records=Array.from({length:120},(_,index)=>({id:`run-${index}`,createdAt:index,status:'completed',prompt:`question ${index}`}));
    let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
    const order:string[]=[],host:any={app:{},runs:{list:()=>records,open:vi.fn(async()=>{await gate;order.push('open');})},
      inspect:vi.fn(),activateChat:vi.fn(async()=>{order.push('activate');}),refreshChat:vi.fn(async()=>{order.push('refresh');})};
    const modal=new RunHistoryModal(host),root=document.createElement('div');Object.assign(modal,{contentEl:root});
    modal.onOpen();
    const buttons=(text:string)=>Array.from(root.querySelectorAll('button')).filter(button=>button.textContent===text);
    expect(buttons('打开记录')).toHaveLength(50);
    buttons('下一页')[0].click();expect(buttons('打开记录')).toHaveLength(50);
    buttons('查看日志')[0].click();expect(host.inspect).toHaveBeenCalledWith('run-50');
    const open=buttons('打开记录')[0];open.click();open.click();expect(host.runs.open).toHaveBeenCalledOnce();expect(open.disabled).toBe(true);
    release();await vi.waitFor(()=>expect(host.refreshChat).toHaveBeenCalledOnce());
    expect(order).toEqual(['open','activate','refresh']);
    modal.onClose();expect(root.textContent).toBe('');
  });
});
