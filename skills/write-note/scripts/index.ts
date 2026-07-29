// Write Note Implementation
// Create/overwrite notes with mutiple operation modes (create, append, prepend, section, replace-all)

import { z } from 'zod';
import { TFile, Vault } from 'obsidian';
import { SkillContext, SkillResult } from '../../../src/skills/skill-types';
import { NoteLinter } from '../../../src/utils/note-linter';
import { computeDiff } from '../../../src/utils/diff';
import { getHeadingPattern, insertAfterHeading, replaceSection } from '../../../src/utils/note-manipulator';

/**
 * Skill metadata
 */
export const metadata = {
  name: 'write_note',
  description: 'Create or overwrite notes with flexible content operations',
  version: '1.0.0',
  tags: ['create', 'write', 'append', 'prepend'],
  requiresConfirmation: true,
  executionCategory: 'write',
  permissions: ['read', 'write'],
  performance: 'fast',
  category: 'file-operations'
};

/**
 * Input schema
 */
export const schema = z.object({
  path: z.string().describe('File path to write to'),
  content: z.string().describe('Content to write/append/prepend'),

  frontmatter: z.record(z.any()).optional().describe('Frontmatter metadata'),
  heading: z.string().optional().describe('Target heading for section insert/replace'),
  append: z.boolean().default(false).describe('Append to end of file'),
  prepend: z.boolean().default(false).describe('Prepend to beginning of file'),
  insert_after: z.boolean().default(false).describe('Insert after heading instead of replacing section'),
  create_only: z.boolean().default(false).describe('Only create, fail if file exists'),

  triggerReindex: z.boolean().default(true).describe('Trigger reindex after operation')
});

export type Input = z.infer<typeof schema>;

interface WriteResult {
  path: string;
  name: string;
  created: boolean;
  updated: boolean;
  operation: string;
  previousLength: number;
  newLength: number;
  reindexed: boolean;
}

export async function execute(
  input: Input,
  context: SkillContext
): Promise<SkillResult<WriteResult>> {
  const startTime = Date.now();
  const file = context.vault.getAbstractFileByPath(input.path);
  const fileExists = !!(file && file instanceof TFile);

  let previousContent: string | null = null;
  const wasCreated = !fileExists;

  if (input.create_only && fileExists) {
    return {
      success: false,
      error: `File already exists and create_only is true: ${input.path}`
    };
  }

  try {
    if (fileExists && file instanceof TFile) {
      previousContent = await context.vault.read(file);
    }
  } catch (backupError) {
    console.warn('[WriteNote] Backup failed:', backupError);
  }

  if (fileExists && context.readTracker && !context.readTracker.hasBeenRead(input.path)) {
    return {
      success: false,
      error: `You must read the file using read_note before modifying it: ${input.path}`
    };
  }

  try {
    let operation: string;
    let result: WriteResult;

    if (!fileExists) {
      operation = 'create';
      result = await createFile(input, context);
    } else if (input.heading) {
      operation = input.insert_after ? 'insert-after-heading' : 'replace-section';
      result = await handleSection(file as TFile, input, context);
    } else if (input.append) {
      operation = 'append';
      result = await appendContent(file as TFile, input, context);
    } else if (input.prepend) {
      operation = 'prepend';
      result = await prependContent(file as TFile, input, context);
    } else {
      operation = 'replace-all';
      result = await replaceAllContent(file as TFile, input, context);
    }

    // Linter Validation & Rollback Guard
    const updatedFile = context.vault.getAbstractFileByPath(input.path);
    if (updatedFile instanceof TFile) {
      const newContent = await context.vault.read(updatedFile);
      const linterResult = NoteLinter.validate(newContent);

      if (!linterResult.isValid) {
        let isIncrementalImprovement = false;
        let originalErrorsCount = 0;

        if (previousContent !== null) {
          const originalLinterResult = NoteLinter.validate(previousContent);
          originalErrorsCount = originalLinterResult.errors.length;
          if (linterResult.errors.length <= originalLinterResult.errors.length) {
            isIncrementalImprovement = true;
          }
        }

        if (isIncrementalImprovement) {
          console.log(`[WriteNote] Allowed edit with formatting errors under Incremental Linter Guard. Previous errors: ${originalErrorsCount}, New errors: ${linterResult.errors.length}`);
        } else {
          try {
            if (wasCreated) {
              await context.vault.delete(updatedFile);
            } else if (previousContent !== null) {
              await context.vault.modify(updatedFile, previousContent);
            }
          } catch (rollbackError) {
            console.error('[WriteNote] Rollback failed:', rollbackError);
          }

          return {
            success: false,
            error: `Note Linter Validation Failed!\nYour edit introduced formatting errors:\n${linterResult.errors.map(err => `- ${err}`).join('\n')}\n\nYour changes have been safely rolled back. Please correct these formatting issues and try again.`
          };
        }
      }
    }

    // Compute diff for display
    const finalFile = context.vault.getAbstractFileByPath(input.path);
    let diff: any[] | undefined;
    if (finalFile instanceof TFile) {
      try {
        const finalContent = await context.vault.read(finalFile);
        diff = computeDiff(previousContent ?? '', finalContent);
      } catch (_) { /* ignore diff errors */ }
    }

    return {
      success: true,
      data: {
        ...result,
        operation
      },
      metadata: {
        executionTime: Date.now() - startTime,
        filesCreated: result.created ? [result.path] : undefined,
        filesModified: result.updated ? [result.path] : undefined,
        diff
      }
    };
  } catch (error) {
    console.error('[WriteNote] Error:', error);

    try {
      const crashedFile = context.vault.getAbstractFileByPath(input.path);
      if (crashedFile instanceof TFile) {
        if (wasCreated) {
          await context.vault.delete(crashedFile);
        } else if (previousContent !== null) {
          await context.vault.modify(crashedFile, previousContent);
        }
      }
    } catch (rollbackError) {
      console.error('[WriteNote] Rollback on crash failed:', rollbackError);
    }

    return {
      success: false,
      error: (error as Error).message || 'Failed to write note'
    };
  }
}

async function createFile(
  input: Input,
  context: SkillContext
): Promise<WriteResult> {
  const folderPath = input.path.substring(0, input.path.lastIndexOf('/'));
  if (folderPath) {
    await ensureFolder(context.vault, folderPath);
  }

  let content = input.content || '';

  if (input.frontmatter && Object.keys(input.frontmatter).length > 0) {
    const frontmatterText = buildFrontmatter(input.frontmatter);
    content = frontmatterText + '\n\n' + content;
  }

  const file = await context.vault.create(input.path, content);

  let reindexed = false;
  if (input.triggerReindex && context.indexManager) {
    try {
      await context.indexManager.indexFile(file);
      reindexed = true;
    } catch (error) {
      console.warn('[WriteNote] Failed to reindex:', error);
    }
  }

  return {
    path: file.path,
    name: file.basename,
    created: true,
    updated: false,
    operation: 'create',
    previousLength: 0,
    newLength: content.length,
    reindexed
  };
}

async function handleSection(
  file: TFile,
  input: Input,
  context: SkillContext
): Promise<WriteResult> {
  const currentContent = await context.vault.read(file);
  const previousLength = currentContent.length;

  let newContent: string;
  if (input.insert_after) {
    newContent = insertAfterHeading(currentContent, input.heading!, input.content);
  } else {
    newContent = replaceSection(currentContent, input.heading!, input.content);
  }

  if (newContent === currentContent) {
    const availableHeadings = currentContent
      .split('\n')
      .filter((line: string) => line.match(/^#+\s/))
      .map((line: string) => line.replace(/^#+\s+/, ''))
      .join(', ');
    throw new Error(
      `Heading "${input.heading}" not found. Available headings: ${availableHeadings || 'none'}`
    );
  }

  await context.vault.modify(file, newContent);

  let reindexed = false;
  if (input.triggerReindex && context.indexManager) {
    try {
      await context.indexManager.indexFile(file);
      reindexed = true;
    } catch (error) {
      console.warn('[WriteNote] Failed to reindex:', error);
    }
  }

  return {
    path: file.path,
    name: file.basename,
    created: false,
    updated: true,
    operation: input.insert_after ? 'insert-after-heading' : 'replace-section',
    previousLength,
    newLength: newContent.length,
    reindexed
  };
}

async function appendContent(
  file: TFile,
  input: Input,
  context: SkillContext
): Promise<WriteResult> {
  const currentContent = await context.vault.read(file);
  const previousLength = currentContent.length;

  const newContent = currentContent + '\n\n' + input.content;
  await context.vault.modify(file, newContent);

  let reindexed = false;
  if (input.triggerReindex && context.indexManager) {
    try {
      await context.indexManager.indexFile(file);
      reindexed = true;
    } catch (error) {
      console.warn('[WriteNote] Failed to reindex:', error);
    }
  }

  return {
    path: file.path,
    name: file.basename,
    created: false,
    updated: true,
    operation: 'append',
    previousLength,
    newLength: newContent.length,
    reindexed
  };
}

async function prependContent(
  file: TFile,
  input: Input,
  context: SkillContext
): Promise<WriteResult> {
  const currentContent = await context.vault.read(file);
  const previousLength = currentContent.length;

  let newContent: string;

  const frontmatterMatch = currentContent.match(/^---\n[\s\S]*?\n---\n/);
  if (frontmatterMatch) {
    const frontmatter = frontmatterMatch[0];
    const restContent = currentContent.substring(frontmatter.length);
    newContent = frontmatter + '\n' + input.content + '\n\n' + restContent;
  } else {
    newContent = input.content + '\n\n' + currentContent;
  }

  await context.vault.modify(file, newContent);

  let reindexed = false;
  if (input.triggerReindex && context.indexManager) {
    try {
      await context.indexManager.indexFile(file);
      reindexed = true;
    } catch (error) {
      console.warn('[WriteNote] Failed to reindex:', error);
    }
  }

  return {
    path: file.path,
    name: file.basename,
    created: false,
    updated: true,
    operation: 'prepend',
    previousLength,
    newLength: newContent.length,
    reindexed
  };
}

async function replaceAllContent(
  file: TFile,
  input: Input,
  context: SkillContext
): Promise<WriteResult> {
  const currentContent = await context.vault.read(file);
  const previousLength = currentContent.length;

  let newContent = input.content;

  if (input.frontmatter && Object.keys(input.frontmatter).length > 0) {
    const frontmatterText = buildFrontmatter(input.frontmatter);
    newContent = frontmatterText + '\n\n' + newContent;
  }

  await context.vault.modify(file, newContent);

  let reindexed = false;
  if (input.triggerReindex && context.indexManager) {
    try {
      await context.indexManager.indexFile(file);
      reindexed = true;
    } catch (error) {
      console.warn('[WriteNote] Failed to reindex:', error);
    }
  }

  return {
    path: file.path,
    name: file.basename,
    created: false,
    updated: true,
    operation: 'replace-all',
    previousLength,
    newLength: newContent.length,
    reindexed
  };
}

// --- YAML Helpers ---

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

function needsQuoting(str: string): boolean {
  return /[:#{}[\],&*?|>'"!%@`]|[\n\r]|^\s|\s$/.test(str) ||
         /[\u0080-\uFFFF]/.test(str);
}

function escapeYamlValue(value: unknown): string {
  if (typeof value === 'string') {
    if (needsQuoting(value)) {
      return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    }
    return value;
  }
  return String(value);
}

function buildFrontmatter(data: Record<string, unknown>): string {
  const lines = ['---'];

  for (const [key, value] of Object.entries(data)) {
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      (value as unknown[]).forEach(item => {
        const escaped = escapeYamlValue(item);
        lines.push(`  - ${escaped}`);
      });
    } else if (typeof value === 'object' && value !== null) {
      lines.push(`${key}:`);
      Object.entries(value as Record<string, unknown>).forEach(([k, v]) => {
        const escaped = escapeYamlValue(v);
        lines.push(`  ${k}: ${escaped}`);
      });
    } else {
      const escaped = escapeYamlValue(value);
      lines.push(`${key}: ${escaped}`);
    }
  }

  lines.push('---');
  return lines.join('\n');
}

// --- Factory ---

export function createSkill(context: SkillContext) {
  return {
    schema,
    execute: (input: Input) => execute(input, context)
  };
}
