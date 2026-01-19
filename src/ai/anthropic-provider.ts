// Anthropic Provider - Native Claude API support

import { AIProvider, GenerateOptions } from '../types';
import Anthropic from '@anthropic-ai/sdk';

export interface AnthropicProviderConfig {
  id: string;
  apiKey: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
}

export class AnthropicProvider implements AIProvider {
  id: string;
  name: string;
  type: 'anthropic' = 'anthropic';
  private client: Anthropic;
  private config: AnthropicProviderConfig;

  constructor(config: AnthropicProviderConfig) {
    this.id = config.id;
    this.name = `Anthropic (${config.model})`;
    this.config = config;

    this.client = new Anthropic({
      apiKey: config.apiKey,
      dangerouslyAllowBrowser: true // Required for Obsidian plugin environment
    });
  }

  async generate(prompt: string, options?: GenerateOptions): Promise<string> {
    try {
      const message = await this.client.messages.create({
        model: this.config.model,
        max_tokens: options?.maxTokens ?? this.config.maxTokens ?? 4096,
        temperature: options?.temperature ?? this.config.temperature ?? 1.0,
        system: options?.systemPrompt,
        messages: [
          {
            role: 'user',
            content: prompt
          }
        ]
      });

      // Extract text content from the response
      const textContent = message.content.find(block => block.type === 'text');
      return textContent ? textContent.text : '';
    } catch (error) {
      console.error('AnthropicProvider generate error:', error);
      throw new Error(`Anthropic API error: ${error.message}`);
    }
  }

  async generateStream(
    prompt: string,
    onChunk: (chunk: string) => void,
    options?: GenerateOptions
  ): Promise<void> {
    try {
      const stream = await this.client.messages.stream({
        model: this.config.model,
        max_tokens: options?.maxTokens ?? this.config.maxTokens ?? 4096,
        temperature: options?.temperature ?? this.config.temperature ?? 1.0,
        system: options?.systemPrompt,
        messages: [
          {
            role: 'user',
            content: prompt
          }
        ]
      });

      for await (const event of stream) {
        if (event.type === 'content_block_delta' &&
            event.delta.type === 'text_delta') {
          onChunk(event.delta.text);
        }
      }
    } catch (error) {
      console.error('AnthropicProvider generateStream error:', error);
      throw new Error(`Anthropic API error: ${error.message}`);
    }
  }

  async generateEmbedding(text: string): Promise<{ embedding: number[]; tokens?: number }> {
    // Anthropic doesn't provide embedding endpoints
    // Users should use Ollama or OpenAI for embeddings
    throw new Error('Anthropic does not support embeddings. Please use Ollama or OpenAI for embedding tasks.');
  }

  async embed(text: string): Promise<number[]> {
    const result = await this.generateEmbedding(text);
    return result.embedding;
  }

  async isAvailable(): Promise<boolean> {
    try {
      // Test with a minimal message
      await this.client.messages.create({
        model: this.config.model,
        max_tokens: 10,
        messages: [
          {
            role: 'user',
            content: 'test'
          }
        ]
      });
      return true;
    } catch (error) {
      console.error('AnthropicProvider availability check failed:', error);
      return false;
    }
  }
}
