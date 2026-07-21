import { ChatTheme, ThemeCallbacks } from './types';

class ThemeMetadata {
  constructor(
    readonly id: string,
    readonly name: string,
    readonly description: string,
    readonly factory: () => ChatTheme,
  ) {}
}

export class ThemeRegistry {
  private themes: Map<string, ThemeMetadata> = new Map();
  private current: ChatTheme | null = null;
  private currentId: string;
  private container: HTMLElement | null = null;
  private callbacks: ThemeCallbacks | null = null;

  constructor(defaultThemeId: string) {
    this.currentId = defaultThemeId;
  }

  register(id: string, name: string, description: string, factory: () => ChatTheme): void {
    this.themes.set(id, new ThemeMetadata(id, name, description, factory));
  }

  init(container: HTMLElement, callbacks: ThemeCallbacks): void {
    this.container = container;
    this.callbacks = callbacks;
    this.mountCurrent();
  }

  switchTo(id: string): void {
    if (id === this.currentId && this.current) return;
    if (!this.themes.has(id)) return;

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
    for (const meta of this.themes.values()) {
      result.push({ id: meta.id, name: meta.name, description: meta.description });
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
    const meta = this.themes.get(id);
    if (!meta) {
      const fallback = this.themes.values().next().value;
      if (fallback) return fallback.factory();
      throw new Error(`No theme registered with id "${id}" and no fallback available`);
    }
    return meta.factory();
  }
}
