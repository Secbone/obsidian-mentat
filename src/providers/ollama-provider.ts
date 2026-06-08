// Ollama Provider - Local AI models (HTTP API)

import { AIProvider, GenerateOptions } from '../types';

export interface OllamaProviderConfig {
  id: string;
  baseURL: string;
  model: string;
  embeddingModel?: string;
  temperature?: number;
  maxTokens?: number;
}

interface OllamaMessage {
  role: string;
  content: string;
}

export class OllamaProvider implements AIProvider {
  id: string;
  name: string;
  type: 'ollama' = 'ollama';
  private config: OllamaProviderConfig;

  constructor(config: OllamaProviderConfig) {
    this.id = config.id;
    this.name = `Ollama (${config.model})`;
    this.config = config;
  }

  async generate(prompt: string, options?: GenerateOptions): Promise<string> {
    try {
      const messages: OllamaMessage[] = [];

      if (options?.systemPrompt) {
        messages.push({
          role: 'system',
          content: options.systemPrompt
        });
      }

      messages.push({
        role: 'user',
        content: prompt
      });

      const response = await fetch(`${this.config.baseURL}/api/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: this.config.model,
          messages,
          stream: false,
          options: {
            temperature: options?.temperature ?? this.config.temperature ?? 0.7,
            num_predict: options?.maxTokens ?? this.config.maxTokens ?? 16384,
            stop: options?.stopSequences
          }
        })
      });

      if (!response.ok) {
        throw new Error(`Ollama API error: ${response.statusText}`);
      }

      const data = await response.json();
      return data.message?.content || '';
    } catch (error: any) {
      console.error('OllamaProvider generate error:', error);
      throw new Error(`Ollama error: ${error.message}`);
    }
  }

  async generateStream(
    prompt: string,
    onChunk: (chunk: string) => void,
    options?: GenerateOptions
  ): Promise<void> {
    try {
      const messages: OllamaMessage[] = [];

      if (options?.systemPrompt) {
        messages.push({
          role: 'system',
          content: options.systemPrompt
        });
      }

      messages.push({
        role: 'user',
        content: prompt
      });

      const response = await fetch(`${this.config.baseURL}/api/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: this.config.model,
          messages,
          stream: true,
          options: {
            temperature: options?.temperature ?? this.config.temperature ?? 0.7,
            num_predict: options?.maxTokens ?? this.config.maxTokens ?? 16384
          }
        })
      });

      if (!response.ok) {
        throw new Error(`Ollama API error: ${response.statusText}`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('No response body');
      }

      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value);
        const lines = chunk.split('\n').filter(line => line.trim());

        for (const line of lines) {
          try {
            const data = JSON.parse(line);
            if (data.message?.content) {
              onChunk(data.message.content);
            }
          } catch (e) {
            // Skip invalid JSON lines
          }
        }
      }
    } catch (error: any) {
      console.error('OllamaProvider generateStream error:', error);
      throw new Error(`Ollama error: ${error.message}`);
    }
  }

  async generateEmbedding(text: string): Promise<{ embedding: number[]; tokens?: number }> {
    try {
      const embeddingModel = this.config.embeddingModel || 'nomic-embed-text';

      const response = await fetch(`${this.config.baseURL}/api/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: embeddingModel,
          prompt: text
        })
      });

      if (!response.ok) {
        throw new Error(`Ollama API error: ${response.statusText}`);
      }

      const data = await response.json();
      return {
        embedding: data.embedding || [],
        tokens: undefined // Ollama doesn't provide token count in response
      };
    } catch (error: any) {
      console.error('OllamaProvider generateEmbedding error:', error);
      throw new Error(`Ollama embedding error: ${error.message}`);
    }
  }

  async embed(text: string): Promise<number[]> {
    const result = await this.generateEmbedding(text);
    return result.embedding;
  }

  async generateEmbeddings(texts: string[]): Promise<{ embeddings: number[][]; tokens?: number }> {
    try {
      const embeddingModel = this.config.embeddingModel || 'nomic-embed-text';

      const response = await fetch(`${this.config.baseURL}/api/embed`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: embeddingModel,
          input: texts
        })
      });

      if (response.ok) {
        const data = await response.json();
        return {
          embeddings: data.embeddings || [],
          tokens: undefined
        };
      }
      
      // Fallback if /api/embed is not supported by older Ollama version
      console.warn('Ollama /api/embed failed, falling back to sequential /api/embeddings:', response.statusText);
      const embeddings: number[][] = [];
      for (const text of texts) {
        const res = await this.generateEmbedding(text);
        embeddings.push(res.embedding);
      }
      return { embeddings };
    } catch (error: any) {
      console.error('OllamaProvider generateEmbeddings error, falling back to sequential:', error);
      try {
        const embeddings: number[][] = [];
        for (const text of texts) {
          const res = await this.generateEmbedding(text);
          embeddings.push(res.embedding);
        }
        return { embeddings };
      } catch (fallbackError: any) {
        throw new Error(`Ollama batch embedding failed: ${fallbackError.message}`);
      }
    }
  }

  async embeds(texts: string[]): Promise<number[][]> {
    const result = await this.generateEmbeddings(texts);
    return result.embeddings;
  }

  async isAvailable(): Promise<boolean> {
    try {
      // Check if the model is available using tags endpoint
      const response = await fetch(`${this.config.baseURL}/api/tags`);

      if (!response.ok) {
        return false;
      }

      const data = await response.json();
      const hasModel = data.models?.some((m: any) =>
        m.name?.includes(this.config.model) ||
        m.model?.includes(this.config.model)
      );

      return hasModel;
    } catch (error) {
      console.error('OllamaProvider availability check failed:', error);
      return false;
    }
  }
}
