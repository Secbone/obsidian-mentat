export class SmartScroller {
  private container: HTMLElement | null = null;
  private isUserScrolledUp = false;
  private scrollListener: (() => void) | null = null;
  private newMessageButton: HTMLElement | null = null;
  private onScrollToBottom: (() => void) | null = null;

  private static readonly SCROLL_THRESHOLD = 50;

  attach(container: HTMLElement, onScrollToBottom: () => void): void {
    this.detach();
    this.container = container;
    this.onScrollToBottom = onScrollToBottom;
    this.isUserScrolledUp = false;

    this.scrollListener = () => {
      if (!this.container) return;
      const { scrollTop, clientHeight, scrollHeight } = this.container;
      const wasScrolledUp = this.isUserScrolledUp;
      this.isUserScrolledUp = scrollTop + clientHeight < scrollHeight - SmartScroller.SCROLL_THRESHOLD;

      if (this.isUserScrolledUp && !wasScrolledUp) {
        this.showNewMessageButton();
      } else if (!this.isUserScrolledUp && wasScrolledUp) {
        this.hideNewMessageButton();
      }
    };

    this.container.addEventListener('scroll', this.scrollListener);
  }

  detach(): void {
    if (this.scrollListener && this.container) {
      this.container.removeEventListener('scroll', this.scrollListener);
    }
    this.hideNewMessageButton();
    this.container = null;
    this.scrollListener = null;
    this.onScrollToBottom = null;
    this.isUserScrolledUp = false;
  }

  scrollToBottom(): void {
    if (!this.container) return;
    if (this.isUserScrolledUp) return;

    this.container.scrollTo({
      top: this.container.scrollHeight,
      behavior: 'smooth'
    });
  }

  forceScrollToBottom(): void {
    if (!this.container) return;
    this.isUserScrolledUp = false;
    this.hideNewMessageButton();
    this.container.scrollTo({
      top: this.container.scrollHeight,
      behavior: 'smooth'
    });
  }

  isFollowing(): boolean {
    return !this.isUserScrolledUp;
  }

  private showNewMessageButton(): void {
    if (this.newMessageButton || !this.container) return;

    const parent = this.container.parentElement;
    if (!parent) return;

    this.newMessageButton = parent.createEl('button', {
      cls: 'smart-scroll-new-message',
      text: '↓ 新消息'
    });

    this.newMessageButton.addEventListener('click', () => {
      this.forceScrollToBottom();
      if (this.onScrollToBottom) this.onScrollToBottom();
    });
  }

  private hideNewMessageButton(): void {
    if (this.newMessageButton) {
      this.newMessageButton.remove();
      this.newMessageButton = null;
    }
  }
}
