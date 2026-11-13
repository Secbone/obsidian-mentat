import type { Observer } from '../observability/observer';
// AI Router - Intelligent routing of tasks to appropriate AI providers

import { AIProvider } from '../types';
import { TaskType } from '../types';
import { MentatSettings } from '../settings/settings';
import { BUILTIN_PROVIDER_FACTORIES, type ProviderFactories } from './provider-factories';

export class AIRouter {
  private providers: Map<string, AIProvider> = new Map();
  private settings: MentatSettings;
  private embeddingProviders = new Set<string>();
  private factories: ProviderFactories;
  private initializationErrors: unknown[] = [];

  constructor(settings: MentatSettings, private observer?: Observer, factories: ProviderFactories = BUILTIN_PROVIDER_FACTORIES) {
    this.settings = structuredClone(settings);
    this.factories = Object.freeze(Object.fromEntries(Object.entries(factories).map(([type, factory]) => [type, Object.freeze({ ...factory })])));
    this.initializeProviders();
  }

  private initializeProviders(): void {
    this.providers.clear();
    this.embeddingProviders.clear();

    for (const config of this.settings.aiProviders) {
      if (!config.enabled) continue;

      try {
        const factory = this.factories[config.type];
        if (!factory || factory.requiresApiKey && !config.apiKey) {
          this.observer?.event('provider:skipped', { component: 'provider', level: 'warn', attributes: { providerId: config.id,
            reason: factory ? 'missing_api_key' : 'missing_factory' } });
          continue;
        }
        const provider = factory.create({ ...config });
        if (provider.id !== config.id) throw new Error('Provider factory returned a different instance ID');
        const canEmbed = factory.canEmbed(config);
        this.providers.set(config.id, provider);
        if (canEmbed) this.embeddingProviders.add(config.id);
      } catch (error) {
        this.initializationErrors.push(error);
        this.observer?.error('provider:initialize:failed', error, { component: 'provider', attributes: { providerId: config.id } });
      }
    }
  }

  /**
   * Get the best available provider for a specific task type
   */
  async getProvider(taskType: TaskType): Promise<AIProvider | null> {
    const capable = (provider: AIProvider | undefined): provider is AIProvider => !!provider && (
      taskType !== TaskType.EMBEDDING || this.embeddingProviders.has(provider.id)
    );
    // 1. Try task-specific routing
    const taskProviderId = this.settings.taskRouting[taskType];
    if (taskProviderId) {
      const provider = this.providers.get(taskProviderId);
      if (capable(provider)) {
        return provider;
      }
    }

    // 2. Try default provider
    if (this.settings.defaultProvider) {
      const provider = this.providers.get(this.settings.defaultProvider);
      if (capable(provider)) {
        return provider;
      }
    }

    // 3. Find any available provider based on task requirements
    for (const provider of this.providers.values()) {
      // For embedding tasks, only use providers that support it
      if (taskType === TaskType.EMBEDDING) {
        if (capable(provider)) {
          return provider;
        }
      } else {
        // For other tasks, any provider works
        return provider;
      }
    }

    return null;
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
  refresh(settings: MentatSettings): void {
    const candidate = this.prepare(settings);
    this.settings = candidate.settings;
    this.providers = candidate.providers;
    this.embeddingProviders = candidate.embeddingProviders;
  }

  /** Build a complete candidate without changing the router used by existing runs. */
  prepare(settings: MentatSettings): AIRouter {
    const candidate = new AIRouter(settings, this.observer, this.factories);
    if (candidate.initializationErrors.length) throw new Error('模型实现初始化失败，当前路由保持不变。', { cause: candidate.initializationErrors[0] });
    return candidate;
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
        this.observer?.error('provider:test:failed', error, { component: 'provider', attributes: { providerId: id } });
        results.set(id, false);
      }
    }

    return results;
  }
}
