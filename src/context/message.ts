/**
 * Message Layer - Independent message class and utilities
 * No external dependencies - self-contained
 */

/**
 * Tool call information
 */
export interface ToolCall {
  id: string;
  name: string;
  arguments: string | Record<string, any>;
}

/**
 * Message role types
 */
export type MessageRole = 'user' | 'assistant' | 'system' | 'tool' | 'function';

/**
 * Message class - represents a single chat message
 * Independent of external types (no dependency on ChatMessage or TFile)
 */
export class Message {
  role: MessageRole;
  content: string;
  timestamp: number;
  sources?: any[];  // Generic, not tied to TFile - can be any source reference
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];

  constructor(data: {
    role: MessageRole;
    content: string;
    timestamp?: number;
    sources?: any[];
    name?: string;
    tool_call_id?: string;
    tool_calls?: ToolCall[];
  }) {
    this.role = data.role;
    this.content = data.content;
    this.timestamp = data.timestamp ?? Date.now();
    this.sources = data.sources;
    this.name = data.name;
    this.tool_call_id = data.tool_call_id;
    this.tool_calls = data.tool_calls;
  }

  /**
   * Check if message is a tool call
   */
  isToolCall(): boolean {
    return this.role === 'tool' || this.role === 'function';
  }

  /**
   * Check if message is an error
   */
  isError(): boolean {
    return this.isToolCall() && this.content.includes('Error:');
  }

  /**
   * Check if message has tool calls
   */
  hasToolCalls(): boolean {
    return !!this.tool_calls && this.tool_calls.length > 0;
  }

  /**
   * Clone the message
   */
  clone(): Message {
    return new Message({
      role: this.role,
      content: this.content,
      timestamp: this.timestamp,
      sources: this.sources ? [...this.sources] : undefined,
      name: this.name,
      tool_call_id: this.tool_call_id,
      tool_calls: this.tool_calls ? [...this.tool_calls] : undefined
    });
  }

  /**
   * Convert to plain object
   */
  toJSON(): { role: string; content: string; [key: string]: unknown } {
    return {
      role: this.role,
      content: this.content,
      timestamp: this.timestamp,
      sources: this.sources,
      name: this.name,
      tool_call_id: this.tool_call_id,
      tool_calls: this.tool_calls
    };
  }

  /**
   * Create from plain object (for deserialization)
   */
  static fromJSON(data: Record<string, unknown>): Message {
    return new Message(data as { role: MessageRole; content: string; timestamp?: number; sources?: unknown[]; name?: string; tool_call_id?: string; tool_calls?: ToolCall[] });
  }
}

/**
 * Message statistics
 */
export interface MessageStatistics {
  totalMessages: number;
  userMessageCount: number;
  assistantMessageCount: number;
  systemMessageCount: number;
  toolCallCount: number;
  errorCount: number;
}

/**
 * Calculate statistics from messages
 */
export function calculateMessageStats(messages: Message[]): MessageStatistics {
  return {
    totalMessages: messages.length,
    userMessageCount: messages.filter(m => m.role === 'user').length,
    assistantMessageCount: messages.filter(m => m.role === 'assistant').length,
    systemMessageCount: messages.filter(m => m.role === 'system').length,
    toolCallCount: messages.filter(m => m.isToolCall()).length,
    errorCount: messages.filter(m => m.isError()).length
  };
}

/**
 * Estimate tokens for a message (simple approximation)
 * Uses ~4 characters per token as a rough estimate
 */
export function estimateTokens(message: Message): number {
  // Simple estimation: ~4 characters per token
  let totalChars = message.content.length;

  // Add overhead for role and metadata
  totalChars += 10;

  // Add tool call overhead if present
  if (message.tool_calls) {
    totalChars += JSON.stringify(message.tool_calls).length;
  }

  return Math.ceil(totalChars / 4);
}

/**
 * Estimate total tokens for multiple messages
 */
export function estimateTotalTokens(messages: Message[]): number {
  return messages.reduce((total, msg) => total + estimateTokens(msg), 0);
}
