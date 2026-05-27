import { describe, it, expect, beforeEach } from 'vitest';
import { execute, schema } from '../../../skills/edit-note/scripts/index';
import { SkillContext } from '../../../src/skills/skill-types';
import { TFile } from 'obsidian';

describe('Edit-Note Rollback & Linter Guard Integration', () => {
  let mockFiles: Map<string, string>;
  let mockContext: SkillContext;

  beforeEach(() => {
    mockFiles = new Map<string, string>();

    // Mock Vault using TFile and simple key-value structure
    const mockVault = {
      getAbstractFileByPath: (path: string) => {
        if (mockFiles.has(path)) {
          const file = new TFile();
          file.path = path;
          file.name = path.split('/').pop() || path;
          return file;
        }
        return null;
      },
      read: async (file: any) => {
        if (!mockFiles.has(file.path)) {
          throw new Error(`File not found: ${file.path}`);
        }
        return mockFiles.get(file.path)!;
      },
      create: async (path: string, content: string) => {
        mockFiles.set(path, content);
        const file = new TFile();
        file.path = path;
        file.name = path.split('/').pop() || path;
        return file;
      },
      modify: async (file: any, content: string) => {
        mockFiles.set(file.path, content);
      },
      delete: async (file: any) => {
        mockFiles.delete(file.path);
      },
      createFolder: async (path: string) => {}
    };

    mockContext = {
      vault: mockVault as any,
      metadataCache: {} as any,
      workspace: {} as any,
      indexManager: {
        triggerReindex: async () => {},
        indexFile: async () => {}
      } as any,
      plugin: {} as any
    };
  });

  it('should succeed when writing valid technical markdown', async () => {
    const input = schema.parse({
      path: 'Research/valid-note.md',
      content: `# Valid Markdown\n\nInline math $x$ and code block:\n\`\`\`python\nprint("Valid")\n\`\`\``
    });

    const result = await execute(input, mockContext);

    expect(result.success).toBe(true);
    expect(mockFiles.get('Research/valid-note.md')).toContain('Inline math $x$');
  });

  it('should fail and delete the file if creating a new note with unclosed LaTeX block', async () => {
    const input = schema.parse({
      path: 'Research/invalid-new-note.md',
      content: `# Invalid Markdown\n\nUnclosed math:\n$$\nx^2 + y^2\n# Missing closing double dollar`
    });

    const result = await execute(input, mockContext);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Note Linter Validation Failed!');
    expect(result.error).toContain("LaTeX block equation '$$' is opened but never closed.");
    // The new file should have been deleted (not exist in vault)
    expect(mockFiles.has('Research/invalid-new-note.md')).toBe(false);
  });

  it('should fail and roll back to previous content if appending malformed Markdown to an existing note', async () => {
    // 1. Establish pre-existing clean file
    const path = 'Research/existing-note.md';
    const originalContent = `# Original Clean Note\n\nThis is clean.`;
    mockFiles.set(path, originalContent);

    // 2. Attempt to append malformed code block
    const input = schema.parse({
      path,
      content: `\n\nAdding some code:\n\`\`\`python\nprint("Broken block")\n# Oops forgot the closing backticks`,
      append: true
    });

    const result = await execute(input, mockContext);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Note Linter Validation Failed!');
    expect(result.error).toContain('Markdown code block is opened with ```');

    // 3. Verify the file rolled back perfectly to original clean content
    expect(mockFiles.get(path)).toBe(originalContent);
  });
});
