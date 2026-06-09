// Agent Types - Core type definitions for the Agent system

import { ChatMessage } from '../types';
import { SkillCall } from '../skills/skill-types';

/**
 * Agent configuration
 */
export interface AgentConfig {
  id: string;
  name: string;
  description: string;
  systemPrompt?: string;
  maxTurns?: number;
  temperature?: number;
  enableSkills?: boolean;  // Whether to enable skill calling
}

/**
 * Agent execution context
 */
export interface AgentContext {
  messages: ChatMessage[];
  sessionId: string;
  metadata?: Record<string, any>;
  pendingSteerMessages?: string[];
  abortSignal?: AbortSignal;
  confirmHandler?: (
    skillName: string,
    params: any,
    message: string
  ) => Promise<{ approved: boolean; modifiedParams?: any }>;
}

/**
 * Agent execution response
 */
export interface AgentResponse {
  content: string;
  messages: ChatMessage[];
  metadata?: Record<string, any>;
  skillCalls?: SkillCall[];
}

/**
 * AgentEvent - Stream events emitted during RAGP execution
 * Designed for responsive UI and human-in-the-loop interactions
 */
export type AgentEvent =
  | { type: 'status'; message: string }
  | { type: 'chunk'; text: string }
  | { type: 'skill_call'; name: string; params: any }
  | { type: 'skill_success'; name: string; result: any }
  | { type: 'skill_error'; name: string; error: string }
  | { type: 'confirm_request'; skillName: string; params: any; message: string }
  | { type: 'steer'; message: string }
  | { type: 'error'; message: string };

/**
 * DiagnosticsLogger - Decoupled interface for logging tool execution failures
 */
export interface DiagnosticsLogger {
  logIncident(incident: {
    agentId: string;
    agentName: string;
    toolName: string;
    originalArgs: string;
    errorMessage: string;
    strategy: string;
    repairedArgs?: string;
    success: boolean;
  }): Promise<void>;
}

/**
 * Agent task for orchestration
 */
export interface AgentTask {
  id: string;
  agentId: string;
  prompt: string;
  context: AgentContext;
  dependencies?: string[]; // IDs of tasks that must complete first
}

/**
 * Result of multi-agent orchestration
 */
export interface AgentOrchestrationResult {
  tasks: Map<string, AgentResponse>;
  finalResponse: string;
}
