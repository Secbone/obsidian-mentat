import { App, setIcon } from 'obsidian';
import type { MessageRenderer } from '../message-renderer';
import type { ChatTheme, InputAreaElements, InputState, ThemeCallbacks } from '../themes/types';
import type { ChatViewState } from './types';
import { CardList } from './card-list';
import { SmartScroller } from '../themes/smart-scroller';

/** Both existing appearance settings share the same cards, controls and lifecycle. */
export class CardTheme implements ChatTheme {
  readonly name = '卡片时间线';
  readonly description = '单列卡片与分段彩色边框';
  private root!: HTMLElement;
  private messages!: HTMLElement;
  private cardContainer!: HTMLElement;
  private loadEarlier!: HTMLButtonElement;
  private loadLatest!: HTMLButtonElement;
  private visibleStart?: number;
  private visibleEnd?: number;
  private browsingHistory = false;
  private firstCardId?: string;
  private status!: HTMLElement;
  private elapsed!: HTMLElement;
  private stop!: HTMLButtonElement;
  private clear!: HTMLButtonElement;
  private els!: InputAreaElements;
  private list?: CardList;
  private scroller = new SmartScroller();
  private resizeObserver?: ResizeObserver;
  private clock?: ReturnType<typeof setInterval>;
  private state?: ChatViewState;
  constructor(readonly id: string, private app: App, private renderer: MessageRenderer, private preset = 'green') {}
  mount(container: HTMLElement, callbacks: ThemeCallbacks): void {
    const content = container.children[1] as HTMLElement || container;
    content.classList.add('mentat-chat-host');
    content.replaceChildren();
    this.root = content.createDiv('mentat-chat-shell'); this.root.dataset.appearance = this.id;
    this.updatePreset(this.preset);
    const header = this.root.createEl('header',{cls:'mentat-chat-header'});
    header.createEl('strong',{text:'Mentat'});
    const actions = header.createDiv('mentat-chat-header-actions');
    const iconButton = (parent: HTMLElement, label: string, icon: string, callback: () => void) => {
      const button = parent.createEl('button',{cls:'mentat-chat-icon',attr:{'aria-label':label,title:label}});
      setIcon(button,icon); button.addEventListener('click',callback); return button;
    };
    iconButton(actions,'运行检查器','activity',callbacks.onInspect);
    const menu = actions.createEl('details',{cls:'mentat-chat-menu'});
    menu.createEl('summary',{text:'更多',attr:{'aria-label':'更多操作'}});
    const menuBody = menu.createDiv('mentat-chat-menu-body');
    const menuButton = (label: string, callback: () => void) => {
      const button = menuBody.createEl('button',{text:label}); button.addEventListener('click',() => { menu.open = false; callback(); }); return button;
    };
    menuButton('设置',callbacks.onSettings); menuButton('导出诊断',callbacks.onExportDiagnostics);
    this.clear = menuButton('新建会话',callbacks.onClear);
    const statusBar = this.root.createDiv('mentat-chat-status'); statusBar.setAttribute('role','status'); statusBar.setAttribute('aria-live','polite');
    this.status = statusBar.createEl('span'); this.elapsed = statusBar.createEl('span',{cls:'mentat-chat-elapsed'});
    this.stop = statusBar.createEl('button',{text:'停止任务'}); this.stop.hidden = true; this.stop.addEventListener('click',callbacks.onCancel);
    const documents = this.root.createEl('details',{cls:'mentat-chat-context'});
    documents.createEl('summary',{text:'引用文件'});
    const docControls = documents.createDiv('mentat-chat-context-controls');
    const add = docControls.createEl('button',{text:'添加文件'}); add.addEventListener('click',callbacks.onAddDocument);
    const docList = documents.createDiv('mentat-chat-document-list');
    this.messages = this.root.createDiv('mentat-card-scroll'); this.messages.setAttribute('aria-label','会话时间线');
    this.loadEarlier = this.messages.createEl('button',{cls:'mentat-load-earlier',text:'显示较早的记录'});
    this.loadEarlier.hidden = true;
    this.cardContainer = this.messages.createDiv('mentat-card-list');
    this.loadLatest = this.messages.createEl('button',{cls:'mentat-load-earlier',text:'回到最新记录'});
    this.loadLatest.hidden = true;
    const latest = () => {
      this.browsingHistory = false;this.visibleStart=undefined;this.visibleEnd=undefined;
      this.scroller.forceScrollToBottom();if (this.state) this.render(this.state);
    };
    this.loadLatest.addEventListener('click',latest);
    this.loadEarlier.addEventListener('click',() => {
      this.browsingHistory = true;this.scroller.pauseFollowing();
      this.visibleStart = Math.max(0,(this.visibleStart || 0)-100);
      this.visibleEnd = Math.min(this.state?.cards.length || 0,this.visibleStart+250);
      if (this.state) this.render(this.state);
    });
    this.list = new CardList(this.app,this.cardContainer,this.renderer,callbacks.onCardAction,change => this.preserveLayout(change));
    this.scroller.attach(this.messages,latest);
    // Obsidian mounts a leaf before revealing it; its first layout may have zero height.
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.scroller.scrollToBottom());
      this.resizeObserver.observe(this.messages);
    }
    const inputContainer = this.root.createDiv('mentat-composer');
    const inputWrapper = inputContainer.createDiv('mentat-composer-wrapper');
    const input = inputWrapper.createEl('div',{cls:'mentat-composer-input',attr:{contenteditable:'true',role:'textbox','aria-multiline':'true','aria-label':'输入消息','data-placeholder':'输入消息…'}});
    const send = inputWrapper.createEl('button',{text:'发送'});
    const footer = inputContainer.createDiv('mentat-composer-footer');
    const charCount = footer.createEl('span',{text:'0 字'}), badges = footer.createEl('span');
    this.els = {container:inputContainer,wrapper:inputWrapper,inputArea:input,sendButton:send,charCountEl:charCount,badgesEl:badges,documentPanel:documents,documentList:docList,addDocumentButton:add};
    this.clock = setInterval(() => { this.list?.updateClocks(); this.updateElapsed(); },1000);
  }
  render(state: ChatViewState): void {
    this.state = state;
    if (this.firstCardId !== state.cards[0]?.id) { this.visibleStart = undefined;this.visibleEnd=undefined;this.browsingHistory=false;this.firstCardId = state.cards[0]?.id; }
    this.visibleStart ??= Math.max(0,state.cards.length-150);
    if (!this.browsingHistory && this.scroller.isFollowing()) this.visibleStart=Math.max(0,state.cards.length-150);
    this.visibleEnd=this.browsingHistory ? Math.min(state.cards.length,this.visibleEnd ?? this.visibleStart+250):Math.min(state.cards.length,this.visibleStart+300);
    const start=this.visibleStart,end=this.visibleEnd;
    this.preserveLayout(() => {
      this.loadEarlier.hidden = !start;
      this.loadEarlier.textContent = `显示较早的记录（剩余 ${start} 条）`;
      this.loadLatest.hidden = end >= state.cards.length;
      this.list?.render(state.cards.slice(start,end));
    });
    this.root.dataset.runStatus = state.runStatus || 'idle';
    if (this.status.textContent !== state.label) this.status.textContent = state.label;
    this.stop.hidden = !state.canCancel; this.stop.disabled = state.cancelling;
    this.stop.textContent = state.cancelling ? '正在停止…':'停止任务';
    this.clear.disabled = state.busy;
    this.updateElapsed();
  }
  private preserveLayout(change: () => void): void {
    const following = this.scroller.isFollowing();
    const top = this.messages.getBoundingClientRect().top;
    const anchor = following ? undefined : Array.from(this.cardContainer.children).find(el => el.getBoundingClientRect().bottom > top);
    const offset = anchor?.getBoundingClientRect().top;
    change();
    if (following) this.scroller.scrollToBottom();
    else if (anchor?.isConnected && offset !== undefined) this.messages.scrollTop += anchor.getBoundingClientRect().top-offset;
  }
  private updateElapsed(): void {
    this.elapsed.textContent = this.state?.startedAt ? `已持续 ${Math.max(0,Math.floor((Date.now()-this.state.startedAt)/1000))} 秒` : '';
  }
  updateInputState(state: InputState): void {
    if (!this.els) return;
    const blocked = state.mode === 'blocked';
    this.els.sendButton.disabled = blocked;
    this.els.sendButton.textContent = state.mode === 'steer' ? '补充指令':blocked ? '等待处理':'发送';
    this.els.sendButton.setAttribute('aria-label',this.els.sendButton.textContent);
    this.els.inputArea.dataset.placeholder = state.mode === 'steer' ? '补充指令将在下个执行边界生效…' : blocked ? '先处理待办；可以继续编辑草稿…':'输入消息…';
    this.els.charCountEl.textContent = `${state.charCount} 字`;
    this.els.badgesEl.textContent = state.documentCount ? `${state.documentCount} 个引用文件`:'';
    const summary = this.els.documentPanel.querySelector('summary'); if (summary) summary.textContent = state.documentCount ? `引用文件 · ${state.documentCount}`:'引用文件';
  }
  updatePreset(preset: string): void { this.preset = preset; if (this.root) this.root.dataset.preset = preset; }
  scrollToBottom(): void { this.scroller.forceScrollToBottom(); }
  getInputAreaElements(): InputAreaElements { return this.els; }
  getMessagesContainer(): HTMLElement { return this.messages; }
  getInputArea(): HTMLDivElement { return this.els.inputArea; }
  getSendButton(): HTMLButtonElement { return this.els.sendButton; }
  unmount(): void {
    if (this.clock) clearInterval(this.clock);
    this.resizeObserver?.disconnect(); this.resizeObserver = undefined;
    this.list?.dispose(); this.list = undefined; this.scroller.detach(); this.root?.parentElement?.classList.remove('mentat-chat-host'); this.root?.remove();
  }
}
