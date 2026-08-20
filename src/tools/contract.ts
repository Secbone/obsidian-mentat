import type { ZodTypeAny } from 'zod';

export type Permission =
  | 'documents:read' | 'documents:write' | 'documents:delete'
  | 'execute:command' | 'network:fetch' | 'extension:mount';

export interface ToolContext {
  /** Host-agnostic document store (injected via platform, not the host). */
  documents?: import('../platform/contracts').DocumentStore;
  knowledge?: import('../knowledge/knowledge.service').KnowledgeService;
  search?: import('../platform/contracts').SearchCapability;
  graph?: import('../platform/contracts').GraphCapability;
  signal?: AbortSignal;
}

export interface ToolResult<TOutput = unknown> {
  success: boolean;
  data?: TOutput;
  error?: string;
}

/** A tool — the atomic unit registrable into the `tools` service. */
export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  /** Zod input schema for validation. */
  schema?: ZodTypeAny;
  /** Permissions this tool requires (checked against the permissions service). */
  permissions: Permission[];
  execute(input: TInput, ctx: ToolContext): Promise<ToolResult<TOutput>>;
}
