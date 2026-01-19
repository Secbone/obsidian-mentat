// OpenAI-compatible API Provider
// Supports OpenAI, DeepSeek, and any OpenAI-compatible endpoints

import { AIProvider, GenerateOptions } from '../types';
import OpenAI from 'openai';

export interface OpenAIProviderConfig {
  id: string;
  apiKey: string;
  baseURL: string;
  model: string;
  embeddingModel?: string;
  temperature?: number;
  maxTokens?: number;
}

export class OpenAIProvider implements AIProvider {
  id: string;
  name: string;
  type: 'openai' = 'openai';
  private client: OpenAI;
  private config: OpenAIProviderConfig;

  constructor(config: OpenAIProviderConfig) {
    this.id = config.id;
    this.name = `OpenAI (${config.model})`;
    this.config = config;

    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      dangerouslyAllowBrowser: true // Required for Obsidian plugin environment
    });
  }

  async generate(prompt: string, options?: GenerateOptions): Promise<string> {
    try {
      const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];

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

      const response = await this.client.chat.completions.create({
        model: this.config.model,
        messages,
        temperature: options?.temperature ?? this.config.temperature ?? 0.7,
        max_tokens: options?.maxTokens ?? this.config.maxTokens ?? 2048,
        stop: options?.stopSequences
      });

      return response.choices[0]?.message?.content || '';
    } catch (error) {
      console.error('OpenAIProvider generate error:', error);
      throw new Error(`OpenAI API error: ${error.message}`);
    }
  }

  async generateStream(
    prompt: string,
    onChunk: (chunk: string) => void,
    options?: GenerateOptions
  ): Promise<void> {
    try {
      const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];

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

      const stream = await this.client.chat.completions.create({
        model: this.config.model,
        messages,
        temperature: options?.temperature ?? this.config.temperature ?? 0.7,
        max_tokens: options?.maxTokens ?? this.config.maxTokens ?? 2048,
        stream: true,
        stop: options?.stopSequences
      });

      for await (const chunk of stream) {
        const content = chunk.choices[0]?.delta?.content;
        if (content) {
          onChunk(content);
        }
      }
    } catch (error) {
      console.error('OpenAIProvider generateStream error:', error);
      throw new Error(`OpenAI API error: ${error.message}`);
    }
  }

  async generateEmbedding(text: string): Promise<{ embedding: number[]; tokens?: number }> {
    try {
      if (!this.config.embeddingModel) {
        throw new Error('No embedding model configured for this provider');
      }

      const response = await this.client.embeddings.create({
        model: this.config.embeddingModel,
        input: text
      });

      return {
        embedding: response.data[0].embedding,
        tokens: response.usage?.total_tokens
      };
    } catch (error) {
      console.error('OpenAIProvider generateEmbedding error:', error);
      throw new Error(`OpenAI Embedding error: ${error.message}`);
    }
  }

  async embed(text: string): Promise<number[]> {
    const result = await this.generateEmbedding(text);
    return result.embedding;
  }

  async isAvailable(): Promise<boolean> {
    try {
      // Test with a simple completion
      await this.client.chat.completions.create({
        model: this.config.model,
        messages: [{ role: 'user', content: 'test' }],
        max_tokens: 5
      });
      return true;
    } catch (error) {
      console.error('OpenAIProvider availability check failed:', error);
      return false;
    }
  }
}
