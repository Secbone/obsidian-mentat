import { describe, it, expect } from 'vitest';
import { Context } from '../../src/core/cordis';
import {
  SettingsService,
  PlatformService,
  EventBusService,
  ReadTrackerService,
} from '../../src/services';
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

describe('Mentat base services (M2)', () => {
  it('each base service activates once its inject is satisfied', async () => {
    const ctx = new Context();
    const plugin = createMockPlugin();
    ctx.provide('mentatPlugin', plugin);

    await ctx.plugin(SettingsService);
    await ctx.plugin(PlatformService);
    await ctx.plugin(EventBusService);
    await ctx.plugin(ReadTrackerService);

    expect(ctx.get('settings', false)).toBe(plugin.settings);
    expect(ctx.get('platform', false)).toBeTruthy();
    expect(ctx.get('eventBus', false)).toBeTruthy();
    expect(ctx.get('readTracker', false)).toBeTruthy();

    // Plugin field references kept for existing UI/command code.
    expect(plugin.platform).toBe(ctx.get('platform', false));
    expect(plugin.eventBus).toBe(ctx.get('eventBus', false));
  });

  it('stays inactive while the injected service is missing, then activates', async () => {
    const ctx = new Context();
    let activated = 0;
    const fiber = ctx.plugin({
      inject: ['settings'],
      apply: (childCtx) => {
        activated++;
        return () => activated--;
      },
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(activated).toBe(0); // 'settings' not yet provided

    ctx.provide('settings', {});
    await new Promise((r) => setTimeout(r, 5));
    expect(activated).toBe(1);

    await ctx.fiber.dispose();
    expect(activated).toBe(0);
    void fiber;
  });

  it('unloading the context recovers every base service', async () => {
    const ctx = new Context();
    const plugin = createMockPlugin();
    ctx.provide('mentatPlugin', plugin);
    await ctx.plugin(SettingsService);
    await ctx.plugin(ReadTrackerService);

    expect(ctx.get('settings', false)).toBeTruthy();
    await ctx.fiber.dispose();
    expect(ctx.get('settings', false)).toBeUndefined();
    expect(ctx.get('mentatPlugin', false)).toBeUndefined();
  });
});
