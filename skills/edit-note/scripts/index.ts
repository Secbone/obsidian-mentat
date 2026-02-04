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

/**
 * Execute edit note with intelligent operation detection
 */
export async function execute(
  input: Input,
  context: SkillContext
): Promise<SkillResult<EditResult>> {
  try {
    const startTime = Date.now();
    const file = context.vault.getAbstractFileByPath(input.path);
    const fileExists = !!file;

    // Intelligent operation detection
    let operation: string;
    let result: EditResult;

    if (!fileExists) {
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
      .filter(line => line.match(/^#+\s/))
      .map(line => line.replace(/^#+\s+/, ''))
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
 * Helper: Replace section content
 */
function replaceSection(content: string, heading: string, newContent: string): string {
  const lines = content.split('\n');
  const headingPattern = new RegExp(`^(#+)\\s+${heading}\\s*$`, 'i');

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
    return content;
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

  // Replace section content (keep heading, replace everything after)
  const result = [...lines];
  const newLines = newContent.split('\n');
  result.splice(startIndex + 1, endIndex - startIndex - 1, ...newLines);

  return result.join('\n');
}

/**
 * Helper: Exact string replacement with uniqueness validation
 * Inspired by Claude Code's edit tool approach
 *
 * @throws Error if string not found or appears multiple times
 */
function exactReplaceString(
  content: string,
  oldString: string,
  newString: string
): string {
  // Find all occurrences
  const occurrences: number[] = [];
  let searchIndex = 0;

  while (true) {
    const foundIndex = content.indexOf(oldString, searchIndex);
    if (foundIndex === -1) break;

    occurrences.push(foundIndex);
    searchIndex = foundIndex + oldString.length;
  }

  // Validate occurrence count
  if (occurrences.length === 0) {
    throw new Error(
      `Text not found in file: "${oldString}"\n\n` +
      `Tip: The text must match exactly including whitespace, capitalization, and line breaks.`
    );
  }

  if (occurrences.length > 1) {
    // Calculate line numbers for each occurrence
    const lines = content.split('\n');
    const locations = occurrences.map(pos => {
      const textBefore = content.substring(0, pos);
      const lineNum = textBefore.split('\n').length;
      return `line ${lineNum}`;
    }).join(', ');

    // Show context preview for first few occurrences
    const previews = occurrences.slice(0, 3).map((pos, idx) => {
      const contextStart = Math.max(0, pos - 40);
      const contextEnd = Math.min(content.length, pos + oldString.length + 40);
      const preview = content.substring(contextStart, contextEnd);
      const lineNum = content.substring(0, pos).split('\n').length;
      return `  ${idx + 1}. Line ${lineNum}: ...${preview}...`;
    }).join('\n');

    throw new Error(
      `Text "${oldString}" appears ${occurrences.length} times in the file (at ${locations}).\n\n` +
      `Exact replacement requires a unique match. Please provide a longer string with more surrounding context to make it unique.\n\n` +
      `First ${Math.min(3, occurrences.length)} occurrence(s):\n${previews}`
    );
  }

  // Exactly 1 occurrence - safe to replace
  return content.replace(oldString, newString);
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
