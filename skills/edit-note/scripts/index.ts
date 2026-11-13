// Edit Note Implementation
// Targeted text replacement using old_string / new_string (like Claude Code / OpenCode Edit)
import { z } from 'zod';
import { SkillContext, SkillResult } from '../../../src/skills/skill-types';
import { fromToolOutcome } from '../../../src/skills/results';
import type { MutationPlan } from '../../../src/contracts/tools';
import { RunBlocked, RunSuspended } from '../../../src/runtime/types';
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
export async function prepare(input: Input, context: SkillContext): Promise<MutationPlan> {
    if (!context.mutations)
        throw new Error('宿主未提供文件变更服务');
    return context.mutations.prepare('obsidian:edit_note', input, async () => {
        const previous = await context.mutations!.io.read(input.path);
        if (previous === null)
            throw new Error(`File does not exist: ${input.path}. Use write_note to create new files.`);
        if (context.readTracker && !context.readTracker.hasBeenRead(input.path))
            throw new Error(`You must read the file using read_note before editing it: ${input.path}`);
        if (input.old_string === input.new_string)
            throw new Error('old_string and new_string must be different.');
        const content = exactReplaceString(previous, input.old_string, input.new_string);
        return { changes: [await context.mutations!.writeChange(input.path, content, previous)], summary: `编辑 ${input.path}` };
    }, context);
}
export async function execute(input: Input, context: SkillContext): Promise<SkillResult<EditResult>> {
    const started = Date.now();
    try {
        const plan = context.mutationPlan || await prepare(input, context), change = plan.changes[0], previous = await context.mutations!.io.read(input.path);
        const result = await context.mutations!.apply(plan, context);
        let reindexed = false;
        const file = context.files.getAbstractFileByPath(input.path);
        if (result.outcome === 'success' && input.triggerReindex && file && 'extension' in file && context.indexManager && (!context.indexManager.canSearch || await context.indexManager.canSearch())) {
            try {
                await context.indexManager.indexFile(file);
                reindexed = true;
            }
            catch (error) {
                console.warn('[EditNote] Reindex failed', error);
            }
        }
        const content = change?.kind === 'write' ? change.content : '';
        return fromToolOutcome({ ...result, data: { path: input.path, name: input.path.split('/').pop()!.replace(/\.[^.]+$/, ''), created: false, updated: true, operation: 'replace', previousLength: previous?.length || 0, newLength: content.length, reindexed },
            metadata: { executionTime: Date.now() - started, filesModified: result.data?.filesModified || [], verified: result.outcome === 'success', diff: computeDiff(previous || '', content) } });
    }
    catch (error) {
        if (error instanceof RunBlocked || error instanceof RunSuspended)
            throw error;
        return { success: false, outcome: 'input_error', error: error instanceof Error ? error.message : String(error) };
    }
}
export function createSkill(context: SkillContext) { return { schema, execute: (input: Input) => execute(input, context) }; }
