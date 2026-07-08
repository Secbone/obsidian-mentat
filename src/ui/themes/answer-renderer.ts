import { App, Component, MarkdownRenderer, sanitizeHTMLToDom } from 'obsidian';
import { MessageRenderer } from '../message-renderer';

export class AnswerRenderer {
  private app: App;
  private component: Component;
  private fallbackRenderer: MessageRenderer;

  constructor(app: App, component: Component) {
    this.app = app;
    this.component = component;
    this.fallbackRenderer = new MessageRenderer();
  }

  async renderFinalAnswer(markdown: string, container: HTMLElement): Promise<void> {
    container.empty();
    try {
      await MarkdownRenderer.render(
        this.app,
        markdown,
        container,
        '',
        this.component,
      );
    } catch (_e) {
      container.empty();
      container.appendChild(sanitizeHTMLToDom(this.fallbackRenderer.render(markdown)));
    }
  }

  renderFallback(markdown: string, container: HTMLElement): void {
    container.empty();
    container.appendChild(sanitizeHTMLToDom(this.fallbackRenderer.render(markdown)));
  }
}
