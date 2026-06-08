import { vi } from 'vitest';

// Mock implementation of Obsidian API for testing
// This implementation uses real HTTP requests for integration tests
export const requestUrl = vi.fn(async (options: {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  throw?: boolean;
}) => {
  try {
    const response = await fetch(options.url, {
      method: options.method || 'GET',
      headers: options.headers,
      body: options.body,
    });

    const text = await response.text();

    return {
      status: response.status,
      text: text,
      headers: Object.fromEntries(response.headers.entries()),
      arrayBuffer: new ArrayBuffer(0),
      json: {}
    };
  } catch (error: any) {
    if (options.throw !== false) {
      throw error;
    }
    return undefined;
  }
});

export class App {}

export class Plugin {
  app: any;
  manifest: any;
  settings: any;

  async loadData() {
    return {};
  }

  async saveData(data: any) {
    return;
  }
}

export class TFile {
  path: string;
  name: string;
}

export class Vault {}

export class Notice {
  constructor(message: string) {}
}

export class Modal {
  constructor(app: any) {}
  open() {}
  close() {}
}

export class Setting {
  constructor(containerEl: any) {}
  setName(name: string) { return this; }
  setDesc(desc: string) { return this; }
  addText(cb: any) { return this; }
  addToggle(cb: any) { return this; }
  addButton(cb: any) { return this; }
  setValue(val: any) { return this; }
  setPlaceholder(val: any) { return this; }
  onChange(cb: any) { return this; }
}

export class PluginSettingTab {
  constructor(app: any, plugin: any) {}
}

export class SuggestModal {
  constructor(app: any) {}
}

export class ItemView {
  containerEl: any;
  app: any;
  constructor(leaf: any) {
    this.app = leaf?.app;
    if (typeof document !== 'undefined') {
      this.containerEl = document.createElement('div');
      // Append two child divs so that this.containerEl.children[1] is valid
      this.containerEl.appendChild(document.createElement('div'));
      this.containerEl.appendChild(document.createElement('div'));
    }
  }
}

export class WorkspaceLeaf {}

export const setIcon = vi.fn();

export class FileSystemAdapter {}

// Inject Obsidian's HTML element extensions in JSDOM environment
if (typeof window !== 'undefined') {
  const proto = Element.prototype as any;
  
  proto.createEl = function(tag: string, o?: any) {
    const el = document.createElement(tag);
    if (o) {
      if (typeof o === 'string') {
        el.className = o;
      } else {
        if (o.cls) el.className = o.cls;
        if (o.text) el.textContent = o.text;
        if (o.attr) {
          for (const k in o.attr) {
            el.setAttribute(k, o.attr[k]);
          }
        }
      }
    }
    this.appendChild(el);
    return el;
  };

  proto.createDiv = function(o?: any) {
    if (typeof o === 'string') {
      return this.createEl('div', { cls: o });
    }
    return this.createEl('div', o);
  };

  proto.createSpan = function(o?: any) {
    if (typeof o === 'string') {
      return this.createEl('span', { cls: o });
    }
    return this.createEl('span', o);
  };

  proto.addClass = function(cls: string) {
    this.classList.add(cls);
    return this;
  };

  proto.removeClass = function(cls: string) {
    this.classList.remove(cls);
    return this;
  };

  proto.hasClass = function(cls: string) {
    return this.classList.contains(cls);
  };

  proto.empty = function() {
    this.innerHTML = '';
    return this;
  };

  proto.setText = function(text: string) {
    this.textContent = text;
    return this;
  };
}

