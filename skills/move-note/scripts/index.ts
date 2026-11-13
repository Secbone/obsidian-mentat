import { throwIfAborted } from '../../../src/utils/execution';
import { z } from 'zod';
import { fromToolOutcome } from '../../../src/skills/results';
import type { MutationPlan } from '../../../src/contracts/tools';
import { buildMovePlan } from '../../../src/skills/mutations/move-plan';
import { RunBlocked, RunSuspended } from '../../../src/runtime/types';
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
export async function prepare(input: Input, context: SkillContext): Promise<MutationPlan> {
    if (!context.mutations)
        throw new Error('宿主未提供文件变更服务');
    return context.mutations.prepare('obsidian:move_note', input, () => buildMovePlan(context.mutations!, input.path, input.new_path), context);
}
export async function execute(input: Input, context: SkillContext): Promise<SkillResult<MoveResult>> {
    const started = Date.now();
    try {
        const plan = context.mutationPlan || await prepare(input, context), result = await context.mutations!.apply(plan, context);
        const moved = result.items?.some(item => item.kind === 'move' && item.outcome === 'success') || false;
        let reindexed = false;
        if (moved) {
            context.readTracker?.clear();
            context.readTracker?.markRead(input.new_path, Date.now());
        }
        if (moved && input.triggerReindex && context.indexManager) {
            try {
                await context.indexManager.removeFromIndex(input.path);
                for (const path of result.data?.filesModified || []) {
                    const file = context.files.getAbstractFileByPath(path);
                    if (file && 'extension' in file && file.extension === 'md')
                        await context.indexManager.indexFile(file);
                }
                reindexed = true;
            }
            catch (error) {
                console.warn('[MoveNote] Reindex failed', error);
            }
        }
        return fromToolOutcome({ ...result, data: { path: input.path, new_path: input.new_path, name: input.new_path.split('/').pop()!, moved, linksUpdated: result.outcome === 'success', reindexed },
            metadata: { executionTime: Date.now() - started, filesModified: result.data?.filesModified || [], verified: result.outcome === 'success' } });
    }
    catch (error) {
        if (error instanceof RunBlocked || error instanceof RunSuspended)
            throw error;
        return { success: false, outcome: 'input_error', error: error instanceof Error ? error.message : String(error) };
    }
}
export function createSkill(context: SkillContext) { return { schema, execute: (input: Input) => execute(input, context) }; }
