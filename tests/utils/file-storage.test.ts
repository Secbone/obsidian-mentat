import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FileStorage } from '../../src/utils/file-storage';
import { MemoryPlatformAdapter } from './memory-platform-adapter';

describe('FileStorage', () => {
  let platform: MemoryPlatformAdapter;
  let storage: FileStorage;

  beforeEach(() => {
    platform = new MemoryPlatformAdapter();
    storage = new FileStorage(platform);
  });

  it('should resolve full paths under configDir', async () => {
    // Check exist
    const relativePath = 'test-file.json';
    const fullPath = `.obsidian/plugins/obsidian-mentat/${relativePath}`;
    
    platform.addFile(fullPath, '{"test": true}');
    
    const exists = await storage.exists(relativePath);
    expect(exists).toBe(true);

    // Check read
    const content = await storage.read(relativePath);
    expect(content).toBe('{"test": true}');
  });

  it('should auto-create parent directories on write', async () => {
    const mkdirSpy = vi.spyOn(platform, 'mkdir');
    const writeSpy = vi.spyOn(platform, 'write');
    
    await storage.write('cache/nested/file.json', '{}');

    // Should call exists check and mkdir for 'cache' and 'cache/nested'
    expect(mkdirSpy).toHaveBeenCalledWith('.obsidian/plugins/obsidian-mentat/cache');
    expect(mkdirSpy).toHaveBeenCalledWith('.obsidian/plugins/obsidian-mentat/cache/nested');
    expect(writeSpy).toHaveBeenCalledWith('.obsidian/plugins/obsidian-mentat/cache/nested/file.json', '{}');
  });
});
