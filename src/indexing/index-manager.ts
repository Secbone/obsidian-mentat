// Index Manager - Manages the lifecycle of document indexing

import { TFile } from 'obsidian';
import PersonalAgentPlugin from '../main';
import { ContentExtractor } from './content-extractor';
import { ChunkProcessor, FileChunk } from './chunk-processor';
import { VectorStore, SearchOptions, SimilaritySearchResult } from './vector-store';
import { EmbeddingBatch } from './embedding-batch';
import { FileIndex, TaskType } from '../types';

export interface IndexingProgress {
  current: number;
  total: number;
  currentFile: string;
}

export interface IndexStats {
  totalFiles: number;
  totalChunks: number;
  lastIndexTime: number;
  indexSize: number; // bytes
}

export class IndexManager {
  private contentExtractor: ContentExtractor;
  private chunkProcessor: ChunkProcessor;
  private vectorStore: VectorStore;
  private embeddingBatch: EmbeddingBatch;

  // Cache of indexed files with their content hashes
  private indexedFiles: Map<string, string> = new Map(); // filePath -> contentHash

  constructor(private plugin: PersonalAgentPlugin) {
    this.contentExtractor = new ContentExtractor(
      plugin.app,
      plugin.app.metadataCache
    );
    this.chunkProcessor = new ChunkProcessor();
    this.vectorStore = new VectorStore();
    this.embeddingBatch = new EmbeddingBatch(plugin);
  }

  /**
   * Initialize the index manager
   */
  async initialize(): Promise<void> {
    await this.loadIndex();
  }

  /**
   * Index a single file
   */
  async indexFile(file: TFile): Promise<FileIndex> {
    // 1. Extract content and metadata
    const extracted = await this.contentExtractor.extract(file);

    // 2. Calculate content hash
    const contentHash = this.calculateHash(extracted.content);

    // 3. Split into chunks
    const chunks = await this.chunkProcessor.chunkDocument(file, extracted);

    // 4. Generate embeddings for all chunks
    const texts = chunks.map(c => c.content);
    const { embeddings } = await this.embeddingBatch.generateBatch(texts);

    // 5. Assemble complete chunks with embeddings
    const fullChunks: FileChunk[] = chunks.map((chunk, i) => ({
      ...chunk,
      embedding: embeddings[i]
    }));

    // 6. Store in vector store
    this.vectorStore.addFileChunks(file.path, fullChunks);

    // 7. Update cache
    this.indexedFiles.set(file.path, contentHash);

    // 8. Persist
    await this.saveIndex();

    return {
      path: file.path,
      name: file.name,
      content: extracted.content,
      contentHash,
      embedding: embeddings[0], // Use first chunk's embedding as file-level embedding
      metadata: extracted.metadata,
      stats: extracted.stats
    };
  }

  /**
   * Index multiple files with progress callback
   */
  async indexFiles(
    files: TFile[],
    onProgress?: (progress: IndexingProgress) => void
  ): Promise<FileIndex[]> {
    const results: FileIndex[] = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];

      if (onProgress) {
        onProgress({
          current: i + 1,
          total: files.length,
          currentFile: file.path
        });
      }

      try {
        const index = await this.indexFile(file);
        results.push(index);
      } catch (error) {
        console.error(`Failed to index ${file.path}:`, error);
      }
    }

    return results;
  }

  /**
   * Incremental index - only index new or modified files
   */
  async incrementalIndex(
    onProgress?: (progress: IndexingProgress) => void
  ): Promise<number> {
    const allFiles = this.plugin.app.vault.getMarkdownFiles();
    const filesToIndex: TFile[] = [];

    for (const file of allFiles) {
      if (await this.needsReindex(file)) {
        filesToIndex.push(file);
      }
    }

    if (filesToIndex.length > 0) {
      await this.indexFiles(filesToIndex, onProgress);
    }

    return filesToIndex.length;
  }

  /**
   * Check if a file needs reindexing
   */
  async needsReindex(file: TFile): Promise<boolean> {
    const cachedHash = this.indexedFiles.get(file.path);
    if (!cachedHash) return true; // Not indexed yet

    const extracted = await this.contentExtractor.extract(file);
    const currentHash = this.calculateHash(extracted.content);

    return cachedHash !== currentHash; // Content has changed
  }

  /**
   * Remove a file from the index
   */
  async removeFromIndex(filePath: string): Promise<void> {
    this.vectorStore.removeFile(filePath);
    this.indexedFiles.delete(filePath);
    await this.saveIndex();
  }

  /**
   * Search for relevant chunks
   */
  async search(
    query: string,
    options?: SearchOptions
  ): Promise<SimilaritySearchResult[]> {
    // Generate query embedding
    const provider = await this.plugin.aiRouter.getProvider(TaskType.EMBEDDING);
    const { embedding } = await provider.generateEmbedding(query);

    // Search in vector store
    return this.vectorStore.search(embedding, options);
  }

  /**
   * Get index statistics
   */
  getStats(): IndexStats {
    const stats = this.vectorStore.getStats();
    return {
      totalFiles: stats.totalFiles,
      totalChunks: stats.totalChunks,
      lastIndexTime: Date.now(),
      indexSize: 0 // Will be calculated during save
    };
  }

  /**
   * Save index to persistent storage
   */
  private async saveIndex(): Promise<void> {
    const data = {
      vectorStore: this.vectorStore.serialize(),
      indexedFiles: Array.from(this.indexedFiles.entries()),
      timestamp: Date.now()
    };

    const existingData = await this.plugin.loadData() || {};
    await this.plugin.saveData({
      ...existingData,
      index: data
    });
  }

  /**
   * Load index from persistent storage
   */
  private async loadIndex(): Promise<void> {
    const data = await this.plugin.loadData();
    if (data?.index) {
      this.vectorStore.deserialize(data.index.vectorStore);
      this.indexedFiles = new Map(data.index.indexedFiles);
    }
  }

  /**
   * Calculate content hash (simple hash function)
   */
  private calculateHash(content: string): string {
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return hash.toString(36);
  }
}
