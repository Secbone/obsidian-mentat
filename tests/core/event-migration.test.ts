import { describe, it, expect, vi } from 'vitest';
import { Context } from '../../src/core/cordis';
import { AgentLoopService } from '../../src/agents/loop.service';
import { ToolsRegistry } from '../../src/tools/tools.service';
import { ContextWindowService } from '../../src/session/context.service';
import { CompactionService, SummarizeCompactionStrategy } from '../../src/session/compaction.service';
import { LLMRegistry } from '../../src/llm/llm.service';
import type { LLMProvider } from '../../src/llm/contract';
import type { ChatMessage } from '../../src/types';
import type { AgentEvent } from '../../src/agents/agent-types';

function msg(content: string): ChatMessage { return { role: 'user', content, timestamp: Date.now() }; }

function makeProvider(toolCalls = false): LLMProvider {
  const m: LLMProvider = {
    id: 'p', name: 'P', capabilities: { chat: true, streaming: true, embeddings: false, tools: toolCalls },
    generate: async () => 'hello',
    generateStream: async () => {},
    getContextWindow: () => 8000, getCompactionThreshold: () => 6000, isAvailable: async () => true,
  };
  if (toolCalls) m.generateWithTools = async (_m, onChunk) => {
    onChunk?.({ delta: 'thinking' });
    return { content: 'thinking', toolCalls: [{ id: 'c1', name: 'vault_read', arguments: { path: 'a.md' } }] };
  };
  return m;
}

describe('Event migration: kernel ctx bus as the EventBus replacement', () => {
  it('kernel ctx.on(\'*\') receives AgentEvents from a loop bridged via ctx.emit', async () => {
    const ctx = new Context();
    // New orchestration services on the kernel context.
    const llm = new LLMRegistry(); llm.register(makeProvider());
    const tools = new ToolsRegistry();
    const compaction = new CompactionService(new ContextWindowService()); compaction.register(new SummarizeCompactionStrategy());
    ctx.provide('llm', llm);
    ctx.provide('tools', tools);
    ctx.provide('context-window', new ContextWindowService());
    ctx.provide('compaction', compaction);

    // A UI-style listener that receives ONE event object (legacy EventBus shape),
    // bridged over kernel ctx.emit's (subject, ...args) signature.
    const received: AgentEvent[] = [];
    ctx.on('*', (_subject: unknown, ...args: unknown[]) => {
      const ev = args[0] as AgentEvent;
      if (ev && typeof ev === 'object' && 'type' in ev) received.push(ev);
    });

    // Run the loop and bridge emitted events to the kernel bus.
    const loop = new AgentLoopService(llm, tools, ctx.get('context-window'), compaction);
    for await (const ev of loop.run([msg('hi')], {}, new AbortController().signal)) {
      ctx.emit('agent-event', ev);   // ← kernel bus bridge (name + event arg)
    }

    expect(received.length).toBeGreaterThan(0);
    const types = received.map((e) => e.type);
    expect(types).toContain('agent:start');
    expect(types).toContain('turn:end');
    expect(types).toContain('agent:end');
  });

  it('kernel ctx events are lifecycle-managed (listener disposed with its fiber)', async () => {
    const ctx = new Context();
    const count = vi.fn();
    // Listener registered by a plugin child fiber → auto-disposed on unload.
    const fiber = ctx.plugin((c: Context) => {
      c.on('agent-event', (_s: unknown, ...args: unknown[]) => count(args[0]));
      return () => {};
    });
    await fiber;
    ctx.emit('agent-event', { type: 'agent:start' } as AgentEvent);
    expect(count).toHaveBeenCalledTimes(1);
    await fiber.dispose();
    ctx.emit('agent-event', { type: 'agent:start' } as AgentEvent);
    expect(count).toHaveBeenCalledTimes(1); // not called again — listener disposed
  });
});
