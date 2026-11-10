// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
vi.mock('obsidian',async () => {
  const base = await import('../__mocks__/obsidian');
  return {...base,MarkdownRenderer:{render:vi.fn(async (_app:unknown,text:string,target:HTMLElement) => { target.textContent=text; })}};
});
import { MarkdownRenderer } from 'obsidian';
import { CardList } from '../../src/ui/chat-cards/card-list';
import { CardTheme } from '../../src/ui/chat-cards/theme';
import { MessageRenderer } from '../../src/ui/message-renderer';
import { SmartScroller } from '../../src/ui/themes/smart-scroller';
import { InputHandler } from '../../src/ui/chat-view/input-handler';
import type { ChatCard, ChatViewState } from '../../src/ui/chat-cards/types';

beforeAll(() => { HTMLElement.prototype.scrollTo = vi.fn(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });
const card = (overrides:Partial<ChatCard> = {}):ChatCard => ({id:'tool',kind:'tool',title:'read_note',timestamp:100,status:'running',detail:'parameters',...overrides});
const state = (cards:ChatCard[]):ChatViewState => ({cards,label:'准备就绪',busy:false,inputMode:'send',canCancel:false,cancelling:false});

describe('Stable card UI',() => {
  it('retains tool node identity and open details across status updates and sibling streaming',() => {
    const root = document.body.createDiv();
    const list = new CardList({} as any,root,new MessageRenderer(),async()=>{});
    list.render([card()]);
    const tool = root.firstElementChild!, details = tool.querySelector('details')!;
    const toggle = tool.querySelector<HTMLButtonElement>('header button')!;
    expect(toggle.getAttribute('aria-controls')).toBe(details.id);
    toggle.click(); expect(details.open).toBe(true); expect(toggle.getAttribute('aria-expanded')).toBe('true');
    list.render([card({status:'completed',detail:'result'}),card({id:'reply',kind:'reply',title:'回复',text:'streaming',streaming:true})]);
    expect(root.firstElementChild).toBe(tool); expect(tool.querySelector('details')).toBe(details); expect(details.open).toBe(true);
    expect(tool.getAttribute('data-status')).toBe('completed'); expect(details.textContent).toContain('result');
    expect(root.querySelectorAll('article')).toHaveLength(2);
    toggle.click(); expect(details.open).toBe(false); expect(toggle.textContent).toBe('查看详情');
    list.render([card({detail:undefined})]); expect(toggle.hidden).toBe(true);
    list.dispose();
  });
  it('retains question input and focus when an unrelated card changes',() => {
    const root = document.body.createDiv(), action=vi.fn(async()=>{});
    const list = new CardList({} as any,root,new MessageRenderer(),action);
    const question=card({id:'question',kind:'interaction',status:'waiting',interaction:{id:'q',operationId:'op',kind:'question',question:'Choose',requiresInput:true}});
    list.render([question,card()]);
    const input=root.querySelector('textarea')!; input.value='my draft'; input.focus();
    list.render([question,card({status:'completed'})]);
    expect(root.querySelector('textarea')).toBe(input); expect(input.value).toBe('my draft'); expect(document.activeElement).toBe(input);
    list.dispose();
  });
  it('prevents duplicate approvals while waiting for runtime acknowledgement',async()=>{
    let finish!:()=>void;
    const action=vi.fn(()=>new Promise<void>(resolve=>{finish=resolve;})), root=document.body.createDiv();
    const list=new CardList({} as any,root,new MessageRenderer(),action);
    list.render([card({kind:'interaction',status:'waiting',interaction:{id:'approval',operationId:'op',kind:'approval',question:'Allow?'}})]);
    const buttons=root.querySelectorAll<HTMLButtonElement>('.mentat-card-actions button'); buttons[0].click(); buttons[0].click(); buttons[1].click();
    expect(action).toHaveBeenCalledOnce(); expect(buttons[0].disabled).toBe(true); finish(); await Promise.resolve(); await Promise.resolve();
    expect(buttons[0].disabled).toBe(false); list.dispose();
  });
  it('ignores a late Markdown render after newer text has replaced it',async()=>{
    let finish!:()=>void;
    vi.mocked(MarkdownRenderer.render).mockImplementationOnce(async (_app,text,target)=>{await new Promise<void>(resolve=>{finish=resolve;}); target.textContent=text;});
    const root=document.body.createDiv(),list=new CardList({} as any,root,new MessageRenderer(),async()=>{});
    list.render([card({kind:'reply',text:'old text'})]);
    list.render([card({kind:'reply',text:'new prefix',streaming:true})]);
    finish(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(root.querySelector('.mentat-card-body')?.textContent).toBe('new prefix'); list.dispose();
  });
  it('uses a single aligned card structure for every content kind and paginates old history',()=>{
    vi.useFakeTimers();
    const root=document.body.createDiv(),theme=new CardTheme('terminal',{} as any,new MessageRenderer());
    const callbacks={onSend:vi.fn(),onCancel:vi.fn(),onClear:vi.fn(),onAddDocument:vi.fn(),onSettings:vi.fn(),onInspect:vi.fn(),onExportDiagnostics:vi.fn(),onCardAction:vi.fn(async()=>{})};
    theme.mount(root,callbacks);
    const cards=Array.from({length:220},(_,i)=>card({id:`card-${i}`,kind:i%2 ? 'user':'tool'}));
    theme.render(state(cards));
    expect(root.querySelectorAll('article.mentat-card')).toHaveLength(150);
    expect(root.querySelectorAll('.message-avatar,.term-timeline,.term-separator')).toHaveLength(0);
    (root.querySelector('.mentat-load-earlier') as HTMLButtonElement).click();
    expect(root.querySelectorAll('article.mentat-card')).toHaveLength(220);
    theme.updateInputState({mode:'blocked',charCount:3,documentCount:0});
    expect(theme.getSendButton().disabled).toBe(true); expect(theme.getInputArea().contentEditable).not.toBe('false');
    theme.unmount(); expect(vi.getTimerCount()).toBe(0);
  });
  it('rebinds input handlers without duplicate sends and does not send IME confirmation',()=>{
    const root=document.body.createDiv(),input=root.createDiv(),send=root.createEl('button');
    const onSend=vi.fn(),save=vi.fn(),handler=new InputHandler(input,send,{wrapper:root} as any,{onSend,onSteer:vi.fn(),getIsStreaming:()=>false,getSendWithCmdEnter:()=>false,
      getVaultMarkdownFiles:()=>[],updateInputInfoBar:vi.fn(),saveSessionDraft:save,loadSessionDraft:async()=>null,clearSessionDraft:vi.fn()});
    handler.setupListeners(); handler.setupListeners(); send.click(); expect(onSend).toHaveBeenCalledOnce();
    input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true})); expect(onSend).toHaveBeenCalledOnce();
    handler.dispose(); send.click(); expect(onSend).toHaveBeenCalledOnce();
  });
  it('keeps following layout-driven scroll changes but pauses for explicit user scrolling',()=>{
    const root=document.body.createDiv(),scroll=root.createDiv();
    Object.defineProperties(scroll,{scrollHeight:{value:2000},clientHeight:{value:300}});
    const follow=new SmartScroller();follow.attach(scroll,()=>{});
    scroll.dispatchEvent(new Event('scroll'));expect(follow.isFollowing()).toBe(true);
    scroll.dispatchEvent(new WheelEvent('wheel',{deltaY:-30}));expect(follow.isFollowing()).toBe(false);
    expect(root.querySelector('.smart-scroll-new-message')).not.toBeNull();
    follow.forceScrollToBottom();expect(follow.isFollowing()).toBe(true);
    expect(root.querySelector('.smart-scroll-new-message')).toBeNull();
    follow.detach();scroll.dispatchEvent(new WheelEvent('wheel',{deltaY:-30}));expect(follow.isFollowing()).toBe(true);
  });

  it('follows the newest output when an initially hidden Obsidian leaf becomes visible',()=>{
    let resize!:()=>void;const disconnect=vi.fn();
    vi.stubGlobal('ResizeObserver',class {constructor(callback:()=>void){resize=callback;} observe(){} disconnect=disconnect;});
    const root=document.body.createDiv(),theme=new CardTheme('bubble',{} as any,new MessageRenderer());
    theme.mount(root,{onSend:()=>{},onCancel:()=>{},onClear:()=>{},onAddDocument:()=>{},onSettings:()=>{},onInspect:()=>{},onExportDiagnostics:()=>{},onCardAction:async()=>{}});
    theme.render(state([card()]));vi.mocked(HTMLElement.prototype.scrollTo).mockClear();
    resize();expect(HTMLElement.prototype.scrollTo).toHaveBeenCalledOnce();
    theme.unmount();expect(disconnect).toHaveBeenCalledOnce();
  });

});
