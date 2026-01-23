// Query Documents Implementation
// Core logic for searching and filtering Obsidian documents

import { z } from 'zod';
import { TFile } from 'obsidian';
import { SkillContext, SkillResult } from '../../../src/skills/skill-types';

/**
 * Skill metadata
 */
export const metadata = {
  name: 'query_notes',
  description: 'Search documents by content, tags, folders, or glob patterns',
  version: '1.0.0',
  tags: ['search', 'query', 'filter'],
  performance: 'variable',
  category: 'search'
};

/**
 * Input schema for query documents
 */
export const schema = z.object({
  query: z.string().optional().describe('Semantic search query'),
  tags: z.array(z.string()).optional().describe('Filter by tags (AND logic)'),
  folders: z.array(z.string()).optional().describe('Filter by folder paths'),
  pattern: z.string().optional().describe('Glob pattern to match file paths (e.g., "Daily/2025-*.md", "**/*.md")'),
  dateFrom: z.string().optional().describe('Filter files modified after this date (ISO format)'),
  dateTo: z.string().optional().describe('Filter files modified before this date (ISO format)'),
  frontmatter: z.record(z.any()).optional().describe('Filter by frontmatter fields'),
  limit: z.number().min(1).max(100).default(10).describe('Maximum number of results'),
  sortBy: z.enum(['modified', 'created', 'name', 'relevance']).default('relevance').describe('Sort order')
});

export type Input = z.infer<typeof schema>;

/**
 * Query result item
 */
interface QueryResultItem {
  path: string;
  name: string;
  score?: number;
  metadata: {
    tags: string[];
    frontmatter: Record<string, any>;
    modified: number;
    created: number;
  };
}

/**
 * Execute query documents
 */
export async function execute(
  input: Input,
  context: SkillContext
): Promise<SkillResult> {
  try {
    const startTime = Date.now();
    let files = context.vault.getMarkdownFiles() as TFile[];

    // Filter by glob pattern
    if (input.pattern) {
      const regex = globToRegex(input.pattern);
      files = files.filter(file => regex.test(file.path));
    }

    // Filter by folders
    if (input.folders && input.folders.length > 0) {
      files = files.filter(file => {
        return input.folders!.some(folder => file.path.startsWith(folder));
      });
    }

    // Filter by date range
    if (input.dateFrom) {
      const fromTime = new Date(input.dateFrom).getTime();
      files = files.filter(file => file.stat.mtime >= fromTime);
    }

    if (input.dateTo) {
      const toTime = new Date(input.dateTo).getTime();
      files = files.filter(file => file.stat.mtime <= toTime);
    }

    // Filter by tags
    if (input.tags && input.tags.length > 0) {
      files = files.filter(file => {
        const cache = context.metadataCache.getFileCache(file);
        const fileTags = cache?.tags?.map((t: any) => t.tag.replace('#', '')) || [];
        const frontmatterTags = cache?.frontmatter?.tags || [];
        const allTags = [...fileTags, ...frontmatterTags].map(t =>
          typeof t === 'string' ? t : String(t)
        );
        return input.tags!.every(tag => allTags.includes(tag));
      });
    }

    // Filter by frontmatter
    if (input.frontmatter) {
      files = files.filter(file => {
        const cache = context.metadataCache.getFileCache(file);
        const fm = cache?.frontmatter || {};

        return Object.entries(input.frontmatter!).every(([key, value]) => {
          return fm[key] === value;
        });
      });
    }

    // Semantic search (if query provided and index manager available)
    let resultsWithScores: Array<{ file: TFile; score: number }> = [];

    if (input.query && context.indexManager) {
      try {
        const searchResults = await context.indexManager.search(input.query, {
          topK: input.limit * 2,
          minScore: 0.3,
          filterFiles: files.map(f => f.path)
        });

        // Group by file and get max score
        const fileScores = new Map<string, number>();
        searchResults.forEach((result: any) => {
          const path = result.chunk.filePath;
          const currentScore = fileScores.get(path) || 0;
          fileScores.set(path, Math.max(currentScore, result.score));
        });

        resultsWithScores = files
          .map(file => ({
            file,
            score: fileScores.get(file.path) || 0
          }))
          .filter(item => item.score > 0);
      } catch (error) {
        console.warn('[QueryDocuments] Semantic search failed, falling back to metadata-only:', error);
        resultsWithScores = files.map(file => ({ file, score: 1 }));
      }
    } else {
      resultsWithScores = files.map(file => ({ file, score: 1 }));
    }

    // Sort results
    resultsWithScores.sort((a, b) => {
      switch (input.sortBy) {
        case 'modified':
          return b.file.stat.mtime - a.file.stat.mtime;
        case 'created':
          return b.file.stat.ctime - a.file.stat.ctime;
        case 'name':
          return a.file.name.localeCompare(b.file.name);
        case 'relevance':
        default:
          return b.score - a.score;
      }
    });

    // Limit results
    const limitedResults = resultsWithScores.slice(0, input.limit);

    // Build result items
    const results: QueryResultItem[] = limitedResults.map(({ file, score }) => {
      const cache = context.metadataCache.getFileCache(file);
      const fileTags = cache?.tags?.map((t: any) => t.tag.replace('#', '')) || [];
      const frontmatterTags = cache?.frontmatter?.tags || [];
      const allTags = [...fileTags, ...frontmatterTags].map(t =>
        typeof t === 'string' ? t : String(t)
      );

      return {
        path: file.path,
        name: file.basename,
        score: input.sortBy === 'relevance' ? score : undefined,
        metadata: {
          tags: allTags,
          frontmatter: cache?.frontmatter || {},
          modified: file.stat.mtime,
          created: file.stat.ctime
        }
      };
    });

    return {
      success: true,
      data: {
        results,
        total: results.length,
        query: input.query,
        filters: {
          pattern: input.pattern,
          tags: input.tags,
          folders: input.folders,
          dateFrom: input.dateFrom,
          dateTo: input.dateTo
        }
      },
      metadata: {
        executionTime: Date.now() - startTime
      }
    };
  } catch (error) {
    console.error('[QueryDocuments] Error:', error);
    return {
      success: false,
      error: (error as Error).message || 'Failed to query documents'
    };
  }
}

/**
 * Convert glob pattern to regex
 */
function globToRegex(pattern: string): RegExp {
  let regexPattern = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '___DOUBLESTAR___')
    .replace(/\*/g, '[^/]*')
    .replace(/___DOUBLESTAR___/g, '.*')
    .replace(/\?/g, '.');

  return new RegExp(`^${regexPattern}$`);
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
