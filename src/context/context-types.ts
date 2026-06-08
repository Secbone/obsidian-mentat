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
  /** Custom filter function */
  filter?: (message: ChatMessage) => boolean;
  /** Transform tool calls */
  transformToolCalls?: boolean;
  [key: string]: any;
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
  strategy?: string;
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
