import { describe, it, expect, vi } from 'vitest';
import { Context } from '../../src/core/cordis';
import { AgentModeRegistry, EMBEDDED_MODE } from '../../src/agents/agent-mode';
import { createSession } from '../../src/chat/session';
import { EmbeddedBackend } from '../../src/agents/backends/embedded.backend';
import type { AgentModeDescriptor } from '../../src/agents/agent-mode';

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

describe('EmbeddedBackend (L3.4)', () => {
  it('yields agent events through the agent-loop service', async () => {
    const ctx = new Context();
    // Provide the agent-loop dependency chain over the kernel context.
    const { LLMRegistry } = await import('../../src/llm/llm.service');
    const { AgentLoopService } = await import('../../src/agents/loop.service');
    const { ToolsRegistry } = await import('../../src/tools/tools.service');
    const { ContextWindowService } = await import('../../src/session/context.service');
    const { CompactionService, SummarizeCompactionStrategy } = await import('../../src/session/compaction.service');

    const llm = new LLMRegistry();
    llm.register({
      id: 'mock', name: 'Mock',
      capabilities: { chat: true, streaming: true, embeddings: false, tools: false },
      generate: async () => 'hello',
      generateStream: async () => {},
      getContextWindow: () => 8000, getCompactionThreshold: () => 6000, isAvailable: async () => true,
    });
    const compaction = new CompactionService(new ContextWindowService());
    compaction.register(new SummarizeCompactionStrategy());
    ctx.provide('llm', llm);
    ctx.provide('tools', new ToolsRegistry());
    ctx.provide('context-window', new ContextWindowService());
    ctx.provide('compaction', compaction);
    ctx.provide('agent-loop', new AgentLoopService(llm, new ToolsRegistry(), new ContextWindowService(), compaction));

    const backend = new EmbeddedBackend(ctx);
    const events: string[] = [];
    for await (const event of backend.streamChat({
      sessionId: 's1',
      messages: [{ role: 'user', content: 'hi', timestamp: Date.now() }],
    })) {
      events.push(event.type);
    }
    expect(events).toContain('agent:start');
    expect(events.length).toBeGreaterThan(0);
  }, 20000);
});
