// Edit Note Implementation
// Simplified unified skill for creating and updating Obsidian documents with intelligent operation detection

import { z } from 'zod';
import { TFile, Vault } from 'obsidian';
import { SkillContext, SkillResult } from '../../../src/skills/skill-types';

/**
 * Skill metadata
 */
export const metadata = {
  name: 'edit_note',
  description: 'Create or update notes with intelligent operation detection',
  version: '1.0.0',
  tags: ['create', 'update', 'write', 'edit'],
  requiresConfirmation: true,
  performance: 'fast',
  category: 'file-operations'
};

/**
 * Ultra-simplified input schema
 */
export const schema = z.object({
  // Required
  path: z.string().describe('File path'),
  content: z.string().describe('Content to write/add/replace'),

  // Operation hints (all optional!)
  frontmatter: z.record(z.any()).optional().describe('Frontmatter metadata'),
  heading: z.string().optional().describe('Target heading for section operations'),
  replace: z.string().optional().describe('Text to find and replace'),
  append: z.boolean().optional().describe('Add to end of file'),
  prepend: z.boolean().optional().describe('Add to beginning of file'),
  insertAfter: z.boolean().optional().describe('Insert after heading (vs replace section)'),

  // Config
  failIfExists: z.boolean().default(false).describe('Fail instead of overwrite if file exists'),
  triggerReindex: z.boolean().default(true).describe('Trigger reindex after operation')
});

export type Input = z.infer<typeof schema>;

/**
 * Edit result
 */
interface EditResult {
  path: string;
  name: string;
  created: boolean;
  updated: boolean;
  operation: string;
  previousLength: number;
  newLength: number;
  reindexed: boolean;
}

import { NoteLinter } from '../../../src/utils/note-linter';
import { getHeadingPattern, insertAfterHeading, replaceSection, exactReplaceString } from '../../../src/utils/note-manipulator';

/**
 * Execute edit note with intelligent operation detection
 */
export async function execute(
  input: Input,
  context: SkillContext
): Promise<SkillResult<EditResult>> {
  const startTime = Date.now();
  const file = context.vault.getAbstractFileByPath(input.path);
  const fileExists = !!file;

  // 1. Memory Buffer Backup (Rollback Point)
  let previousContent: string | null = null;
  const wasCreated = !fileExists;

  try {
    if (fileExists && file instanceof TFile) {
      previousContent = await context.vault.read(file);
    }
  } catch (backupError) {
    console.warn('[EditNote] Backup failed:', backupError);
  }

  try {
    // Intelligent operation detection
    let operation: string;
    let result: EditResult;

    if (input.content && input.content.includes('<<<<<<< SEARCH')) {
      if (!fileExists) {
        return {
          success: false,
          error: `Cannot apply search-and-replace edits because the file does not exist: ${input.path}`
        };
      }
      operation = 'search-replace';
      result = await applySearchReplace(file as TFile, input.content, context);
    } else if (!fileExists) {
      // CREATE: File doesn't exist
      operation = 'create';
      result = await createFile(input, context);
    } else if (input.replace) {
      // REPLACE: Has replace parameter
      operation = 'replace-content';
      result = await replaceText(file as TFile, input, context);
    } else if (input.heading) {
      // SECTION: Has heading parameter
      operation = input.insertAfter ? 'insert-after-heading' : 'replace-section';
      result = await handleSectionOperation(file as TFile, input, context);
    } else if (input.append) {
      // APPEND: Explicit append flag
      operation = 'append';
      result = await appendContent(file as TFile, input, context);
    } else if (input.prepend) {
      // PREPEND: Explicit prepend flag
      operation = 'prepend';
      result = await prependContent(file as TFile, input, context);
    } else {
      // DEFAULT: Replace entire content
      if (input.failIfExists && fileExists) {
        return {
          success: false,
          error: `File exists and failIfExists is true: ${input.path}`
        };
      }
      operation = 'replace-all';
      result = await replaceAllContent(file as TFile, input, context);
    }

    // 2. Linter Validation & Rollback Guard
    const updatedFile = context.vault.getAbstractFileByPath(input.path);
    if (updatedFile instanceof TFile) {
      const newContent = await context.vault.read(updatedFile);
      const linterResult = NoteLinter.validate(newContent);

      if (!linterResult.isValid) {
        // Incremental Linter Guard (RAGP v2.3): If the previous content was already invalid,
        // and our edit did not increase the number of formatting errors, we allow it!
        // This prevents pre-existing errors in other parts of the document from creating a deadlock.
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
          console.log(`[EditNote] Allowed edit with formatting errors under Incremental Linter Guard. Previous errors: ${originalErrorsCount}, New errors: ${linterResult.errors.length}`);
        } else {
          // Rollback to restore vault state
          try {
            if (wasCreated) {
              // Delete newly created file
              await context.vault.delete(updatedFile);
            } else if (previousContent !== null) {
              // Restore previous content
              await context.vault.modify(updatedFile, previousContent);
            }
          } catch (rollbackError) {
            console.error('[EditNote] Rollback failed:', rollbackError);
          }

          return {
            success: false,
            error: `Note Linter Validation Failed!\nYour edit introduced formatting errors:\n${linterResult.errors.map(err => `- ${err}`).join('\n')}\n\nYour changes have been safely rolled back to protect the vault. Please correct these formatting issues and try again.`
          };
        }
      }
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
        filesModified: result.updated ? [result.path] : undefined
      }
    };
  } catch (error) {
    console.error('[EditNote] Error:', error);

    // Rollback on execution crash to be safe
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
      console.error('[EditNote] Rollback on crash failed:', rollbackError);
    }

    return {
      success: false,
      error: (error as Error).message || 'Failed to edit note'
    };
  }
}

/**
 * Create new file
 */
async function createFile(
  input: Input,
  context: SkillContext
): Promise<EditResult> {
  // Ensure folder path
  const folderPath = input.path.substring(0, input.path.lastIndexOf('/'));
  if (folderPath) {
    await ensureFolder(context.vault, folderPath);
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

  // Trigger reindex if requested
  let reindexed = false;
  if (input.triggerReindex && context.indexManager) {
    try {
      await context.indexManager.indexFile(file);
      reindexed = true;
    } catch (error) {
      console.warn('[EditNote] Failed to reindex:', error);
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

/**
 * Replace specific text in file
 */
async function replaceText(
  file: TFile,
  input: Input,
  context: SkillContext
): Promise<EditResult> {
  const currentContent = await context.vault.read(file);
  const previousLength = currentContent.length;

  // Use exact matching with uniqueness validation
  const newContent = exactReplaceString(
    currentContent,
    input.replace!,
    input.content
  );
  await context.vault.modify(file, newContent);

  // Trigger reindex if requested
  let reindexed = false;
  if (input.triggerReindex && context.indexManager) {
    try {
      await context.indexManager.indexFile(file);
      reindexed = true;
    } catch (error) {
      console.warn('[EditNote] Failed to reindex:', error);
    }
  }

  return {
    path: file.path,
    name: file.basename,
    created: false,
    updated: true,
    operation: 'replace-content',
    previousLength,
    newLength: newContent.length,
    reindexed
  };
}

/**
 * Handle section operations (replace or insert after)
 */
async function handleSectionOperation(
  file: TFile,
  input: Input,
  context: SkillContext
): Promise<EditResult> {
  const currentContent = await context.vault.read(file);
  const previousLength = currentContent.length;

  let newContent: string;
  if (input.insertAfter) {
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
      `Heading "${input.heading}" not found in document. Available headings: ${availableHeadings || 'none'}`
    );
  }

  await context.vault.modify(file, newContent);

  // Trigger reindex if requested
  let reindexed = false;
  if (input.triggerReindex && context.indexManager) {
    try {
      await context.indexManager.indexFile(file);
      reindexed = true;
    } catch (error) {
      console.warn('[EditNote] Failed to reindex:', error);
    }
  }

  return {
    path: file.path,
    name: file.basename,
    created: false,
    updated: true,
    operation: input.insertAfter ? 'insert-after-heading' : 'replace-section',
    previousLength,
    newLength: newContent.length,
    reindexed
  };
}

/**
 * Append content to end of file
 */
async function appendContent(
  file: TFile,
  input: Input,
  context: SkillContext
): Promise<EditResult> {
  const currentContent = await context.vault.read(file);
  const previousLength = currentContent.length;

  const newContent = currentContent + '\n\n' + input.content;
  await context.vault.modify(file, newContent);

  // Trigger reindex if requested
  let reindexed = false;
  if (input.triggerReindex && context.indexManager) {
    try {
      await context.indexManager.indexFile(file);
      reindexed = true;
    } catch (error) {
      console.warn('[EditNote] Failed to reindex:', error);
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

/**
 * Prepend content to beginning of file (preserves frontmatter)
 */
async function prependContent(
  file: TFile,
  input: Input,
  context: SkillContext
): Promise<EditResult> {
  const currentContent = await context.vault.read(file);
  const previousLength = currentContent.length;

  let newContent: string;

  // Preserve frontmatter if it exists
  const frontmatterMatch = currentContent.match(/^---\n[\s\S]*?\n---\n/);
  if (frontmatterMatch) {
    const frontmatter = frontmatterMatch[0];
    const restContent = currentContent.substring(frontmatter.length);
    newContent = frontmatter + '\n' + input.content + '\n\n' + restContent;
  } else {
    newContent = input.content + '\n\n' + currentContent;
  }

  await context.vault.modify(file, newContent);

  // Trigger reindex if requested
  let reindexed = false;
  if (input.triggerReindex && context.indexManager) {
    try {
      await context.indexManager.indexFile(file);
      reindexed = true;
    } catch (error) {
      console.warn('[EditNote] Failed to reindex:', error);
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

/**
 * Replace entire file content
 */
async function replaceAllContent(
  file: TFile,
  input: Input,
  context: SkillContext
): Promise<EditResult> {
  const currentContent = await context.vault.read(file);
  const previousLength = currentContent.length;

  // Build new content
  let newContent = input.content;

  // Add frontmatter if provided
  if (input.frontmatter && Object.keys(input.frontmatter).length > 0) {
    const frontmatterText = buildFrontmatter(input.frontmatter);
    newContent = frontmatterText + '\n\n' + newContent;
  }

  await context.vault.modify(file, newContent);

  // Trigger reindex if requested
  let reindexed = false;
  if (input.triggerReindex && context.indexManager) {
    try {
      await context.indexManager.indexFile(file);
      reindexed = true;
    } catch (error) {
      console.warn('[EditNote] Failed to reindex:', error);
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
 * Helper: Check if a string needs quoting in YAML
 */
function needsQuoting(str: string): boolean {
  return /[:#{}[\],&*?|>'"!%@`]|[\n\r]|^\s|\s$/.test(str) ||
         /[\u0080-\uFFFF]/.test(str);
}

/**
 * Helper: Escape and quote a value for YAML if needed
 */
function escapeYamlValue(value: any): string {
  if (typeof value === 'string') {
    if (needsQuoting(value)) {
      return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    }
    return value;
  }
  return String(value);
}

/**
 * Helper: Build frontmatter YAML
 */
function buildFrontmatter(data: Record<string, any>): string {
  const lines = ['---'];

  for (const [key, value] of Object.entries(data)) {
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      value.forEach(item => {
        const escaped = escapeYamlValue(item);
        lines.push(`  - ${escaped}`);
      });
    } else if (typeof value === 'object' && value !== null) {
      lines.push(`${key}:`);
      Object.entries(value).forEach(([k, v]) => {
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

/**
 * Factory function for backward compatibility
 */
export function createSkill(context: SkillContext) {
  return {
    schema,
    execute: (input: Input) => execute(input, context)
  };
}

interface SearchReplaceBlock {
  search: string;
  replace: string;
}

/**
 * Helper: Parse search-and-replace blocks from content
 */
export function parseSearchReplaceBlocks(content: string): SearchReplaceBlock[] {
  const blocks: SearchReplaceBlock[] = [];
  // Match <<<<<<< SEARCH ... ======= ... >>>>>>> REPLACE
  const blockRegex = /<<<<<<< SEARCH\r?\n([\s\S]*?)\r?\n=======\r?\n([\s\S]*?)\r?\n>>>>>>> REPLACE/g;
  
  let match;
  while ((match = blockRegex.exec(content)) !== null) {
    blocks.push({
      search: match[1],
      replace: match[2]
    });
  }
  
  // Remove all successfully matched blocks from a copy to check for isolated markers
  const cleanContent = content.replace(blockRegex, '');

  const hasIsolatedSearch = cleanContent.includes('<<<<<<< SEARCH');
  const hasIsolatedReplace = cleanContent.includes('>>>>>>> REPLACE');

  if (hasIsolatedSearch || hasIsolatedReplace) {
    const searchMarkers = (content.match(/<<<<<<< SEARCH/g) || []).length;
    const replaceMarkers = (content.match(/>>>>>>> REPLACE/g) || []).length;
    const dividerMarkers = (content.match(/^=======\r?$/gm) || []).length;

    throw new Error(
      `Failed to parse search-and-replace blocks. Found isolated marker(s). Total in content: ${searchMarkers} SEARCH marker(s), ${dividerMarkers} potential divider(s) (=======), and ${replaceMarkers} REPLACE marker(s).\n` +
      `Please ensure all blocks follow the exact format:\n` +
      `<<<<<<< SEARCH\n` +
      `[exact text to find]\n` +
      `=======\n` +
      `[replacement text]\n` +
      `>>>>>>> REPLACE`
    );
  }

  return blocks;
}

/**
 * Helper: Apply search-and-replace blocks sequentially to target file content
 */
export async function applySearchReplace(
  file: TFile,
  content: string,
  context: SkillContext
): Promise<EditResult> {
  const currentContent = await context.vault.read(file);
  const previousLength = currentContent.length;

  const blocks = parseSearchReplaceBlocks(content);
  if (blocks.length === 0) {
    throw new Error(
      `No valid SEARCH/REPLACE blocks found in the content. Ensure your edits are enclosed within:\n` +
      `<<<<<<< SEARCH\n...\n=======\n...\n>>>>>>> REPLACE`
    );
  }

  let updatedContent = currentContent;

  for (let i = 0; i < blocks.length; i++) {
    const { search, replace } = blocks[i];
    
    // Phase 1: Exact Match
    let occurrences: number[] = [];
    let searchIndex = 0;
    while (true) {
      const foundIndex = updatedContent.indexOf(search, searchIndex);
      if (foundIndex === -1) break;
      occurrences.push(foundIndex);
      searchIndex = foundIndex + search.length;
    }

    if (occurrences.length === 1) {
      // Unique match found, perform replacement
      updatedContent = updatedContent.substring(0, occurrences[0]) + replace + updatedContent.substring(occurrences[0] + search.length);
      continue;
    }

    if (occurrences.length > 1) {
      const locations = occurrences.map(pos => {
        const textBefore = updatedContent.substring(0, pos);
        const lineNum = textBefore.split('\n').length;
        return `line ${lineNum}`;
      }).join(', ');

      throw new Error(
        `Search block #${i + 1} is not unique. It appears ${occurrences.length} times in the file (at ${locations}).\n` +
        `Please provide more surrounding lines in the SEARCH block to make it unique.`
      );
    }

    // Phase 2: Elastic (Fuzzy) Matching Fallback
    const normalizeText = (str: string) => str.replace(/\r\n/g, '\n').trim();
    const cleanSearch = normalizeText(search);
    
    if (!cleanSearch) {
      throw new Error(`Search block #${i + 1} is empty. Cannot search for empty text.`);
    }

    const escapedSearch = cleanSearch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const flexiblePattern = escapedSearch.replace(/\s+/g, '\\s+');
    
    const flexibleRegex = new RegExp(flexiblePattern);
    const flexibleGlobalRegex = new RegExp(flexiblePattern, 'g');

    const matches = updatedContent.match(flexibleGlobalRegex);

    if (matches && matches.length === 1) {
      const matchResult = updatedContent.match(flexibleRegex);
      if (matchResult && matchResult.index !== undefined) {
        const start = matchResult.index;
        const end = start + matchResult[0].length;
        updatedContent = updatedContent.substring(0, start) + replace + updatedContent.substring(end);
        continue;
      }
    } else if (matches && matches.length > 1) {
      throw new Error(
        `Search block #${i + 1} matches ${matches.length} different places in the file under flexible spacing.\n` +
        `Please provide more unique surrounding context lines in the SEARCH block.`
      );
    }

    throw new Error(
      `Search block #${i + 1} not found in the file.\n` +
      `=======[ EXPECTED SEARCH BLOCK ]=======\n` +
      `${search}\n` +
      `=======================================\n` +
      `Tip: The text must match the target file content exactly (lines, indentation, and spacing). Check for typos or outdated context.`
    );
  }

  // Write updated content
  await context.vault.modify(file, updatedContent);

  // Trigger reindex if requested
  let reindexed = false;
  if (context.indexManager) {
    try {
      await context.indexManager.indexFile(file);
      reindexed = true;
    } catch (error) {
      console.warn('[EditNote] Failed to reindex:', error);
    }
  }

  return {
    path: file.path,
    name: file.basename,
    created: false,
    updated: true,
    operation: 'search-replace',
    previousLength,
    newLength: updatedContent.length,
    reindexed
  };
}
