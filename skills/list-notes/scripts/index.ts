// List Notes Implementation
// Core logic for listing notes

import { z } from 'zod';
import { TFile } from 'obsidian';
import { SkillContext, SkillResult } from '../../../src/skills/skill-types';

/**
 * Skill metadata
 */
export const metadata = {
  name: 'list_notes',
  description: 'List vault folders, tags, and recent files',
  version: '1.0.0',
  tags: ['vault', 'structure', 'overview'],
  performance: 'variable',
  category: 'vault-info'
};

/**
 * Input schema
 */
export const schema = z.object({
  includeFolders: z.boolean().default(true).describe('Include folder list'),
  includeTags: z.boolean().default(true).describe('Include tag statistics'),
  includeRecent: z.boolean().default(true).describe('Include recent files'),
  limit: z.number().min(1).max(100).default(20).describe('Limit for lists')
});

export type Input = z.infer<typeof schema>;

/**
 * Vault structure result
 */
interface VaultStructure {
  totalFiles: number;
  folders?: Array<{ path: string; fileCount: number }>;
  tags?: Array<{ tag: string; count: number }>;
  recentFiles?: Array<{ path: string; name: string; modified: number }>;
}

/**
 * Execute list vault structure
 */
export async function execute(
  input: Input,
  context: SkillContext
): Promise<SkillResult<VaultStructure>> {
  try {
    const startTime = Date.now();
    const allFiles = context.vault.getMarkdownFiles() as TFile[];

    const result: VaultStructure = {
      totalFiles: allFiles.length
    };

    // Collect folders
    if (input.includeFolders) {
      const folderCounts = new Map<string, number>();
      allFiles.forEach(file => {
        const folderPath = file.parent?.path || '/';
        folderCounts.set(folderPath, (folderCounts.get(folderPath) || 0) + 1);
      });

      result.folders = Array.from(folderCounts.entries())
        .map(([path, fileCount]) => ({ path, fileCount }))
        .sort((a, b) => b.fileCount - a.fileCount)
        .slice(0, input.limit);
    }

    // Collect tags
    if (input.includeTags) {
      const tagCounts = new Map<string, number>();
      allFiles.forEach(file => {
        const cache = context.metadataCache.getFileCache(file);
        const fileTags = cache?.tags?.map((t: any) => t.tag.replace('#', '')) || [];
        const frontmatterTags = cache?.frontmatter?.tags || [];
        [...fileTags, ...frontmatterTags].forEach(tag => {
          const tagStr = typeof tag === 'string' ? tag : String(tag);
          tagCounts.set(tagStr, (tagCounts.get(tagStr) || 0) + 1);
        });
      });

      result.tags = Array.from(tagCounts.entries())
        .map(([tag, count]) => ({ tag, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, input.limit);
    }

    // Collect recent files
    if (input.includeRecent) {
      result.recentFiles = allFiles
        .sort((a, b) => b.stat.mtime - a.stat.mtime)
        .slice(0, input.limit)
        .map(file => ({
          path: file.path,
          name: file.basename,
          modified: file.stat.mtime
        }));
    }

    return {
      success: true,
      data: result,
      metadata: {
        executionTime: Date.now() - startTime
      }
    };
  } catch (error) {
    console.error('[ListNotes] Error:', error);
    return {
      success: false,
      error: (error as Error).message || 'Failed to list notes'
    };
  }
}

/**
 * Factory function for backward compatibility
 */
export function createSkill(context: SkillContext) {
  return {
    schema,
    execute: (input: Input) => execute(input, context)
  };
}
