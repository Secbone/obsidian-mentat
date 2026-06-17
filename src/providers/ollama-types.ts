export interface OllamaChatResponse {
  message?: { role: string; content: string };
  done?: boolean;
  model?: string;
  created_at?: string;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
}

export interface OllamaEmbeddingResponse {
  embedding?: number[];
}

export interface OllamaEmbeddingsResponse {
  embeddings?: number[][];
}

export interface OllamaTagsResponse {
  models?: Array<{ name?: string; model?: string; size?: number; modified_at?: string }>;
}

export interface OllamaStreamChunk {
  message?: { role: string; content: string };
  done?: boolean;
}
