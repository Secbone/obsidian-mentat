// Agent Types - Core type definitions for the Agent system

import { ChatMessage, ToolCall } from '../types';
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
