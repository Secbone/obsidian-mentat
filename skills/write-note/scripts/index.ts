// Write Note Implementation
// Create/overwrite notes with mutiple operation modes (create, append, prepend, section, replace-all)
import { z } from 'zod';
import { stringifyYaml } from 'obsidian';
import { SkillContext, SkillResult } from '../../../src/skills/skill-types';
import { fromToolOutcome } from '../../../src/skills/results';
import type { MutationPlan } from '../../../src/contracts/tools';
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
export async function prepare(input: Input, context: SkillContext): Promise<MutationPlan> {
    if (!context.mutations)
        throw new Error('宿主未提供文件变更服务');
    return context.mutations.prepare('obsidian:write_note', input, async () => {
        const previous = await context.mutations!.io.read(input.path);
        if (input.create_only && previous !== null)
            throw new Error(`File already exists and create_only is true: ${input.path}`);
        if (previous !== null && context.readTracker && !context.readTracker.hasBeenRead(input.path))
            throw new Error(`You must read the file using read_note before modifying it: ${input.path}`);
        let content = input.content;
        if (previous !== null && input.heading) {
            content = input.insert_after ? insertAfterHeading(previous, input.heading, input.content) : replaceSection(previous, input.heading, input.content);
            if (content === previous)
                throw new Error(`Heading "${input.heading}" not found or unchanged`);
        }
        else if (previous !== null && input.append)
            content = previous + '\n\n' + input.content;
        else if (previous !== null && input.prepend)
            content = input.content + '\n\n' + previous;
        if (input.frontmatter && Object.keys(input.frontmatter).length && (previous === null || !input.heading && !input.append && !input.prepend)) {
            content = `---\n${stringifyYaml(input.frontmatter).trimEnd()}\n---\n\n${content}`;
        }
        return { changes: [await context.mutations!.writeChange(input.path, content, previous)], summary: `写入 ${input.path}` };
    }, context);
}
export async function execute(input: Input, context: SkillContext): Promise<SkillResult<WriteResult>> {
    const start = Date.now();
    try {
        const plan = context.mutationPlan || await prepare(input, context), change = plan.changes[0];
        const previous = await context.mutations!.io.read(input.path);
        const result = await context.mutations!.apply(plan, context);
        const file = context.files.getAbstractFileByPath(input.path);
        let reindexed = false;
        if (result.outcome === 'success' && input.triggerReindex && file && 'extension' in file && file.extension === 'md' && context.indexManager && (!context.indexManager.canSearch || await context.indexManager.canSearch())) {
            try {
                await context.indexManager.indexFile(file);
                reindexed = true;
            }
            catch (error) {
                console.warn('[WriteNote] Reindex failed', error);
            }
        }
        const content = change?.kind === 'write' ? change.content : '';
        return fromToolOutcome({ ...result, data: { path: input.path, name: input.path.split('/').pop()!.replace(/\.[^.]+$/, ''), created: previous === null, updated: previous !== null,
                operation: previous === null ? 'create' : input.heading ? 'replace-section' : input.append ? 'append' : input.prepend ? 'prepend' : 'replace-all',
                previousLength: previous?.length || 0, newLength: content.length, reindexed }, metadata: { executionTime: Date.now() - start, filesModified: result.data?.filesModified || [], verified: result.outcome === 'success', diff: computeDiff(previous || '', content) } });
    }
    catch (error) {
        if (error instanceof RunBlocked || error instanceof RunSuspended)
            throw error;
        return { success: false, outcome: 'input_error', error: error instanceof Error ? error.message : String(error) };
    }
}
export function createSkill(context: SkillContext) { return { schema, execute: (input: Input) => execute(input, context) }; }
