/** Follow new output until the user explicitly scrolls or navigates away. */
export class SmartScroller {
  private container: HTMLElement | null = null;
  private isUserScrolledUp = false;
  private controller?: AbortController;
  private newMessageButton: HTMLElement | null = null;
  private onScrollToBottom: (() => void) | null = null;
  private intentUntil = 0;
  private static readonly SCROLL_THRESHOLD = 50;

  attach(container: HTMLElement, onScrollToBottom: () => void): void {
    this.detach(); this.container = container; this.onScrollToBottom = onScrollToBottom;
    this.controller = new AbortController();
    const options = {signal:this.controller.signal};
    const intent = () => { this.intentUntil = Date.now()+1000; };
    container.addEventListener('wheel',event => {
      intent(); if (event.deltaY < 0) this.pause();
    },{...options,passive:true});
    container.addEventListener('pointerdown',intent,options);
    container.addEventListener('pointermove',event => { if (event.buttons) intent(); },options);
    container.addEventListener('keydown',event => {
      if ((event.target as HTMLElement).closest('textarea,input,[contenteditable=true]')) return;
      if (['PageUp','PageDown','Home','End','ArrowUp','ArrowDown'].includes(event.key)) {
        intent(); if (['PageUp','Home','ArrowUp'].includes(event.key)) this.pause();
      }
    },options);
    container.addEventListener('scroll',() => {
      const bottom = container.scrollTop+container.clientHeight >= container.scrollHeight-SmartScroller.SCROLL_THRESHOLD;
      if (bottom) { this.isUserScrolledUp = false; this.hideNewMessageButton(); }
      else if (Date.now() <= this.intentUntil) this.pause();
    },options);
  }
  private pause(): void { this.isUserScrolledUp = true; this.showNewMessageButton(); }
  detach(): void {
    this.controller?.abort(); this.controller = undefined; this.hideNewMessageButton();
    this.container = null; this.onScrollToBottom = null; this.isUserScrolledUp = false; this.intentUntil = 0;
  }
  scrollToBottom(): void {
    if (!this.container || this.isUserScrolledUp) return;
    this.container.scrollTo({top:this.container.scrollHeight,behavior:'auto'});
  }
  forceScrollToBottom(): void {
    if (!this.container) return;
    this.isUserScrolledUp = false; this.intentUntil = 0; this.hideNewMessageButton();
    this.container.scrollTo({top:this.container.scrollHeight,behavior:'auto'});
  }
  isFollowing(): boolean { return !this.isUserScrolledUp; }
  pauseFollowing(): void { this.pause(); }
  private showNewMessageButton(): void {
    if (this.newMessageButton || !this.container?.parentElement) return;
    this.newMessageButton = this.container.parentElement.createEl('button',{cls:'smart-scroll-new-message',text:'↓ 回到最新'});
    this.newMessageButton.addEventListener('click',() => { this.forceScrollToBottom(); this.onScrollToBottom?.(); });
  }
  private hideNewMessageButton(): void { this.newMessageButton?.remove(); this.newMessageButton = null; }
}
