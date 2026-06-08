import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IndexManager } from '../../src/indexing/index-manager';
import { MemoryPlatformAdapter } from '../utils/memory-platform-adapter';

describe('IndexManager Incremental Check', () => {
  let platform: MemoryPlatformAdapter;
  let indexManager: IndexManager;
  let mockGetEmbeddingProvider: any;

  beforeEach(() => {
    platform = new MemoryPlatformAdapter();
    mockGetEmbeddingProvider = vi.fn();
    indexManager = new IndexManager(platform, mockGetEmbeddingProvider);
  });

  it('should determine needsReindex based on mtime and size', async () => {
    const testPath = 'test.md';
    (indexManager as any).indexedFiles.set(testPath, {
      path: testPath,
      contentHash: 'hash1',
      mtime: 1000,
      size: 50
    });

    // Up to date
    const file = platform.addFile(testPath, 'x'.repeat(50), { mtime: 1000, size: 50 });
    let needsReindex = await indexManager.needsReindex(file);
    expect(needsReindex).toBe(false);

    // Modified time changed
    const modifiedFile = platform.addFile(testPath, 'x'.repeat(50), { mtime: 1001, size: 50 });
    needsReindex = await indexManager.needsReindex(modifiedFile);
    expect(needsReindex).toBe(true);

    // Size changed
    const resizedFile = platform.addFile(testPath, 'x'.repeat(55), { mtime: 1000, size: 55 });
    needsReindex = await indexManager.needsReindex(resizedFile);
    expect(needsReindex).toBe(true);
  });
});
