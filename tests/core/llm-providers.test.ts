import { describe, it, expect } from 'vitest';
import { Context } from '../../src/core/cordis';
import { LlmService, LLMRegistry } from '../../src/llm/llm.service';
import { LlmProvidersService } from '../../src/llm/providers.service';
import { DEFAULT_SETTINGS, type MentatSettings } from '../../src/settings/settings';

function settingsWith(aiProviders: unknown[]): MentatSettings {
  return structuredClone({ ...DEFAULT_SETTINGS, aiProviders });
}

describe('LlmProvidersService (L2.2)', () => {
  it('registers enabled providers (with API key) from settings into the llm registry', async () => {
    const ctx = new Context();
    ctx.provide('settings', settingsWith([
      { id: 'openai-main', type: 'openai', name: 'OpenAI', enabled: true, apiKey: 'sk-xxx', model: 'gpt-4o', baseURL: 'https://api.openai.com/v1' },
      { id: 'no-key', type: 'anthropic', name: 'Anthropic', enabled: true, apiKey: '', model: 'claude' },
    ] as never));
    await ctx.plugin(LlmService);
    await ctx.plugin(LlmProvidersService);

    const registry = ctx.get<LLMRegistry>('llm', false)!;
    expect(registry.get('openai-main')).toBeTruthy();
    // disabled/empty-key providers are skipped
    expect(registry.get('no-key')).toBeUndefined();
  });

  it('reacts to settings:update — registers a newly added provider', async () => {
    const ctx = new Context();
    const settings = settingsWith([
      { id: 'a', type: 'openai', name: 'A', enabled: true, apiKey: 'k', model: 'm', baseURL: 'https://x' },
    ] as never);
    ctx.provide('settings', settings);
    await ctx.plugin(LlmService);
    await ctx.plugin(LlmProvidersService);
    const registry = ctx.get<LLMRegistry>('llm', false)!;

    expect(registry.get('a')).toBeTruthy();

    // Simulate a settings change: two providers now.
    (settings.aiProviders as never[]).push({ id: 'b', type: 'anthropic', name: 'B', enabled: true, apiKey: 'k2', model: 'claude' } as never);
    ctx.emit('settings:update', settings);

    expect(registry.get('b')).toBeTruthy();
    expect(registry.get('a')).toBeTruthy();
  });

  it('skips ollama with no local node check (registers by config)', async () => {
    const ctx = new Context();
    ctx.provide('settings', settingsWith([
      { id: 'local', type: 'ollama', name: 'Ollama', enabled: true, model: 'llama3', baseURL: 'http://localhost:11434' },
    ] as never));
    await ctx.plugin(LlmService);
    await ctx.plugin(LlmProvidersService);
    const registry = ctx.get<LLMRegistry>('llm', false)!;
    expect(registry.get('local')).toBeTruthy();
    expect(registry.get('local')!.capabilities.embeddings).toBe(true);
  });
});
