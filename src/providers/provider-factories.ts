import type { AIProvider } from '../types';
import type { AIProviderConfig } from '../settings/settings';
import { OpenAIProvider } from './openai-provider';
import { AnthropicProvider } from './anthropic-provider';
import { OllamaProvider } from './ollama-provider';

/** Factories are selected at composition time; routing only uses declared capabilities. */
export interface ProviderFactory {
  readonly requiresApiKey?: boolean;
  create(config: AIProviderConfig): AIProvider;
  canEmbed(config: AIProviderConfig): boolean;
}
export type ProviderFactories = Readonly<Record<string, ProviderFactory>>;

export const BUILTIN_PROVIDER_FACTORIES: ProviderFactories = Object.freeze({
  openai: {
    requiresApiKey: true,
    create: config => new OpenAIProvider({ ...config, apiKey: config.apiKey!, baseURL: config.baseURL || 'https://api.openai.com/v1' }),
    canEmbed: config => !!config.embeddingModel?.trim(),
  },
  anthropic: {
    requiresApiKey: true,
    create: config => new AnthropicProvider({ ...config, apiKey: config.apiKey! }),
    canEmbed: () => false,
  },
  ollama: {
    create: config => new OllamaProvider({ ...config, baseURL: config.baseURL || 'http://localhost:11434' }),
    canEmbed: config => !!config.embeddingModel?.trim(),
  },
});
