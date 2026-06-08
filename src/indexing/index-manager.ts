// Index Manager - Manages the lifecycle of document indexing

import { ContentExtractor } from './content-extractor';
import { ChunkProcessor, FileChunk } from './chunk-processor';
import { VectorStore, SearchOptions, SimilaritySearchResult } from './vector-store';
import { EmbeddingBatch } from './embedding-batch';
import { FileIndex, AIProvider } from '../types';
import { FileStorage } from '../utils/file-storage';
import { IPlatformAdapter, IPlatformFile } from '../types/platform';

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

interface IndexedFileMeta {
  path: string;
  contentHash: string;
  mtime: number;
  size: number;
}

export class IndexManager {
  private contentExtractor: ContentExtractor;
  private chunkProcessor: ChunkProcessor;
  private vectorStore: VectorStore;
  private embeddingBatch: EmbeddingBatch;
  private storage: FileStorage;

  // Cache of indexed files with their metadata
  private indexedFiles: Map<string, IndexedFileMeta> = new Map(); // filePath -> metadata

  constructor(
    private platform: IPlatformAdapter,
    private getEmbeddingProvider: () => Promise<AIProvider>
  ) {
    this.contentExtractor = new ContentExtractor(platform);
    this.chunkProcessor = new ChunkProcessor();
    this.vectorStore = new VectorStore();
    this.embeddingBatch = new EmbeddingBatch(getEmbeddingProvider);
    this.storage = new FileStorage(platform);
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
  async indexFile(file: IPlatformFile): Promise<FileIndex> {
    // 1. Extract content and metadata
    const extracted = await this.contentExtractor.extract(file);

    // 2. Calculate content hash
    const contentHash = this.calculateHash(extracted.content);

    // 3. Split into chunks
    const chunks = await this.chunkProcessor.chunkDocument(file as any, extracted);

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

    // 7. Update cache map with mtime and size
    this.indexedFiles.set(file.path, {
      path: file.path,
      contentHash,
      mtime: file.stat.mtime,
      size: file.stat.size
    });

    // 8. Persist the individual file cache and global metadata
    await this.saveFileIndex(file.path, fullChunks);
    await this.saveIndexMetadata();

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
    files: IPlatformFile[],
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
    const allFiles = this.platform.getMarkdownFiles();
    const filesToIndex: IPlatformFile[] = [];

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
  async needsReindex(file: IPlatformFile): Promise<boolean> {
    const cachedMeta = this.indexedFiles.get(file.path);
    if (!cachedMeta) return true; // Not indexed yet

    // O(1) comparison of modification time and size
    if (cachedMeta.mtime !== file.stat.mtime || cachedMeta.size !== file.stat.size) {
      return true;
    }

    return false;
  }

  /**
   * Remove a file from the index
   */
  async removeFromIndex(filePath: string): Promise<void> {
    this.vectorStore.removeFile(filePath);
    this.indexedFiles.delete(filePath);
    
    // Also delete the individual cache file
    const filename = this.getCacheFilename(filePath);
    await this.storage.delete(filename);
    
    await this.saveIndexMetadata();
  }

  /**
   * Search for relevant chunks
   */
  async search(
    query: string,
    options?: SearchOptions
  ): Promise<SimilaritySearchResult[]> {
    // Generate query embedding
    const provider = await this.getEmbeddingProvider();
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
      indexSize: 0
    };
  }

  /**
   * Save individual file chunks
   */
  private async saveFileIndex(filePath: string, chunks: FileChunk[]): Promise<void> {
    const filename = this.getCacheFilename(filePath);
    await this.storage.write(filename, JSON.stringify(chunks, null, 2));
  }

  /**
   * Save index metadata to persistent storage
   */
  private async saveIndexMetadata(): Promise<void> {
    const data = {
      indexedFiles: Array.from(this.indexedFiles.entries()),
      timestamp: Date.now()
    };
    await this.storage.write('index_meta.json', JSON.stringify(data, null, 2));
  }

  /**
   * Load index from persistent storage
   */
  private async loadIndex(): Promise<void> {
    try {
      if (await this.storage.exists('index_meta.json')) {
        // Load metadata
        const metaContent = await this.storage.read('index_meta.json');
        const metaData = JSON.parse(metaContent);
        this.indexedFiles = new Map(metaData.indexedFiles);

        // Load cached chunks asynchronously in the background so it doesn't block startup
        this.loadCachedChunksInBackground();
      } else {
        // Data migration from data.json
        const data = await this.platform.loadPluginData();
        if (data?.index) {
          console.log('[IndexManager] Migrating legacy global vector store...');
          
          // Deserialize vector store from old data.json format
          const oldVectorStore = new VectorStore();
          oldVectorStore.deserialize(data.index.vectorStore);
          
          // Legacy indexedFiles format was Map entries: [filePath, contentHash]
          const legacyIndexedFiles: [string, string][] = data.index.indexedFiles || [];
          const fileChunksMap = new Map<string, FileChunk[]>();
          
          for (const [filePath, contentHash] of legacyIndexedFiles) {
            const chunks = oldVectorStore.getFileChunks(filePath);
            if (chunks) {
              // Get actual mtime and size from vault if file exists
              const abstractFile = this.platform.getFileByPath(filePath);
              let mtime = 0;
              let size = 0;
              if (abstractFile) {
                mtime = abstractFile.stat.mtime;
                size = abstractFile.stat.size;
              }
              
              this.indexedFiles.set(filePath, {
                path: filePath,
                contentHash,
                mtime,
                size
              });

              fileChunksMap.set(filePath, chunks);
              // Save to individual cache file
              await this.saveFileIndex(filePath, chunks);
            }
          }

          // Populate local vector store in bulk
          this.vectorStore.addFileChunksBulk(fileChunksMap);
          
          // Save metadata
          await this.saveIndexMetadata();

          // Remove old index data from data.json to reduce size
          delete data.index;
          await this.platform.savePluginData(data);
          console.log('[IndexManager] Legacy global vector store migrated successfully.');
        }
      }
    } catch (error) {
      console.error('Failed to load index metadata or migrate:', error);
    }
  }

  /**
   * Load cached chunks asynchronously in the background
   */
  private async loadCachedChunksInBackground(): Promise<void> {
    const fileChunksMap = new Map<string, FileChunk[]>();
    const filePaths = Array.from(this.indexedFiles.keys());
    
    // Process in parallel with batches of 50
    const batchSize = 50;
    for (let i = 0; i < filePaths.length; i += batchSize) {
      const batch = filePaths.slice(i, i + batchSize);
      await Promise.all(batch.map(async (filePath) => {
        try {
          const filename = this.getCacheFilename(filePath);
          if (await this.storage.exists(filename)) {
            const content = await this.storage.read(filename);
            const chunks: FileChunk[] = JSON.parse(content);
            fileChunksMap.set(filePath, chunks);
          }
        } catch (error) {
          console.error(`Failed to load cached chunks for file ${filePath}:`, error);
        }
      }));
    }

    // Load into VectorStore in one bulk operation to rebuild the index once!
    this.vectorStore.addFileChunksBulk(fileChunksMap);
    console.log(`[IndexManager] Loaded ${fileChunksMap.size} files' chunks in background.`);
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

  /**
   * Map a file path in the vault to a unique alphanumeric cache filename
   */
  private getCacheFilename(filePath: string): string {
    let hash = 0;
    for (let i = 0; i < filePath.length; i++) {
      const char = filePath.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    const cleanHash = Math.abs(hash).toString(36);
    return `cache/${cleanHash}.json`;
  }
}
