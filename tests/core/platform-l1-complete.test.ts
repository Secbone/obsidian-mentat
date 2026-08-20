import { describe, it, expect, vi } from 'vitest';
import { Context } from '../../src/core/cordis';
import { ObsidianPlatformPlugin } from '../../src/platform/platform.service';
import { DiagnosticsService } from '../../src/diagnostics/diagnostics.service';
import { MentatRoot } from '../../src/root';
import { DEFAULT_SETTINGS } from '../../src/settings/settings';
import { TFile } from 'obsidian';
import type MentatPlugin from '../../src/main';

function createMockPlugin(): MentatPlugin {
  const files = new Map<string, string>([['Research/Paper.md', '# Paper']]);
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
    rename: async (f: { path: string }, to: string) => { const c = files.get(f.path); if (c) { files.delete(f.path); files.set(to, c); } },
    adapter: { exists: async () => true, read: async () => '', write: async () => {}, remove: async () => {}, mkdir: async () => {}, list: async () => ({ files: [], folders: [] }) },
    on: () => ({ ref: 1 }),
    offref: () => {},
  };
  const metadataCache = { getFileCache: () => null, getBacklinksForFile: () => ({}), resolvedLinks: {} };
  const workspace = { getActiveFile: () => null, on: () => ({ ref: 1 }), offref: () => {} };
  return {
    app: { vault, metadataCache, workspace },
    manifest: { id: 'mentat' },
    settings: structuredClone(DEFAULT_SETTINGS),
    loadData: async () => ({}),
    saveData: async () => {},
  } as unknown as MentatPlugin;
}

describe('L1 completion', () => {
  it('SettingsService emits settings:update on the kernel context', async () => {
    const ctx = new Context();
    const plugin = createMockPlugin();
    ctx.provide('mentatPlugin', plugin);
    await ctx.plugin(ObsidianPlatformPlugin);
    // settings + diagnostics explicit for this scenario
    const { SettingsService } = await import('../../src/services/settings.service');
    await ctx.plugin(SettingsService);
    await ctx.plugin(DiagnosticsService);

    const onUpdate = vi.fn();
    ctx.on('settings:update', (...args: unknown[]) => onUpdate(args[1]));
    ctx.emit('settings:update', plugin.settings);
    expect(onUpdate).toHaveBeenCalledWith(plugin.settings);
  });

  it('DiagnosticsService provides the diagnostics API', async () => {
    const ctx = new Context();
    const plugin = createMockPlugin();
    ctx.provide('mentatPlugin', plugin);
    await ctx.plugin(DiagnosticsService);

    const diag = ctx.get<{ log: (...a: unknown[]) => void; openLog: () => Promise<void> }>('diagnostics', false)!;
    expect(diag).toBeTruthy();
    expect(typeof diag.log).toBe('function');
    expect(typeof diag.openLog).toBe('function');
  });

  it('MentatRoot mounts the L1 platform plugin (all six service names present)', async () => {
    const ctx = new Context();
    await ctx.plugin(MentatRoot, { plugin: createMockPlugin() });
    // L1 host-agnostic services
    expect(ctx.get('documents', true)).toBeTruthy();
    expect(ctx.get('search', true)).toBeTruthy();
    expect(ctx.get('storage', true)).toBeTruthy();
    // diagnostics mounted via root
    expect(ctx.get('diagnostics', false)).toBeTruthy();
    // legacy services still present (switch point not reached)
    expect(ctx.get('platform', false)).toBeTruthy();
  });
});
