import type { ChatMessage, ToolCall } from './conversation';
import type { GenerateResponse, ModelRequest, ToolDefinition } from './model';
import type { AgentConfig, AgentContext, AgentResponse } from '../agents/agent-types';

export interface EngineBinding { id: string; version: string; codecVersion: number; }
export interface AgentEngine {
  getId(): string;
  getName(): string;
  getDescription(): string;
  getConfig(): AgentConfig;
  execute(prompt: string, context: AgentContext): Promise<AgentResponse>;
}
export interface AgentHost {
  readonly signal?: AbortSignal;
  tools(): ToolDefinition[];
  model(request: Omit<ModelRequest, 'messages'>): Promise<GenerateResponse>;
  invoke(call: ToolCall): Promise<unknown>;
  checkpoint(state: unknown): Promise<void>;
  instructions(): Promise<ChatMessage[]>;
  progress(message: string): void;
}
export interface EngineDefinition {
  readonly binding: EngineBinding;
  run(input: { prompt: string; messages: readonly ChatMessage[]; state?: unknown; maxTurns: number }, host: AgentHost): Promise<{ content: string; state?: unknown; status?: 'completed' | 'max_turns_exceeded' }>;
}
