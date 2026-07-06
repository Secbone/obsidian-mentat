// Read Document Implementation
// Core logic for reading Obsidian documents

import { z } from 'zod';
import { TFile } from 'obsidian';
import { SkillContext, SkillResult } from '../../../src/skills/skill-types';

/**
 * Skill metadata
 */
export const metadata = {
  name: 'read_note',
  description: 'Read document content with optional metadata',
  version: '1.0.0',
  tags: ['read', 'file', 'content'],
  performance: 'fast',
  category: 'file-operations'
};

/**
 * Input schema for read document
 */
export const schema = z.object({
  // === EXISTING PARAMETERS ===
  path: z.string().describe('File path to read'),
  section: z.string().optional().describe('Specific section/heading to read (optional)'),
  includeMetadata: z.boolean().default(true).describe('Include file metadata'),
  includeFrontmatter: z.boolean().default(true).describe('Include frontmatter'),
  includeLinks: z.boolean().default(true).describe('Include outgoing links'),
  includeBacklinks: z.boolean().default(false).describe('Include backlinks'),

  // === NEW: Line-based partial reading ===
  startLine: z.number().optional().describe('Starting line number (1-based, inclusive)'),
  endLine: z.number().optional().describe('Ending line number (1-based, inclusive)'),

  // === NEW: Character-based partial reading ===
  startChar: z.number().optional().describe('Starting character offset (0-based)'),
  length: z.number().optional().describe('Number of characters to read from startChar'),

  // === NEW: Multi-section reading ===
  sections: z.array(z.string()).optional().describe('Array of section headings to extract'),

  // === NEW: Context control ===
  contextLines: z.number().optional().describe('Number of context lines before/after range')
});

export type Input = z.infer<typeof schema>;

/**
 * Document content result
 */
interface DocumentContent {
  path: string;
  name: string;
  content: string;

  // NEW: Range metadata
  lineRange?: { start: number; end: number; totalLines: number };
  charRange?: { start: number; end: number; totalChars: number };

  // NEW: Multi-section results
  sectionsContent?: Array<{
    heading: string;
    content: string;
    startLine: number;
    endLine: number;
    level: number;
  }>;

  // NEW: Context content
  beforeContext?: string;
  afterContext?: string;

  frontmatter?: Record<string, any>;
  metadata?: {
    tags: string[];
    links: string[];
    backlinks?: string[];
    headings: Array<{ level: number; text: string; position: number; lineNumber: number }>;
    wordCount: number;
    charCount: number;
    lineCount: number;
    modified: number;
    created: number;
  };
}

/**
 * Helper: Extract line range with optional context
 */
interface LineRangeResult {
  content: string;
  beforeContext?: string;
  afterContext?: string;
  lineRange: { start: number; end: number; totalLines: number };
}

function extractLineRange(
  content: string,
  startLine: number,
  endLine: number,
  contextLines?: number
): LineRangeResult {
  const lines = content.split('\n');
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
  const endIdx = endLine; // endLine is inclusive, so we want lines[startIdx] to lines[endIdx-1]

  // Extract main content
  const mainContent = lines.slice(startIdx, endIdx).join('\n');

  // Extract context if requested
  let beforeContext: string | undefined;
  let afterContext: string | undefined;

  if (contextLines && contextLines > 0) {
    const contextStart = Math.max(0, startIdx - contextLines);
    if (contextStart < startIdx) {
      beforeContext = lines.slice(contextStart, startIdx).join('\n');
    }

    const contextEnd = Math.min(totalLines, endIdx + contextLines);
    if (contextEnd > endIdx) {
      afterContext = lines.slice(endIdx, contextEnd).join('\n');
    }
  }

  return {
    content: mainContent,
    beforeContext,
    afterContext,
    lineRange: { start: startLine, end: endLine, totalLines }
  };
}

/**
 * Helper: Extract character range
 */
interface CharRangeResult {
  content: string;
  charRange: { start: number; end: number; totalChars: number };
}

function extractCharRange(
  content: string,
  startChar: number,
  length: number
): CharRangeResult {
  const totalChars = content.length;

  // Validate character offsets (0-based)
  if (startChar < 0 || startChar >= totalChars) {
    throw new Error(`Start character ${startChar} is out of range (0-${totalChars - 1})`);
  }
  if (length < 1) {
    throw new Error('Length must be at least 1');
  }

  const endChar = Math.min(startChar + length, totalChars);
  const extracted = content.substring(startChar, endChar);

  return {
    content: extracted,
    charRange: { start: startChar, end: endChar, totalChars }
  };
}

/**
 * Helper: Extract multiple sections
 */
interface SectionContent {
  heading: string;
  content: string;
  startLine: number;
  endLine: number;
  level: number;
}

function extractMultipleSections(
  content: string,
  headings: string[]
): SectionContent[] {
  const lines = content.split('\n');
  const results: SectionContent[] = [];

  for (const heading of headings) {
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
      continue; // Skip if not found
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

    results.push({
      heading,
      content: lines.slice(startIndex, endIndex).join('\n'),
      startLine: startIndex + 1, // Convert to 1-based
      endLine: endIndex, // Already exclusive, so this is correct
      level: startLevel
    });
  }

  return results;
}

/**
 * Helper: Add line numbers to headings metadata
 */
function addLineNumbersToHeadings(
  headings: Array<{ level: number; text: string; position: number }>,
  content: string
): Array<{ level: number; text: string; position: number; lineNumber: number }> {
  return headings.map(h => {
    // Count newlines up to this position
    const textBeforeHeading = content.substring(0, h.position);
    const lineNumber = textBeforeHeading.split('\n').length;
    return { ...h, lineNumber };
  });
}

/**
 * Truncate read output to prevent overwhelming the context window.
 * Limits: 2000 lines, 2000 chars per line, 50KB total.
 */
function truncateContent(content: string): {
  content: string;
  truncated: boolean;
  linesShown: number;
  totalLines: number;
  bytesShown: number;
  totalBytes: number;
} {
  const MAX_LINES = 2000;
  const MAX_LINE_CHARS = 2000;
  const MAX_BYTES = 50 * 1024;

  let lines = content.split('\n');
  const totalLines = lines.length;
  let truncated = false;

  if (lines.length > MAX_LINES) {
    lines = lines.slice(0, MAX_LINES);
    truncated = true;
  }

  lines = lines.map(line => {
    if (line.length > MAX_LINE_CHARS) {
      truncated = true;
      return line.substring(0, MAX_LINE_CHARS) + '...';
    }
    return line;
  });

  let result = lines.join('\n');
  const encoder = new TextEncoder();
  let bytes = encoder.encode(result).length;
  const totalBytes = encoder.encode(content).length;

  while (bytes > MAX_BYTES && lines.length > 0) {
    lines = lines.slice(0, lines.length - 1);
    result = lines.join('\n');
    bytes = encoder.encode(result).length;
    truncated = true;
  }

  return {
    content: result,
    truncated,
    linesShown: lines.length,
    totalLines,
    bytesShown: bytes,
    totalBytes
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

    // Build result
    const result: DocumentContent = {
      path: file.path,
      name: file.basename,
      content: fullContent // Default, will be overridden by parameter priority logic
    };

    // === PARAMETER PRIORITY LOGIC ===
    // 1. If `sections` array provided → Extract all specified sections
    if (input.sections && input.sections.length > 0) {
      const sectionsContent = extractMultipleSections(fullContent, input.sections);
      if (sectionsContent.length === 0) {
        return {
          success: false,
          error: `None of the requested sections found: ${input.sections.join(', ')}`
        };
      }
      result.sectionsContent = sectionsContent;
      result.content = sectionsContent.map(s => s.content).join('\n\n---\n\n');
    }
    // 2. Else if `section` (single) provided → Extract single section (backward compat)
    else if (input.section) {
      const extracted = extractSection(fullContent, input.section);
      if (!extracted) {
        return {
          success: false,
          error: `Section "${input.section}" not found in document`
        };
      }
      result.content = extracted;
    }
    // 3. Else if `startLine` & `endLine` provided → Extract line range
    else if (input.startLine !== undefined && input.endLine !== undefined) {
      try {
        const rangeResult = extractLineRange(
          fullContent,
          input.startLine,
          input.endLine,
          input.contextLines
        );
        result.content = rangeResult.content;
        result.lineRange = rangeResult.lineRange;
        result.beforeContext = rangeResult.beforeContext;
        result.afterContext = rangeResult.afterContext;
      } catch (error) {
        return {
          success: false,
          error: (error as Error).message
        };
      }
    }
    // 4. Else if `startChar` & `length` provided → Extract character range
    else if (input.startChar !== undefined && input.length !== undefined) {
      try {
        const charResult = extractCharRange(fullContent, input.startChar, input.length);
        result.content = charResult.content;
        result.charRange = charResult.charRange;
      } catch (error) {
        return {
          success: false,
          error: (error as Error).message
        };
      }
    }
    // 5. Otherwise → Read full document (backward compat)
    // Already set above

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
        const backlinkData = (context.metadataCache as any).getBacklinksForFile(file);
        if (backlinkData) {
          backlinks = Array.from(backlinkData.keys());
        }
      }

      // Extract headings with line numbers
      const rawHeadings = cache?.headings?.map((h: any) => ({
        level: h.level,
        text: h.heading,
        position: h.position.start.offset
      })) || [];
      const headings = addLineNumbersToHeadings(rawHeadings, fullContent);

      result.metadata = {
        tags: allTags,
        links,
        backlinks: input.includeBacklinks ? backlinks : undefined,
        headings,
        wordCount: countWords(result.content),
        charCount: result.content.length,
        lineCount: fullContent.split('\n').length,
        modified: file.stat.mtime,
        created: file.stat.ctime
      };
    }

    context.readTracker?.markRead(file.path, file.stat.mtime);

    const truncated = truncateContent(result.content);
    result.content = truncated.content;

    return {
      success: true,
      data: result,
      metadata: {
        executionTime: Date.now() - startTime,
        truncated: truncated.truncated,
        ...(truncated.truncated ? {
          truncationNotice: `Output truncated. Showing ${truncated.linesShown} of ${truncated.totalLines} lines (${truncated.bytesShown} of ${truncated.totalBytes} bytes). Use startLine/endLine or section/sections to read specific portions.`
        } : {})
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
