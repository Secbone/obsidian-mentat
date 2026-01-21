// Update Document Implementation
// Core logic for updating Obsidian documents

import { z } from 'zod';
import { TFile, Vault } from 'obsidian';
import { SkillContext, SkillResult } from '../../../src/skills/skill-types';

/**
 * Input schema for update document
 */
export const schema = z.object({
  path: z.string().describe('File path to update'),
  content: z.string().describe('Content to add or replace'),
  mode: z.enum(['replace', 'append', 'prepend', 'insert-after-heading']).describe('Update mode'),
  heading: z.string().optional().describe('Heading name (required for insert-after-heading mode)'),
  createIfNotExists: z.boolean().default(false).describe('Create file if it does not exist'),
  triggerReindex: z.boolean().default(true).describe('Trigger reindex after update')
});

export type Input = z.infer<typeof schema>;

/**
 * Update result
 */
interface UpdateResult {
  path: string;
  name: string;
  updated: boolean;
  created: boolean;
  previousLength: number;
  newLength: number;
  reindexed: boolean;
}

/**
 * Execute update document
 */
export async function execute(
  input: Input,
  context: SkillContext
): Promise<SkillResult<UpdateResult>> {
  try {
    const startTime = Date.now();
    let file = context.vault.getAbstractFileByPath(input.path);
    let created = false;
    let previousLength = 0;

    // Check if file exists
    if (!file) {
      if (!input.createIfNotExists) {
        return {
          success: false,
          error: `File not found: ${input.path}`
        };
      }

      // Create the file
      const folderPath = input.path.substring(0, input.path.lastIndexOf('/'));
      if (folderPath) {
        await ensureFolder(context.vault, folderPath);
      }

      file = await context.vault.create(input.path, '');
      created = true;
    }

    if (!(file instanceof TFile)) {
      return {
        success: false,
        error: `Path is not a file: ${input.path}`
      };
    }

    // Read current content
    const currentContent = await context.vault.read(file);
    previousLength = currentContent.length;

    // Build new content based on mode
    let newContent: string;

    switch (input.mode) {
      case 'replace':
        newContent = input.content;
        break;

      case 'append':
        newContent = currentContent + '\n\n' + input.content;
        break;

      case 'prepend':
        // Preserve frontmatter if it exists
        const frontmatterMatch = currentContent.match(/^---\n[\s\S]*?\n---\n/);
        if (frontmatterMatch) {
          const frontmatter = frontmatterMatch[0];
          const restContent = currentContent.substring(frontmatter.length);
          newContent = frontmatter + '\n' + input.content + '\n\n' + restContent;
        } else {
          newContent = input.content + '\n\n' + currentContent;
        }
        break;

      case 'insert-after-heading':
        if (!input.heading) {
          return {
            success: false,
            error: 'Heading is required for insert-after-heading mode'
          };
        }
        newContent = insertAfterHeading(currentContent, input.heading, input.content);
        if (newContent === currentContent) {
          return {
            success: false,
            error: `Heading "${input.heading}" not found in document`
          };
        }
        break;

      default:
        return {
          success: false,
          error: `Unknown mode: ${input.mode}`
        };
    }

    // Write the updated content
    await context.vault.modify(file, newContent);

    // Trigger reindex if requested and index manager is available
    let reindexed = false;
    if (input.triggerReindex && context.indexManager) {
      try {
        await context.indexManager.indexFile(file);
        reindexed = true;
      } catch (error) {
        console.warn('[UpdateDocument] Failed to reindex:', error);
      }
    }

    const result: UpdateResult = {
      path: file.path,
      name: file.basename,
      updated: true,
      created,
      previousLength,
      newLength: newContent.length,
      reindexed
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
    console.error('[UpdateDocument] Error:', error);
    return {
      success: false,
      error: (error as Error).message || 'Failed to update document'
    };
  }
}

/**
 * Helper: Insert content after a heading
 */
function insertAfterHeading(content: string, heading: string, newContent: string): string {
  const lines = content.split('\n');
  const headingPattern = new RegExp(`^#+\\s+${heading}\\s*$`, 'i');

  for (let i = 0; i < lines.length; i++) {
    if (headingPattern.test(lines[i])) {
      lines.splice(i + 1, 0, '', newContent);
      return lines.join('\n');
    }
  }

  return content;
}

/**
 * Helper: Ensure folder exists
 */
async function ensureFolder(vault: Vault, folderPath: string): Promise<void> {
  const parts = folderPath.split('/');
  let currentPath = '';

  for (const part of parts) {
    currentPath += (currentPath ? '/' : '') + part;
    const folder = vault.getAbstractFileByPath(currentPath);

    if (!folder) {
      await vault.createFolder(currentPath);
    }
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
