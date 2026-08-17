import { describe, it, expect } from 'vitest';
import { Context } from '../../src/core/cordis';
import { MentatRoot } from '../../src/root';
import { DEFAULT_SETTINGS } from '../../src/settings/settings';
import type MentatPlugin from '../../src/main';

/** Minimal mock of the Obsidian `App` surface used by Mentat's adapter. */
function createMockApp() {
  const adapter = {
    exists: async () => false,
    read: async () => '',
    write: async () => {},
    remove: async () => {},
    mkdir: async () => {},
    list: async () => ({ files: [] as string[], folders: [] as string[] }),
  };
  return {
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
}

/** Minimal mock of the Obsidian `Plugin` surface used by the host assembly. */
function createMockPlugin(): MentatPlugin {
  const app = createMockApp();
  return {
    app,
    manifest: { id: 'mentat', name: 'Mentat', version: '0.3.9', minAppVersion: '1.8.0' },
    settings: structuredClone(DEFAULT_SETTINGS),
    loadData: async () => ({}),
    saveData: async () => {},
  } as unknown as MentatPlugin;
}

describe('MentatRoot host assembly (M1)', () => {
  it('is a plugin object with no required inject', () => {
    expect(MentatRoot.inject).toEqual([]);
    expect(typeof MentatRoot.apply).toBe('function');
  });

  it('mounts and provides the host services on the unified context', async () => {
    const plugin = createMockPlugin();
    const ctx = new Context();
    await ctx.plugin(MentatRoot, { plugin });

    expect(ctx.get('mentatPlugin')).toBe(plugin);
    expect(ctx.get('settings')).toBe(plugin.settings);
    expect(ctx.get('platform')).toBeTruthy();
    expect(ctx.get('aiRouter')).toBeTruthy();
    expect(ctx.get('indexing')).toBeTruthy();
    expect(ctx.get('eventBus')).toBeTruthy();
    expect(ctx.get('chat')).toBeTruthy();
    expect(ctx.get('agents')).toBeTruthy();
    expect(ctx.get('extensions')).toBeTruthy();
    expect(ctx.get('openCode')).toBeTruthy();

    // Plugin field references are kept for existing UI/command code.
    expect(plugin.platform).toBeTruthy();
    expect(plugin.aiRouter).toBeTruthy();
    expect(plugin.chatOrchestrator).toBeTruthy();
    expect(plugin.extensionManager).toBeTruthy();
  });

  it('recovers every host registration when the context fiber unloads', async () => {
    const plugin = createMockPlugin();
    const ctx = new Context();
    await ctx.plugin(MentatRoot, { plugin });

    expect(ctx.get('chat', false)).toBeTruthy();
    await ctx.fiber.dispose();

    for (const name of ['settings', 'platform', 'aiRouter', 'indexing', 'eventBus', 'chat', 'agents', 'extensions', 'openCode']) {
      expect(ctx.get(name, false)).toBeUndefined();
    }
  });

  it('keeps working when the orchestrator fails to initialize (no provider)', async () => {
    const plugin = createMockPlugin();
    const ctx = new Context();
    await ctx.plugin(MentatRoot, { plugin });
    // Chat service may still be registered; the assembly must not throw.
    expect(ctx.get('settings')).toBe(plugin.settings);
  });
});
