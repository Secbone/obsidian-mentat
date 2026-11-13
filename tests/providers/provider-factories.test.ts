import { describe, expect, it, vi } from 'vitest';
vi.mock('obsidian');
import { AIRouter } from '../../src/providers/ai-router';
import type { ProviderFactories } from '../../src/providers/provider-factories';
import { BUILTIN_PROVIDER_FACTORIES } from '../../src/providers/provider-factories';
import { DEFAULT_SETTINGS, type AIProviderConfig } from '../../src/settings/settings';
import { TaskType, type AIProvider } from '../../src/types';

const config: AIProviderConfig = { id: 'local-protocol', name: 'local', type: 'openai', enabled: true,
  model: 'model-a', supportsStreaming: true, supportsEmbedding: false };
const settings = () => ({ ...structuredClone(DEFAULT_SETTINGS), aiProviders: [{ ...config }], defaultProvider: config.id });
function localFactories(canEmbed = false): ProviderFactories {
  return { openai: { create: c => ({ id: c.id, name: c.model, type: c.type, isAvailable: async () => true } as AIProvider), canEmbed: () => canEmbed } };
}

describe('Provider composition factories', () => {
  it('replaces an adapter through composition while retaining routing and instance IDs', async () => {
    const router = new AIRouter(settings(), undefined, localFactories(true));
    expect(await router.getProvider(TaskType.CHAT)).toMatchObject({ id: config.id, name: 'model-a' });
    // Capability belongs to the implementation, rather than the provider type label or UI flag.
    expect((await router.getProvider(TaskType.EMBEDDING))?.id).toBe(config.id);
    expect(await new AIRouter(settings(), undefined, localFactories(false)).getProvider(TaskType.EMBEDDING)).toBeNull();
  });

  it('prepares a candidate without changing the bound configuration or provider instance', async () => {
    const data = settings(), router = new AIRouter(data, undefined, localFactories());
    const original = await router.getProvider(TaskType.CHAT);
    data.aiProviders[0].model = 'model-b'; data.defaultProvider = 'missing';
    const candidate = router.prepare(data);
    expect(await router.getProvider(TaskType.CHAT)).toBe(original);
    expect(original?.name).toBe('model-a');
    expect((await candidate.getProvider(TaskType.CHAT))?.name).toBe('model-b');
    expect(await candidate.getProvider(TaskType.CHAT)).not.toBe(original);
  });

  it('keeps injected factories for refresh and refuses a broken candidate without replacing the old instance', async () => {
    const data = settings(), factories = localFactories();
    const create = vi.fn((c: AIProviderConfig) => {
      if (c.model === 'broken') throw new Error('adapter failed');
      return factories.openai.create(c);
    });
    const router = new AIRouter(data, undefined, { openai: { ...factories.openai, create } });
    const original = router.getProviderById(config.id);
    data.aiProviders[0].model = 'broken';
    expect(() => router.refresh(data)).toThrow('保持不变');
    expect(router.getProviderById(config.id)).toBe(original);
    data.aiProviders[0].model = 'model-c'; router.refresh(data);
    expect(router.getProviderById(config.id)?.name).toBe('model-c');
    expect(create).toHaveBeenCalledTimes(3);
  });

  it('does not retain an externally mutated factory table', async () => {
    const factory = localFactories().openai, table = { openai: factory };
    const router = new AIRouter(settings(), undefined, table);
    table.openai = { create: () => { throw new Error('mutated'); }, canEmbed: () => false };
    expect((await router.prepare(settings()).getProvider(TaskType.CHAT))?.id).toBe(config.id);
  });

  it('enforces factory credential requirements and provider identity at the boundary', () => {
    const create = vi.fn(localFactories().openai.create);
    expect(new AIRouter(settings(), undefined, { openai: { create, requiresApiKey: true, canEmbed: () => false } }).getAllProviders()).toEqual([]);
    expect(create).not.toHaveBeenCalled();
    const factories: ProviderFactories = { openai: { create: () => ({ id: 'wrong' } as AIProvider), canEmbed: () => true } };
    expect(new AIRouter(settings(), undefined, factories).getAllProviders()).toEqual([]);
  });

  it('preserves builtin authentication, embedding and DeepSeek output configuration', () => {
    const data = settings(); data.aiProviders[0] = { ...config, apiKey: 'test', baseURL: 'https://api.deepseek.com', reasoningEffort: 'high', maxTokens: 65536 };
    const router = new AIRouter(data, undefined, BUILTIN_PROVIDER_FACTORIES);
    expect(router.getProviderById(config.id)?.getMaxOutputTokens?.()).toBe(65536);
    expect(router.getProviderById(config.id)?.getRequestMetadata?.()).toMatchObject({ reasoningEffort: 'high' });
  });
});
