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
  constructor(leaf: any) {}
}

export class WorkspaceLeaf {}

export const setIcon = vi.fn();

export class FileSystemAdapter {}
