// Type definitions for Personal Agent plugin

import { TFile } from 'obsidian';

// Task types for AI routing
export enum TaskType {
  EMBEDDING = 'embedding',
  CLASSIFICATION = 'classification',
  LINKING = 'linking',
  CHAT = 'chat',
  REVIEW = 'review'
}

// AI Provider interfaces
export interface GenerateOptions {
  maxTokens?: number;
  temperature?: number;
  systemPrompt?: string;
  stopSequences?: string[];
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

  // Embedding methods
  generateEmbedding(text: string): Promise<{
    embedding: number[];
    tokens?: number;
  }>;
  embed(text: string): Promise<number[]>;

  // Health check
  isAvailable(): Promise<boolean>;
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
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  sources?: TFile[];
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
    frontmatter: Record<string, unknown>;
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
