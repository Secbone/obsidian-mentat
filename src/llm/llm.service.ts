import type { PluginObject, Context } from '../core/cordis';
import type { LLMCapabilities, LLMProvider, LLMTask } from './contract';

/**
 * Model registry (L2.1). Providers register themselves; the `llm` service
 * routes tasks to providers. A provider registration is a reversible effect,
 * so unloading a provider fiber unregisters it and dependents are notified.
 *
 * Services with tools/embeddings declare capability flags and are discovered
 * by routing: `providersFor(task)` filters by capability.
 */
export class LLMRegistry {
  private providers = new Map<string, LLMProvider>();
  private _routing: Record<string, string> = {};

  /** Register a provider; returns an unregister function (reversible). */
  register(provider: LLMProvider): () => void {
    if (this.providers.has(provider.id)) {
      throw new Error(`LLM provider "${provider.id}" is already registered`);
    }
    this.providers.set(provider.id, provider);
    return () => this.providers.delete(provider.id);
  }

  unregister(id: string): void {
    this.providers.delete(id);
  }

  get(id: string): LLMProvider | undefined {
    return this.providers.get(id);
  }

  list(): LLMProvider[] {
    return [...this.providers.values()];
  }

  /** Providers capable of a task. */
  providersFor(task: LLMTask): LLMProvider[] {
    const cap: Record<LLMTask, keyof LLMCapabilities> = {
      chat: 'chat',
      embedding: 'embeddings',
      classification: 'chat',
      summary: 'chat',
    };
    const key = cap[task];
    return this.list().filter((p) => p.capabilities[key]);
  }

  /** Set explicit per-task routing (provider id or ''=auto). */
  setRouting(task: LLMTask, providerId: string): void {
    this._routing[task] = providerId;
  }

  /** Resolve the provider for a task (explicit routing, else first capable). */
  resolve(task: LLMTask): LLMProvider | undefined {
    const explicit = this._routing[task];
    if (explicit) return this.providers.get(explicit);
    return this.providersFor(task)[0];
  }
}

export const LlmService: PluginObject = {
  apply(ctx: Context) {
    const registry = new LLMRegistry();
    return ctx.provide('llm', registry);
  },
};
