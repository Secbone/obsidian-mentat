import { describe, it, expect, vi } from 'vitest';
import { Context } from '../../src/core/cordis';
import { SessionService, SessionServicePlugin } from '../../src/session/session.service';
import { AgentModeRegistry, EMBEDDED_MODE } from '../../src/agents/agent-mode';
import type { AgentEvent } from '../../src/agents/agent-types';

describe('SessionService (L3.5)', () => {
  it('creates sessions, resolves modes, streams send, and disposes', async () => {
    const ctx = new Context();
    const modes = new AgentModeRegistry();
    const fn = vi.fn();
    modes.register({
      id: EMBEDDED_MODE,
      displayName: 'Embedded', description: '',
      createBackend: ({ sessionId }) => ({
        id: EMBEDDED_MODE, displayName: 'E', capabilities: { supportsStreaming: true, supportsCancellation: false, supportsSkills: false },
        streamChat: async function* () { fn(sessionId); yield { type: 'agent:start' } as AgentEvent; },
        dispose: () => {},
      }),
    });
    ctx.provide('modes', modes);

    const service = new SessionService(ctx, modes);
    const s = service.create('s1');
    expect(service.get('s1')).toBe(s);
    expect(service.list()).toEqual(['s1']);

    const events: string[] = [];
    for await (const e of service.send('s1', { messages: [{ role: 'user', content: 'hi', timestamp: 1 }] })) events.push(e.type);
    expect(fn).toHaveBeenCalledWith('s1');
    expect(events).toContain('agent:start');

    await service.dispose('s1');
    expect(service.get('s1')).toBeUndefined();
  });

  it('SessionServicePlugin wires modes and unload recovers', async () => {
    const ctx = new Context();
    ctx.provide('modes', new AgentModeRegistry());
    await ctx.plugin(SessionServicePlugin);
    expect(ctx.get<SessionService>('session', false)).toBeInstanceOf(SessionService);
    await ctx.fiber.dispose();
    expect(ctx.get('session', false)).toBeUndefined();
  });
});
