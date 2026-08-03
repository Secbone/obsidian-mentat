// Edit Note Implementation
// Targeted text replacement using old_string / new_string (like Claude Code / OpenCode Edit)

import { z } from 'zod';
import { TFile } from 'obsidian';
import { SkillContext, SkillResult } from '../../../src/skills/skill-types';
import { NoteLinter } from '../../../src/utils/note-linter';
import { computeDiff } from '../../../src/utils/diff';
import { exactReplaceString } from '../../../src/utils/note-manipulator';

/**
 * Skill metadata
 */
export const metadata = {
  name: 'edit_note',
  description: 'Edit existing notes by replacing specific text',
  version: '2.0.0',
  tags: ['edit', 'replace', 'update'],
  requiresConfirmation: true,
  executionCategory: 'write',
  permissions: ['read', 'write'],
  performance: 'fast',
  category: 'file-operations'
};

/**
 * Input schema — aligns with Claude Code Edit and OpenCode edit tool design
 */
export const schema = z.object({
  path: z.string().describe('File path to edit (must exist)'),
  old_string: z.string().describe('The exact text to find and replace'),
  new_string: z.string().describe('The replacement text (must differ from old_string)'),
  replace_all: z.boolean().default(false).describe('Replace all occurrences of old_string'),
  triggerReindex: z.boolean().default(true).describe('Trigger reindex after operation')
});

export type Input = z.infer<typeof schema>;

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

export async function execute(
  input: Input,
  context: SkillContext
): Promise<SkillResult<EditResult>> {
  const startTime = Date.now();
  const file = context.vault.getAbstractFileByPath(input.path);

    if (!file || !(file instanceof TFile)) {
      return {
        success: false,
        error: `File does not exist: ${input.path}. Use write_note to create new files.`
      };
    }

    if (context.readTracker && !context.readTracker.hasBeenRead(input.path)) {
      return {
        success: false,
        error: `You must read the file using read_note before editing it: ${input.path}`
      };
    }

    if (input.old_string === input.new_string) {
    return {
      success: false,
      error: 'old_string and new_string must be different.'
    };
  }

  let previousContent: string | null = null;
  try {
    previousContent = await context.vault.read(file);
  } catch (backupError) {
    console.warn('[EditNote] Backup failed:', backupError);
  }

  try {
    const currentContent = await context.vault.read(file);
    const previousLength = currentContent.length;

    const newContent = exactReplaceString(
      currentContent,
      input.old_string,
      input.new_string
    );
    await context.vault.modify(file, newContent);

    let reindexed = false;
    if (input.triggerReindex && context.indexManager) {
      try {
        await context.indexManager.indexFile(file);
        reindexed = true;
      } catch (error) {
        console.warn('[EditNote] Failed to reindex:', error);
      }
    }

    // Linter Validation & Rollback Guard
    const updatedFile = context.vault.getAbstractFileByPath(input.path);
    if (updatedFile instanceof TFile) {
      const verifiedContent = await context.vault.read(updatedFile);
      const linterResult = NoteLinter.validate(verifiedContent);

      if (!linterResult.isValid) {
        let isIncrementalImprovement = false;

        if (previousContent !== null) {
          const originalLinterResult = NoteLinter.validate(previousContent);
          if (linterResult.errors.length <= originalLinterResult.errors.length) {
            isIncrementalImprovement = true;
          }
        }

        if (!isIncrementalImprovement) {
          try {
            if (previousContent !== null) {
              await context.vault.modify(updatedFile, previousContent);
            }
          } catch (rollbackError) {
            console.error('[EditNote] Rollback failed:', rollbackError);
          }

          return {
            success: false,
            error: `Note Linter Validation Failed!\nYour edit introduced formatting errors:\n${linterResult.errors.map(err => `- ${err}`).join('\n')}\n\nYour changes have been safely rolled back. Please correct these formatting issues and try again.`
          };
        }
      }
    }

    const result: EditResult = {
      path: file.path,
      name: file.basename,
      created: false,
      updated: true,
      operation: 'replace',
      previousLength,
      newLength: newContent.length,
      reindexed
    };

    return {
      success: true,
      data: result,
      metadata: {
        executionTime: Date.now() - startTime,
        filesModified: [result.path],
        diff: previousContent !== null ? computeDiff(previousContent, newContent) : undefined
      }
    };
  } catch (error) {
    console.error('[EditNote] Error:', error);

    try {
      const crashedFile = context.vault.getAbstractFileByPath(input.path);
      if (crashedFile instanceof TFile && previousContent !== null) {
        await context.vault.modify(crashedFile, previousContent);
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

export function createSkill(context: SkillContext) {
  return {
    schema,
    execute: (input: Input) => execute(input, context)
  };
}
