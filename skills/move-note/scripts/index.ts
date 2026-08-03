import { z } from 'zod';
import { TFile } from 'obsidian';
import { SkillContext, SkillResult } from '../../../src/skills/skill-types';

export const metadata = {
  name: 'move_note',
  description: 'Move or rename notes, updating all links automatically',
  version: '1.0.0',
  tags: ['move', 'rename', 'delete', 'trash', 'organize'],
  requiresConfirmation: true,
  executionCategory: 'mutate',
  permissions: ['read', 'write'],
  performance: 'fast',
  category: 'file-operations'
};

export const schema = z.object({
  path: z.string().describe('Source file path (must exist)'),
  new_path: z.string().describe('Destination file path (use Trash/filename to delete)'),
  triggerReindex: z.boolean().default(true).describe('Trigger reindex after operation')
});

export type Input = z.infer<typeof schema>;

interface MoveResult {
  path: string;
  new_path: string;
  name: string;
  moved: boolean;
  linksUpdated: boolean;
  reindexed: boolean;
}

export async function execute(
  input: Input,
  context: SkillContext
): Promise<SkillResult<MoveResult>> {
  const startTime = Date.now();
  const sourceFile = context.vault.getAbstractFileByPath(input.path);

  if (!sourceFile || !(sourceFile instanceof TFile)) {
    return {
      success: false,
      error: `File does not exist: ${input.path}`
    };
  }

  if (input.path === input.new_path) {
    return {
      success: false,
      error: 'Source and destination paths are the same.'
    };
  }

  const destFile = context.vault.getAbstractFileByPath(input.new_path);
  if (destFile) {
    return {
      success: false,
      error: `Destination already exists: ${input.new_path}. Choose a different path.`
    };
  }

  // Ensure destination folder exists
  const folderPath = input.new_path.substring(0, input.new_path.lastIndexOf('/'));
  if (folderPath) {
    await ensureFolder(context.vault, folderPath);
  }

  try {
    // Use FileManager.renameFile to automatically update all links
    await context.plugin.app.fileManager.renameFile(sourceFile, input.new_path);

    // Update read tracker
    context.readTracker?.clear();
    context.readTracker?.markRead(input.new_path, Date.now());

    // Reindex at new path
    let reindexed = false;
    if (input.triggerReindex && context.indexManager) {
      try {
        await context.indexManager.removeFromIndex(input.path);
        const newFile = context.vault.getAbstractFileByPath(input.new_path);
        if (newFile instanceof TFile) {
          await context.indexManager.indexFile(newFile);
        }
        reindexed = true;
      } catch (error) {
        console.warn('[MoveNote] Failed to reindex:', error);
      }
    }

    return {
      success: true,
      data: {
        path: input.path,
        new_path: input.new_path,
        name: input.new_path.split('/').pop() || input.new_path,
        moved: true,
        linksUpdated: true,
        reindexed
      },
      metadata: {
        executionTime: Date.now() - startTime,
        filesModified: [input.path]
      }
    };
  } catch (error) {
    console.error('[MoveNote] Error:', error);
    return {
      success: false,
      error: (error as Error).message || 'Failed to move note'
    };
  }
}

async function ensureFolder(vault: import('obsidian').Vault, folderPath: string): Promise<void> {
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

export function createSkill(context: SkillContext) {
  return {
    schema,
    execute: (input: Input) => execute(input, context)
  };
}
