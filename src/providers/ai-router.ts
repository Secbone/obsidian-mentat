// AI Router - Intelligent routing of tasks to appropriate AI providers

import { AIProvider } from '../types';
import { TaskType } from '../types';
import { PersonalAgentSettings } from '../settings/settings';
import { OpenAIProvider } from './openai-provider';
import { AnthropicProvider } from './anthropic-provider';
import { OllamaProvider } from './ollama-provider';

export class AIRouter {
  private providers: Map<string, AIProvider> = new Map();
  private settings: PersonalAgentSettings;

  constructor(settings: PersonalAgentSettings) {
    this.settings = settings;
    this.initializeProviders();
  }

  private initializeProviders(): void {
    this.providers.clear();

    for (const config of this.settings.aiProviders) {
      if (!config.enabled) continue;

      try {
        let provider: AIProvider;

        switch (config.type) {
          case 'openai':
            provider = new OpenAIProvider({
              id: config.id,
              apiKey: config.apiKey!,
              baseURL: config.baseURL || 'https://api.openai.com/v1',
              model: config.model,
              embeddingModel: config.embeddingModel,
              temperature: config.temperature,
              maxTokens: config.maxTokens
            });
            break;

          case 'anthropic':
            provider = new AnthropicProvider({
              id: config.id,
              apiKey: config.apiKey!,
              model: config.model,
              temperature: config.temperature,
              maxTokens: config.maxTokens
            });
            break;

          case 'ollama':
            provider = new OllamaProvider({
              id: config.id,
              baseURL: config.baseURL || 'http://localhost:11434',
              model: config.model,
              embeddingModel: config.embeddingModel,
              temperature: config.temperature,
              maxTokens: config.maxTokens
            });
            break;

          default:
            console.warn(`Unknown provider type: ${config.type}`);
            continue;
        }

        this.providers.set(config.id, provider);
      } catch (error) {
        console.error(`Failed to initialize provider ${config.id}:`, error);
      }
    }
  }

  /**
   * Get the best available provider for a specific task type
   */
  async getProvider(taskType: TaskType): Promise<AIProvider> {
    // 1. Try task-specific routing
    const taskProviderId = this.settings.taskRouting[taskType];
    if (taskProviderId) {
      const provider = this.providers.get(taskProviderId);
      if (provider) {
        return provider;
      }
    }

    // 2. Try default provider
    if (this.settings.defaultProvider) {
      const provider = this.providers.get(this.settings.defaultProvider);
      if (provider) {
        return provider;
      }
    }

    // 3. Find any available provider based on task requirements
    for (const provider of this.providers.values()) {
      // For embedding tasks, only use providers that support it
      if (taskType === TaskType.EMBEDDING) {
        if (provider.type === 'ollama' || provider.type === 'openai') {
          return provider;
        }
      } else {
        // For other tasks, any provider works
        return provider;
      }
    }

    throw new Error(`No available AI provider found for task: ${taskType}`);
  }

  /**
   * Get a specific provider by ID
   */
  getProviderById(providerId: string): AIProvider | undefined {
    return this.providers.get(providerId);
  }

  /**
   * Get all available providers
   */
  getAllProviders(): AIProvider[] {
    return Array.from(this.providers.values());
  }

  /**
   * Refresh providers after settings change
   */
  refresh(settings: PersonalAgentSettings): void {
    this.settings = settings;
    this.initializeProviders();
  }

  /**
   * Test all providers
   */
  async testAllProviders(): Promise<Map<string, boolean>> {
    const results = new Map<string, boolean>();

    for (const [id, provider] of this.providers.entries()) {
      try {
        const available = await provider.isAvailable();
        results.set(id, available);
      } catch (error) {
        console.error(`Provider ${id} test failed:`, error);
        results.set(id, false);
      }
    }

    return results;
  }
}
