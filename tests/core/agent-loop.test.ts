import { describe, it, expect, vi } from 'vitest';
import { Context } from '../../src/core/cordis';
import { AgentLoopService, AgentLoopServicePlugin } from '../../src/agents/loop.service';
import { ToolsRegistry } from '../../src/tools/tools.service';
import { ContextWindowService } from '../../src/session/context.service';
import { CompactionService, SummarizeCompactionStrategy } from '../../src/session/compaction.service';
import { LLMRegistry } from '../../src/llm/llm.service';
import type { LLMProvider } from '../../src/llm/contract';
import type { ChatMessage } from '../../src/types';
import type { ToolDefinition } from '../../src/tools/contract';

function msg(content: string): ChatMessage { return { role: 'user', content, timestamp: Date.now() }; }

describe('AgentLoopService (L3.3)', () => {
  it('runs a chat turn without tools when the provider lacks tool support', async () => {
    const llm = new LLMRegistry();
    const provider: LLMProvider = {
      id: 'p', name: 'P', capabilities: { chat: true, streaming: true, embeddings: false, tools: false },
      generate: async (msgs) => `reply to ${msgs.length}`,
      generateStream: async () => {},
      getContextWindow: () => 8000, getCompactionThreshold: () => 6000, isAvailable: async () => true,
    };
    llm.register(provider);

    const loop = new AgentLoopService(llm, new ToolsRegistry(), new ContextWindowService(), new CompactionService(new ContextWindowService()));
    loop['compaction'].register(new SummarizeCompactionStrategy());

    const events: string[] = [];
    for await (const e of loop.run([msg('hi')], {}, new AbortController().signal)) {
      events.push(e.type);
    }
    expect(events).toContain('agent:start');
    expect(events).toContain('message:update');
    expect(events).toContain('turn:end');
    expect(events).toContain('agent:end');
  });

  it('executes tools when the provider returns tool calls', async () => {
    const llm = new LLMRegistry();
    const provider: LLMProvider = {
      id: 'p', name: 'P', capabilities: { chat: true, streaming: true, embeddings: false, tools: true },
      generate: async () => 'done',
      generateStream: async () => {},
      generateWithTools: async (_, onChunk) => {
        onChunk?.({ delta: 'thinking' });
        return { content: 'thinking', toolCalls: [{ id: 'c1', name: 'vault_read', arguments: { path: 'a.md' } }] };
      },
      getContextWindow: () => 8000, getCompactionThreshold: () => 6000, isAvailable: async () => true,
    };
    llm.register(provider);

    const tools = new ToolsRegistry();
    const readFn = vi.fn(async () => ({ success: true, data: { content: 'file' } }));
    tools.register({ name: 'vault_read', description: '', permissions: ['documents:read'], execute: readFn } as ToolDefinition);

    const loop = new AgentLoopService(llm, tools, new ContextWindowService(), new CompactionService(new ContextWindowService()));
    loop['compaction'].register(new SummarizeCompactionStrategy());

    const events: string[] = [];
    for await (const e of loop.run([msg('read a.md')], {}, new AbortController().signal)) {
      events.push(e.type);
    }
    expect(readFn).toHaveBeenCalled();
    expect(events).toContain('tool:start');
    expect(events).toContain('tool:end');
    expect(events).toContain('turn:end');
  });

  it('AgentLoopServicePlugin wires deps and unload recovers', async () => {
    const ctx = new Context();
    ctx.provide('llm', new LLMRegistry());
    ctx.provide('tools', new ToolsRegistry());
    ctx.provide('context-window', new ContextWindowService());
    ctx.provide('compaction', new CompactionService(new ContextWindowService()));
    await ctx.plugin(AgentLoopServicePlugin);
    expect(ctx.get<AgentLoopService>('agent-loop', false)).toBeInstanceOf(AgentLoopService);
    await ctx.fiber.dispose();
    expect(ctx.get('agent-loop', false)).toBeUndefined();
  });
});
