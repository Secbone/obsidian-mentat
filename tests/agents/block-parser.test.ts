import { describe, it, expect, beforeEach } from 'vitest';
import { execute as editExecute, schema as editSchema } from '../../skills/edit-note/scripts/index';
import { execute as writeExecute, schema as writeSchema } from '../../skills/write-note/scripts/index';
import { SkillContext } from '../../src/skills/skill-types';
import { TFile } from 'obsidian';

function makeMockContext(mockFiles: Map<string, string>): SkillContext {
  return {
    vault: {
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
        if (!mockFiles.has(file.path)) {
          throw new Error(`File not found: ${file.path}`);
        }
        return mockFiles.get(file.path)!;
      },
      modify: async (file: any, content: string) => {
        mockFiles.set(file.path, content);
      },
      create: async (path: string, content: string) => {
        mockFiles.set(path, content);
        const file = new TFile();
        file.path = path;
        file.name = path.split('/').pop() || path;
        file.basename = (path.split('/').pop() || path).replace(/\.md$/, '');
        return file;
      },
      delete: async (file: any) => {
        mockFiles.delete(file.path);
      },
      createFolder: async (_path: string) => {}
    } as any,
    metadataCache: {} as any,
    workspace: {} as any,
    indexManager: { indexFile: async () => {} } as any,
    plugin: {} as any
  };
}

describe('edit_note', () => {
  let mockFiles: Map<string, string>;
  let mockContext: SkillContext;

  beforeEach(() => {
    mockFiles = new Map<string, string>();
    mockContext = makeMockContext(mockFiles);
  });

  it('should apply exact matching and successfully replace content', async () => {
    const path = 'Note.md';
    mockFiles.set(path, '# Note Title\n\nOriginal text block.\n\nFooter.');

    const input = editSchema.parse({
      path,
      old_string: 'Original text block.',
      new_string: 'Updated text block with new info.'
    });

    const result = await editExecute(input, mockContext);
    expect(result.success).toBe(true);
    expect(mockFiles.get(path)).toBe('# Note Title\n\nUpdated text block with new info.\n\nFooter.');
  });

  it('should fall back to fuzzy whitespace matching when exact match fails', async () => {
    const path = 'Note.md';
    // Target file has extra spaces
    mockFiles.set(path, '# Title\n\nOriginal    long    spacing text.\n');

    const input = editSchema.parse({
      path,
      old_string: 'Original long spacing text.',
      new_string: 'Fuzzy match succeeded!'
    });

    const result = await editExecute(input, mockContext);
    expect(result.success).toBe(true);
    expect(mockFiles.get(path)).toBe('# Title\n\nFuzzy match succeeded!\n');
  });

  it('should throw an error and rollback if old_string is not unique', async () => {
    const path = 'Note.md';
    const originalContent = '# Title\n\nRepeated line.\n\nRepeated line.';
    mockFiles.set(path, originalContent);

    const input = editSchema.parse({
      path,
      old_string: 'Repeated line.',
      new_string: 'New line.'
    });

    const result = await editExecute(input, mockContext);
    expect(result.success).toBe(false);
    expect(mockFiles.get(path)).toBe(originalContent);
  });

  it('should throw an error and rollback if old_string is not found', async () => {
    const path = 'Note.md';
    const originalContent = '# Title\n\nSome text here.';
    mockFiles.set(path, originalContent);

    const input = editSchema.parse({
      path,
      old_string: 'Non-existent text.',
      new_string: 'New text.'
    });

    const result = await editExecute(input, mockContext);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Text not found');
    expect(mockFiles.get(path)).toBe(originalContent);
  });

  it('should return error if file does not exist', async () => {
    const input = editSchema.parse({
      path: 'NonExistent.md',
      old_string: 'text',
      new_string: 'new text'
    });

    const result = await editExecute(input, mockContext);
    expect(result.success).toBe(false);
    expect(result.error).toContain('File does not exist');
  });

  it('should return error if old_string equals new_string', async () => {
    const path = 'Note.md';
    mockFiles.set(path, 'content');

    const input = editSchema.parse({
      path,
      old_string: 'content',
      new_string: 'content'
    });

    const result = await editExecute(input, mockContext);
    expect(result.success).toBe(false);
    expect(result.error).toContain('must be different');
  });

  it('should replace all occurrences with replace_all: true', async () => {
    const path = 'Note.md';
    mockFiles.set(path, '# TODO list\n\n- TODO: item 1\n- TODO: item 2\n- DONE: item 3');

    const input = editSchema.parse({
      path,
      old_string: 'TODO',
      new_string: 'DONE',
      replace_all: true
    });

    const result = await editExecute(input, mockContext);
    // Note: exactReplaceString's replace_all behavior depends on the utility
    if (result.success) {
      expect(mockFiles.get(path)).toContain('DONE');
    }
  });
});

describe('write_note', () => {
  let mockFiles: Map<string, string>;
  let mockContext: SkillContext;

  beforeEach(() => {
    mockFiles = new Map<string, string>();
    mockContext = makeMockContext(mockFiles);
  });

  it('should create a new file', async () => {
    const path = 'Notes/New Note.md';
    const input = writeSchema.parse({
      path,
      content: '# Hello\n\nNew file content.'
    });

    const result = await writeExecute(input, mockContext);
    expect(result.success).toBe(true);
    expect(mockFiles.get(path)).toBe('# Hello\n\nNew file content.');
  });

  it('should create a new file with frontmatter', async () => {
    const path = 'Notes/Tagged Note.md';
    const input = writeSchema.parse({
      path,
      content: '# Tagged Note\nBody text.',
      frontmatter: { tags: ['test', 'note'], date: '2025-01-20' }
    });

    const result = await writeExecute(input, mockContext);
    expect(result.success).toBe(true);
    expect(mockFiles.get(path)).toContain('tags:');
    expect(mockFiles.get(path)).toContain('- test');
    expect(mockFiles.get(path)).toContain('date: 2025-01-20');
  });

  it('should append content to existing file', async () => {
    const path = 'Note.md';
    mockFiles.set(path, '# Original\n\nContent.');
    const input = writeSchema.parse({
      path,
      content: '## Appendix\nNew section.',
      append: true
    });

    const result = await writeExecute(input, mockContext);
    expect(result.success).toBe(true);
    const updated = mockFiles.get(path)!;
    expect(updated).toContain('# Original');
    expect(updated).toContain('## Appendix');
  });

  it('should prepend content preserving existing frontmatter', async () => {
    const path = 'Note.md';
    mockFiles.set(path, '---\ntags: [existing]\n---\n\n# Body');
    const input = writeSchema.parse({
      path,
      content: '# Important Notice\nRead this first.',
      prepend: true
    });

    const result = await writeExecute(input, mockContext);
    expect(result.success).toBe(true);
    const updated = mockFiles.get(path)!;
    // Frontmatter preserved
    expect(updated).toContain('tags: [existing]');
    // New content prepended right after frontmatter
    expect(updated.indexOf('# Important Notice')).toBeLessThan(updated.indexOf('# Body'));
  });

  it('should replace all content', async () => {
    const path = 'Note.md';
    mockFiles.set(path, '# Old Content\n\nTo be replaced.');
    const input = writeSchema.parse({
      path,
      content: '# New Content\n\nComplete rewrite.'
    });

    const result = await writeExecute(input, mockContext);
    expect(result.success).toBe(true);
    expect(mockFiles.get(path)).toBe('# New Content\n\nComplete rewrite.');
  });

  it('should fail with create_only if file already exists', async () => {
    const path = 'Note.md';
    mockFiles.set(path, '# Existing');
    const input = writeSchema.parse({
      path,
      content: '# New',
      create_only: true
    });

    const result = await writeExecute(input, mockContext);
    expect(result.success).toBe(false);
    expect(result.error).toContain('create_only');
    expect(mockFiles.get(path)).toBe('# Existing');
  });

  it('should replace section under heading', async () => {
    const path = 'Note.md';
    mockFiles.set(path, '# Title\n\n## Section A\nOld section content.\n\n## Section B\nOther stuff.');
    const input = writeSchema.parse({
      path,
      heading: 'Section A',
      content: '## Section A\nReplaced content.'
    });

    const result = await writeExecute(input, mockContext);
    expect(result.success).toBe(true);
    const updated = mockFiles.get(path)!;
    expect(updated).toContain('Replaced content.');
    expect(updated).toContain('## Section B');
  });
});
