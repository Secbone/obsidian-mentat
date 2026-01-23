// Update Document Implementation
// Core logic for updating Obsidian documents

import { z } from 'zod';
import { TFile, Vault } from 'obsidian';
import { SkillContext, SkillResult } from '../../../src/skills/skill-types';

/**
 * Skill metadata
 */
export const metadata = {
  name: 'update_note',
  description: 'Update document content with replace, append, prepend, or insert modes',
  version: '1.0.0',
  tags: ['write', 'update', 'modify'],
  requiresConfirmation: true,
  performance: 'fast',
  category: 'file-operations'
};

/**
 * Input schema for update document
 */
export const schema = z.object({
  // === EXISTING PARAMETERS ===
  path: z.string().describe('File path to update'),
  content: z.string().describe('Content to add or replace'),
  mode: z.enum([
    // Existing modes
    'replace',
    'append',
    'prepend',
    'insert-after-heading',

    // NEW: Line-based modes
    'replace-lines',
    'insert-at-line',
    'delete-lines',

    // NEW: Section-based modes
    'replace-section',
    'delete-section',

    // NEW: Search modes
    'search-replace',
    'exact-replace'
  ]).describe('Update mode'),
  heading: z.string().optional().describe('Heading name (required for insert-after-heading mode)'),
  createIfNotExists: z.boolean().default(false).describe('Create file if it does not exist'),
  triggerReindex: z.boolean().default(true).describe('Trigger reindex after update'),

  // === NEW: Line-based parameters ===
  startLine: z.number().optional().describe('Starting line for line-based operations (1-based)'),
  endLine: z.number().optional().describe('Ending line for line-based operations (1-based)'),

  // === NEW: Search-and-replace parameters ===
  searchPattern: z.string().optional().describe('Text or regex pattern to search'),
  replaceWith: z.string().optional().describe('Replacement text'),
  useRegex: z.boolean().default(false).describe('Treat searchPattern as regex'),
  matchCase: z.boolean().default(true).describe('Case-sensitive matching'),
  maxReplacements: z.number().optional().describe('Max number of replacements (0 = all)'),

  // === NEW: Exact-replace parameters ===
  oldString: z.string().optional().describe('Exact string to find and replace'),
  newString: z.string().optional().describe('Exact replacement string'),

  // === NEW: Safety options ===
  dryRun: z.boolean().default(false).describe('Preview changes without applying')
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

  // NEW: Change details
  changes: {
    linesAdded: number;
    linesRemoved: number;
    linesModified: number;
    replacementCount?: number;
  };

  // NEW: Dry-run preview
  preview?: {
    before: string;
    after: string;
  };

  // NEW: Validation warnings
  warnings?: string[];
}

/**
 * Helper: Insert content at a specific line
 */
function insertAtLine(lines: string[], lineNum: number, content: string): string[] {
  const totalLines = lines.length;

  // Validate line number (1-based)
  if (lineNum < 1 || lineNum > totalLines + 1) {
    throw new Error(`Line number ${lineNum} is out of range (1-${totalLines + 1})`);
  }

  // Convert to 0-based index
  const insertIdx = lineNum - 1;

  // Split content into lines and insert
  const newLines = content.split('\n');
  const result = [...lines];
  result.splice(insertIdx, 0, ...newLines);

  return result;
}

/**
 * Helper: Replace line range
 */
function replaceLines(lines: string[], startLine: number, endLine: number, newContent: string): string[] {
  const totalLines = lines.length;

  // Validate line numbers (1-based)
  if (startLine < 1 || startLine > totalLines) {
    throw new Error(`Start line ${startLine} is out of range (1-${totalLines})`);
  }
  if (endLine < startLine || endLine > totalLines) {
    throw new Error(`End line ${endLine} is invalid (must be between ${startLine}-${totalLines})`);
  }

  // Convert to 0-based indices
  const startIdx = startLine - 1;
  const endIdx = endLine; // endLine is inclusive, so we want to replace up to and including endIdx-1

  // Split new content into lines
  const newLines = newContent.split('\n');

  // Replace the range
  const result = [...lines];
  result.splice(startIdx, endIdx - startIdx, ...newLines);

  return result;
}

/**
 * Helper: Delete line range
 */
function deleteLines(lines: string[], startLine: number, endLine: number): string[] {
  const totalLines = lines.length;

  // Validate line numbers (1-based)
  if (startLine < 1 || startLine > totalLines) {
    throw new Error(`Start line ${startLine} is out of range (1-${totalLines})`);
  }
  if (endLine < startLine || endLine > totalLines) {
    throw new Error(`End line ${endLine} is invalid (must be between ${startLine}-${totalLines})`);
  }

  // Convert to 0-based indices
  const startIdx = startLine - 1;
  const endIdx = endLine; // endLine is inclusive

  // Delete the range
  const result = [...lines];
  result.splice(startIdx, endIdx - startIdx);

  return result;
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
    throw new Error(`Section "${heading}" not found in document`);
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
 * Helper: Delete entire section including heading
 */
function deleteSection(content: string, heading: string): string {
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
    throw new Error(`Section "${heading}" not found in document`);
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

  // Delete section including heading
  const result = [...lines];
  result.splice(startIndex, endIndex - startIndex);

  return result.join('\n');
}

/**
 * Helper: Search and replace with options
 */
interface ReplaceOptions {
  useRegex: boolean;
  matchCase: boolean;
  maxReplacements?: number;
}

interface ReplaceResult {
  content: string;
  replacementCount: number;
}

function searchAndReplace(
  content: string,
  searchPattern: string,
  replaceWith: string,
  options: ReplaceOptions
): ReplaceResult {
  let replacementCount = 0;
  let result = content;

  try {
    if (options.useRegex) {
      // Regex mode
      const flags = options.matchCase ? 'g' : 'gi';
      const regex = new RegExp(searchPattern, flags);

      if (options.maxReplacements && options.maxReplacements > 0) {
        // Limited replacements
        result = content.replace(regex, (match) => {
          if (replacementCount < options.maxReplacements!) {
            replacementCount++;
            return replaceWith;
          }
          return match;
        });
      } else {
        // All replacements
        result = content.replace(regex, () => {
          replacementCount++;
          return replaceWith;
        });
      }
    } else {
      // Plain text mode
      const search = options.matchCase ? searchPattern : searchPattern.toLowerCase();
      const compareContent = options.matchCase ? content : content.toLowerCase();

      let lastIndex = 0;
      const parts: string[] = [];

      while (true) {
        const index = compareContent.indexOf(search, lastIndex);
        if (index === -1) break;

        if (options.maxReplacements && replacementCount >= options.maxReplacements) {
          break;
        }

        parts.push(content.substring(lastIndex, index));
        parts.push(replaceWith);
        replacementCount++;
        lastIndex = index + searchPattern.length;
      }

      parts.push(content.substring(lastIndex));
      result = parts.join('');
    }
  } catch (error) {
    throw new Error(`Search-replace failed: ${(error as Error).message}`);
  }

  return { content: result, replacementCount };
}

/**
 * Helper: Exact string replacement (must be unique)
 */
function exactReplace(content: string, oldString: string, newString: string): string {
  // Count occurrences
  const occurrences: number[] = [];
  let index = content.indexOf(oldString);

  while (index !== -1) {
    occurrences.push(index);
    index = content.indexOf(oldString, index + 1);
  }

  if (occurrences.length === 0) {
    throw new Error(`String not found: "${oldString}"`);
  }

  if (occurrences.length > 1) {
    const lines = content.split('\n');
    const locations = occurrences.map(pos => {
      const textBefore = content.substring(0, pos);
      const lineNum = textBefore.split('\n').length;
      return `line ${lineNum}`;
    }).join(', ');

    throw new Error(
      `String "${oldString}" appears ${occurrences.length} times (at ${locations}). ` +
      `Exact-replace requires a unique match. Please provide a longer string with more context.`
    );
  }

  // Single occurrence - safe to replace
  return content.replace(oldString, newString);
}

/**
 * Helper: Calculate change statistics
 */
interface ChangeStats {
  linesAdded: number;
  linesRemoved: number;
  linesModified: number;
}

function calculateChangeStats(oldContent: string, newContent: string): ChangeStats {
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');

  const oldCount = oldLines.length;
  const newCount = newLines.length;

  if (newCount > oldCount) {
    return {
      linesAdded: newCount - oldCount,
      linesRemoved: 0,
      linesModified: oldCount
    };
  } else if (newCount < oldCount) {
    return {
      linesAdded: 0,
      linesRemoved: oldCount - newCount,
      linesModified: newCount
    };
  } else {
    // Same number of lines - count modified
    let modified = 0;
    for (let i = 0; i < oldCount; i++) {
      if (oldLines[i] !== newLines[i]) {
        modified++;
      }
    }
    return {
      linesAdded: 0,
      linesRemoved: 0,
      linesModified: modified
    };
  }
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

    // Validate mode-specific required parameters
    const requiredParams: Record<string, string[]> = {
      'replace-lines': ['startLine', 'endLine', 'content'],
      'insert-at-line': ['startLine', 'content'],
      'delete-lines': ['startLine', 'endLine'],
      'replace-section': ['heading', 'content'],
      'delete-section': ['heading'],
      'search-replace': ['searchPattern', 'replaceWith'],
      'exact-replace': ['oldString', 'newString']
    };

    if (requiredParams[input.mode]) {
      for (const param of requiredParams[input.mode]) {
        if (!(input as any)[param]) {
          return {
            success: false,
            error: `Parameter "${param}" is required for mode "${input.mode}"`
          };
        }
      }
    }

    // Build new content based on mode
    let newContent: string;
    let replacementCount: number | undefined;
    const warnings: string[] = [];

    try {
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
            const availableHeadings = currentContent
              .split('\n')
              .filter(line => line.match(/^#+\s/))
              .map(line => line.replace(/^#+\s+/, ''))
              .join(', ');
            return {
              success: false,
              error: `Heading "${input.heading}" not found in document. Available headings: ${availableHeadings || 'none'}`
            };
          }
          break;

        // === NEW MODES ===

        case 'insert-at-line': {
          const lines = currentContent.split('\n');
          const result = insertAtLine(lines, input.startLine!, input.content);
          newContent = result.join('\n');
          break;
        }

        case 'replace-lines': {
          const lines = currentContent.split('\n');
          const result = replaceLines(lines, input.startLine!, input.endLine!, input.content);
          newContent = result.join('\n');
          break;
        }

        case 'delete-lines': {
          const lines = currentContent.split('\n');
          const result = deleteLines(lines, input.startLine!, input.endLine!);
          newContent = result.join('\n');
          warnings.push(`Deleted lines ${input.startLine}-${input.endLine}`);
          break;
        }

        case 'replace-section':
          newContent = replaceSection(currentContent, input.heading!, input.content);
          break;

        case 'delete-section':
          newContent = deleteSection(currentContent, input.heading!);
          warnings.push(`Deleted section "${input.heading}"`);
          break;

        case 'search-replace': {
          const result = searchAndReplace(
            currentContent,
            input.searchPattern!,
            input.replaceWith!,
            {
              useRegex: input.useRegex || false,
              matchCase: input.matchCase !== false, // default true
              maxReplacements: input.maxReplacements
            }
          );
          newContent = result.content;
          replacementCount = result.replacementCount;
          if (replacementCount === 0) {
            warnings.push('No matches found for search pattern');
          }
          break;
        }

        case 'exact-replace':
          newContent = exactReplace(currentContent, input.oldString!, input.newString!);
          break;

        default:
          return {
            success: false,
            error: `Unknown mode: ${input.mode}`
          };
      }
    } catch (error) {
      return {
        success: false,
        error: (error as Error).message
      };
    }

    // Handle dry-run
    if (input.dryRun) {
      const changes = calculateChangeStats(currentContent, newContent);

      return {
        success: true,
        data: {
          path: file.path,
          name: file.basename,
          updated: false,
          created: false,
          previousLength,
          newLength: newContent.length,
          reindexed: false,
          changes: {
            ...changes,
            replacementCount
          },
          preview: {
            before: currentContent.substring(0, 500),
            after: newContent.substring(0, 500)
          },
          warnings: warnings.length > 0 ? warnings : undefined
        },
        metadata: {
          executionTime: Date.now() - startTime,
          dryRun: true
        }
      };
    }

    // Write the updated content
    await context.vault.modify(file, newContent);

    // Calculate change statistics
    const changes = calculateChangeStats(currentContent, newContent);

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
      reindexed,
      changes: {
        ...changes,
        replacementCount
      },
      warnings: warnings.length > 0 ? warnings : undefined
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
