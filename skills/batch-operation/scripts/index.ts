import { throwIfAborted } from '../../../src/utils/execution';
// Batch Operation Implementation
// Core logic for batch operations on Obsidian documents
import { z } from 'zod';
import { parseYaml, stringifyYaml } from 'obsidian';
import type { SkillFile, MutationPlan } from '../../../src/contracts/tools';
import { isSkillFile } from '../../../src/skills/skill-types';
import { fromToolOutcome } from '../../../src/skills/results';
import { RunBlocked, RunSuspended } from '../../../src/runtime/types';
import { SkillContext, SkillResult } from '../../../src/skills/skill-types';
/**
 * Skill metadata
 */
export const metadata = {
    name: 'batch_operation',
    description: 'Perform bulk operations on multiple documents matching filter criteria',
    version: '1.0.0',
    tags: ['batch', 'bulk', 'update'],
    requiresConfirmation: true,
    executionCategory: 'write',
    permissions: ['read', 'write', 'delete'],
    performance: 'slow',
    category: 'file-operations'
};
/**
 * Input schema for batch operations
 */
export const schema = z.object({
    operation: z.enum(['add-tags', 'remove-tags', 'update-frontmatter', 'append-content']).describe('Operation to perform'),
    filter: z.object({
        folders: z.array(z.string()).optional().describe('Filter by folder paths (OR logic)'),
        tags: z.array(z.string()).optional().describe('Filter by tags (AND logic)'),
        frontmatter: z.record(z.any()).optional().describe('Filter by frontmatter fields'),
        paths: z.array(z.string()).optional().describe('Specific file paths to operate on')
    }).describe('Filter criteria for selecting files'),
    params: z.union([
        z.object({ tags: z.array(z.string()) }),
        z.object({ updates: z.record(z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])) }),
        z.object({ content: z.string() })
    ]).describe('Operation-specific parameters'),
    dryRun: z.boolean().default(false).describe('Preview changes without applying (default: false)'),
    maxFiles: z.number().min(1).max(100).default(50).describe('Maximum number of files to process (default: 50, max: 100)')
});
export type Input = z.infer<typeof schema>;
/**
 * Batch operation result
 */
interface BatchOperationResult {
    operation: string;
    filesProcessed: number;
    filesModified: string[];
    filesSkipped: string[];
    errors: Array<{
        path: string;
        error: string;
    }>;
    dryRun: boolean;
}
/**
 * Execute batch operation
 */
export async function prepare(input: Input, context: SkillContext): Promise<MutationPlan> {
    if (!context.mutations)
        throw new Error('宿主未提供文件变更服务');
    return context.mutations.prepare('obsidian:batch_operation', input, async () => {
        const files = await getFilteredFiles(context, input.filter, input.maxFiles), changes = [], skipped = [];
        for (const file of files) {
            const previous = await context.files.read(file);
            const content = transform(previous, input.operation, input.params);
            if (content === previous) {
                skipped.push(file.path);
                continue;
            }
            changes.push(await context.mutations!.writeChange(file.path, content, previous));
        }
        return { changes, skipped, summary: `批量 ${input.operation}：${changes.length} 个明确目标，${skipped.length} 个无需改动` };
    }, context);
}
export async function execute(input: Input, context: SkillContext): Promise<SkillResult<BatchOperationResult>> {
    const started = Date.now();
    try {
        const plan = context.mutationPlan || await prepare(input, context);
        const result = input.dryRun ? { outcome: 'success' as const, data: { filesModified: plan.changes.map(c => c.path) }, items: [] } : await context.mutations!.apply(plan, context);
        return fromToolOutcome({ ...result, data: { operation: input.operation, filesProcessed: plan.changes.length + (plan.skipped?.length || 0), filesModified: result.data?.filesModified || [], filesSkipped: plan.skipped || [],
                errors: (result.items || []).filter(i => i.outcome !== 'success').map(i => ({ path: i.path, error: i.error || '未完成' })), dryRun: input.dryRun },
            metadata: { executionTime: Date.now() - started, filesModified: input.dryRun ? [] : result.data?.filesModified || [] } });
    }
    catch (error) {
        if (error instanceof RunBlocked || error instanceof RunSuspended)
            throw error;
        return { success: false, outcome: 'input_error', error: error instanceof Error ? error.message : String(error), data: { operation: input.operation, filesProcessed: 0, filesModified: [], filesSkipped: [], errors: [], dryRun: input.dryRun } };
    }
}
/**
 * Helper: Get filtered files
 */
async function getFilteredFiles(context: SkillContext, filter: Input['filter'], maxFiles: number): Promise<SkillFile[]> {
    let files = context.files.getMarkdownFiles() as SkillFile[];
    // Filter by specific paths (takes precedence)
    if (filter.paths && filter.paths.length > 0) {
        files = filter.paths
            .map(path => context.files.getAbstractFileByPath(path))
            .filter(isSkillFile);
    }
    else {
        // Filter by folders
        if (filter.folders && filter.folders.length > 0) {
            files = files.filter(file => {
                return filter.folders!.some(folder => {
                    const directory = folder.replace(/\/+$/, '');
                    return !directory || file.path.startsWith(`${directory}/`);
                });
            });
        }
        // Filter by tags
        if (filter.tags && filter.tags.length > 0) {
            files = files.filter(file => {
                const cache = context.metadataCache.getFileCache(file);
                const fileTags = cache?.tags?.map(t => t.tag.replace('#', '')) || [];
                const frontmatterTags = readTags(cache?.frontmatter?.tags);
                const allTags = [...fileTags, ...frontmatterTags].map(t => typeof t === 'string' ? t : String(t));
                return filter.tags!.every(tag => allTags.includes(tag));
            });
        }
        // Filter by frontmatter
        if (filter.frontmatter) {
            files = files.filter(file => {
                const cache = context.metadataCache.getFileCache(file);
                const fm = cache?.frontmatter || {};
                return Object.entries(filter.frontmatter!).every(([key, value]) => {
                    return fm[key] === value;
                });
            });
        }
    }
    // Limit results
    return files.slice(0, maxFiles);
}
function transform(content: string, operation: Input['operation'], params: Input['params']): string {
    if (operation === 'append-content') {
        const text = 'content' in params ? params.content : '';
        return text ? content + '\n\n' + text : content;
    }
    const parsed = parseFrontmatter(content), frontmatter = parsed.frontmatter;
    if (operation === 'update-frontmatter')
        return buildContent({ ...frontmatter, ...('updates' in params ? params.updates : {}) }, parsed.content);
    const tags = 'tags' in params ? params.tags : [], existing = readTags(frontmatter.tags);
    const updated = operation === 'add-tags' ? [...new Set([...existing, ...tags])] : existing.filter(tag => !tags.includes(tag));
    if (JSON.stringify(updated) === JSON.stringify(existing))
        return content;
    return buildContent({ ...frontmatter, tags: updated }, parsed.content);
}
/**
 * Helper: Parse frontmatter from content
 */
function parseFrontmatter(content: string): {
    frontmatter: Record<string, unknown>;
    content: string;
} {
    if (!/^\uFEFF?---[ \t]*\r?\n/.test(content))
        return { frontmatter: {}, content };
    const match = content.match(/^\uFEFF?---[ \t]*\r?\n([\s\S]*?)^---[ \t]*(?:\r?\n|$)([\s\S]*)$/m);
    if (!match)
        throw new Error('Unterminated YAML frontmatter; file was not modified');
    const parsed: unknown = parseYaml(match[1]);
    if (parsed !== null && parsed !== undefined && (typeof parsed !== 'object' || Array.isArray(parsed))) {
        throw new Error('Frontmatter must be a YAML mapping; file was not modified');
    }
    return { frontmatter: (parsed || {}) as Record<string, unknown>, content: match[2] };
}
function readTags(value: unknown): string[] {
    if (value === null || value === undefined)
        return [];
    if (typeof value === 'string')
        return value.split(/[\s,]+/).filter(Boolean);
    if (Array.isArray(value) && value.every(tag => typeof tag === 'string'))
        return value;
    throw new Error('Frontmatter tags must be a string or an array of strings');
}
function buildContent(frontmatter: Record<string, unknown>, bodyContent: string): string {
    if (Object.keys(frontmatter).length === 0)
        return bodyContent;
    return `---\n${stringifyYaml(frontmatter).trimEnd()}\n---\n${bodyContent}`;
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
