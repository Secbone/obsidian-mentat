// Core types for Skill system

import { ZodTypeAny } from 'zod';
import { Vault, MetadataCache, Workspace } from 'obsidian';

/**
 * Skill execution status
 */
export type SkillStatus = 'pending' | 'executing' | 'success' | 'error';

/**
 * Skill namespace - identifies the source of the skill
 */
export type SkillNamespace = 'obsidian' | 'mcp' | 'meta' | 'guard';

/**
 * Skill execution result
 */
export interface SkillResult<T = unknown> {
  success: boolean;
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

  // Execution function
  execute: (input: TInput) => Promise<SkillResult<TOutput>>;

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
export interface SkillContext {
  vault: Vault;
  metadataCache: MetadataCache;
  workspace: Workspace;
  indexManager?: import('../indexing/index-manager').IndexManager;
  plugin: import('../main').default;
}

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
