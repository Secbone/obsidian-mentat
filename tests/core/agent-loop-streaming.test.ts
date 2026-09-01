import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { AgentLoopService } from '../../src/agents/loop.service';
import { ToolsRegistry } from '../../src/tools/tools.service';
import { ContextWindowService } from '../../src/session/context.service';
import { CompactionService, SummarizeCompactionStrategy } from '../../src/session/compaction.service';
import { LLMRegistry } from '../../src/llm/llm.service';
import type { LLMProvider, LLMToolDefinition } from '../../src/llm/contract';
import type { ChatMessage } from '../../src/types';

function msg(content: string): ChatMessage { return { role: 'user', content, timestamp: Date.now() }; }

function makeLoop(provider: LLMProvider, tools?: ToolsRegistry) {
  const llm = new LLMRegistry();
  llm.register(provider);
  const toolsRegistry = tools ?? new ToolsRegistry();
  const loop = new AgentLoopService(
    llm, toolsRegistry,
    new ContextWindowService(), new CompactionService(new ContextWindowService()),
  );
  loop['compaction'].register(new SummarizeCompactionStrategy());
  return { loop, tools: toolsRegistry };
}

describe('AgentLoopService — streaming contract', () => {
  it('yields each message delta as it arrives, BEFORE the provider turn resolves (regression: buffered streaming)', async () => {
    let releaseTurn!: () => void;
    let providerFinished = false;
    const provider: LLMProvider = {
      id: 'p', name: 'P', capabilities: { chat: true, streaming: true, embeddings: false, tools: true },
      generate: async () => '',
      generateStream: async () => {},
      generateWithTools: async (_, onChunk) => {
        onChunk?.({ delta: 'first ' });                 // push immediately...
        await new Promise<void>((res) => { releaseTurn = res; }); // ...then HOLD the turn open
        onChunk?.({ delta: 'second' });                 // second delta only after release
        providerFinished = true;
        return { content: 'first second', toolCalls: undefined };
      },
      getContextWindow: () => 8000, getCompactionThreshold: () => 6000, isAvailable: async () => true,
    };
    const { loop } = makeLoop(provider);
    const it = loop.run([msg('hi')], {}, new AbortController().signal)[Symbol.asyncIterator]();

    await it.next(); // agent:start
    await it.next(); // turn:start

    // The FIRST delta must be receivable WITHOUT releasing the provider's
    // turn. The old buffered implementation blocked here until the whole turn
    // resolved — this assertion is exactly what would have caught that bug.
    const step1 = it.next();
    const m1 = await Promise.race([
      step1.then((r) => ({ ...r })),
      new Promise<{ __timeout: true }>((res) => setTimeout(() => res({ __timeout: true }), 300)),
    ]);
    if ('__timeout' in m1) {
      throw new Error('agent-loop did not stream the first delta until the provider turn resolved');
    }
    expect(m1.value.type).toBe('message:update');
    expect(m1.value.delta).toBe('first ');
    expect(providerFinished).toBe(false); // provider is STILL mid-turn while we already streamed a delta

    releaseTurn();
    const m2 = await it.next();
    expect(m2.value.type).toBe('message:update');
    expect(m2.value.delta).toBe('second');
    expect((await it.next()).value.type).toBe('turn:end');
  });
});

describe('AgentLoopService — tools advertised to the model', () => {
  it('passes the registered tools to the provider via options.tools (regression: tools never sent)', async () => {
    let received: LLMToolDefinition[] | undefined;
    const provider: LLMProvider = {
      id: 'p', name: 'P', capabilities: { chat: true, streaming: true, embeddings: false, tools: true },
      generate: async () => '',
      generateStream: async () => {},
      generateWithTools: async (_msgs, onChunk, options) => {
        received = options?.tools;
        onChunk?.({ delta: 'ok' });
        return { content: 'ok', toolCalls: undefined };
      },
      getContextWindow: () => 8000, getCompactionThreshold: () => 6000, isAvailable: async () => true,
    };
    const tools = new ToolsRegistry();
    tools.register({
      name: 'vault_read',
      description: 'Read a note from the vault',
      schema: z.object({ path: z.string() }),
      permissions: ['documents:read'],
      execute: async () => ({ success: true, data: {} }),
    });
    const { loop } = makeLoop(provider, tools);

    const events: string[] = [];
    for await (const e of loop.run([msg('read a.md')], {}, new AbortController().signal)) events.push(e.type);

    expect(received).toBeDefined();
    expect(received!.length).toBe(1);
    expect(received![0].name).toBe('vault_read');
    expect(received![0].description).toBe('Read a note from the vault');
    // zod schema -> JSON Schema parameters
    expect(received![0].parameters?.properties).toEqual({ path: { type: 'string' } });
    expect(received![0].parameters?.required).toContain('path');
    expect(events).toContain('agent:end');
  });

  it('does NOT advertise tools when the provider lacks tool support', async () => {
    const generate = vi.fn(async () => 'plain');
    const provider: LLMProvider = {
      id: 'p', name: 'P', capabilities: { chat: true, streaming: true, embeddings: false, tools: false },
      generate, generateStream: async () => {},
      getContextWindow: () => 8000, getCompactionThreshold: () => 6000, isAvailable: async () => true,
    };
    const { loop } = makeLoop(provider);
    for await (const _e of loop.run([msg('hi')], {}, new AbortController().signal)) { /* drain */ }
    expect(generate).toHaveBeenCalled();
  });
});

describe('AgentLoopService — tool execution round-trip', () => {
  it('pairs assistant tool_calls with matching tool-result messages on the follow-up turn', async () => {
    const calls: ChatMessage[][] = [];
    const provider: LLMProvider = {
      id: 'p', name: 'P', capabilities: { chat: true, streaming: true, embeddings: false, tools: true },
      generate: async () => '',
      generateStream: async () => {},
      generateWithTools: async (msgs, onChunk) => {
        calls.push(msgs);
        if (calls.length === 1) {
          onChunk?.({ delta: 'tool time' });
          return { content: 'tool time', toolCalls: [{ id: 'call_1', name: 'vault_read', arguments: { path: 'a.md' } }] };
        }
        onChunk?.({ delta: 'done' });
        return { content: 'done', toolCalls: undefined };
      },
      getContextWindow: () => 8000, getCompactionThreshold: () => 6000, isAvailable: async () => true,
    };
    const tools = new ToolsRegistry();
    const readFn = vi.fn(async () => ({ success: true, data: { content: 'hello' } }));
    tools.register({
      name: 'vault_read', description: '', permissions: ['documents:read'], execute: readFn,
    });
    const { loop } = makeLoop(provider, tools);

    const events: string[] = [];
    for await (const e of loop.run([msg('read a.md')], {}, new AbortController().signal)) events.push(e.type);

    // Two provider calls: initial + follow-up with the tool result.
    expect(calls.length).toBe(2);
    expect(readFn).toHaveBeenCalledTimes(1);
    expect(readFn).toHaveBeenCalledWith({ path: 'a.md' }, expect.anything());

    const second = calls[1];
    const assistant = second.find((m) => m.role === 'assistant');
    expect(assistant?.tool_calls).toEqual([{ id: 'call_1', name: 'vault_read', arguments: { path: 'a.md' } }]);
    const tool = second.find((m) => m.role === 'tool');
    expect(tool?.tool_call_id).toBe('call_1');
    expect(tool?.name).toBe('vault_read');
    expect(JSON.parse(tool!.content)).toEqual({ success: true, data: { content: 'hello' } });

    expect(events.filter((e) => e === 'tool:start').length).toBe(1);
    expect(events.filter((e) => e === 'tool:end').length).toBe(1);
    expect(events).toContain('turn:end');
  });
});

describe('AgentLoopService — failure handling', () => {
  it('emits system:error when no chat provider is resolved', async () => {
    const llm = new LLMRegistry(); // empty registry -> no provider
    const loop = new AgentLoopService(llm, new ToolsRegistry(), new ContextWindowService(), new CompactionService(new ContextWindowService()));
    loop['compaction'].register(new SummarizeCompactionStrategy());
    const events: string[] = [];
    for await (const e of loop.run([msg('hi')], {}, new AbortController().signal)) events.push(e.type);
    expect(events).toContain('system:error');
    expect(events).not.toContain('message:update'); // no generation happened
  });

  it('honours an already-aborted signal', async () => {
    const ac = new AbortController();
    ac.abort();
    const provider: LLMProvider = {
      id: 'p', name: 'P', capabilities: { chat: true, streaming: true, embeddings: false, tools: true },
      generate: async () => '', generateStream: async () => {},
      generateWithTools: async () => ({ content: '', toolCalls: undefined }),
      getContextWindow: () => 8000, getCompactionThreshold: () => 6000, isAvailable: async () => true,
    };
    const { loop } = makeLoop(provider);
    const events: string[] = [];
    for await (const e of loop.run([msg('hi')], {}, ac.signal)) events.push(e.type);
    // Aborted before any generation -> abort event, no message stream
    expect(events).toContain('agent:error');
    expect(events).not.toContain('message:update');
  });
});
