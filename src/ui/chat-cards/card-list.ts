import { App, Component, MarkdownRenderer, Notice, sanitizeHTMLToDom } from 'obsidian';
import { MessageRenderer } from '../message-renderer';
import { CARD_LABELS } from './presenter';
import type { CardAction, ChatCard } from './types';

interface CardNode {
  card: ChatCard;
  el: HTMLElement;
  title: HTMLElement;
  status: HTMLElement;
  time: HTMLElement;
  body: HTMLElement;
  details: HTMLDetailsElement;
  detailToggle: HTMLButtonElement;
  detailText: HTMLElement;
  actions: HTMLElement;
  signature: string;
  textSignature: string;
  actionSignature: string;
  renderVersion: number;
  component?: Component;
}

/** Stable card shells preserve native disclosure, focus and selection across unrelated updates. */
export class CardList {
  private nodes = new Map<string,CardNode>();
  private pending = new Set<string>();
  constructor(private app: App, private container: HTMLElement, private renderer: MessageRenderer,
    private onAction: (card: ChatCard, action: CardAction, answer?: string) => Promise<void>,
    private applyLayout: (change: () => void) => void = change => change()) {}

  render(cards: ChatCard[]): void {
    const ids = new Set(cards.map(card => card.id));
    for (const [id,node] of this.nodes) if (!ids.has(id)) { this.release(node); this.nodes.delete(id); }
    let previous: HTMLElement | null = null;
    for (const card of cards) {
      let node = this.nodes.get(card.id);
      if (!node) { node = this.create(card); this.nodes.set(card.id,node); }
      const expected: Element | null = previous ? previous.nextElementSibling : this.container.firstElementChild;
      if (expected !== node.el) this.container.insertBefore(node.el,expected);
      previous = node.el;
      if (node.card === card && node.signature) continue;
      node.card = card;
      const signature = JSON.stringify(card);
      if (signature === node.signature) continue;
      node.signature = signature;
      node.el.dataset.kind = card.kind;
      node.el.dataset.status = card.status || '';
      node.el.classList.toggle('is-streaming',!!card.streaming);
      node.title.textContent = card.title;
      node.status.textContent = card.status ? CARD_LABELS[card.status] : '';
      node.time.textContent = card.durationMs !== undefined ? card.durationMs < 1000 ? `${Math.round(card.durationMs)} 毫秒` : `${(card.durationMs/1000).toFixed(1)} 秒` : card.timestamp ? new Date(card.timestamp).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) : '';
      if (['running','waiting'].includes(card.status || '')) node.time.dataset.started = String(card.timestamp);
      else delete node.time.dataset.started;
      const textSignature = `${card.kind}:${!!card.streaming}:${card.text || ''}`;
      if (node.textSignature !== textSignature) { node.textSignature = textSignature; this.renderText(node); }
      node.details.hidden = !card.detail;
      node.detailToggle.hidden = !card.detail;
      if (!card.detail) node.details.open = false;
      node.detailToggle.setAttribute('aria-expanded',String(node.details.open));
      node.detailToggle.textContent = node.details.open ? '收起详情' : '查看详情';
      if (node.detailText.textContent !== (card.detail || '')) node.detailText.textContent = card.detail || '';
      const actionSignature = JSON.stringify([card.interaction,card.canResume,card.canReconcile,card.path,card.runId,card.kind]);
      if (node.actionSignature !== actionSignature) { node.actionSignature = actionSignature; this.renderActions(node); }
    }
    this.updateClocks();
  }
  private create(card: ChatCard): CardNode {
    const el = document.createElement('article'); el.className = 'mentat-card'; el.dataset.cardId = card.id;
    const header = el.createEl('header',{cls:'mentat-card-header'});
    const title = header.createEl('span',{cls:'mentat-card-title'});
    const status = header.createEl('span',{cls:'mentat-card-status'});
    const time = header.createEl('span',{cls:'mentat-card-time'});
    const detailToggle = header.createEl('button',{cls:'mentat-card-detail-toggle',text:'查看详情',attr:{type:'button','aria-expanded':'false'}});
    const body = el.createDiv('mentat-card-body');
    const details = el.createEl('details',{cls:'mentat-card-details'});
    details.id = `mentat-card-details-${crypto.randomUUID()}`;
    detailToggle.setAttribute('aria-controls',details.id);
    details.createEl('summary',{text:'详情',attr:{hidden:''}});
    const syncDetails = () => {
      detailToggle.setAttribute('aria-expanded',String(details.open));
      detailToggle.textContent = details.open ? '收起详情' : '查看详情';
    };
    detailToggle.addEventListener('click',() => this.applyLayout(() => { details.open = !details.open; syncDetails(); }));
    details.addEventListener('toggle',syncDetails);
    const detailText = details.createEl('pre');
    const actions = el.createDiv('mentat-card-actions');
    return { card,el,title,status,time,body,details,detailToggle,detailText,actions,signature:'',textSignature:'',actionSignature:'',renderVersion:0 };
  }
  private renderText(node: CardNode): void {
    const version = ++node.renderVersion, card = node.card;
    node.component?.unload(); node.component = undefined;
    node.body.replaceChildren(); node.body.hidden = !card.text;
    if (!card.text) return;
    if (!['reply','process'].includes(card.kind) || card.streaming) {
      node.body.textContent = card.text; return;
    }
    // Render into a detached target so an older async Markdown render cannot overwrite newer text.
    const staging = document.createElement('div'); staging.className = 'markdown-rendered';
    const component = new Component(); component.load(); node.component = component;
    void MarkdownRenderer.render(this.app,card.text,staging,'',component).catch(() => {
      staging.replaceChildren(sanitizeHTMLToDom(this.renderer.render(card.text || '')));
    }).then(() => {
      if (node.renderVersion === version && this.nodes.get(card.id) === node) this.applyLayout(() => node.body.replaceChildren(staging));
      else component.unload();
    }).catch(() => { /* A detached/unloaded renderer cannot affect execution. */ });
  }
  private renderActions(node: CardNode): void {
    const card = node.card;
    node.actions.replaceChildren();
    const button = (label: string, action: CardAction, answer?: () => string, primary = false) => {
      const el = node.actions.createEl('button',{text:label,cls:primary ? 'mod-cta':''});
      el.addEventListener('click',() => { void this.act(node,action,answer?.()); });
      return el;
    };
    if (card.interaction) {
      if (card.interaction.kind === 'approval') {
        button('批准','approve',undefined,true); button('拒绝','reject');
      } else {
        for (const option of card.interaction.options || []) button(option,'answer',() => option);
        const input = node.actions.createEl('textarea',{attr:{placeholder:'输入回答…','aria-label':'回答问题',rows:'2'}});
        button('提交回答','answer',() => input.value,true);
      }
    }
    if (card.canResume) button('从检查点继续','resume',undefined,true);
    if (card.canReconcile) button('核对实际结果','reconcile',undefined,true);
    if (card.path) button('打开文件','open');
    node.details.querySelector('.mentat-tool-inspect')?.remove();
    if (card.runId && card.kind === 'tool') {
      const inspect = node.details.createEl('button',{cls:'mentat-tool-inspect',text:'在检查器中查看'});
      inspect.addEventListener('click',() => { void this.act(node,'inspect'); });
    } else if (card.runId && card.kind === 'system') button('运行详情','inspect');
    if (['user','reply','process'].includes(card.kind)) {
      const copy = node.actions.createEl('button',{text:'复制',attr:{'aria-label':'复制内容'}});
      copy.addEventListener('click',() => { void navigator.clipboard.writeText(node.card.text || '').then(() => { copy.textContent = '已复制'; },() => new Notice('复制失败，请手动选择文本。')); });
    }
    this.disable(node,this.pending.has(card.id));
  }
  private disable(node: CardNode, disabled: boolean): void {
    node.el.setAttribute('aria-busy',String(disabled));
    node.actions.querySelectorAll<HTMLButtonElement | HTMLTextAreaElement>('button,textarea').forEach(el => { el.disabled = disabled; });
  }
  private async act(node: CardNode, action: CardAction, answer?: string): Promise<void> {
    if (this.pending.has(node.card.id)) return;
    if (action === 'answer' && node.card.interaction?.requiresInput && !answer?.trim()) { new Notice('请先输入回答。'); return; }
    this.pending.add(node.card.id); this.disable(node,true);
    try { await this.onAction(node.card,action,answer); }
    catch (error) { new Notice(error instanceof Error ? error.message:String(error)); }
    finally { this.pending.delete(node.card.id); const current = this.nodes.get(node.card.id); if (current) this.disable(current,false); }
  }
  updateClocks(): void {
    for (const node of this.nodes.values()) if (node.time.dataset.started) node.time.textContent = `${Math.max(0,Math.floor((Date.now()-Number(node.time.dataset.started))/1000))} 秒`;
  }
  private release(node: CardNode): void { node.renderVersion++; node.component?.unload(); node.el.remove(); }
  dispose(): void { for (const node of this.nodes.values()) this.release(node); this.nodes.clear(); }
}
