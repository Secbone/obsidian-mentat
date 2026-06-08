import { describe, it, expect, beforeEach } from 'vitest';
import { execute, schema, parseSearchReplaceBlocks, applySearchReplace } from '../../skills/edit-note/scripts/index';
import { SkillContext } from '../../src/skills/skill-types';
import { TFile } from 'obsidian';

describe('Search-and-Replace Diff Matching Engine Parser & Execution', () => {
  describe('parseSearchReplaceBlocks', () => {
    it('should successfully parse a single SEARCH/REPLACE block', () => {
      const content = `
<<<<<<< SEARCH
old text line 1
old text line 2
=======
new text line 1
new text line 2
>>>>>>> REPLACE
`;
      const blocks = parseSearchReplaceBlocks(content);
      expect(blocks).toHaveLength(1);
      expect(blocks[0].search).toBe('old text line 1\nold text line 2');
      expect(blocks[0].replace).toBe('new text line 1\nnew text line 2');
    });

    it('should successfully parse multiple SEARCH/REPLACE blocks', () => {
      const content = `
Some explanation before.
<<<<<<< SEARCH
block 1 search
=======
block 1 replace
>>>>>>> REPLACE

Middle explanation.
<<<<<<< SEARCH
block 2 search
=======
block 2 replace
>>>>>>> REPLACE
`;
      const blocks = parseSearchReplaceBlocks(content);
      expect(blocks).toHaveLength(2);
      expect(blocks[0].search).toBe('block 1 search');
      expect(blocks[0].replace).toBe('block 1 replace');
      expect(blocks[1].search).toBe('block 2 search');
      expect(blocks[1].replace).toBe('block 2 replace');
    });

    it('should throw an error on syntax issues (mismatched markers)', () => {
      const content = `
<<<<<<< SEARCH
block 1 search
=======
block 1 replace
// Missing REPLACE marker
`;
      expect(() => parseSearchReplaceBlocks(content)).toThrowError(/Failed to parse search-and-replace blocks/);
    });
  });

  describe('Diff Matching Engine Execution (applySearchReplace)', () => {
    let mockFiles: Map<string, string>;
    let mockContext: SkillContext;

    beforeEach(() => {
      mockFiles = new Map<string, string>();

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
        modify: async (file: any, content: string) => {
          mockFiles.set(file.path, content);
        },
        createFolder: async (path: string) => {}
      };

      mockContext = {
        vault: mockVault as any,
        metadataCache: {} as any,
        workspace: {} as any,
        indexManager: {
          indexFile: async () => {}
        } as any,
        plugin: {} as any
      };
    });

    it('should apply exact matching and successfully replace content', async () => {
      const path = 'Note.md';
      mockFiles.set(path, '# Note Title\n\nOriginal text block.\n\nFooter.');

      const input = schema.parse({
        path,
        content: `
<<<<<<< SEARCH
Original text block.
=======
Updated text block with new info.
>>>>>>> REPLACE
`
      });

      const result = await execute(input, mockContext);
      expect(result.success).toBe(true);
      expect(mockFiles.get(path)).toBe('# Note Title\n\nUpdated text block with new info.\n\nFooter.');
    });

    it('should apply multiple search-replace blocks sequentially', async () => {
      const path = 'Note.md';
      mockFiles.set(path, '# Title\n\nSection 1.\n\nSection 2.\n\nEnd.');

      const input = schema.parse({
        path,
        content: `
<<<<<<< SEARCH
Section 1.
=======
Section 1 Edited.
>>>>>>> REPLACE

<<<<<<< SEARCH
Section 2.
=======
Section 2 Edited.
>>>>>>> REPLACE
`
      });

      const result = await execute(input, mockContext);
      expect(result.success).toBe(true);
      expect(mockFiles.get(path)).toBe('# Title\n\nSection 1 Edited.\n\nSection 2 Edited.\n\nEnd.');
    });

    it('should fall back to elastic/fuzzy whitespace matching when exact match fails', async () => {
      const path = 'Note.md';
      // Target file has spaces and carriage returns
      mockFiles.set(path, '# Title\r\n\r\nOriginal    long    spacing text.\r\n');

      const input = schema.parse({
        path,
        content: `
<<<<<<< SEARCH
Original long spacing text.
=======
Fuzzy match succeeded!
>>>>>>> REPLACE
`
      });

      const result = await execute(input, mockContext);
      expect(result.success).toBe(true);
      expect(mockFiles.get(path)).toBe('# Title\r\n\r\nFuzzy match succeeded!\r\n');
    });

    it('should throw an error and rollback if search block is not unique', async () => {
      const path = 'Note.md';
      const originalContent = '# Title\n\nRepeated line.\n\nRepeated line.';
      mockFiles.set(path, originalContent);

      const input = schema.parse({
        path,
        content: `
<<<<<<< SEARCH
Repeated line.
=======
New line.
>>>>>>> REPLACE
`
      });

      const result = await execute(input, mockContext);
      expect(result.success).toBe(false);
      expect(result.error).toContain('is not unique');
      // Rollback verified
      expect(mockFiles.get(path)).toBe(originalContent);
    });

    it('should throw an error and rollback if search block is not found', async () => {
      const path = 'Note.md';
      const originalContent = '# Title\n\nSome text here.';
      mockFiles.set(path, originalContent);

      const input = schema.parse({
        path,
        content: `
<<<<<<< SEARCH
Non-existent text.
=======
New text.
>>>>>>> REPLACE
`
      });

      const result = await execute(input, mockContext);
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found in the file');
      expect(mockFiles.get(path)).toBe(originalContent);
    });
  });
});
