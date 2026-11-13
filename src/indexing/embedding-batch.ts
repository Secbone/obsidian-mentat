// Embedding Batch - Optimizes embedding generation through batching

import type { AIProvider } from '../types';
import type { Embedder } from '../contracts/model';
import { asEmbedder } from '../providers/model-adapters';

export interface BatchEmbeddingResult {
  embeddings: number[][];
  tokens: number;
  cost?: number;
}

export class EmbeddingBatch {
  constructor(
    private getEmbeddingProvider: () => Promise<AIProvider | Embedder | null>,
    private batchSize: number = 100 // Larger batch size for native batching
  ) {}

  /**
   * Generate embeddings for multiple texts
   */
  async generateBatch(texts: string[]): Promise<BatchEmbeddingResult> {
    if (texts.length === 0) {
      return { embeddings: [], tokens: 0 };
    }

    const provider = await this.getEmbeddingProvider();
    if (!provider) {
      throw new Error('未配置向量模型，已跳过向量索引。');
    }

    const embedder = asEmbedder(provider);
    const embeddings: number[][] = [];
    let tokens = 0;
    for (let start = 0; start < texts.length; start += this.batchSize) {
      const result = await this.retryWithBackoff(() => embedder.embed(texts.slice(start, start + this.batchSize)));
      embeddings.push(...result.embeddings); tokens += result.tokens || 0;
    }
    return { embeddings, tokens };
  }

  /**
   * Retry an async operation with exponential backoff
   */
  private async retryWithBackoff<T>(
    fn: () => Promise<T>,
    retries: number = 3,
    delayMs: number = 200
  ): Promise<T> {
    try {
      return await fn();
    } catch (error: unknown) {
      const status = (error as { status?: number })?.status;
      if (retries <= 0 || /not configured|no .*configured|未配置|invalid|unauthorized|forbidden/i.test(String(error)) || (status && status >= 400 && status < 500 && status !== 408 && status !== 429)) {
        throw error;
      }
      console.warn(`Embedding request failed. Retrying in ${delayMs}ms... (Retries left: ${retries}). Error: ${error instanceof Error ? error.message : String(error)}`);
      await this.delay(delayMs);
      return this.retryWithBackoff(fn, retries - 1, delayMs * 2);
    }
  }

  /**
   * Delay helper
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
