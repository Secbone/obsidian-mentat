// Embedding Batch - Optimizes embedding generation through batching

import { AIProvider } from '../types';

export interface BatchEmbeddingResult {
  embeddings: number[][];
  tokens: number;
  cost?: number;
}

export class EmbeddingBatch {
  constructor(
    private getEmbeddingProvider: () => Promise<AIProvider>,
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

    // If provider supports native batching (via generateEmbeddings method)
    if (provider.generateEmbeddings && typeof provider.generateEmbeddings === 'function') {
      return await this.generateBatchNative(texts, provider);
    } else {
      return await this.generateBatchSequential(texts, provider);
    }
  }

  /**
   * Use provider's native batch API
   */
  private async generateBatchNative(
    texts: string[],
    provider: AIProvider
  ): Promise<BatchEmbeddingResult> {
    const embeddings: number[][] = [];
    let totalTokens = 0;

    // Process in batches (e.g., 100 at a time) to avoid payload limits
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);

      const result = await this.retryWithBackoff(async () => {
        return await provider.generateEmbeddings!(batch);
      });

      embeddings.push(...result.embeddings);
      totalTokens += result.tokens || 0;
    }

    return { embeddings, tokens: totalTokens };
  }

  /**
   * Generate embeddings sequentially/concurrently with retry fallback
   */
  private async generateBatchSequential(
    texts: string[],
    provider: AIProvider
  ): Promise<BatchEmbeddingResult> {
    const embeddings: number[][] = [];
    let totalTokens = 0;
    const sequentialBatchSize = 10; // Keep concurrency moderate for individual requests

    // Process in batches to avoid overwhelming the API
    for (let i = 0; i < texts.length; i += sequentialBatchSize) {
      const batch = texts.slice(i, i + sequentialBatchSize);

      // Generate embeddings concurrently for current batch with individual retries
      const batchResults = await Promise.all(
        batch.map(text =>
          this.retryWithBackoff(async () => {
            return await provider.generateEmbedding(text);
          })
        )
      );

      embeddings.push(...batchResults.map(r => r.embedding));
      totalTokens += batchResults.reduce((sum, r) => sum + (r.tokens || 0), 0);

      // Add delay to avoid rate limiting (except for last batch)
      if (i + sequentialBatchSize < texts.length) {
        await this.delay(100);
      }
    }

    return { embeddings, tokens: totalTokens };
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
      if (retries <= 0) {
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
    return new Promise(resolve => window.setTimeout(resolve, ms));
  }
}
