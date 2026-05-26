// Type definitions for Personal Agent plugin

import { TFile } from 'obsidian';

// Re-export context types
export {
  ContextOptions,
  ContextMetadata,
  ExportData,
  TokenEstimate,
  CodeBlock,
  FormattedContent
} from '../context/context-types';

// Task types for AI routing
export enum TaskType {
  EMBEDDING = 'embedding',
  CLASSIFICATION = 'classification',
  LINKING = 'linking',
  CHAT = 'chat',
  REVIEW = 'review'
}

// Skill/Tool Call types
export interface ToolCall {
  id: string;
  name: string;
  arguments: string | Record<string, any>;
}

export interface SkillCallMessage {
  role: 'tool' | 'function';
  name: string;
  content: string;
  tool_call_id?: string;
}

// AI Provider interfaces
export interface GenerateOptions {
  maxTokens?: number;
  temperature?: number;
  systemPrompt?: string;
  stopSequences?: string[];
  // Skill support
  skills?: any[]; // OpenAI functions or Anthropic tools
  toolChoice?: 'auto' | 'none' | string;
}

export interface GenerateResponse {
  content: string;
  toolCalls?: ToolCall[];
  finishReason?: 'stop' | 'tool_calls' | 'length';
}

export interface AIProvider {
  id: string;
  name: string;
  type: 'openai' | 'anthropic' | 'ollama';

  // Core methods
  generate(prompt: string, options?: GenerateOptions): Promise<string>;
  generateStream(
    prompt: string,
    onChunk: (chunk: string) => void,
    options?: GenerateOptions
  ): Promise<void>;

  // Skill-enhanced methods
  generateWithSkills?(
    messages: ChatMessage[],
    options?: GenerateOptions
  ): Promise<GenerateResponse>;

  generateStreamWithSkills?(
    messages: ChatMessage[],
    onChunk: (chunk: string) => void,
    onToolCall?: (toolCall: ToolCall) => void,
    options?: GenerateOptions
  ): Promise<GenerateResponse>;

  // Embedding methods
  generateEmbedding(text: string): Promise<{ embedding: number[]; tokens?: number }>;
  embed(text: string): Promise<number[]>;

  // Health check
  isAvailable(): Promise<boolean>;

  // Capabilities
  supportsSkills?(): boolean;
}

// Classification results
export interface ClassificationResult {
  categories: string[];
  tags: string[];
  summary: string;
  keywords: string[];
  confidence: number;
}

// Link suggestion
export interface LinkSuggestion {
  targetFile: TFile;
  score: number;
  reason: string;
  snippets: string[];
  suggestedPosition?: number;
}

// Chat system
export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool' | 'function';
  content: string;
  timestamp: number;
  sources?: TFile[];
  name?: string; // For tool/function messages
  tool_call_id?: string; // For tool response messages
  tool_calls?: ToolCall[]; // For assistant messages with tool calls
}

export interface ChatContext {
  messages: ChatMessage[];
  relevantNotes: TFile[];
  sessionId: string;
}

// Graph visualization
export interface GraphNode {
  id: string;
  name: string;
  group: string;
  val: number;
  metadata: {
    tags: string[];
    categories: string[];
    lastModified: number;
  };
}

export interface GraphLink {
  source: string;
  target: string;
  value: number;
  type: 'explicit' | 'semantic';
}

// Review system
export interface ReviewItem {
  file: TFile;
  nextReviewDate: number;
  interval: number;
  easeFactor: number;
  repetitions: number;
  lastReviewed: number;
}

// Index data structure
export interface FileIndex {
  path: string;
  name: string;
  content: string;
  contentHash: string;
  embedding: number[];
  metadata: {
    tags: string[];
    links: string[];
    headings: string[];
    frontmatter: Record<string, any>;
  };
  stats: {
    wordCount: number;
    charCount: number;
    lastModified: number;
    created: number;
  };
}

// Similarity search result
export interface SimilarityResult {
  file: TFile;
  score: number;
  index: FileIndex;
}

// Skill Invocation Configuration
export type SkillInvocationMode = 'progressive' | 'native' | 'auto';
export type SkillDetailFormat = 'markdown' | 'xml' | 'json';

export interface SkillInvocationConfig {
  mode: SkillInvocationMode;
  detailFormat?: SkillDetailFormat;
  enableCache?: boolean;
  enableDynamicDiscovery?: boolean;
  cacheConfig?: {
    ttl?: number; // Time to live in milliseconds
    maxSize?: number; // Maximum cache entries
  };
  directCallSkills?: string[]; // Custom skills to be called directly in 'auto' mode
}

// Spec Parameters
export interface SpecParams {
  skill_name: string;
}

// Invoke Parameters
export interface InvokeParams {
  skill_name: string;
  params: Record<string, any>;
}
