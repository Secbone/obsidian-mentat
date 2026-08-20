import { describe, it, expect } from 'vitest';
import { Context } from '../../src/core/cordis';
import { LLMRegistry, LlmService } from '../../src/llm/llm.service';
import type { LLMProvider } from '../../src/llm/contract';

function makeProvider(id: string, capabilities: Partial<LLMProvider['capabilities']> = {}): LLMProvider {
  return {
    id,
    name: id,
    capabilities: { chat: true, streaming: true, embeddings: false, tools: false, ...capabilities },
    generate: async () => 'reply',
    generateStream: async () => {},
    embed: async () => [],
    getContextWindow: () => 8000,
    getCompactionThreshold: () => 6000,
    isAvailable: async () => true,
  };
}

describe('LLMRegistry (L2.1)', () => {
  it('registers, lists, gets and reversibly unregisters providers', () => {
    const r = new LLMRegistry();
    const p = makeProvider('openai');
    const unregister = r.register(p);
    expect(r.get('openai')).toBe(p);
    expect(r.list().map((x) => x.id)).toEqual(['openai']);
    unregister();
    expect(r.get('openai')).toBeUndefined();
  });

  it('rejects duplicate provider ids', () => {
    const r = new LLMRegistry();
    r.register(makeProvider('anthropic'));
    expect(() => r.register(makeProvider('anthropic'))).toThrow(/already registered/);
  });

  it('providersFor filters by capability; resolve uses routing or first capable', () => {
    const r = new LLMRegistry();
    r.register(makeProvider('chat-only', { embeddings: false }));
    r.register(makeProvider('embed', { chat: false, streaming: false, embeddings: true }));

    expect(r.providersFor('embedding').map((x) => x.id)).toEqual(['embed']);
    expect(r.resolve('chat')!.id).toBe('chat-only');

    // explicit routing overrides
    r.setRouting('chat', 'embed'); // (not sensible, but proves override)
    expect(r.resolve('chat')!.id).toBe('embed');
  });

  it('LlmService provides the registry on the context and unload recovers it', async () => {
    const ctx = new Context();
    await ctx.plugin(LlmService);
    const r = ctx.get<LLMRegistry>('llm', false)!;
    expect(r).toBeInstanceOf(LLMRegistry);

    await ctx.fiber.dispose();
    expect(ctx.get('llm', false)).toBeUndefined();
  });
});
