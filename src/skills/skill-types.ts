import type { RunRuntime, OutcomeKind } from '../runtime/types';
import type { MentatSettings } from '../settings/settings';
// Core types for Skill system

import { ZodTypeAny } from 'zod';
import type { ReadTracker } from '../services/read-tracker';
import type { SkillFiles, SkillFile, SkillMetadataReader, MutationPlan, ToolCommandExecutor } from '../contracts/tools';
import type { MutationService } from './mutations/mutation-service';
export type { ToolOutcome, ToolCatalog, ToolHandler, MutationPlan, SkillFile, SkillFiles } from '../contracts/tools';

/**
 * Skill execution status
 */
export type SkillStatus = 'pending' | 'executing' | 'success' | 'error';

/**
 * Skill namespace - identifies the source of the skill
 */
export type SkillNamespace = 'obsidian' | 'mcp' | 'meta' | 'guard' | 'custom';

/**
 * Skill execution result
 */
export interface SkillResult<T = unknown> {
  success: boolean;
  outcome?: OutcomeKind;
  data?: T;
  error?: string;
  metadata?: {
    executionTime?: number;
    filesModified?: string[];
    filesCreated?: string[];
    [key: string]: unknown;
  };
}

/**
 * Skill call record - tracks a skill invocation
 */
export interface SkillCall {
  id: string;
  skillName: string;
  namespace: SkillNamespace;
  parameters: Record<string, unknown>;
  status: SkillStatus;
  result?: SkillResult;
  timestamp: number;
  executionTime?: number;
}

/**
 * Core Skill Definition
 */
export interface SkillDefinition<TInput = unknown, TOutput = unknown> {
  // Identification
  name: string;
  namespace: SkillNamespace;
  description: string;

  // Schema - Zod schema for input validation
  schema: ZodTypeAny;
  /** Native JSON Schema from external adapters; local schema validates the input envelope. */
  inputSchema?: Record<string, unknown>;

  // Execution function
  prepare?: (input: TInput, options?: SkillExecutionOptions) => Promise<MutationPlan>;
  execute: (input: TInput, options?: SkillExecutionOptions) => Promise<SkillResult<TOutput>>;

  // Metadata
  metadata?: {
    version?: string;
    author?: string;
    tags?: string[];
    examples?: Array<{
      input: TInput;
      description: string;
    }>;
    requiresConfirmation?: boolean; // Whether to ask user before executing
    executionCategory?: 'read' | 'write' | 'mutate' | 'external' | 'interaction' | 'orchestration';
    // read     → 纯读取，完全并行安全
    // write    → 文件写入，同组串行
    // mutate   → 修改 vault 结构（move/delete/rename），与 write 互斥
    // external → 外部 API 调用，单独分组
    permissions?: SkillPermission[]; // 声明所需权限
    documentation?: string;
  };
}

/**
 * OpenAI Function format
 */
export interface OpenAIFunction {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/**
 * Anthropic Tool format
 */
export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/**
 * Tool call from AI provider
 */
export interface ToolCall {
  id: string;
  name: string;
  arguments: string | Record<string, unknown>; // Can be JSON string or parsed object
}

/**
 * Skill execution context - provides access to plugin resources
 */
export interface SkillExecutionOptions {
  abortSignal?: AbortSignal; runtime?: RunRuntime; operationId?: string; mutationPlan?: MutationPlan;
}
export interface SkillContext {
  /** This context carries host capabilities, never the plugin or an Obsidian App. */
  settings?: Readonly<MentatSettings>;
  runtime?: Pick<RunRuntime,'runId'|'scope'|'record'|'interact'>;
  operationId?: string;
  abortSignal?: AbortSignal;
  files: SkillFiles;
  metadataCache: SkillMetadataReader;
  mutations?: MutationService;
  mutationPlan?: MutationPlan;
  commands?: ToolCommandExecutor;
  askUser?: (input:{question:string;context?:string;options?:string[];requiresInput?:boolean}) => Promise<NonNullable<import('../runtime/types').InteractionRequest['outcome']>>;
  indexManager?: {
    canSearch?:()=>Promise<boolean>; search:(query:string,options?:{topK?:number;minScore?:number;filterFiles?:string[]})=>Promise<Array<{chunk:{filePath:string};score:number}>>;
    indexFile:(file:SkillFile)=>Promise<unknown>;removeFromIndex:(path:string)=>Promise<void>;
  };
  readTracker?: Pick<ReadTracker,'hasBeenRead'|'markRead'|'clear'>;
}
export function isSkillFile(file:SkillFile|{path:string}|null|undefined):file is SkillFile { return !!file && 'extension' in file; }

/**
 * Skill permission level
 */
export enum SkillPermission {
  READ = 'read',         // Can read files
  WRITE = 'write',       // Can modify files
  CREATE = 'create',     // Can create files
  DELETE = 'delete',     // Can delete files
  EXTERNAL = 'external'  // Can make external API calls
}

/**
 * Skill security configuration
 */
export interface SkillSecurity {
  permissions: SkillPermission[];
  requireConfirmation: boolean;
  allowedPaths?: string[]; // Restrict to specific paths
  denyPaths?: string[];    // Explicitly deny certain paths
}

/**
 * Documentation Skill Definition
 * For pure documentation/guidance skills (no executable code)
 * Follows Agent Skills specification (agentskills.io)
 */
export interface DocumentationSkillDefinition {
  // Identification
  name: string;
  namespace: SkillNamespace;
  description: string;

  // Content - Markdown documentation
  content: string;

  // Metadata
  metadata?: {
    version?: string;
    author?: string;
    tags?: string[];
    source?: string; // Source file path
  };
}

export type ToolDefinition = OpenAIFunction | AnthropicTool;

/**
 * Union type for all skill types
 */
export type AnySkillDefinition =
  | SkillDefinition<any, any>
  | DocumentationSkillDefinition;

/**
 * Type guard to check if a skill is a documentation skill
 */
export function isDocumentationSkill(
  skill: AnySkillDefinition
): skill is DocumentationSkillDefinition {
  return 'content' in skill && !('execute' in skill);
}

/**
 * Type guard to check if a skill is an executable skill
 */
export function isExecutableSkill(
  skill: AnySkillDefinition
): skill is SkillDefinition<any, any> {
  return 'execute' in skill;
}
