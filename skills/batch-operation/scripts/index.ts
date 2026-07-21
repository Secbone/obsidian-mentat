// Batch Operation Implementation
// Core logic for batch operations on Obsidian documents

import { z } from 'zod';
import { TFile, Vault, MetadataCache } from 'obsidian';
import { SkillContext, SkillResult } from '../../../src/skills/skill-types';

/**
 * Skill metadata
 */
export const metadata = {
  name: 'batch_operation',
  description: 'Perform bulk operations on multiple documents matching filter criteria',
  version: '1.0.0',
  tags: ['batch', 'bulk', 'update'],
  requiresConfirmation: true,
  executionCategory: 'write',
  permissions: ['read', 'write', 'delete'],
  performance: 'slow',
  category: 'file-operations'
};

/**
 * Input schema for batch operations
 */
export const schema = z.object({
  operation: z.enum(['add-tags', 'remove-tags', 'update-frontmatter', 'append-content']).describe('Operation to perform'),
  filter: z.object({
    folders: z.array(z.string()).optional().describe('Filter by folder paths (OR logic)'),
    tags: z.array(z.string()).optional().describe('Filter by tags (AND logic)'),
    frontmatter: z.record(z.any()).optional().describe('Filter by frontmatter fields'),
    paths: z.array(z.string()).optional().describe('Specific file paths to operate on')
  }).describe('Filter criteria for selecting files'),
  params: z.union([
    z.object({ tags: z.array(z.string()) }),
    z.object({ updates: z.record(z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])) }),
    z.object({ content: z.string() })
  ]).describe('Operation-specific parameters'),
  dryRun: z.boolean().default(false).describe('Preview changes without applying (default: false)'),
  maxFiles: z.number().min(1).max(100).default(50).describe('Maximum number of files to process (default: 50, max: 100)')
});

export type Input = z.infer<typeof schema>;

/**
 * Batch operation result
 */
interface BatchOperationResult {
  operation: string;
  filesProcessed: number;
  filesModified: string[];
  filesSkipped: string[];
  errors: Array<{ path: string; error: string }>;
  dryRun: boolean;
}

/**
 * Execute batch operation
 */
export async function execute(
  input: Input,
  context: SkillContext
): Promise<SkillResult<BatchOperationResult>> {
  try {
    const startTime = Date.now();

    // Get all files matching the filter
    const files = await getFilteredFiles(context, input.filter, input.maxFiles);

    if (files.length === 0) {
      return {
        success: true,
        data: {
          operation: input.operation,
          filesProcessed: 0,
          filesModified: [],
          filesSkipped: [],
          errors: [],
          dryRun: input.dryRun
        }
      };
    }

    // Perform the operation
    const result = await performOperation(
      context,
      input.operation,
      files,
      input.params,
      input.dryRun
    );

    return {
      success: true,
      data: {
        ...result,
        operation: input.operation,
        dryRun: input.dryRun
      },
      metadata: {
        executionTime: Date.now() - startTime,
        filesModified: input.dryRun ? [] : result.filesModified
      }
    };
  } catch (error) {
    console.error('[BatchOperation] Error:', error);
    return {
      success: false,
      error: (error as Error).message || 'Failed to perform batch operation'
    };
  }
}

/**
 * Helper: Get filtered files
 */
async function getFilteredFiles(
  context: SkillContext,
  filter: Input['filter'],
  maxFiles: number
): Promise<TFile[]> {
  let files = context.vault.getMarkdownFiles() as TFile[];

  // Filter by specific paths (takes precedence)
  if (filter.paths && filter.paths.length > 0) {
    files = filter.paths
      .map(path => context.vault.getAbstractFileByPath(path))
      .filter((f): f is TFile => f instanceof TFile);
  } else {
    // Filter by folders
    if (filter.folders && filter.folders.length > 0) {
      files = files.filter(file => {
        return filter.folders!.some(folder => file.path.startsWith(folder));
      });
    }

    // Filter by tags
    if (filter.tags && filter.tags.length > 0) {
      files = files.filter(file => {
        const cache = context.metadataCache.getFileCache(file);
        const fileTags = cache?.tags?.map((t: any) => t.tag.replace('#', '')) || [];
        const frontmatterTags = cache?.frontmatter?.tags || [];
        const allTags = [...fileTags, ...frontmatterTags].map(t =>
          typeof t === 'string' ? t : String(t)
        );
        return filter.tags!.every(tag => allTags.includes(tag));
      });
    }

    // Filter by frontmatter
    if (filter.frontmatter) {
      files = files.filter(file => {
        const cache = context.metadataCache.getFileCache(file);
        const fm = cache?.frontmatter || {};

        return Object.entries(filter.frontmatter!).every(([key, value]) => {
          return fm[key] === value;
        });
      });
    }
  }

  // Limit results
  return files.slice(0, maxFiles);
}

/**
 * Helper: Perform the operation
 */
async function performOperation(
  context: SkillContext,
  operation: string,
  files: TFile[],
  params: Record<string, any>,
  dryRun: boolean
): Promise<{
  filesProcessed: number;
  filesModified: string[];
  filesSkipped: string[];
  errors: Array<{ path: string; error: string }>;
}> {
  const filesModified: string[] = [];
  const filesSkipped: string[] = [];
  const errors: Array<{ path: string; error: string }> = [];

  for (const file of files) {
    try {
      let modified = false;

      switch (operation) {
        case 'add-tags':
          modified = await addTags(context, file, params.tags || [], dryRun);
          break;

        case 'remove-tags':
          modified = await removeTags(context, file, params.tags || [], dryRun);
          break;

        case 'update-frontmatter':
          modified = await updateFrontmatter(context, file, params.updates || {}, dryRun);
          break;

        case 'append-content':
          modified = await appendContent(context, file, params.content || '', dryRun);
          break;

        default:
          throw new Error(`Unknown operation: ${operation}`);
      }

      if (modified) {
        filesModified.push(file.path);
      } else {
        filesSkipped.push(file.path);
      }
    } catch (error) {
      console.error(`[BatchOperation] Error processing ${file.path}:`, error);
      errors.push({ path: file.path, error: (error as Error).message });
    }
  }

  return {
    filesProcessed: files.length,
    filesModified,
    filesSkipped,
    errors
  };
}

/**
 * Helper: Add tags to a file
 */
async function addTags(
  context: SkillContext,
  file: TFile,
  tags: string[],
  dryRun: boolean
): Promise<boolean> {
  const content = await context.vault.read(file);
  const { frontmatter, content: bodyContent } = parseFrontmatter(content);

  // Get existing tags
  const existingTags = Array.isArray(frontmatter.tags) ? frontmatter.tags : [];

  // Add new tags (avoid duplicates)
  const newTags = [...new Set([...existingTags, ...tags])];

  if (newTags.length === existingTags.length) {
    return false; // No changes needed
  }

  if (!dryRun) {
    frontmatter.tags = newTags;
    const newContent = buildContent(frontmatter, bodyContent);
    await context.vault.modify(file, newContent);
  }

  return true;
}

/**
 * Helper: Remove tags from a file
 */
async function removeTags(
  context: SkillContext,
  file: TFile,
  tags: string[],
  dryRun: boolean
): Promise<boolean> {
  const content = await context.vault.read(file);
  const { frontmatter, content: bodyContent } = parseFrontmatter(content);

  // Get existing tags
  const existingTags = Array.isArray(frontmatter.tags) ? frontmatter.tags : [];

  // Remove specified tags
  const newTags = existingTags.filter(tag => !tags.includes(tag));

  if (newTags.length === existingTags.length) {
    return false; // No changes needed
  }

  if (!dryRun) {
    frontmatter.tags = newTags;
    const newContent = buildContent(frontmatter, bodyContent);
    await context.vault.modify(file, newContent);
  }

  return true;
}

/**
 * Helper: Update frontmatter
 */
async function updateFrontmatter(
  context: SkillContext,
  file: TFile,
  updates: Record<string, any>,
  dryRun: boolean
): Promise<boolean> {
  const content = await context.vault.read(file);
  const { frontmatter, content: bodyContent } = parseFrontmatter(content);

  // Merge updates
  const newFrontmatter = { ...frontmatter, ...updates };

  if (!dryRun) {
    const newContent = buildContent(newFrontmatter, bodyContent);
    await context.vault.modify(file, newContent);
  }

  return true;
}

/**
 * Helper: Append content
 */
async function appendContent(
  context: SkillContext,
  file: TFile,
  content: string,
  dryRun: boolean
): Promise<boolean> {
  if (!content) {
    return false;
  }

  if (!dryRun) {
    const currentContent = await context.vault.read(file);
    const newContent = currentContent + '\n\n' + content;
    await context.vault.modify(file, newContent);
  }

  return true;
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
