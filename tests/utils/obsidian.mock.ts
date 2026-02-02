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

export class Notice {
  constructor(message: string) {}
}
