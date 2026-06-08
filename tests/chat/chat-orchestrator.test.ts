import { describe, it, expect } from 'vitest';
import { ChatOrchestrator } from '../../src/chat/chat-orchestrator';
import { VaultMapRebuilder } from '../../src/chat/vault-map-rebuilder';
import { MemoryPlatformAdapter } from '../utils/memory-platform-adapter';

describe('ChatOrchestrator - Semantic Vault Architecture (v2.4)', () => {
  const settings = {
    userConfigFolder: 'Personal Agent/Config'
  };

  describe('getFileTags', () => {
    it('should extract and normalize tags from metadata cache tags array', () => {
      const platform = new MemoryPlatformAdapter();

      const mockFile = platform.addFile('Research/Paper.md', '', undefined, {
        tags: [{ tag: '#ai' }, { tag: 'deep-learning' }]
      });

      const tags = VaultMapRebuilder.getFileTags(mockFile, platform);
      expect(tags).toEqual(['ai', 'deep-learning']);
    });

    it('should extract and normalize tags from frontmatter array', () => {
      const platform = new MemoryPlatformAdapter();

      const mockFile = platform.addFile('Research/Paper.md', '', undefined, {
        frontmatter: { tags: ['rl', 'kto'] }
      });

      const tags = VaultMapRebuilder.getFileTags(mockFile, platform);
      expect(tags).toEqual(['rl', 'kto']);
    });

    it('should handle comma-separated string in frontmatter tags gracefully', () => {
      const platform = new MemoryPlatformAdapter();

      const mockFile = platform.addFile('Research/Paper.md', '', undefined, {
        frontmatter: { tags: 'dpo, sft, rlhf' }
      });

      const tags = VaultMapRebuilder.getFileTags(mockFile, platform);
      expect(tags).toEqual(['dpo', 'sft', 'rlhf']);
    });

    it('should deduplicate and clean tags correctly', () => {
      const platform = new MemoryPlatformAdapter();

      const mockFile = platform.addFile('Research/Paper.md', '', undefined, {
        tags: [{ tag: '#ai' }, { tag: 'AI' }],
        frontmatter: { tags: ['ai', 'nlp'] }
      });

      const tags = VaultMapRebuilder.getFileTags(mockFile, platform);
      expect(tags).toEqual(['ai', 'AI', 'nlp']);
    });
  });

  describe('buildSemanticDirectoryTree', () => {
    it('should handle an empty file list gracefully', () => {
      const platform = new MemoryPlatformAdapter();
      const orchestrator = new ChatOrchestrator(platform, settings, {}, {});

      const tree = (orchestrator as any).buildSemanticDirectoryTree([]);
      expect(tree).toBe('- *(No folders containing documents)*');
    });

    it('should ignore root level files in direct hierarchy outline but handle parent folders', () => {
      const platform = new MemoryPlatformAdapter();
      const orchestrator = new ChatOrchestrator(platform, settings, {}, {});

      const f1 = platform.addFile('Inbox.md', '', undefined, { tags: [{ tag: 'quick' }] });
      const f2 = platform.addFile('Research/Paper.md', '', undefined, { tags: [{ tag: 'ai' }, { tag: 'math' }] });
      const f3 = platform.addFile('Research/Project.md', '', undefined, { tags: [{ tag: 'ai' }, { tag: 'coding' }] });

      const files = [f1, f2, f3];
      const tree = (orchestrator as any).buildSemanticDirectoryTree(files);
      expect(tree).toContain('- `Research/` (2 docs) | Tags: #ai, #math, #coding');
    });

    it('should build hierarchical tree up to depth 3 with recursive statistics and descending sort', () => {
      const platform = new MemoryPlatformAdapter();
      const orchestrator = new ChatOrchestrator(platform, settings, {}, {});

      const f1 = platform.addFile('Research/LLM/DPO.md', '', undefined, { tags: [{ tag: 'llm' }, { tag: 'sft' }] });
      const f2 = platform.addFile('Research/LLM/KTO.md', '', undefined, { tags: [{ tag: 'llm' }, { tag: 'kto' }, { tag: 'math' }] });
      const f3 = platform.addFile('Research/RL/PPO.md', '', undefined, { tags: [{ tag: 'rl' }, { tag: 'math' }] });
      const f4 = platform.addFile('Projects/Hivemind/Agent.md', '', undefined, { tags: [{ tag: 'hivemind' }] });
      const f5 = platform.addFile('Archives/Old/Notes/Sub/Deep.md', '', undefined, { tags: [{ tag: 'old' }] });

      const files = [f1, f2, f3, f4, f5];
      const tree = (orchestrator as any).buildSemanticDirectoryTree(files);

      const lines = tree.split('\n');
      expect(lines[0]).toContain('- `Research/` (3 docs)');
      expect(lines[0]).toContain('#llm');
      expect(lines[0]).toContain('#math');
      expect(lines[0]).toContain('#sft');

      expect(lines[1]).toContain('  - `Research/LLM/` (2 docs)');
      expect(lines[1]).toContain('Tags: #llm, #sft, #kto');

      expect(lines[2]).toContain('  - `Research/RL/` (1 doc)');

      expect(tree).toContain('- `Projects/` (1 doc)');
      expect(tree).toContain('  - `Projects/Hivemind/` (1 doc)');

      expect(tree).toContain('- `Archives/` (1 doc)');
      expect(tree).toContain('  - `Archives/Old/` (1 doc)');
      expect(tree).toContain('    - `Archives/Old/Notes/` (1 doc)');
      expect(tree).not.toContain('Archives/Old/Notes/Sub/');
    });
  });

  describe('getVaultMap', () => {
    it('should return placeholder message if vault-map.md does not exist', async () => {
      const platform = new MemoryPlatformAdapter();
      const orchestrator = new ChatOrchestrator(platform, settings, {}, {});

      const map = await orchestrator.getVaultMap();
      expect(map).toContain('*(None defined.');
    });

    it('should successfully read and return vault-map.md content if it exists', async () => {
      const platform = new MemoryPlatformAdapter();
      const orchestrator = new ChatOrchestrator(platform, settings, {}, {});
      
      const testContent = '# My Vault Map\n- Guide lines...';
      platform.addFile('Personal Agent/Config/vault-map.md', testContent);

      const map = await orchestrator.getVaultMap();
      expect(map).toBe(testContent);
    });
  });
});
