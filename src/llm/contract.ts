import type { ChatMessage } from '../types';
import type { ToolCall } from '../types';

/** Model provider capabilities — declarative, no host types. */
export interface LLMCapabilities {
  chat: boolean;        // conversational generation
  streaming: boolean;   // streamed chat
  embeddings: boolean;  // embedding generation
  tools: boolean;       // tool/function calling
}

export interface LLMChunk {
  delta: string;
}

export interface LLMGenerateOptions {
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

/** A model provider — the atomic unit registrable into the `llm` service. */
export interface LLMProvider {
  readonly id: string;   // 'openai' | 'anthropic' | 'ollama' | ...
  readonly name: string;
  capabilities: LLMCapabilities;

  /** Non-streaming chat. Returns the full assistant text. */
  generate(messages: ChatMessage[], options?: LLMGenerateOptions): Promise<string>;

  /** Streaming chat. Yields content chunks; resolves when the turn ends. */
  generateStream(
    messages: ChatMessage[],
    onChunk: (chunk: LLMChunk) => void,
    options?: LLMGenerateOptions,
  ): Promise<void>;

  /** Tool-enabled chat: yields assistant completion and any tool calls. */
  generateWithTools?(
    messages: ChatMessage[],
    onChunk?: (chunk: LLMChunk) => void,
    options?: LLMGenerateOptions,
  ): Promise<{ content: string; toolCalls?: ToolCall[] }>;

  /** Embedding generation (if capabilities.embeddings). */
  embed?(texts: string[]): Promise<number[][]>;

  /** Context/resource sizing used by budgeting and compaction. */
  getContextWindow(): number;
  getCompactionThreshold(): number;

  isAvailable(): Promise<boolean>;
}

/** Task → provider routing key (kept for backward compat with current routing). */
export type LLMTask = 'chat' | 'embedding' | 'classification' | 'summary';
