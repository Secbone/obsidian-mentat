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
  toolExecutionMode?: 'sequential' | 'parallel';  // 默认 'parallel'
  maxParallelTools?: number;                       // 默认 5
}

/**
 * Agent execution context
 */
export interface AgentContext {
  messages: ChatMessage[];
  sessionId: string;
  metadata?: Record<string, unknown>;
  pendingSteerMessages?: string[];
  abortSignal?: AbortSignal;
  confirmHandler?: (
    skillName: string,
    params: unknown,
    message: string
  ) => Promise<{ approved: boolean; modifiedParams?: unknown }>;
}

/**
 * Agent execution response
 */
export interface AgentResponse {
  content: string;
  messages: ChatMessage[];
  metadata?: Record<string, unknown>;
  skillCalls?: SkillCall[];
}

/**
 * AgentEvent - Stream events emitted during RAGP execution
 * Designed for responsive UI and human-in-the-loop interactions
 */
export type AgentEvent =
  // 状态与错误
  | { type: 'status'; message: string }
  | { type: 'error'; message: string }

  // Agent 生命周期
  | { type: 'agent_start' }
  | { type: 'agent_end'; messages: ChatMessage[] }

  // Turn 生命周期（一次 LLM 调用 + 可能的工具执行）
  | { type: 'turn_start'; turnIndex: number }
  | { type: 'turn_end'; turnIndex: number; message: ChatMessage; toolResults: unknown[] }

  // 消息生命周期
  | { type: 'message_start'; role: string }
  | { type: 'message_update'; delta: string; accumulatedText?: string }
  | { type: 'message_end'; role: string; content: string }

  // 工具调用生命周期（替代旧的 skill_call / skill_success / skill_error）
  | { type: 'tool_execution_start'; toolCallId: string; toolName: string; args: unknown }
  | { type: 'tool_execution_end'; toolCallId: string; result: unknown; isError: boolean }

  // 【旧事件 — 向后兼容】
  | { type: 'chunk'; text: string }
  | { type: 'skill_call'; name: string; params: unknown }
  | { type: 'skill_success'; name: string; result: unknown }
  | { type: 'skill_error'; name: string; error: string }

  // 确认请求与引导
  | { type: 'confirm_request'; skillName: string; params: unknown; message: string }
  | { type: 'steer'; message: string };

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
