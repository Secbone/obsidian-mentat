import type { PluginObject, Context } from '../core/cordis';
import { OpenAIProvider } from '../providers/openai-provider';
import { AnthropicProvider } from '../providers/anthropic-provider';
import { OllamaProvider } from '../providers/ollama-provider';
import { adaptLegacyProvider } from './legacy-adapter';
import type { LLMRegistry } from './llm.service';
import type { MentatSettings, AIProviderConfig } from '../settings/settings';

/**
 * Provider registration component (L2.2): reads provider configs from the
 * `settings` service, instantiates the legacy providers (OpenAI/Anthropic/
 * Ollama) and registers them into the `llm` registry as LLMProvider adapters.
 *
 * It subscribes to `settings:update`: when provider config changes, it
 * re-syncs the registry — the Cordis reactive hot-swap pattern for models.
 */
export const LlmProvidersService: PluginObject = {
  inject: ['settings', 'llm'],
  apply(ctx: Context) {
    const settings = ctx.get<MentatSettings>('settings', false)!;
    const registry = ctx.get<LLMRegistry>('llm', false)!;

    const syncProviders = () => {
      // Track current provider ids so removal re-syncs too.
      const want = new Set<string>();
      for (const config of settings.aiProviders) {
        if (!config.enabled) continue;
        try {
          const provider = buildProvider(config);
          if (!provider) continue;
          want.add(config.id);
          if (!registry.get(config.id)) {
            registry.register(adaptLegacyProvider(provider));
            ctx.emit('llm:provider-registered', config.id);
          }
        } catch (error) {
          console.error(`[llm] failed to load provider ${config.id}:`, error);
        }
      }
      // Remove providers whose config was removed/disabled.
      for (const existing of registry.list()) {
        if (!want.has(existing.id)) {
          registry.unregister(existing.id);
          ctx.emit('llm:provider-unregistered', existing.id);
        }
      }
    };

    syncProviders();
    const off = ctx.on('settings:update', () => syncProviders());
    return () => off();
  },
};

function buildProvider(config: AIProviderConfig) {
  switch (config.type) {
    case 'openai':
      if (!config.apiKey) return null;
      return new OpenAIProvider({
        id: config.id,
        apiKey: config.apiKey,
        baseURL: config.baseURL || 'https://api.openai.com/v1',
        model: config.model,
        embeddingModel: config.embeddingModel,
        temperature: config.temperature,
        maxTokens: config.maxTokens,
        contextWindow: config.contextWindow,
        compactionThreshold: config.compactionThreshold,
      });
    case 'anthropic':
      if (!config.apiKey) return null;
      return new AnthropicProvider({
        id: config.id,
        apiKey: config.apiKey,
        model: config.model,
        temperature: config.temperature,
        maxTokens: config.maxTokens,
        contextWindow: config.contextWindow,
        compactionThreshold: config.compactionThreshold,
      });
    case 'ollama':
      return new OllamaProvider({
        id: config.id,
        baseURL: config.baseURL || 'http://localhost:11434',
        model: config.model,
        embeddingModel: config.embeddingModel,
        temperature: config.temperature,
        maxTokens: config.maxTokens,
        contextWindow: config.contextWindow,
        compactionThreshold: config.compactionThreshold,
      });
    default:
      return null;
  }
}
