import { describe, it, expect } from 'vitest';
import { ChatOrchestrator } from '../../src/chat/chat-orchestrator';

describe('ChatOrchestrator - Semantic Vault Architecture (v2.4)', () => {
  // Helper to construct a mock Obsidian file (TFile)
  const createMockFile = (path: string, tags: string[] = [], frontmatterTags?: any): any => {
    const segments = path.split('/');
    const name = segments[segments.length - 1];
    
    // Parent folder details
    let parent = null;
    if (segments.length > 1) {
      const parentPath = segments.slice(0, -1).join('/');
      const parentName = segments[segments.length - 2];
      parent = { path: parentPath, name: parentName };
    }

    return {
      path,
      name,
      parent,
      mockCache: {
        tags: tags.map(tag => ({ tag: tag.startsWith('#') ? tag : `#${tag}` })),
        frontmatter: frontmatterTags !== undefined ? { tags: frontmatterTags } : undefined
      }
    };
  };

  // Construct a minimal mock of the Obsidian App & Plugin
  const createMockPlugin = (files: any[] = [], vaultMapExists = false, vaultMapContent = ''): any => {
    const filesMap = new Map<string, any>();
    files.forEach(f => filesMap.set(f.path, f));

    return {
      app: {
        vault: {
          getMarkdownFiles: () => files,
          getAbstractFileByPath: (path: string) => filesMap.get(path),
          adapter: {
            getBasePath: () => '',
            exists: async (path: string) => {
              if (path.endsWith('vault-map.md')) {
                return vaultMapExists;
              }
              return false;
            },
            read: async (path: string) => {
              if (path.endsWith('vault-map.md')) {
                return vaultMapContent;
              }
              throw new Error('File not found');
            }
          }
        },
        metadataCache: {
          getFileCache: (file: any) => file.mockCache || {}
        }
      },
      settings: {
        userConfigFolder: 'Personal Agent/Config'
      }
    };
  };

  describe('getFileTags', () => {
    it('should extract and normalize tags from metadata cache tags array', () => {
      const mockFile = createMockFile('Research/Paper.md', ['#ai', 'deep-learning']);
      const plugin = createMockPlugin([mockFile]);
      const orchestrator = new ChatOrchestrator(plugin);

      const tags = (orchestrator as any).getFileTags(mockFile);
      expect(tags).toEqual(['ai', 'deep-learning']);
    });

    it('should extract and normalize tags from frontmatter array', () => {
      const mockFile = createMockFile('Research/Paper.md', [], ['rl', 'kto']);
      const plugin = createMockPlugin([mockFile]);
      const orchestrator = new ChatOrchestrator(plugin);

      const tags = (orchestrator as any).getFileTags(mockFile);
      expect(tags).toEqual(['rl', 'kto']);
    });

    it('should handle comma-separated string in frontmatter tags gracefully', () => {
      const mockFile = createMockFile('Research/Paper.md', [], 'dpo, sft, rlhf');
      const plugin = createMockPlugin([mockFile]);
      const orchestrator = new ChatOrchestrator(plugin);

      const tags = (orchestrator as any).getFileTags(mockFile);
      expect(tags).toEqual(['dpo', 'sft', 'rlhf']);
    });

    it('should deduplicate and clean tags correctly', () => {
      const mockFile = createMockFile('Research/Paper.md', ['#ai', 'AI'], ['ai', 'nlp']);
      const plugin = createMockPlugin([mockFile]);
      const orchestrator = new ChatOrchestrator(plugin);

      const tags = (orchestrator as any).getFileTags(mockFile);
      // Case-sensitive comparison, deduplicated
      expect(tags).toEqual(['ai', 'AI', 'nlp']);
    });
  });

  describe('buildSemanticDirectoryTree', () => {
    it('should handle an empty file list gracefully', () => {
      const plugin = createMockPlugin([]);
      const orchestrator = new ChatOrchestrator(plugin);

      const tree = (orchestrator as any).buildSemanticDirectoryTree([]);
      expect(tree).toBe('- *(No folders containing documents)*');
    });

    it('should ignore root level files in direct hierarchy outline but handle parent folders', () => {
      const files = [
        createMockFile('Inbox.md', ['quick']),
        createMockFile('Research/Paper.md', ['ai', 'math']),
        createMockFile('Research/Project.md', ['ai', 'coding'])
      ];
      const plugin = createMockPlugin(files);
      const orchestrator = new ChatOrchestrator(plugin);

      const tree = (orchestrator as any).buildSemanticDirectoryTree(files);
      // Should serialize only the Research folder, root Inbox.md doesn't have parent
      expect(tree).toContain('- `Research/` (2 docs) | Tags: #ai, #math, #coding');
    });

    it('should build hierarchical tree up to depth 3 with recursive statistics and descending sort', () => {
      const files = [
        createMockFile('Research/LLM/DPO.md', ['llm', 'sft']),
        createMockFile('Research/LLM/KTO.md', ['llm', 'kto', 'math']),
        createMockFile('Research/RL/PPO.md', ['rl', 'math']),
        createMockFile('Projects/Hivemind/Agent.md', ['hivemind']),
        createMockFile('Archives/Old/Notes/Sub/Deep.md', ['old']) // Depth 4, should be pruned
      ];
      const plugin = createMockPlugin(files);
      const orchestrator = new ChatOrchestrator(plugin);

      const tree = (orchestrator as any).buildSemanticDirectoryTree(files);

      // Verify Research/ is at the top (has 3 docs recursively), followed by Projects/ (1 doc)
      const lines = tree.split('\n');
      expect(lines[0]).toContain('- `Research/` (3 docs)');
      expect(lines[0]).toContain('#llm');
      expect(lines[0]).toContain('#math');
      expect(lines[0]).toContain('#sft');

      // Nested folders: Research/LLM has 2 docs, Research/RL has 1 doc. LLM should come first
      expect(lines[1]).toContain('  - `Research/LLM/` (2 docs)');
      expect(lines[1]).toContain('Tags: #llm, #sft, #kto');

      expect(lines[2]).toContain('  - `Research/RL/` (1 doc)');

      // Projects should come after Research
      expect(tree).toContain('- `Projects/` (1 doc)');
      expect(tree).toContain('  - `Projects/Hivemind/` (1 doc)');

      // Pruned/Depth 4 check: Archives/Old/Notes/ should be listed but not Sub/Deep.md
      expect(tree).toContain('- `Archives/` (1 doc)');
      expect(tree).toContain('  - `Archives/Old/` (1 doc)');
      expect(tree).toContain('    - `Archives/Old/Notes/` (1 doc)');
      expect(tree).not.toContain('Archives/Old/Notes/Sub/');
    });
  });

  describe('getVaultMap', () => {
    it('should return placeholder message if vault-map.md does not exist', async () => {
      const plugin = createMockPlugin([], false);
      const orchestrator = new ChatOrchestrator(plugin);

      const map = await orchestrator.getVaultMap();
      expect(map).toContain('*(None defined.');
    });

    it('should successfully read and return vault-map.md content if it exists', async () => {
      const testContent = '# My Vault Map\n- Guide lines...';
      const plugin = createMockPlugin([], true, testContent);
      const orchestrator = new ChatOrchestrator(plugin);

      const map = await orchestrator.getVaultMap();
      expect(map).toBe(testContent);
    });
  });
});
