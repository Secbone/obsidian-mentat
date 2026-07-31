// Agent Types - Core type definitions for the Agent system

import { ChatMessage } from '../types';
import { SkillCall, SkillResult } from '../skills/skill-types';

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
 * Organized by multi-level namespace (domain:entity:action)
 * Designed for responsive UI and human-in-the-loop interactions
 */
export type AgentEvent =
  // agent 生命周期
  | { type: 'agent:start' }
  | { type: 'agent:end'; messages: ChatMessage[] }

  // turn 生命周期（一次 LLM 调用 + 可能的工具执行）
  | { type: 'turn:start'; turnIndex: number }
  | { type: 'turn:end'; turnIndex: number; message: ChatMessage; toolResults: unknown[] }

  // message 流
  | { type: 'message:start'; role: string }
  | { type: 'message:update'; delta: string; accumulatedText?: string }
  | { type: 'message:end'; role: string; content: string }

  // tool 调用（唯一来源）
  | { type: 'tool:start'; toolCallId: string; toolName: string; args: unknown }
  | { type: 'tool:end'; toolCallId: string; toolName: string; result: SkillResult | null; isError: boolean }

  // context 压缩
  | { type: 'context:compact:start' }
  | { type: 'context:compact:end'; summaryLength: number }

  // HITL 确认（双向）
  | { type: 'confirm:request'; taskId: string; skillName: string; params: unknown; message: string }
  | { type: 'confirm:response'; taskId: string; approved: boolean }

  // system 级
  | { type: 'system:status'; message: string }
  | { type: 'system:error'; message: string }
  | { type: 'system:steer'; message: string };

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
