// Read Document Implementation
// Core logic for reading Obsidian documents

import { z } from 'zod';
import { TFile } from 'obsidian';
import { SkillContext, SkillResult } from '../../../src/skills/skill-types';

/**
 * Input schema for read document
 */
export const schema = z.object({
  path: z.string().describe('File path to read'),
  section: z.string().optional().describe('Specific section/heading to read (optional)'),
  includeMetadata: z.boolean().default(true).describe('Include file metadata'),
  includeFrontmatter: z.boolean().default(true).describe('Include frontmatter'),
  includeLinks: z.boolean().default(true).describe('Include outgoing links'),
  includeBacklinks: z.boolean().default(false).describe('Include backlinks')
});

export type Input = z.infer<typeof schema>;

/**
 * Document content result
 */
interface DocumentContent {
  path: string;
  name: string;
  content: string;
  frontmatter?: Record<string, any>;
  metadata?: {
    tags: string[];
    links: string[];
    backlinks?: string[];
    headings: Array<{ level: number; text: string; position: number }>;
    wordCount: number;
    charCount: number;
    modified: number;
    created: number;
  };
}

/**
 * Execute read document
 */
export async function execute(
  input: Input,
  context: SkillContext
): Promise<SkillResult<DocumentContent>> {
  try {
    const startTime = Date.now();

    // Find the file
    const file = context.vault.getAbstractFileByPath(input.path);

    if (!file || !(file instanceof TFile)) {
      return {
        success: false,
        error: `File not found: ${input.path}`
      };
    }

    // Read file content
    const fullContent = await context.vault.read(file);

    // Extract section if requested
    let content = fullContent;
    if (input.section) {
      const extracted = extractSection(fullContent, input.section);
      if (!extracted) {
        return {
          success: false,
          error: `Section "${input.section}" not found in document`
        };
      }
      content = extracted;
    }

    // Build result
    const result: DocumentContent = {
      path: file.path,
      name: file.basename,
      content
    };

    // Add frontmatter if requested
    if (input.includeFrontmatter) {
      const cache = context.metadataCache.getFileCache(file);
      result.frontmatter = cache?.frontmatter || {};
    }

    // Add metadata if requested
    if (input.includeMetadata) {
      const cache = context.metadataCache.getFileCache(file);

      // Extract tags
      const fileTags = cache?.tags?.map((t: any) => t.tag.replace('#', '')) || [];
      const frontmatterTags = cache?.frontmatter?.tags || [];
      const allTags = [...fileTags, ...frontmatterTags].map(t =>
        typeof t === 'string' ? t : String(t)
      );

      // Extract links
      let links: string[] = [];
      if (input.includeLinks) {
        links = cache?.links?.map((l: any) => l.link) || [];
      }

      // Extract backlinks
      let backlinks: string[] = [];
      if (input.includeBacklinks) {
        const backlinkData = context.metadataCache.getBacklinksForFile(file);
        if (backlinkData) {
          backlinks = Array.from(backlinkData.keys());
        }
      }

      // Extract headings
      const headings = cache?.headings?.map((h: any) => ({
        level: h.level,
        text: h.heading,
        position: h.position.start.offset
      })) || [];

      result.metadata = {
        tags: allTags,
        links,
        backlinks: input.includeBacklinks ? backlinks : undefined,
        headings,
        wordCount: countWords(content),
        charCount: content.length,
        modified: file.stat.mtime,
        created: file.stat.ctime
      };
    }

    return {
      success: true,
      data: result,
      metadata: {
        executionTime: Date.now() - startTime
      }
    };
  } catch (error) {
    console.error('[ReadDocument] Error:', error);
    return {
      success: false,
      error: (error as Error).message || 'Failed to read document'
    };
  }
}

/**
 * Helper: Extract section by heading
 */
function extractSection(content: string, heading: string): string | null {
  const lines = content.split('\n');
  const headingPattern = new RegExp(`^#+\\s+${heading}\\s*$`, 'i');

  let startIndex = -1;
  let startLevel = 0;

  // Find the heading
  for (let i = 0; i < lines.length; i++) {
    if (headingPattern.test(lines[i])) {
      startIndex = i;
      const match = lines[i].match(/^(#+)/);
      startLevel = match ? match[1].length : 0;
      break;
    }
  }

  if (startIndex === -1) {
    return null;
  }

  // Find the end (next heading of same or higher level)
  let endIndex = lines.length;
  for (let i = startIndex + 1; i < lines.length; i++) {
    const match = lines[i].match(/^(#+)\s/);
    if (match) {
      const level = match[1].length;
      if (level <= startLevel) {
        endIndex = i;
        break;
      }
    }
  }

  return lines.slice(startIndex, endIndex).join('\n');
}

/**
 * Helper: Count words in text
 */
function countWords(text: string): number {
  const words = text.trim().split(/\s+/);
  return words.length > 0 && words[0] !== '' ? words.length : 0;
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
