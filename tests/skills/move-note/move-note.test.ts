import { describe, it, expect, beforeEach } from 'vitest';
import { execute, schema } from '../../../skills/move-note/scripts/index';
import { SkillContext } from '../../../src/skills/skill-types';
import { TFile } from 'obsidian';

describe('move_note', () => {
  let mockFiles: Map<string, string>;
  let mockContext: SkillContext;
  let renameFileCalls: Array<{ oldPath: string; newPath: string }>;

  beforeEach(() => {
    mockFiles = new Map<string, string>();
    renameFileCalls = [];

    const mockVault = {
      getAbstractFileByPath: (path: string) => {
        if (mockFiles.has(path)) {
          const file = new TFile();
          file.path = path;
          file.name = path.split('/').pop() || path;
          file.basename = (path.split('/').pop() || path).replace(/\.md$/, '');
          return file;
        }
        return null;
      },
      read: async (file: any) => {
        return mockFiles.get(file.path) || '';
      },
      modify: async (file: any, content: string) => {
        mockFiles.set(file.path, content);
      },
      create: async (path: string, content: string) => {
        mockFiles.set(path, content);
        const file = new TFile();
        file.path = path;
        file.name = path.split('/').pop() || path;
        return file;
      },
      delete: async (file: any) => {
        mockFiles.delete(file.path);
      },
      createFolder: async (_path: string) => {}
    };

    const mockFileManager = {
      renameFile: async (file: any, newPath: string) => {
        renameFileCalls.push({ oldPath: file.path, newPath });
        const oldContent = mockFiles.get(file.path);
        mockFiles.delete(file.path);
        mockFiles.set(newPath, oldContent || '');
      }
    };

    mockContext = {
      vault: mockVault as any,
      metadataCache: {} as any,
      workspace: {} as any,
      indexManager: {
        indexFile: async () => {},
        removeFromIndex: async (filePath: string) => {
          mockFiles.delete(filePath);
        }
      } as any,
      plugin: {
        app: {
          fileManager: mockFileManager
        }
      } as any
    };
  });

  it('should move a note to a new folder', async () => {
    mockFiles.set('Notes/Meeting.md', '# Meeting Notes');

    const input = schema.parse({
      path: 'Notes/Meeting.md',
      new_path: 'Archive/Meeting.md'
    });

    const result = await execute(input, mockContext);

    expect(result.success).toBe(true);
    expect(result.data?.new_path).toBe('Archive/Meeting.md');
    expect(result.data?.moved).toBe(true);
    expect(result.data?.linksUpdated).toBe(true);
    expect(renameFileCalls).toHaveLength(1);
    expect(renameFileCalls[0].oldPath).toBe('Notes/Meeting.md');
    expect(renameFileCalls[0].newPath).toBe('Archive/Meeting.md');
  });

  it('should rename a note', async () => {
    mockFiles.set('Notes/Draft.md', '# Draft');

    const input = schema.parse({
      path: 'Notes/Draft.md',
      new_path: 'Notes/Final Version.md'
    });

    const result = await execute(input, mockContext);

    expect(result.success).toBe(true);
    expect(result.data?.new_path).toBe('Notes/Final Version.md');
    expect(result.data?.name).toBe('Final Version.md');
  });

  it('should move note to Trash for deletion', async () => {
    mockFiles.set('Notes/Obsolete.md', '# Obsolete');

    const input = schema.parse({
      path: 'Notes/Obsolete.md',
      new_path: 'Trash/Obsolete.md'
    });

    const result = await execute(input, mockContext);

    expect(result.success).toBe(true);
    expect(result.data?.new_path).toBe('Trash/Obsolete.md');
  });

  it('should fail if source file does not exist', async () => {
    const input = schema.parse({
      path: 'Notes/NonExistent.md',
      new_path: 'Archive/NonExistent.md'
    });

    const result = await execute(input, mockContext);

    expect(result.success).toBe(false);
    expect(result.error).toContain('does not exist');
  });

  it('should fail if source and destination are the same', async () => {
    mockFiles.set('Notes/Same.md', '# Same');

    const input = schema.parse({
      path: 'Notes/Same.md',
      new_path: 'Notes/Same.md'
    });

    const result = await execute(input, mockContext);

    expect(result.success).toBe(false);
    expect(result.error).toContain('same');
  });

  it('should fail if destination file already exists', async () => {
    mockFiles.set('Notes/Source.md', '# Source');
    mockFiles.set('Archive/Source.md', '# Already here');

    const input = schema.parse({
      path: 'Notes/Source.md',
      new_path: 'Archive/Source.md'
    });

    const result = await execute(input, mockContext);

    expect(result.success).toBe(false);
    expect(result.error).toContain('already exists');
  });
});
