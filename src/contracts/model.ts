import type { ToolCall, ChatMessage, ProtocolState } from './conversation';

export interface GenerateOptions {
  onProgress?: (message: string) => void;
  onResponse?: (response: GenerateResponse) => void;
  maxTokens?: number;
  temperature?: number;
  systemPrompt?: string;
  stopSequences?: string[];
  // Skill support
  skills?: unknown[]; // OpenAI functions or Anthropic tools
  toolChoice?: 'auto' | 'none' | (string & NonNullable<unknown>);
  abortSignal?: AbortSignal;
}

export interface GenerateResponse {
  content: string;
  toolCalls?: ToolCall[];
  finishReason?: 'stop' | 'tool_calls' | 'length';
  providerState?: ProtocolState;
  diagnostics?: { outputLimit?: number; partialContent?: string; pendingToolCalls?: number; reasoningTokens?: number;
    requestId?: string; elapsedMs?: number; firstProgressMs?: number; outputCharacters?: number; reasoningCharacters?: number; reasoningMode?: string; legacyCompatibility?: boolean };
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  };
}

export interface ToolDefinition { name: string; description: string; inputSchema: Record<string, unknown>; }
export interface ModelRequest {
  messages: ChatMessage[];
  systemPrompt?: string;
  tools?: ToolDefinition[];
  maxTokens?: number;
  temperature?: number;
  toolChoice?: string;
  stopSequences?: string[];
}
export type ModelEvent = { type: 'text'; text: string } | { type: 'progress'; message: string };
export interface ChatModel {
  readonly kind: 'chat-model';
  readonly id: string;
  readonly name: string;
  readonly capabilities: { tools: boolean; protocolState: boolean };
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly compactionThreshold: number;
  requestMetadata(): Record<string, unknown>;
  stream(request: ModelRequest, emit: (event: ModelEvent) => void, signal?: AbortSignal): Promise<GenerateResponse>;
}
export interface Embedder {
  readonly id: string;
  embed(texts: string[], signal?: AbortSignal): Promise<{ embeddings: number[][]; tokens?: number }>;
}
