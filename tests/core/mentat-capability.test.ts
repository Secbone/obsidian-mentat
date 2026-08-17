import { describe, it, expect } from 'vitest';
import { Context } from '../../src/core/cordis';
import { SettingsService, PlatformService } from '../../src/services';
import { AIRouterService } from '../../src/providers/ai-router.service';
import { IndexingService } from '../../src/indexing/indexing.service';
import { DEFAULT_SETTINGS } from '../../src/settings/settings';
import type MentatPlugin from '../../src/main';

function createMockPlugin(): MentatPlugin {
  const adapter = {
    exists: async () => false,
    read: async () => '',
    write: async () => {},
    remove: async () => {},
    mkdir: async () => {},
    list: async () => ({ files: [] as string[], folders: [] as string[] }),
  };
  const app = {
    vault: {
      configDir: 'vault/.obsidian',
      getMarkdownFiles: () => [],
      getAbstractFileByPath: () => null,
      read: async () => '',
      adapter,
    },
    metadataCache: { getFileCache: () => null },
    workspace: { getActiveFile: () => null },
  } as never;
  return {
    app,
    manifest: { id: 'mentat' },
    settings: structuredClone(DEFAULT_SETTINGS),
    loadData: async () => ({}),
    saveData: async () => {},
  } as unknown as MentatPlugin;
}

describe('Mentat capability services (M3)', () => {
  it('mounts aiRouter and indexing with their inject chain satisfied', async () => {
    const ctx = new Context();
    const plugin = createMockPlugin();
    ctx.provide('mentatPlugin', plugin);

    await ctx.plugin(SettingsService);
    await ctx.plugin(PlatformService);
    await ctx.plugin(AIRouterService);
    await ctx.plugin(IndexingService);

    expect(ctx.get('aiRouter', false)).toBeTruthy();
    expect(ctx.get('indexing', false)).toBeTruthy();
    expect(plugin.aiRouter).toBe(ctx.get('aiRouter', false));
    expect(plugin.indexManager).toBe(ctx.get('indexing', false));
  });

  it('reactively activates indexing once aiRouter appears (out-of-order mount)', async () => {
    const ctx = new Context();
    const plugin = createMockPlugin();
    ctx.provide('mentatPlugin', plugin);
    await ctx.plugin(SettingsService);
    await ctx.plugin(PlatformService);

    // Mount indexing BEFORE the router: it must stay pending, then activate
    // reactively when the router is provided.
    const indexingFiber = ctx.plugin(IndexingService);
    await new Promise((r) => setTimeout(r, 5));
    expect(ctx.get('indexing', false)).toBeUndefined();

    await ctx.plugin(AIRouterService);
    await new Promise((r) => setTimeout(r, 5));
    expect(ctx.get('indexing', false)).toBeTruthy();
    void indexingFiber;
  });
});
