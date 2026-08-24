import { describe, it, expect, vi } from 'vitest';
import { Context } from '../../src/core/cordis';
import { EventBridgeService, EventBridgeServicePlugin } from '../../src/events/event-bridge.service';
import type { AgentEvent } from '../../src/agents/agent-types';

describe('EventBridgeService (L4.1)', () => {
  it('legacy-style on(\'*\') receives single event objects from emit(event)', async () => {
    const ctx = new Context();
    await ctx.plugin(EventBridgeServicePlugin);
    const bridge = ctx.get<EventBridgeService>('event-bridge', false)!;

    const received: AgentEvent[] = [];
    bridge.on('*', (ev) => received.push(ev));   // legacy single-arg handler

    bridge.emit({ type: 'agent:start' } as AgentEvent);
    bridge.emit({ type: 'turn:end', turnIndex: 0, message: { role: 'assistant', content: 'x', timestamp: 1 }, toolResults: [] });

    expect(received.map((e) => e.type)).toEqual(['agent:start', 'turn:end']);
  });

  it('supports namespace wildcard matching like the legacy bus', async () => {
    const ctx = new Context();
    await ctx.plugin(EventBridgeServicePlugin);
    const bridge = ctx.get<EventBridgeService>('event-bridge', false)!;

    const toolEvents: AgentEvent[] = [];
    bridge.on('tool:*', (ev) => toolEvents.push(ev));

    bridge.emit({ type: 'tool:start', toolCallId: 'a', toolName: 'x', args: {} } as AgentEvent);
    bridge.emit({ type: 'message:update', delta: 'hi' } as AgentEvent);

    expect(toolEvents.map((e) => e.type)).toEqual(['tool:start']);
  });

  it('returns an unsubscriber; manual teardown matches the legacy contract', () => {
    const ctx = new Context();
    ctx.registry.provide(ctx, 'event-bridge', new EventBridgeService(ctx));
    const bridge = ctx.get<EventBridgeService>('event-bridge', false)!;
    const handler = vi.fn();

    const unsub = bridge.on('*', handler);   // legacy UI calls this
    bridge.emit({ type: 'agent:start' } as AgentEvent);
    expect(handler).toHaveBeenCalledTimes(1);

    unsub();                                  // legacy UI teardown
    bridge.emit({ type: 'agent:start' } as AgentEvent);
    expect(handler).toHaveBeenCalledTimes(1); // now stopped
  });
});
