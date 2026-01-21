// Update Frontmatter Implementation
// Core logic for updating frontmatter in Obsidian documents

import { z } from 'zod';
import { TFile } from 'obsidian';
import { SkillContext, SkillResult } from '../../../src/skills/skill-types';

/**
 * Input schema for update frontmatter
 */
export const schema = z.object({
  path: z.string().describe('File path to update'),
  updates: z.record(z.any()).describe('Frontmatter fields to add or update'),
  remove: z.array(z.string()).optional().describe('Frontmatter fields to remove'),
  merge: z.boolean().default(true).describe('Merge with existing frontmatter (if false, replaces entirely)')
});

export type Input = z.infer<typeof schema>;

/**
 * Frontmatter update result
 */
interface FrontmatterUpdateResult {
  path: string;
  name: string;
  updated: boolean;
  previousFrontmatter: Record<string, any>;
  newFrontmatter: Record<string, any>;
}

/**
 * Execute update frontmatter
 */
export async function execute(
  input: Input,
  context: SkillContext
): Promise<SkillResult<FrontmatterUpdateResult>> {
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

    // Read current content
    const content = await context.vault.read(file);

    // Extract existing frontmatter
    const { frontmatter: previousFrontmatter, content: bodyContent } = parseFrontmatter(content);

    // Build new frontmatter
    let newFrontmatter: Record<string, any>;

    if (input.merge) {
      // Merge with existing
      newFrontmatter = { ...previousFrontmatter, ...input.updates };

      // Remove specified fields
      if (input.remove) {
        input.remove.forEach(key => delete newFrontmatter[key]);
      }
    } else {
      // Replace entirely
      newFrontmatter = { ...input.updates };
    }

    // Build new content with updated frontmatter
    const newContent = buildContent(newFrontmatter, bodyContent);

    // Write back to file
    await context.vault.modify(file, newContent);

    const result: FrontmatterUpdateResult = {
      path: file.path,
      name: file.basename,
      updated: true,
      previousFrontmatter,
      newFrontmatter
    };

    return {
      success: true,
      data: result,
      metadata: {
        executionTime: Date.now() - startTime,
        filesModified: [file.path]
      }
    };
  } catch (error) {
    console.error('[UpdateFrontmatter] Error:', error);
    return {
      success: false,
      error: (error as Error).message || 'Failed to update frontmatter'
    };
  }
}

/**
 * Helper: Parse frontmatter from content
 */
function parseFrontmatter(content: string): {
  frontmatter: Record<string, any>;
  content: string;
} {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);

  if (!match) {
    return { frontmatter: {}, content };
  }

  const frontmatterText = match[1];
  const bodyContent = match[2];

  // Simple YAML parsing
  const frontmatter: Record<string, any> = {};
  const lines = frontmatterText.split('\n');
  let currentKey: string | null = null;
  let currentArray: any[] | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Array item
    if (trimmed.startsWith('- ')) {
      const value = trimmed.substring(2);
      if (currentArray) {
        currentArray.push(value);
      }
      continue;
    }

    // Key-value pair
    const colonIndex = trimmed.indexOf(':');
    if (colonIndex > 0) {
      currentKey = trimmed.substring(0, colonIndex).trim();
      const value = trimmed.substring(colonIndex + 1).trim();

      if (value === '') {
        // Start of array
        currentArray = [];
        frontmatter[currentKey] = currentArray;
      } else {
        // Simple value
        frontmatter[currentKey] = value;
        currentArray = null;
      }
    }
  }

  return { frontmatter, content: bodyContent };
}

/**
 * Helper: Build content with frontmatter
 */
function buildContent(frontmatter: Record<string, any>, bodyContent: string): string {
  if (Object.keys(frontmatter).length === 0) {
    return bodyContent;
  }

  const lines = ['---'];

  for (const [key, value] of Object.entries(frontmatter)) {
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      value.forEach(item => lines.push(`  - ${item}`));
    } else if (typeof value === 'object' && value !== null) {
      lines.push(`${key}:`);
      Object.entries(value).forEach(([k, v]) => lines.push(`  ${k}: ${v}`));
    } else {
      lines.push(`${key}: ${value}`);
    }
  }

  lines.push('---');
  return lines.join('\n') + '\n' + bodyContent;
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
