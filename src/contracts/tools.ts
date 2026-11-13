/** Host-independent tool, file and mutation contracts. */
export type ToolEffect = 'read' | 'write' | 'mutate' | 'external' | 'interaction' | 'orchestration';
export interface ToolDescriptor {
    id: string;
    description: string;
    inputSchema: Record<string, unknown>;
    effect: ToolEffect;
}
export interface ToolCatalog {
    listTools(): ToolDescriptor[];
    resolveTool(id: string): ToolDescriptor | undefined;
}
export interface ToolInvocation {
    toolId: string;
    input: Record<string, unknown>;
    operationId?: string;
    signal?: AbortSignal;
}
export interface ToolHandler {
    invoke(call: ToolInvocation): Promise<ToolOutcome>;
}
interface OutcomeData<T> {
    data?: T;
    metadata?: Record<string, unknown>;
    items?: MutationItemResult[];
    warnings?: string[];
}
export type ToolOutcome<T = unknown> = ({
    outcome: 'success';
} & OutcomeData<T>) | ({
    outcome: 'partial';
    error: string;
} & OutcomeData<T>) | ({
    outcome: 'failure';
    code: string;
    error: string;
} & OutcomeData<T>) | ({
    outcome: 'unknown';
    error: string;
} & OutcomeData<T>);
export interface SkillFile {
    path: string;
    name: string;
    basename: string;
    extension: string;
    stat: {
        mtime: number;
        ctime: number;
        size: number;
    };
    parent?: {
        path: string;
    } | null;
}
export interface SkillFiles {
    getAbstractFileByPath(path: string): SkillFile | {
        path: string;
    } | null;
    getMarkdownFiles(): SkillFile[];
    read(file: SkillFile): Promise<string>;
}
export interface SkillFileCache {
    frontmatter?: Record<string, unknown>;
    tags?: Array<{
        tag: string;
    }>;
    links?: Array<{
        link: string;
    }>;
    headings?: Array<{
        level: number;
        heading: string;
        position: {
            start: {
                offset: number;
            };
        };
    }>;
}
export interface SkillMetadataReader {
    getFileCache(file: SkillFile): SkillFileCache | null;
    getBacklinksForFile?(file: SkillFile): Map<string, unknown> | undefined;
}
export type MutationChange = {
    kind: 'write';
    path: string;
    beforeHash: string;
    afterHash: string;
    content: string;
} | {
    kind: 'move';
    path: string;
    to: string;
    beforeHash: string;
    afterHash: string;
    content?: string;
};
export interface MutationPlan {
    version: 1;
    id: string;
    requestHash: string;
    toolId: string;
    changes: MutationChange[];
    warnings: string[];
    summary: string;
    skipped?: string[];
}
export interface MutationItemResult {
    path: string;
    kind: 'write' | 'move';
    outcome: 'success' | 'failure' | 'unknown';
    error?: string;
    disposition?: 'applied' | 'already_satisfied';
}
export interface MutationIO {
    read(path: string): Promise<string | null>;
    exists(path: string): Promise<boolean>;
    listMarkdown(): Promise<string[]>;
    write(path: string, content: string): Promise<void>;
    move(from: string, to: string): Promise<void>;
    resolveLink(link: string, source: string): string | null;
}
export interface MutationPlanStore {
    load(key: string): Promise<MutationPlan | null>;
    save(key: string, plan: MutationPlan): Promise<void>;
    clear(key: string): Promise<void>;
}
export interface ToolCommandExecutor {
    execute(input: {
        command: string;
        cwd?: string;
        timeout: number;
    }, signal?: AbortSignal): Promise<ToolOutcome>;
}
