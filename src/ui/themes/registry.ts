import { ChatTheme, ThemeCallbacks } from './types';

export class ThemeRegistry {
  private factories: Map<string, () => ChatTheme> = new Map();
  private current: ChatTheme | null = null;
  private currentId: string;
  private container: HTMLElement | null = null;
  private callbacks: ThemeCallbacks | null = null;

  constructor(defaultThemeId: string) {
    this.currentId = defaultThemeId;
  }

  register(id: string, factory: () => ChatTheme): void {
    this.factories.set(id, factory);
  }

  init(container: HTMLElement, callbacks: ThemeCallbacks): void {
    this.container = container;
    this.callbacks = callbacks;
    this.mountCurrent();
  }

  switchTo(id: string): void {
    if (id === this.currentId && this.current) return;
    if (!this.factories.has(id)) return;

    this.unmountCurrent();
    this.currentId = id;
    this.mountCurrent();
  }

  getCurrent(): ChatTheme {
    if (!this.current) {
      this.current = this.createTheme(this.currentId);
    }
    return this.current;
  }

  getCurrentId(): string {
    return this.currentId;
  }

  list(): Array<{ id: string; name: string; description: string }> {
    const result: Array<{ id: string; name: string; description: string }> = [];
    for (const [id, factory] of this.factories) {
      const theme = factory();
      result.push({ id, name: theme.name, description: theme.description });
    }
    return result;
  }

  dispose(): void {
    this.unmountCurrent();
    this.container = null;
    this.callbacks = null;
  }

  private mountCurrent(): void {
    if (!this.container || !this.callbacks) return;
    this.current = this.createTheme(this.currentId);
    this.current.mount(this.container, this.callbacks);
  }

  private unmountCurrent(): void {
    if (this.current) {
      this.current.unmount();
      this.current = null;
    }
  }

  private createTheme(id: string): ChatTheme {
    const factory = this.factories.get(id);
    if (!factory) {
      const fallback = this.factories.values().next().value;
      if (fallback) return fallback();
      throw new Error(`No theme registered with id "${id}" and no fallback available`);
    }
    return factory();
  }
}
