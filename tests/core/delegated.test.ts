import { describe, it, expect, vi } from 'vitest';
import { Context } from '../../src/core/cordis';
import { DelegatedService, DelegatedServicePlugin, type DelegatedAdapter } from '../../src/external/delegated/delegated.service';
import { AgentModeRegistry } from '../../src/agents/agent-mode';
import type { AgentEvent } from '../../src/agents/agent-types';

function makeAdapter(): DelegatedAdapter {
  const createBackend = vi.fn(async () => ({
    id: 'delegated:test', displayName: 'Test', capabilities: { supportsStreaming: true, supportsCancellation: false, supportsSkills: false },
    streamChat: async function* () { yield { type: 'agent:start' } as AgentEvent; },
    dispose: () => {},
  }));
  return {
    id: 'delegated:test', displayName: 'Test Agent', description: 'a test external agent',
    createBackend,
  };
}

describe('DelegatedService (L4.4)', () => {
  it('registers an adapter as a mode into the modes registry', () => {
    const ctx = new Context();
    const modes = new AgentModeRegistry();
    ctx.provide('modes', modes);

    const svc = new DelegatedService(modes);
    const unregister = svc.register(makeAdapter());
    expect(svc.get('delegated:test')).toBeTruthy();
    expect(modes.get('delegated:test')).toBeTruthy();
    expect(modes.get('delegated:test')!.requiresVaultServer).toBe(true);

    unregister();
    expect(modes.get('delegated:test')).toBeUndefined();
  });

  it('a registered delegated mode streams via the lazy external backend', async () => {
    const ctx = new Context();
    const modes = new AgentModeRegistry();
    ctx.provide('modes', modes);
    const svc = new DelegatedService(modes);
    const adapter = makeAdapter();
    svc.register(adapter);

    const { createSession } = await import('../../src/chat/session');
    const handle = createSession(ctx, 's1', 'delegated:test', modes);
    const events: string[] = [];
    for await (const ev of handle.backend.streamChat({ sessionId: 's1', messages: [{ role: 'user', content: 'hi', timestamp: 1 }] })) {
      events.push(ev.type);
    }
    expect(adapter.createBackend).toHaveBeenCalled();
    expect(events).toContain('agent:start');
    await handle.dispose();
  });

  it('rejects duplicate adapter ids', () => {
    const modes = new AgentModeRegistry();
    const svc = new DelegatedService(modes);
    svc.register(makeAdapter());
    expect(() => svc.register(makeAdapter())).toThrow(/already registered/);
  });

  it('DelegatedServicePlugin wires modes and unload recovers', async () => {
    const ctx = new Context();
    ctx.provide('modes', new AgentModeRegistry());
    await ctx.plugin(DelegatedServicePlugin);
    expect(ctx.get<DelegatedService>('delegated', false)).toBeInstanceOf(DelegatedService);
    await ctx.fiber.dispose();
    expect(ctx.get('delegated', false)).toBeUndefined();
  });
});
