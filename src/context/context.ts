/**
 * Context Layer - Collection of messages with metadata
 * Single unified Context class for all context types
 */

import { Message, MessageStatistics, calculateMessageStats, estimateTotalTokens } from './message';

/**
 * Context metadata
 */
export interface ContextMetadata {
  totalMessages: number;
  windowSize: number;
  strategy?: string;
  sessionId?: string;
  sessionStartTime?: number;
  lastUpdated?: number;
  tokenCount?: number;
  statistics?: MessageStatistics;
  [key: string]: any;  // Allow custom metadata
}

/**
 * Context options for transformations
 */
export interface ContextOptions {
  maxMessages?: number;
  maxTokens?: number;
  includeSystemMessages?: boolean;
  includeToolCalls?: boolean;
  strategy?: string;
  filter?: (message: Message) => boolean;
  keepRecentToolResults?: number; // Default: 5 - Keep latest N tool results with full content
  // Transformation hints
  optimizeForLLM?: boolean;
  enhanceForDisplay?: boolean;
  transformToolCalls?: boolean;
  [key: string]: any;  // Allow custom options
}

/**
 * Context - represents a collection of messages
 * Single unified class for all context types (replaces LLMContext, DisplayContext, RawContext)
 */
export class Context {
  private messages: Message[];
  private metadata: ContextMetadata;

  constructor(messages: Message[], metadata?: Partial<ContextMetadata>) {
    this.messages = messages;
    this.metadata = this.initializeMetadata(messages, metadata);
  }

  /**
   * Get all messages (returns a copy to prevent external mutation)
   */
  getMessages(): Message[] {
    return [...this.messages];
  }

  /**
   * Get metadata (returns a copy)
   */
  getMetadata(): ContextMetadata {
    return { ...this.metadata };
  }

  /**
   * Get message count
   */
  getMessageCount(): number {
    return this.messages.length;
  }

  /**
   * Get statistics
   */
  getStatistics(): MessageStatistics {
    return this.metadata.statistics || calculateMessageStats(this.messages);
  }

  /**
   * Get estimated token count
   */
  getTokenCount(): number {
    if (this.metadata.tokenCount !== undefined) {
      return this.metadata.tokenCount;
    }
    return estimateTotalTokens(this.messages);
  }

  /**
   * Clone the context
   */
  clone(): Context {
    return new Context(
      this.messages.map(m => m.clone()),
      { ...this.metadata }
    );
  }

  /**
   * Create a new context with filtered messages
   */
  filter(predicate: (message: Message) => boolean): Context {
    const filtered = this.messages.filter(predicate);
    return new Context(filtered, {
      ...this.metadata,
      windowSize: filtered.length,
      totalMessages: filtered.length
    });
  }

  /**
   * Create a new context with limited messages (takes last N messages)
   */
  limit(maxMessages: number): Context {
    const limited = this.messages.slice(-maxMessages);
    return new Context(limited, {
      ...this.metadata,
      windowSize: limited.length,
      totalMessages: limited.length
    });
  }

  /**
   * Create a new context with messages in a specific range
   */
  slice(start?: number, end?: number): Context {
    const sliced = this.messages.slice(start, end);
    return new Context(sliced, {
      ...this.metadata,
      windowSize: sliced.length,
      totalMessages: sliced.length
    });
  }

  /**
   * Update metadata (mutates the context)
   */
  updateMetadata(updates: Partial<ContextMetadata>): void {
    this.metadata = { ...this.metadata, ...updates };
  }

  /**
   * Check if context is empty
   */
  isEmpty(): boolean {
    return this.messages.length === 0;
  }

  /**
   * Get first message
   */
  getFirstMessage(): Message | undefined {
    return this.messages[0];
  }

  /**
   * Get last message
   */
  getLastMessage(): Message | undefined {
    return this.messages[this.messages.length - 1];
  }

  /**
   * Get messages by role
   */
  getMessagesByRole(role: string): Message[] {
    return this.messages.filter(m => m.role === role);
  }

  /**
   * Convert to plain object for serialization
   */
  toJSON(): { messages: any[]; metadata: ContextMetadata } {
    return {
      messages: this.messages.map(m => m.toJSON()),
      metadata: this.metadata
    };
  }

  /**
   * Create from plain object (deserialization)
   */
  static fromJSON(data: { messages: any[]; metadata: ContextMetadata }): Context {
    const messages = data.messages.map(m => Message.fromJSON(m));
    return new Context(messages, data.metadata);
  }

  /**
   * Create an empty context
   */
  static empty(metadata?: Partial<ContextMetadata>): Context {
    return new Context([], metadata);
  }

  /**
   * Get context in different formats as plain JS objects
   * @param format - 'raw' (default), 'llm', or 'display'
   * @param options - Optional filtering/limiting options
   * @returns Plain JS array of message objects
   */
  getContext(
    format: 'raw' | 'llm' | 'display' = 'raw',
    options?: ContextOptions
  ): Array<{role: string; content: string; [key: string]: any}> {
    let messages = [...this.messages];

    // Apply filters
    if (options?.includeSystemMessages === false) {
      messages = messages.filter(m => m.role !== 'system');
    }
    if (options?.includeToolCalls === false) {
      messages = messages.filter(m => !m.isToolCall());
    }
    if (options?.filter) {
      messages = messages.filter(options.filter);
    }

    // Apply token limit (simple estimation)
    if (options?.maxTokens) {
      messages = this.limitByTokens(messages, options.maxTokens);
    }

    // Apply message limit (take last N)
    if (options?.maxMessages) {
      messages = messages.slice(-options.maxMessages);
    }

    // Apply format-specific transformations
    switch (format) {
      case 'llm':
        return this.formatForLLM(messages, options);
      case 'display':
        return this.formatForDisplay(messages);
      case 'raw':
      default:
        return this.formatRaw(messages);
    }
  }

  /**
   * Limit messages by token count
   */
  private limitByTokens(messages: Message[], maxTokens: number): Message[] {
    // Simple token limiting: keep recent messages within token budget
    const result: Message[] = [];
    let tokenCount = 0;

    // Always include system messages first
    const systemMessages = messages.filter(m => m.role === 'system');
    for (const msg of systemMessages) {
      const tokens = estimateTotalTokens([msg]);
      tokenCount += tokens;
      result.push(msg);
    }

    // Add recent non-system messages in reverse order
    const nonSystemMessages = messages.filter(m => m.role !== 'system');
    for (let i = nonSystemMessages.length - 1; i >= 0; i--) {
      const msg = nonSystemMessages[i];
      const tokens = estimateTotalTokens([msg]);
      if (tokenCount + tokens > maxTokens) break;
      tokenCount += tokens;
      result.unshift(msg);
    }

    return result;
  }

  /**
   * Summarize tool result content
   * Takes first 150 chars + ellipsis + last 50 chars
   */
  private summarizeToolResult(content: string): string {
    if (content.length <= 200) {
      return content;
    }

    const firstPart = content.substring(0, 150).trim();
    const lastPart = content.substring(content.length - 50).trim();

    return `${firstPart}\n...[summarized]...\n${lastPart}`;
  }

  /**
   * Format messages for LLM consumption
   */
  private formatForLLM(messages: Message[], options?: ContextOptions): any[] {
    const keepRecentToolResults = options?.keepRecentToolResults ?? 5;

    // Step 1: Find all tool message indices
    const toolIndices: number[] = [];
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].isToolCall()) {
        toolIndices.push(i);
      }
    }

    // Step 2: Determine which tool messages are "recent" (last N)
    const recentToolIndices = new Set(
      toolIndices.slice(-keepRecentToolResults)
    );

    // Step 3: Process messages
    const formatted: any[] = [];
    let consecutiveToolCount = 0;
    let mergedToolContent: string[] = [];
    let lastToolName: string | undefined;

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const obj = msg.toJSON();

      // Remove sources field (not needed by LLM)
      delete obj.sources;

      // Truncate long messages (non-tool messages)
      if (!msg.isToolCall() && obj.content.length > 2000) {
        obj.content = obj.content.substring(0, 1900) + '\n[truncated]';
      }

      // Handle tool messages
      if (msg.isToolCall()) {
        // Summarize old tool results if content > 200
        if (!recentToolIndices.has(i) && obj.content.length > 200) {
          obj.content = this.summarizeToolResult(obj.content);
        }

        consecutiveToolCount++;
        mergedToolContent.push(obj.content);
        lastToolName = obj.name;

        // Check if next message is also a tool call
        const isLast = i === messages.length - 1;
        const nextIsToolCall = !isLast && messages[i + 1].isToolCall();

        // Flush if this is the last message or next is not a tool call
        if (!nextIsToolCall) {
          if (consecutiveToolCount > 2) {
            // Merge multiple consecutive tool calls
            formatted.push({
              role: 'tool',
              content: mergedToolContent.join('\n---\n'),
              name: 'merged_tools'
            });
          } else {
            // Don't merge if only 1-2 consecutive
            for (const content of mergedToolContent) {
              formatted.push({
                role: 'tool',
                content,
                ...(lastToolName && { name: lastToolName })
              });
            }
          }
          consecutiveToolCount = 0;
          mergedToolContent = [];
          lastToolName = undefined;
        }
      } else {
        formatted.push(obj);
      }
    }

    return formatted;
  }

  /**
   * Format messages for display
   */
  private formatForDisplay(messages: Message[]): any[] {
    return messages.map(m => m.toJSON());
  }

  /**
   * Format messages as raw (no transformations)
   */
  private formatRaw(messages: Message[]): any[] {
    return messages.map(m => m.toJSON());
  }

  /**
   * Initialize metadata from messages
   */
  private initializeMetadata(
    messages: Message[],
    partial?: Partial<ContextMetadata>
  ): ContextMetadata {
    const stats = calculateMessageStats(messages);
    const tokenCount = estimateTotalTokens(messages);

    return {
      totalMessages: messages.length,
      windowSize: messages.length,
      sessionStartTime: messages[0]?.timestamp,
      lastUpdated: messages[messages.length - 1]?.timestamp,
      statistics: stats,
      tokenCount,
      ...partial
    };
  }
}
