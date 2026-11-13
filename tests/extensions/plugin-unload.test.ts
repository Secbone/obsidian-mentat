import { describe, expect, it, vi } from 'vitest';
vi.mock('obsidian');
import MentatPlugin from '../../src/main';

describe('Plugin extension shutdown', () => {
  it('releases extension tools and subscriptions after runtime shutdown and before flushing logs', async () => {
    const order: string[] = [];
    let stopped!: () => void;
    const gate = new Promise<void>(resolve => { stopped = resolve; });
    const plugin = { observer: { event: vi.fn(), error: vi.fn(), store: { drain: async () => { order.push('logs'); } } },
      runController: { dispose: async () => { await gate; order.push('runtime'); } },
      extensionManager: { unloadAll: () => { order.push('extensions'); } },
      draftStore: { flush: async () => { order.push('drafts'); } }, chatOrchestrator: { dispose: vi.fn() }, openCodeIntegration: { dispose: vi.fn() } };
    MentatPlugin.prototype.onunload.call(plugin as any);
    expect(order).toEqual([]);
    stopped();
    await vi.waitFor(() => expect(order).toEqual(['runtime', 'extensions', 'drafts', 'logs']));
  });
});
