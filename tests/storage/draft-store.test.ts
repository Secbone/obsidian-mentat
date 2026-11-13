import { describe, expect, it, vi } from 'vitest';
vi.mock('obsidian');
import { FileDraftStore, initializeDraftStore } from '../../src/storage/draft-store';
import { MemoryPlatformAdapter } from '../utils/memory-platform-adapter';
import MentatPlugin from '../../src/main';

const path = '.obsidian/plugins/mentat/drafts.json';

describe('Independent session draft storage', () => {
  it('isolates a failed migration, preserves legacy settings, and never acknowledges fallback writes as durable', async () => {
    const io = new MemoryPlatformAdapter(), legacy = { session:'old draft' }, onFailure = vi.fn();
    const error = new Error('draft directory permission denied');
    vi.spyOn(io,'write').mockRejectedValue(error);
    let data: Record<string,unknown> = { drafts:legacy };
    const plugin = {loadData:async () => structuredClone(data),saveData:async (next:Record<string,unknown>) => { data = structuredClone(next); }} as any;
    await MentatPlugin.prototype.loadSettings.call(plugin);
    const result = await initializeDraftStore(io,path,plugin.settings.drafts,onFailure);
    expect(result.migrated).toBe(false); expect(onFailure).toHaveBeenCalledExactlyOnceWith(error);
    expect(await result.store.load('session')).toBe('old draft');
    await expect(result.store.save('session','in-memory edit')).rejects.toThrow('仅保留在内存');
    expect(await result.store.load('session')).toBe('in-memory edit');
    plugin.settings.maxTurns = 42;
    await MentatPlugin.prototype.saveSettings.call(plugin);
    expect(data.maxTurns).toBe(42); expect(data.drafts).toEqual(legacy);
    await expect(result.store.clear('session')).rejects.toThrow('持久草稿未清除');
    expect(await result.store.load('session')).toBeNull();
    await result.store.flush();
    expect(legacy.session).toBe('old draft');
    vi.restoreAllMocks();
    const retry = await initializeDraftStore(io,path,data.drafts,onFailure);
    expect(retry.migrated).toBe(true); expect(await retry.store.load('session')).toBe('old draft');
  });
  it('migrates strings once, preserves newer drafts and does not resurrect cleared legacy drafts', async () => {
    const io = new MemoryPlatformAdapter(), store = new FileDraftStore(io,path);
    const legacy = { old:'legacy', current:'stale', empty:'', invalid:42 };
    await store.save('current','newer');
    await store.migrateLegacy(legacy);
    expect(await store.load('current')).toBe('newer');
    expect(await store.load('old')).toBe('legacy');
    expect(await store.load('empty')).toBe('');
    expect(await store.load('invalid')).toBeNull();
    await store.clear('old');
    const restarted = new FileDraftStore(io,path);
    await restarted.migrateLegacy(legacy);
    expect(await restarted.load('old')).toBeNull();
    expect(legacy).toEqual({ old:'legacy', current:'stale', empty:'', invalid:42 });
  });

  it('serializes overlapping saves and clears across sessions without losing unrelated drafts', async () => {
    const io = new MemoryPlatformAdapter(), store = new FileDraftStore(io,path);
    await store.migrateLegacy({});
    await Promise.all([store.save('a','first'),store.save('b','other'),store.clear('a'),store.save('a','last')]);
    await store.flush();
    const restarted = new FileDraftStore(io,path);
    expect(await restarted.load('a')).toBe('last');
    expect(await restarted.load('b')).toBe('other');
  });

  it('does not mark a partial legacy import complete, allowing safe retry after restart', async () => {
    const io = new MemoryPlatformAdapter(), store = new FileDraftStore(io,path), legacy = { session:'recover me' };
    const write = io.write.bind(io);
    const spy = vi.spyOn(io,'write').mockImplementation(async (target,data) => write(target,target === path ? '{partial' : data));
    await expect(store.migrateLegacy(legacy)).rejects.toThrow('校验失败');
    expect(legacy.session).toBe('recover me');
    spy.mockRestore();
    const restarted = new FileDraftStore(io,path);
    await restarted.migrateLegacy(legacy);
    expect(await restarted.load('session')).toBe('recover me');
  });

  it('recovers the last verified draft after an interrupted file write', async () => {
    const io = new MemoryPlatformAdapter(), store = new FileDraftStore(io,path);
    await store.migrateLegacy({}); await store.save('session','verified');
    const write = io.write.bind(io);
    const spy = vi.spyOn(io,'write').mockImplementation(async (target,data) => {
      if (target === path) { await write(target,'{partial'); throw new Error('disk full'); }
      await write(target,data);
    });
    await expect(store.save('session','incomplete')).rejects.toThrow('disk full');
    spy.mockRestore();
    const restarted = new FileDraftStore(io,path);
    expect(await restarted.load('session')).toBe('verified');
    await restarted.save('session','retry');
    expect(await new FileDraftStore(io,path).load('session')).toBe('retry');
  });

  it('refuses to overwrite damaged storage when no valid backup exists', async () => {
    const io = new MemoryPlatformAdapter(); io.addFile(path,'{damaged');
    const store = new FileDraftStore(io,path);
    await expect(store.migrateLegacy({session:'legacy'})).rejects.toThrow();
    await expect(store.save('new','draft')).rejects.toThrow();
    expect(await io.read(path)).toBe('{damaged');
  });

  it('isolates draft writes from settings saves in either order', async () => {
    const io = new MemoryPlatformAdapter();
    let data: Record<string, unknown> = { drafts:{session:'legacy'} };
    const plugin = {loadData:async () => structuredClone(data),saveData:async (next:Record<string,unknown>) => { data = structuredClone(next); }} as any;
    await MentatPlugin.prototype.loadSettings.call(plugin);
    const store = new FileDraftStore(io,path); await store.migrateLegacy(data.drafts);
    plugin.settings.maxTurns = 42;
    await Promise.all([store.save('session','new draft'),MentatPlugin.prototype.saveSettings.call(plugin)]);
    expect(data.maxTurns).toBe(42);
    expect(await new FileDraftStore(io,path).load('session')).toBe('new draft');
    await store.clear('session');
    await MentatPlugin.prototype.saveSettings.call(plugin);
    const restarted = new FileDraftStore(io,path); await restarted.migrateLegacy(data.drafts);
    expect(await restarted.load('session')).toBeNull();
    expect(data.maxTurns).toBe(42);
  });
});
