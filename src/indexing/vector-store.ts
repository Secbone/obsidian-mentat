// Vector Store - Stores vectors and performs similarity search

import { FileChunk } from './chunk-processor';

export interface SimilaritySearchResult {
  chunk: FileChunk;
  score: number;
}

export interface SearchOptions {
  topK: number;           // Return top K results (default: 5)
  minScore: number;       // Minimum similarity threshold (default: 0.5)
  filterFiles?: string[]; // Only search in these files
}

export class VectorStore {
  private chunks: Map<string, FileChunk[]> = new Map(); // filePath -> chunks
  private allChunks: FileChunk[] = [];                  // Flattened array for search

  /**
   * Add chunks for a file
   */
  addFileChunks(filePath: string, chunks: FileChunk[]): void {
    this.chunks.set(filePath, chunks);
    this.rebuildIndex();
  }

  /**
   * Add chunks for multiple files in bulk and rebuild the index once
   */
  addFileChunksBulk(fileChunksMap: Map<string, FileChunk[]>): void {
    for (const [filePath, chunks] of fileChunksMap.entries()) {
      this.chunks.set(filePath, chunks);
    }
    this.rebuildIndex();
  }

  /**
   * Remove a file from the store
   */
  removeFile(filePath: string): void {
    this.chunks.delete(filePath);
    this.rebuildIndex();
  }

  /**
   * Get chunks for a specific file
   */
  getFileChunks(filePath: string): FileChunk[] | undefined {
    return this.chunks.get(filePath);
  }

  /**
   * Clear the vector store
   */
  clear(): void {
    this.chunks.clear();
    this.allChunks = [];
  }

  /**
   * Get all indexed file paths
   */
  getFilePaths(): string[] {
    return Array.from(this.chunks.keys());
  }

  /**
   * Search for similar chunks using cosine similarity
   */
  search(
    queryEmbedding: number[],
    options: SearchOptions = { topK: 5, minScore: 0.5 }
  ): SimilaritySearchResult[] {
    // Filter candidates if filterFiles is specified
    const candidates = options.filterFiles
      ? this.allChunks.filter(c => options.filterFiles!.includes(c.filePath))
      : this.allChunks;

    // Calculate cosine similarity for each chunk
    const results = candidates.map(chunk => ({
      chunk,
      score: this.cosineSimilarity(queryEmbedding, chunk.embedding)
    }));

    // Filter by minimum score and sort by score descending
    return results
      .filter(r => r.score >= options.minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, options.topK);
  }

  /**
   * Calculate cosine similarity between two vectors
   */
  private cosineSimilarity(vec1: number[], vec2: number[]): number {
    if (vec1.length !== vec2.length) {
      throw new Error('Vectors must have the same length');
    }

    let dotProduct = 0;
    let norm1 = 0;
    let norm2 = 0;

    for (let i = 0; i < vec1.length; i++) {
      dotProduct += vec1[i] * vec2[i];
      norm1 += vec1[i] * vec1[i];
      norm2 += vec2[i] * vec2[i];
    }

    const denominator = Math.sqrt(norm1) * Math.sqrt(norm2);

    // Avoid division by zero
    if (denominator === 0) {
      return 0;
    }

    return dotProduct / denominator;
  }

  /**
   * Rebuild the flattened index
   */
  rebuildIndex(): void {
    this.allChunks = [];
    for (const chunks of this.chunks.values()) {
      this.allChunks.push(...chunks);
    }
  }

  /**
   * Serialize the store for persistence (used for migration)
   */
  serialize(): string {
    const data = {
      chunks: Array.from(this.chunks.entries())
    };
    return JSON.stringify(data);
  }

  /**
   * Deserialize from stored data
   */
  deserialize(data: string): void {
    const parsed = JSON.parse(data);
    this.chunks = new Map(parsed.chunks);
    this.rebuildIndex();
  }

  /**
   * Get statistics about the store
   */
  getStats() {
    return {
      totalFiles: this.chunks.size,
      totalChunks: this.allChunks.length,
      avgChunksPerFile: this.chunks.size > 0
        ? this.allChunks.length / this.chunks.size
        : 0
    };
  }
}
