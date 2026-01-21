// Create Document Implementation
// Core logic for creating Obsidian documents

import { z } from 'zod';
import { TFile, Vault } from 'obsidian';
import { SkillContext, SkillResult } from '../../../src/skills/skill-types';

/**
 * Input schema for create document
 */
export const schema = z.object({
  path: z.string().describe('File path for the new document'),
  content: z.string().optional().describe('Initial content'),
  template: z.string().optional().describe('Template name to use'),
  variables: z.record(z.any()).optional().describe('Variables for template'),
  frontmatter: z.record(z.any()).optional().describe('Frontmatter metadata'),
  triggerReindex: z.boolean().default(true).describe('Trigger reindex after creation')
});

export type Input = z.infer<typeof schema>;

/**
 * Create result
 */
interface CreateResult {
  path: string;
  name: string;
  created: boolean;
  length: number;
  reindexed: boolean;
}

/**
 * Execute create document
 */
export async function execute(
  input: Input,
  context: SkillContext
): Promise<SkillResult<CreateResult>> {
  try {
    const startTime = Date.now();

    // Ensure folder path
    const folderPath = input.path.substring(0, input.path.lastIndexOf('/'));
    if (folderPath) {
      await ensureFolder(context.vault, folderPath);
    }

    // Check if file already exists
    const existingFile = context.vault.getAbstractFileByPath(input.path);
    if (existingFile) {
      return {
        success: false,
        error: `File already exists: ${input.path}`
      };
    }

    // Build content
    let content = input.content || '';

    // Add frontmatter if provided
    if (input.frontmatter && Object.keys(input.frontmatter).length > 0) {
      const frontmatterText = buildFrontmatter(input.frontmatter);
      content = frontmatterText + '\n\n' + content;
    }

    // Create the file
    const file = await context.vault.create(input.path, content);

    // Trigger reindex if requested and index manager is available
    let reindexed = false;
    if (input.triggerReindex && context.indexManager) {
      try {
        await context.indexManager.indexFile(file);
        reindexed = true;
      } catch (error) {
        console.warn('[CreateDocument] Failed to reindex:', error);
      }
    }

    const result: CreateResult = {
      path: file.path,
      name: file.basename,
      created: true,
      length: content.length,
      reindexed
    };

    return {
      success: true,
      data: result,
      metadata: {
        executionTime: Date.now() - startTime,
        filesCreated: [file.path]
      }
    };
  } catch (error) {
    console.error('[CreateDocument] Error:', error);
    return {
      success: false,
      error: (error as Error).message || 'Failed to create document'
    };
  }
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
 * Helper: Build frontmatter YAML
 */
function buildFrontmatter(data: Record<string, any>): string {
  const lines = ['---'];

  for (const [key, value] of Object.entries(data)) {
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
  return lines.join('\n');
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
