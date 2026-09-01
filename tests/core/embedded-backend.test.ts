import { describe, it, expect, vi } from 'vitest';
import { Context } from '../../src/core/cordis';
import { EmbeddedBackend } from '../../src/agents/backends/embedded.backend';
import type { AgentEvent } from '../../src/agents/agent-types';

describe('EmbeddedBackend (L3.4)', () => {
  it('streamChat delegates to the agent-loop service', async () => {
    const ctx = new Context();
    const run = vi.fn(async function* () {
      yield { type: 'agent:start' } as AgentEvent;
      yield { type: 'turn:end', turnIndex: 0, message: { role: 'assistant', content: 'hi', timestamp: 1 }, toolResults: [] };
      yield { type: 'agent:end', messages: [] } as AgentEvent;
    });
    ctx.provide('agent-loop', { run } as never);

    const backend = new EmbeddedBackend(ctx);
    const events: string[] = [];
    for await (const e of backend.streamChat({ sessionId: 's1', messages: [{ role: 'user', content: 'hi', timestamp: 1 }] })) {
      events.push(e.type);
    }
    expect(run).toHaveBeenCalled();
    expect(events).toContain('agent:start');
    expect(events).toContain('agent:end');
    expect(backend.id).toBe('embedded');
  });
});

describe('EmbeddedBackend — loop wiring', () => {
  it('passes maxTurns:4 and the input messages/signal to the agent-loop', async () => {
    const ctx = new Context();
    let seen: { messages: unknown; opts: unknown; signal: unknown } | undefined;
    const run = vi.fn(async function* (messages: unknown, opts: unknown, signal: unknown) {
      seen = { messages, opts, signal };
      yield { type: 'agent:end', messages: [] } as AgentEvent;
    });
    ctx.provide('agent-loop', { run } as never);

    const backend = new EmbeddedBackend(ctx);
    const ac = new AbortController();
    const msgs = [{ role: 'user' as const, content: 'hi', timestamp: 1 }];
    for await (const _e of backend.streamChat({ sessionId: 's1', messages: msgs, signal: ac.signal })) { /* drain */ }

    expect(seen).toBeDefined();
    expect(seen!.messages).toEqual(msgs);
    expect((seen!.opts as { maxTurns: number }).maxTurns).toBe(10);
    expect(seen!.signal).toBe(ac.signal);
  });
});
