import { describe, it, expect, vi } from 'vitest';
import { Context } from '../../src/core/cordis';
import { AgentModeRegistry, EMBEDDED_MODE } from '../../src/agents/agent-mode';
import { createSession } from '../../src/chat/session';
import { EmbeddedBackend } from '../../src/agents/embedded-backend';
import type { AgentModeDescriptor } from '../../src/agents/agent-mode';
import type { AIProvider } from '../../src/types';

describe('AgentModeRegistry (M6)', () => {
  it('registers, lists, gets and reversibly unregisters modes', () => {
    const registry = new AgentModeRegistry();
    const backend = { id: 'x', displayName: 'X', capabilities: { supportsStreaming: false, supportsCancellation: false, supportsSkills: false } };
    const mode: AgentModeDescriptor = {
      id: 'custom',
      displayName: 'Custom',
      description: '',
      createBackend: () => backend as never,
    };
    const unregister = registry.register(mode);
    expect(registry.has('custom')).toBe(true);
    expect(registry.get('custom')).toBe(mode);
    expect(registry.list().map((m) => m.id)).toEqual(['custom']);

    unregister();
    expect(registry.has('custom')).toBe(false);
  });

  it('rejects duplicate mode ids', () => {
    const registry = new AgentModeRegistry();
    const mode: AgentModeDescriptor = { id: 'dup', displayName: 'D', description: '', createBackend: () => ({}) as never };
    registry.register(mode);
    expect(() => registry.register(mode)).toThrow(/already registered/);
  });
});

describe('createSession (M6)', () => {
  it('resolves the backend from the registry and isolates the session context', () => {
    const ctx = new Context();
    const registry = new AgentModeRegistry();
    const onStart = vi.fn();
    const onEnd = vi.fn();
    registry.register({
      id: 'test-mode',
      displayName: 'Test',
      description: '',
      createBackend: ({ sessionId }) => ({
        id: 'test-mode',
        displayName: 'Test',
        capabilities: { supportsStreaming: true, supportsCancellation: false, supportsSkills: false },
        onSessionStart: () => onStart(sessionId),
        onSessionEnd: () => onEnd(sessionId),
        streamChat: async function* () {},
        dispose: () => {},
      }),
    });

    const session = createSession(ctx, 's1', 'test-mode', registry);
    expect(session.sessionId).toBe('s1');
    expect(session.backend.id).toBe('test-mode');
    expect(onStart).toHaveBeenCalledWith('s1');
    // Session context is isolated: providing under 'agent' realm does not leak.
    expect(session.ctx).not.toBe(ctx);

    return session.dispose().then(() => {
      expect(onEnd).toHaveBeenCalledWith('s1');
    });
  });

  it('falls back to the embedded mode for unknown mode ids', () => {
    const ctx = new Context();
    const registry = new AgentModeRegistry();
    const embedded: AgentModeDescriptor = {
      id: EMBEDDED_MODE,
      displayName: 'Embedded',
      description: '',
      createBackend: ({ ctx: c }) => new EmbeddedBackend(c),
    };
    registry.register(embedded);

    const session = createSession(ctx, 's2', 'no-such-mode', registry);
    expect(session.backend.id).toBe('embedded');
    void session.dispose();
  });
});

describe('EmbeddedBackend (M6)', () => {
  it('yields agent events through the existing RAGP loop', async () => {
    const ctx = new Context();
    const mockProvider = {
      id: 'mock', name: 'Mock', type: 'openai',
      generate: async () => 'hello',
      generateStream: async (_p: string, cb: (c: string) => void) => { cb('hello'); },
      generateEmbedding: async () => ({ embedding: [] }),
      embed: async () => [],
      isAvailable: async () => true,
      getContextWindow: () => 8000,
      getCompactionThreshold: () => 6000,
      supportsSkills: () => false,
    } as AIProvider;
    ctx.provide('aiRouter', { getProvider: async () => mockProvider } as never);

    const backend = new EmbeddedBackend(ctx);
    const events: string[] = [];
    for await (const event of backend.streamChat({
      sessionId: 's1',
      messages: [{ role: 'user', content: 'hi' }],
    })) {
      events.push(event.type);
    }
    expect(events).toContain('agent:start');
    expect(events.length).toBeGreaterThan(0);
  }, 20000);
});
