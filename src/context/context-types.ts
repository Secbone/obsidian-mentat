/**
 * Context types for managing different views of chat message history
 */

import { ChatMessage } from '../types';

/**
 * Configuration options for context retrieval
 */
export interface ContextOptions {
  /** Maximum number of messages to include */
  maxMessages?: number;
  /** Maximum token count (estimated) */
  maxTokens?: number;
  /** Include system messages in context */
  includeSystemMessages?: boolean;
  /** Include tool call messages */
  includeToolCalls?: boolean;
  /** Transform tool calls for optimization */
  transformToolCalls?: boolean;
  /** Strategy to use for context preparation */
  strategy?: string;
  /** Custom filter function */
  filter?: (message: ChatMessage) => boolean;
}

/**
 * Base context window with metadata
 */
export interface ContextWindow {
  /** The messages in this context window */
  messages: ChatMessage[];
  /** Metadata about the context window */
  metadata: ContextMetadata;
}

/**
 * Metadata about a context window
 */
export interface ContextMetadata {
  /** Total number of messages in full history */
  totalMessages: number;
  /** Number of messages in this window */
  windowSize: number;
  /** Strategy used to create this window */
  strategy: string;
  /** Estimated token count */
  tokenCount?: number;
  /** Time range of messages */
  timeRange?: {
    start: number;
    end: number;
  };
  /** Whether the context was truncated */
  isTruncated?: boolean;
}

/**
 * Context optimized for LLM consumption
 */
export interface LLMContext extends ContextWindow {
  /** Messages optimized for LLM */
  messages: ChatMessage[];
  /** LLM-specific metadata */
  metadata: ContextMetadata & {
    /** Whether tool calls were compressed */
    toolCallsCompressed?: boolean;
    /** Number of messages filtered out */
    messagesFiltered?: number;
    /** Optimization applied */
    optimizations?: string[];
  };
}

/**
 * Context enhanced for UI display
 */
export interface DisplayContext extends ContextWindow {
  /** Messages enhanced with display metadata */
  messages: DisplayMessage[];
  /** Display-specific metadata */
  metadata: ContextMetadata & {
    /** Message groups for UI rendering */
    messageGroups?: MessageGroup[];
    /** Whether messages are grouped */
    isGrouped?: boolean;
  };
}

/**
 * Message enhanced with display metadata
 */
export interface DisplayMessage extends ChatMessage {
  /** Display-specific metadata */
  _display?: {
    /** Human-readable timestamp */
    timestamp: string;
    /** Position in message list */
    isFirst: boolean;
    isLast: boolean;
    /** Tool call information */
    hasToolCalls: boolean;
    toolCallCount: number;
    toolCallStatus?: 'pending' | 'success' | 'error';
    /** Error detection */
    isError: boolean;
    errorType?: string;
    /** Formatting hints */
    codeBlockCount: number;
    hasLinks: boolean;
    hasSources: boolean;
    /** Truncation info */
    isTruncated: boolean;
    originalLength: number;
    /** Streaming status */
    isStreaming?: boolean;
    /** Copy button placeholders */
    copyButtons?: Array<{ id: string; copied: boolean }>;
  };
}

/**
 * Group of related messages
 */
export interface MessageGroup {
  /** Unique identifier for the group */
  id: string;
  /** Messages in this group */
  messages: DisplayMessage[];
  /** Group timestamp (from first message) */
  timestamp: number;
  /** Group type */
  type?: 'conversation' | 'tool-sequence' | 'error-sequence';
}

/**
 * Raw unmodified context
 */
export interface RawContext extends ContextWindow {
  /** Complete unmodified message history */
  messages: ChatMessage[];
  /** Raw context metadata */
  metadata: ContextMetadata & {
    /** Session information */
    sessionId?: string;
    sessionStartTime?: number;
    lastUpdated?: number;
    /** Statistics */
    userMessageCount: number;
    assistantMessageCount: number;
    toolCallCount: number;
    errorCount: number;
    /** Export metadata */
    exportFormat: 'raw';
    version: string;
    includesToolCalls: boolean;
    includesSources: boolean;
    includesTimestamps: boolean;
  };
}

/**
 * Code block information for display
 */
export interface CodeBlock {
  /** Programming language */
  language: string;
  /** Code content */
  code: string;
  /** Start position in original content */
  startIndex: number;
  /** End position in original content */
  endIndex: number;
}

/**
 * Formatted content with code blocks
 */
export interface FormattedContent {
  /** Original content */
  original: string;
  /** Extracted code blocks */
  codeBlocks: CodeBlock[];
  /** Whether content has code */
  hasCode: boolean;
}

/**
 * Data structure for export/import
 */
export interface ExportData {
  /** Export format version */
  version: string;
  /** Export timestamp */
  exported: number;
  /** Session metadata */
  session: Record<string, any>;
  /** Message history */
  messages: ChatMessage[];
  /** Data integrity checksum */
  checksum?: string;
}

/**
 * Strategy for preparing context windows
 */
export interface ContextStrategy {
  /** Strategy name */
  name: string;

  /**
   * Prepare messages according to strategy
   * @param messages Full message history
   * @param options Context options
   * @returns Prepared context window
   */
  prepare(messages: ChatMessage[], options?: ContextOptions): Promise<ContextWindow>;

  /**
   * Estimate token count for messages
   * @param messages Messages to estimate
   * @returns Estimated token count
   */
  estimateTokens(messages: ChatMessage[]): number;

  /**
   * Validate if strategy can handle the options
   * @param options Context options
   * @returns Whether strategy is valid for options
   */
  validate?(options: ContextOptions): boolean;
}

/**
 * Context manager configuration
 */
export interface ContextManagerConfig {
  /** Default strategy name */
  defaultStrategy?: string;
  /** Default options for LLM context */
  llmDefaults?: ContextOptions;
  /** Default options for display context */
  displayDefaults?: ContextOptions;
  /** Available strategies */
  strategies?: Map<string, ContextStrategy>;
  /** Whether to cache prepared contexts */
  enableCache?: boolean;
  /** Cache TTL in milliseconds */
  cacheTTL?: number;
}

/**
 * Token estimation result
 */
export interface TokenEstimate {
  /** Estimated token count */
  count: number;
  /** Estimation method used */
  method: 'exact' | 'approximate' | 'character-based';
  /** Confidence level (0-1) */
  confidence: number;
}