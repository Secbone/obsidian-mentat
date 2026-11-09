// Write Note Implementation
// Create/overwrite notes with mutiple operation modes (create, append, prepend, section, replace-all)

import { z } from 'zod';
import { TFile } from 'obsidian';
import { SkillContext, SkillResult } from '../../../src/skills/skill-types';
import { writeVerifiedArtifact } from '../../../src/skills/verified-artifact';
import { RunBlocked, RunSuspended } from '../../../src/runtime/types';
import { computeDiff } from '../../../src/utils/diff';
import { insertAfterHeading, replaceSection } from '../../../src/utils/note-manipulator';

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

export async function execute(input: Input, context: SkillContext): Promise<SkillResult<WriteResult>> {
  const startTime = Date.now();
  try {
    const existing = context.vault.getAbstractFileByPath(input.path);
    const previous = existing instanceof TFile ? await context.vault.read(existing) : null;
    if (input.create_only && existing) return { success: false, outcome: 'input_error', error: `File already exists and create_only is true: ${input.path}` };
    if (previous !== null && context.readTracker && !context.readTracker.hasBeenRead(input.path)) return { success: false, outcome: 'input_error', error: `You must read the file using read_note before modifying it: ${input.path}` };
    let content = input.content, operation = previous === null ? 'create' : 'replace-all';
    if (previous !== null && input.heading) {
      content = input.insert_after ? insertAfterHeading(previous, input.heading, input.content) : replaceSection(previous, input.heading, input.content);
      if (content === previous) throw new Error(`Heading "${input.heading}" not found or unchanged`);
      operation = input.insert_after ? 'insert-after-heading' : 'replace-section';
    } else if (previous !== null && input.append) { content = previous + '\n\n' + input.content; operation = 'append'; }
    else if (previous !== null && input.prepend) { content = input.content + '\n\n' + previous; operation = 'prepend'; }
    if (input.frontmatter && Object.keys(input.frontmatter).length && ['create','replace-all'].includes(operation)) content = buildFrontmatter(input.frontmatter) + '\n\n' + content;
    const file = await writeVerifiedArtifact(context, input.path, content, previous);
    let reindexed = false;
    if (input.triggerReindex && file.extension === 'md' && context.indexManager && (!context.indexManager.canSearch || await context.indexManager.canSearch())) {
      try { await context.indexManager.indexFile(file); reindexed = true; } catch (error) { console.warn('[WriteNote] Reindex failed after verified write', error); }
    }
    return { success: true, outcome: 'success', data: { path: file.path, name: file.basename, created: previous === null, updated: previous !== null,
      operation, previousLength: previous?.length || 0, newLength: content.length, reindexed },
      metadata: { executionTime: Date.now() - startTime, filesCreated: previous === null ? [file.path] : undefined, filesModified: previous !== null ? [file.path] : undefined, diff: computeDiff(previous || '', content), verified: true } };
  } catch (error) {
    if (error instanceof RunBlocked || error instanceof RunSuspended) throw error;
    return { success: false, outcome: 'input_error', error: error instanceof Error ? error.message : String(error) };
  }
}

// --- YAML Helpers ---

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
