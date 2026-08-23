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
