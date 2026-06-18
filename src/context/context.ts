/**
 * Context Layer - Collection of messages with metadata
 * Single unified Context class for all context types
 */

import { Message, MessageStatistics, calculateMessageStats, estimateTotalTokens } from './message';
import { parseJson } from '../utils/json-healer';

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
  [key: string]: unknown;  // Allow custom metadata
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
  [key: string]: unknown;  // Allow custom options
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
  toJSON(): { messages: unknown[]; metadata: ContextMetadata } {
    return {
      messages: this.messages.map(m => m.toJSON()),
      metadata: this.metadata
    };
  }

  /**
   * Create from plain object (deserialization)
   */
  static fromJSON(data: { messages: unknown[]; metadata: ContextMetadata }): Context {
    const messages = data.messages.map(m => Message.fromJSON(m as Record<string, unknown>));
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
  ): Array<{role: string; content: string; [key: string]: unknown}> {
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
      // Ensure truncation doesn't leave orphan tool messages at the start
      messages = this.stripLeadingOrphanToolMessages(messages);
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

    // Strip leading orphan tool messages that lost their assistant after truncation
    return this.stripLeadingOrphanToolMessages(result);
  }

  /**
   * Remove leading tool messages that have no preceding assistant with matching tool_calls.
   * Prevents broken tool_calls pairing after message truncation (causes OpenAI API 400 errors).
   */
  private stripLeadingOrphanToolMessages(messages: Message[]): Message[] {
    let start = 0;
    while (start < messages.length && messages[start].isToolCall()) {
      start++;
    }
    return start > 0 ? messages.slice(start) : messages;
  }

  /**
   * Summarize tool result content
   * Intelligently parses and condenses HTML, JSON, and raw text structures
   */
  private summarizeToolResult(content: string): string {
    const trimmed = content.trim();
    if (trimmed.length <= 200) {
      return content;
    }

    // 1. JSON Data detection & extraction
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        const parsed = parseJson<Record<string, unknown>>(trimmed);
        if (parsed && typeof parsed === 'object') {
          const keys = Object.keys(parsed);
          const success = parsed.success !== undefined ? parsed.success : undefined;
          const error = parsed.error || undefined;
          const msg = parsed.message || parsed.msg || undefined;
          const count = Array.isArray(parsed) ? parsed.length : keys.length;

          let summary = `[JSON Data (summarized): ${Array.isArray(parsed) ? 'Array' : 'Object'} with ${count} fields`;
          if (success !== undefined) summary += `, success = ${success}`;
          if (error) summary += `, error = "${String(error).substring(0, 50)}"`;
          if (msg) summary += `, message = "${String(msg).substring(0, 80)}"`;
          summary += `]`;
          return summary;
        }
      } catch (_e) {
        // Fall back to general text/html if JSON parsing fails
      }
    }

    // 2. HTML content detection & structural summary
    const htmlLower = trimmed.toLowerCase();
    if (htmlLower.includes('<html') || htmlLower.includes('<!doctype') || /<[a-z][\s\S]*>/i.test(trimmed)) {
      const titleMatch = trimmed.match(/<title>(.*?)<\/title>/i);
      const title = titleMatch ? titleMatch[1].trim() : 'No Title';
      const paragraphCount = (trimmed.match(/<p\b[^>]*>/gi) || []).length;
      const tableCount = (trimmed.match(/<table\b[^>]*>/gi) || []).length;
      const headingCount = (trimmed.match(/<h[1-6]\b[^>]*>/gi) || []).length;

      return `[HTML Content (summarized) - Title: "${title}", Headings: ${headingCount}, Paragraphs: ${paragraphCount}, Tables: ${tableCount}]`;
    }

    // 3. General Text high-density truncation
    const originalLength = trimmed.length;
    const firstPart = trimmed.substring(0, 180).trim();
    const lastPart = trimmed.substring(trimmed.length - 80).trim();

    return `${firstPart}\n...[summarized] (${originalLength} chars)...\n${lastPart}`;
  }

  /**
   * Format messages for LLM consumption
   */
  private formatForLLM(messages: Message[], options?: ContextOptions): { role: string; content: string; [key: string]: unknown }[] {
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
    const formatted: { role: string; content: string; [key: string]: unknown }[] = [];

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const obj = msg.toJSON();

      // Remove sources field (not needed by LLM)
      delete obj.sources;
      // Remove timestamp field (not needed by LLM API)
      delete obj.timestamp;

      // Truncate long messages (non-tool messages)
      if (!msg.isToolCall() && obj.content.length > 2000) {
        obj.content = obj.content.substring(0, 1900) + '\n[truncated]';
      }

      // Handle tool messages - each must keep its own tool_call_id (required by OpenAI API)
      if (msg.isToolCall()) {
        // Summarize old tool results if content > 200
        if (!recentToolIndices.has(i) && obj.content.length > 200) {
          obj.content = this.summarizeToolResult(obj.content);
        }

        // Build the tool message, always preserving tool_call_id
        const toolMsg: { role: string; content: string; [key: string]: unknown } = {
          role: 'tool',
          content: obj.content,
        };
        if (obj.tool_call_id) {
          toolMsg.tool_call_id = obj.tool_call_id;
        }
        if (obj.name) {
          toolMsg.name = obj.name;
        }
        formatted.push(toolMsg);
      } else {
        formatted.push(obj);
      }
    }

    return formatted;
  }

  /**
   * Format messages for display
   */
  private formatForDisplay(messages: Message[]): { role: string; content: string; [key: string]: unknown }[] {
    return messages.map(m => m.toJSON());
  }

  /**
   * Format messages as raw (no transformations)
   */
  private formatRaw(messages: Message[]): { role: string; content: string; [key: string]: unknown }[] {
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
