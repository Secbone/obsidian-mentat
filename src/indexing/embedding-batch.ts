// Embedding Batch - Optimizes embedding generation through batching

import PersonalAgentPlugin from '../main';
import { TaskType } from '../types';

export interface BatchEmbeddingResult {
  embeddings: number[][];
  tokens: number;
  cost?: number;
}

export class EmbeddingBatch {
  constructor(
    private plugin: PersonalAgentPlugin,
    private batchSize: number = 10
  ) {}

  /**
   * Generate embeddings for multiple texts
   */
  async generateBatch(texts: string[]): Promise<BatchEmbeddingResult> {
    const provider = await this.plugin.aiRouter.getProvider(TaskType.EMBEDDING);

    // Check if provider supports batch generation
    if (provider.supportsBatch && typeof provider.supportsBatch === 'function' && provider.supportsBatch()) {
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
    provider: any
  ): Promise<BatchEmbeddingResult> {
    // If provider supports native batch API
    const result = await provider.generateEmbeddings(texts);
    return result;
  }

  /**
   * Generate embeddings sequentially in batches
   */
  private async generateBatchSequential(
    texts: string[],
    provider: any
  ): Promise<BatchEmbeddingResult> {
    const embeddings: number[][] = [];
    let totalTokens = 0;

    // Process in batches to avoid overwhelming the API
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);

      // Generate embeddings concurrently for current batch
      const batchResults = await Promise.all(
        batch.map(text => provider.generateEmbedding(text))
      );

      embeddings.push(...batchResults.map(r => r.embedding));
      totalTokens += batchResults.reduce((sum, r) => sum + (r.tokens || 0), 0);

      // Add delay to avoid rate limiting (except for last batch)
      if (i + this.batchSize < texts.length) {
        await this.delay(100);
      }
    }

    return { embeddings, tokens: totalTokens };
  }

  /**
   * Delay helper
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
