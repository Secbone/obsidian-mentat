import type { AIProvider } from '../types';
import type { LLMProvider } from './contract';
import { TaskType } from '../types';

/**
 * Adapter: wraps an existing `AIProvider` (OpenAI/Anthropic/Ollama SDK
 * implementations) as an `LLMProvider`, so the new `llm` registry can consume
 * the mature legacy providers without rewriting them.
 *
 * Capability flags are derived from the provider's runtime methods.
 */
export function adaptLegacyProvider(source: AIProvider): LLMProvider {
  const capabilities = {
    chat: true,
    streaming: true,
    embeddings: typeof source.embed === 'function' || typeof source.generateEmbedding === 'function',
    tools: typeof source.supportsSkills === 'function' && source.supportsSkills(),
  };
  return {
    id: source.id,
    name: source.name,
    capabilities,
    async generate(messages, options) {
      const prompt = messages.at(-1)?.content ?? '';
      return source.generate(prompt, {
        temperature: options?.temperature,
        maxTokens: options?.maxTokens,
        abortSignal: options?.signal,
      });
    },
    async generateStream(messages, onChunk, options) {
      const prompt = messages.at(-1)?.content ?? '';
      await source.generateStream(prompt, (delta) => onChunk({ delta }), {
        temperature: options?.temperature,
        maxTokens: options?.maxTokens,
        abortSignal: options?.signal,
      });
    },
    async generateWithTools(messages, onChunk, options) {
      if (capabilities.tools) {
        const result = await source.generateStreamWithSkills!(
          messages,
          (delta) => onChunk?.({ delta }),
          undefined,
          { temperature: options?.temperature, maxTokens: options?.maxTokens, abortSignal: options?.signal },
        );
        return { content: result.content ?? '', toolCalls: result.toolCalls };
      }
      const content = await source.generate(messages.at(-1)?.content ?? '', options as never);
      return { content };
    },
    async embed(texts) {
      if (typeof source.embeds === 'function') return source.embeds(texts);
      const out: number[][] = [];
      for (const t of texts) out.push(await source.embed(t));
      return out;
    },
    getContextWindow: () => source.getContextWindow(),
    getCompactionThreshold: () => source.getCompactionThreshold(),
    isAvailable: () => source.isAvailable(),
    // Legacy router-compatible source for fallback.
  };
}

/** Task-type mapping from the legacy router for provider selection. */
export const LEGACY_TASK_EMBEDDING = TaskType.EMBEDDING;
