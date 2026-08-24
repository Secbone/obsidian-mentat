import { describe, it, expect } from 'vitest';
import { Context } from '../../src/core/cordis';
import { MentatRoot } from '../../src/root';
import { DEFAULT_SETTINGS } from '../../src/settings/settings';
import { TFile } from 'obsidian';
import type MentatPlugin from '../../src/main';

function createMockPlugin(): MentatPlugin {
  const files = new Map<string, string>();
  const mkTFile = (path: string) => {
    const t = new TFile();
    Object.assign(t, { path, basename: path.split('/').pop()!.replace(/\.md$/, ''), extension: 'md', stat: { mtime: 1, ctime: 1, size: 1 }, parent: null });
    return t;
  };
  const vault = {
    configDir: 'vault/.obsidian',
    getMarkdownFiles: () => [...files.keys()].map(mkTFile),
    getAbstractFileByPath: (p: string) => (files.has(p) ? mkTFile(p) : null),
    read: async (f: { path: string }) => files.get(f.path) ?? '',
    create: async (p: string, c: string) => { files.set(p, c); },
    modify: async (f: { path: string }, c: string) => { files.set(f.path, c); },
    delete: async (f: { path: string }) => { files.delete(f.path); },
    rename: async () => {},
    adapter: { exists: async () => false, read: async () => '', write: async () => {}, remove: async () => {}, mkdir: async () => {}, list: async () => ({ files: [], folders: [] }) },
    on: () => ({ ref: 1 }), offref: () => {}, search: async () => [],
  };
  const metadataCache = { getFileCache: () => null, getBacklinksForFile: () => ({}), resolvedLinks: {} };
  const workspace = { getActiveFile: () => null, on: () => ({ ref: 1 }), offref: () => {} };
  return {
    app: { vault, metadataCache, workspace },
    manifest: { id: 'mentat' },
    settings: Object.assign(structuredClone(DEFAULT_SETTINGS), { aiProviders: [] }),
    loadData: async () => ({}), saveData: async () => {},
  } as unknown as MentatPlugin;
}

describe('L5 assembly: new-architecture layer mounts alongside legacy', () => {
  it('mounts all new-layer services on the context', async () => {
    const ctx = new Context();
    await ctx.plugin(MentatRoot, { plugin: createMockPlugin() });

    // New architecture services
    for (const name of [
      'llm', 'tools', 'knowledge', 'context-window', 'compaction',
      'agent-loop', 'modes', 'session', 'event-bridge', 'permissions',
      'mcp-server', 'delegated', 'extensions-v2',
    ]) {
      expect(ctx.get(name, true), `service ${name} should be provided`).toBeTruthy();
    }
    // Micro tools registered in the tools registry
    const tools = ctx.get<{ get(n: string): unknown; list(): { name: string }[] }>('tools', false)!;
    expect(tools.get('vault_read')).toBeTruthy();
    expect(tools.get('web_fetch')).toBeTruthy();

    // Legacy services still present (parallel mode)
    expect(ctx.get('platform', true)).toBeTruthy();      // legacy ObsidianAdapter
    expect(ctx.get('chat', true)).toBeTruthy();          // legacy ChatService
  });

  it('legacy UI-facing services remain available alongside new ones', async () => {
    const ctx = new Context();
    await ctx.plugin(MentatRoot, { plugin: createMockPlugin() });
    // Both event paths available: legacy eventBus + kernel event-bridge
    expect(ctx.get('eventBus', true)).toBeTruthy();
    expect(ctx.get('event-bridge', true)).toBeTruthy();
  });
});
