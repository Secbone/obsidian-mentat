import { describe, it, expect, vi } from 'vitest';
import { AgentLoopService } from '../../src/agents/loop.service';
import { ToolsRegistry } from '../../src/tools/tools.service';
import { ContextWindowService } from '../../src/session/context.service';
import { CompactionService, SummarizeCompactionStrategy } from '../../src/session/compaction.service';
import { LLMRegistry } from '../../src/llm/llm.service';
import type { LLMProvider } from '../../src/llm/contract';
import type { ChatMessage } from '../../src/types';

function msg(content: string): ChatMessage { return { role: 'user', content, timestamp: Date.now() }; }

function makeLoop(provider: LLMProvider, opts: { window?: ContextWindowService; tools?: ToolsRegistry } = {}) {
  const llm = new LLMRegistry();
  llm.register(provider);
  const tools = opts.tools ?? new ToolsRegistry();
  const window = opts.window ?? new ContextWindowService();
  const loop = new AgentLoopService(llm, tools, window, new CompactionService(window));
  loop['compaction'].register(new SummarizeCompactionStrategy());
  return { loop, tools };
}

function toolProvider(alwaysTool: boolean, calls: ChatMessage[][] = []): { provider: LLMProvider; calls: ChatMessage[][] } {
  const provider: LLMProvider = {
    id: 'p', name: 'P', capabilities: { chat: true, streaming: true, embeddings: false, tools: true },
    generate: async () => 'plain', generateStream: async () => {},
    generateWithTools: async (msgs, onChunk) => {
      calls.push(msgs);
      if (alwaysTool) {
        onChunk?.({ delta: 't' });
        return { content: 't', toolCalls: [{ id: 'call_1', name: 'vault_read', arguments: { path: 'a.md' } }] };
      }
      onChunk?.({ delta: 'done' });
      return { content: 'done', toolCalls: undefined };
    },
    getContextWindow: () => 8000, getCompactionThreshold: () => 6000, isAvailable: async () => true,
  };
  return { provider, calls };
}

describe('AgentLoopService — turn budget (maxTurns)', () => {
  it('stops the loop after maxTurns even when the model keeps requesting tools (infinite-loop guard)', async () => {
    const { provider, calls } = toolProvider(true);
    const tools = new ToolsRegistry();
    tools.register({ name: 'vault_read', description: '', permissions: ['documents:read'], execute: async () => ({ success: true, data: {} }) });
    const { loop } = makeLoop(provider, { tools });

    const events: string[] = [];
    for await (const e of loop.run([msg('hi')], { maxTurns: 2 }, new AbortController().signal)) events.push(e.type);

    expect(calls.length).toBe(2); // capped at maxTurns
    expect(events.filter((e) => e === 'tool:start').length).toBe(2);
    expect(events).toContain('agent:end');
  });
});

describe('AgentLoopService — tool failure handling', () => {
  it('marks a throwing tool as error and feeds the error back to the model', async () => {
    const calls: ChatMessage[][] = [];
    const { provider } = toolProvider(false, calls);
    // Override: first call requests a tool, second returns plain content.
    provider.generateWithTools = async (msgs, onChunk) => {
      calls.push(msgs);
      if (calls.length === 1) {
        onChunk?.({ delta: 'x' });
        return { content: 'x', toolCalls: [{ id: 'c1', name: 'boom', arguments: {} }] };
      }
      onChunk?.({ delta: 'recovered' });
      return { content: 'recovered', toolCalls: undefined };
    };
    const tools = new ToolsRegistry();
    const failing = vi.fn(async () => { throw new Error('disk full'); });
    tools.register({ name: 'boom', description: '', permissions: ['documents:read'], execute: failing });

    const { loop } = makeLoop(provider, { tools });
    const toolEnds: unknown[] = [];
    for await (const e of loop.run([msg('go')], {}, new AbortController().signal)) {
      if (e.type === 'tool:end') toolEnds.push(e);
    }

    expect(toolEnds).toHaveLength(1);
    expect((toolEnds[0] as { isError: boolean }).isError).toBe(true);
    // The follow-up turn received the tool-error result as context.
    const second = calls[1];
    const toolMsg = second.find((m) => m.role === 'tool');
    expect(JSON.parse(toolMsg!.content)).toEqual({ success: false, error: 'disk full' });
  });

  it('does not crash when the model requests a tool that is not registered', async () => {
    const calls: ChatMessage[][] = [];
    const { provider } = toolProvider(false, calls);
    provider.generateWithTools = async (msgs, onChunk) => {
      calls.push(msgs);
      if (calls.length === 1) {
        onChunk?.({ delta: 'x' });
        return { content: 'x', toolCalls: [{ id: 'c1', name: 'ghost_tool', arguments: {} }] };
      }
      onChunk?.({ delta: 'done' });
      return { content: 'done', toolCalls: undefined };
    };
    const { loop } = makeLoop(provider); // empty tools registry

    const events: string[] = [];
    const toolEnds: unknown[] = [];
    for await (const e of loop.run([msg('go')], {}, new AbortController().signal)) {
      events.push(e.type);
      if (e.type === 'tool:end') toolEnds.push(e);
    }
    expect(toolEnds).toHaveLength(1);
    expect((toolEnds[0] as { isError: boolean }).isError).toBe(true);
    expect(events).toContain('agent:end'); // loop recovered and finished
  });

  it('parses string tool arguments as JSON and falls back to {} on invalid JSON', async () => {
    const readFn = vi.fn(async () => ({ success: true, data: {} }));
    const calls: ChatMessage[][] = [];
    const { provider } = toolProvider(false, calls);
    provider.generateWithTools = async (msgs, onChunk) => {
      calls.push(msgs);
      if (calls.length === 1) {
        onChunk?.({ delta: 'x' });
        return { content: 'x', toolCalls: [{ id: 'c1', name: 'vault_read', arguments: '{"path":"a.md"}' }] };
      }
      if (calls.length === 2) {
        return { content: 'y', toolCalls: [{ id: 'c2', name: 'vault_read', arguments: 'not-json' }] };
      }
      return { content: 'done', toolCalls: undefined };
    };
    const tools = new ToolsRegistry();
    tools.register({ name: 'vault_read', description: '', permissions: ['documents:read'], execute: readFn });
    const { loop } = makeLoop(provider, { tools });

    for await (const _e of loop.run([msg('go')], {}, new AbortController().signal)) { /* drain */ }

    expect(readFn).toHaveBeenNthCalledWith(1, { path: 'a.md' }, expect.anything());
    expect(readFn).toHaveBeenNthCalledWith(2, {}, expect.anything()); // invalid JSON -> {}
  });
});

describe('AgentLoopService — completion contract', () => {
  it('emits agent:end carrying the full (user + assistant) message history', async () => {
    const { provider } = toolProvider(false);
    const { loop } = makeLoop(provider);
    let finalMessages: ChatMessage[] | undefined;
    for await (const e of loop.run([msg('hello')], {}, new AbortController().signal)) {
      if (e.type === 'agent:end') finalMessages = e.messages;
    }
    expect(finalMessages).toBeDefined();
    expect(finalMessages!.length).toBe(2);
    expect(finalMessages![0].role).toBe('user');
    expect(finalMessages![1].role).toBe('assistant');
  });
});

describe('AgentLoopService — context compaction', () => {
  it('triggers compaction when the conversation exceeds the (provider-derived) window budget', async () => {
    // The loop derives the budget from provider.getContextWindow()*0.6 (the
    // mock provider reports 8000) and compacts at > 8000*0.6*1.1 = 5280 tokens.
    // Token estimate is ~chars/4, so the message must be far over ~21k chars.
    const big = msg('x'.repeat(30000));
    const window = new ContextWindowService({ maxTokens: 1000 });
    const { provider } = toolProvider(false);
    const { loop } = makeLoop(provider, { window });

    const events: string[] = [];
    for await (const e of loop.run([big], {}, new AbortController().signal)) events.push(e.type);

    expect(events).toContain('context:compact:start');
  });
});

describe('AgentLoopService — provider failure handling', () => {
  it('turns a throwing provider into a system:error event and still finishes (no uncaught stall)', async () => {
    const provider: LLMProvider = {
      id: 'p', name: 'P', capabilities: { chat: true, streaming: true, embeddings: false, tools: true },
      generate: async () => '', generateStream: async () => {},
      generateWithTools: async () => { throw new Error('400 Empty input messages'); },
      getContextWindow: () => 8000, getCompactionThreshold: () => 6000, isAvailable: async () => true,
    };
    const { loop } = makeLoop(provider);
    const events: string[] = [];
    const msgs: string[] = [];
    for await (const e of loop.run([msg('hi')], {}, new AbortController().signal)) {
      events.push(e.type);
      if (e.type === 'system:error') msgs.push((e as { message: string }).message);
    }
    expect(events).toContain('system:error');
    expect(events).toContain('agent:end'); // run still finishes cleanly
    expect(msgs[0]).toContain('400 Empty input messages');
  });
});

describe('AgentLoopService — final-answer guarantee', () => {
  it('still produces a final answer when the model spends every turn on tool calls (no empty run)', async () => {
    const gen = vi.fn(async () => 'Here is the final summary.');
    const calls: ChatMessage[][] = [];
    const provider: LLMProvider = {
      id: 'p', name: 'P', capabilities: { chat: true, streaming: true, embeddings: false, tools: true },
      generate: gen, generateStream: async () => {},
      generateWithTools: async (msgs, onChunk) => {
        calls.push(msgs);
        onChunk?.({ delta: 'x' });
        return { content: 'x', toolCalls: [{ id: 'c1', name: 'vault_list', arguments: {} }] };
      },
      getContextWindow: () => 8000, getCompactionThreshold: () => 6000, isAvailable: async () => true,
    };
    const tools = new ToolsRegistry();
    tools.register({ name: 'vault_list', description: '', permissions: ['documents:read'], execute: async () => ({ success: true, data: [] }) });
    const { loop } = makeLoop(provider, { tools });

    const events: string[] = [];
    let lastDelta = '';
    for await (const e of loop.run([msg('hi')], { maxTurns: 1 }, new AbortController().signal)) {
      events.push(e.type);
      if (e.type === 'message:update') lastDelta = (e as { delta: string }).delta;
    }
    // The single allowed turn was a tool call — the loop must synthesize an answer.
    expect(lastDelta).toBe('Here is the final summary.');
    expect(events).toContain('agent:end');
    expect(gen).toHaveBeenCalled();
  });
});

describe('AgentLoopService — context budget regression (realistic large vault)', () => {
  it('does NOT compact on a normal-sized conversation and keeps tool results for the model', async () => {
    // Realistic: a vault tool returns a large listing (~20k chars ≈ 5k tokens).
    // The old hardcoded 4096 budget compacted every turn and erased tool
    // results; the provider-derived budget (getContextWindow=128k *0.6) must
    // not compact a conversation that is far below that.
    const makeListing = () => Array.from({ length: 400 }, (_, i) => ({ path: `folder/subfolder/note_${i}.md`, name: `note_${i}`, extension: 'md' }));
    const bigList = JSON.stringify({ success: true, data: makeListing() });
    const calls: ChatMessage[][] = [];
    const provider: LLMProvider = {
      id: 'p', name: 'P', capabilities: { chat: true, streaming: true, embeddings: false, tools: true },
      getContextWindow: () => 128000,
      generate: async () => '', generateStream: async () => {},
      generateWithTools: async (msgs, onChunk) => {
        calls.push(msgs);
        if (calls.length === 1) {
          onChunk?.({ delta: 'x' });
          return { content: 'x', toolCalls: [{ id: 'c1', name: 'vault_list', arguments: {} }] };
        }
        onChunk?.({ delta: 'There are 60 notes.' });
        return { content: 'There are 60 notes.', toolCalls: undefined };
      },
      getCompactionThreshold: () => 0.8, isAvailable: async () => true,
    };
    const tools = new ToolsRegistry();
    tools.register({ name: 'vault_list', description: '', permissions: ['documents:read'], execute: async () => ({ success: true, data: makeListing() }) });
    const { loop } = makeLoop(provider, { tools });

    const events: string[] = [];
    for await (const e of loop.run([msg('how many notes?')], {}, new AbortController().signal)) events.push(e.type);

    // Compaction must NOT fire on this (well under budget) conversation.
    expect(events).not.toContain('context:compact:start');
    // The full tool result must reach the follow-up provider call unchanged.
    const secondCall = calls[1];
    const toolMsg = secondCall.find((m) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    expect((toolMsg!.content as string).length).toBeGreaterThan(5000); // not truncated/erased by compaction
    expect(toolMsg!.content).toContain('note_59.md');
  });
});

describe('AgentLoopService — system prompt injection (baseline behaviour)', () => {
  it('always passes a non-empty systemPrompt to the provider (regression: no system prompt injected)', async () => {
    const received: { systemPrompt?: string }[] = [];
    const provider: LLMProvider = {
      id: 'p', name: 'P', capabilities: { chat: true, streaming: true, embeddings: false, tools: true },
      getContextWindow: () => 128000, getCompactionThreshold: () => 0.8,
      generate: async () => '', generateStream: async () => {},
      generateWithTools: async (_m, onChunk, options) => {
        received.push({ systemPrompt: options?.systemPrompt });
        onChunk?.({ delta: 'done' });
        return { content: 'done', toolCalls: undefined };
      },
      isAvailable: async () => true,
    };
    const { loop } = makeLoop(provider);
    for await (const _e of loop.run([msg('hi')], {}, new AbortController().signal)) { /* drain */ }
    // The model must always be given an instruction to answer directly.
    expect(received.length).toBeGreaterThan(0);
    for (const r of received) {
      expect(r.systemPrompt).toBeDefined();
      expect((r.systemPrompt ?? '').length).toBeGreaterThan(0);
      expect(r.systemPrompt!.toLowerCase()).toMatch(/answer|回答|直接/i);
    }
  });
});
