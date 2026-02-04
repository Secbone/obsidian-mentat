// Anthropic Provider - Native Claude API support

import { AIProvider, GenerateOptions, GenerateResponse, ChatMessage, ToolCall } from '../types';
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

  supportsSkills(): boolean {
    return true;
  }

  /**
   * Generate with skills support (non-streaming)
   */
  async generateWithSkills(
    messages: ChatMessage[],
    options?: GenerateOptions
  ): Promise<GenerateResponse> {
    try {
      const anthropicMessages = this.convertMessages(messages);

      const requestParams: any = {
        model: this.config.model,
        max_tokens: options?.maxTokens ?? this.config.maxTokens ?? 4096,
        temperature: options?.temperature ?? this.config.temperature ?? 1.0,
        messages: anthropicMessages
      };

      if (options?.systemPrompt) {
        requestParams.system = options.systemPrompt;
      }

      // Add tools if provided
      if (options?.skills && options.skills.length > 0) {
        requestParams.tools = options.skills;

        if (options.toolChoice && options.toolChoice !== 'auto') {
          requestParams.tool_choice = { type: options.toolChoice };
        }
      }

      const response = await this.client.messages.create(requestParams);

      // Extract content and tool calls
      let content = '';
      const toolCalls: ToolCall[] = [];

      for (const block of response.content) {
        if (block.type === 'text') {
          content += block.text;
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            name: block.name,
            arguments: block.input
          });
        }
      }

      return {
        content,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        finishReason: response.stop_reason as any
      };
    } catch (error) {
      console.error('AnthropicProvider generateWithSkills error:', error);
      throw new Error(`Anthropic API error: ${error.message}`);
    }
  }

  /**
   * Generate with skills support (streaming)
   */
  async generateStreamWithSkills(
    messages: ChatMessage[],
    onChunk: (chunk: string) => void,
    onToolCall?: (toolCall: ToolCall) => void,
    options?: GenerateOptions
  ): Promise<GenerateResponse> {
    try {
      const anthropicMessages = this.convertMessages(messages);

      const requestParams: any = {
        model: this.config.model,
        max_tokens: options?.maxTokens ?? this.config.maxTokens ?? 4096,
        temperature: options?.temperature ?? this.config.temperature ?? 1.0,
        messages: anthropicMessages
      };

      if (options?.systemPrompt) {
        requestParams.system = options.systemPrompt;
      }

      // Add tools if provided
      if (options?.skills && options.skills.length > 0) {
        requestParams.tools = options.skills;

        if (options.toolChoice && options.toolChoice !== 'auto') {
          requestParams.tool_choice = { type: options.toolChoice };
        }
      }

      const stream = await this.client.messages.stream(requestParams);

      let fullContent = '';

      // Stream text content
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          fullContent += event.delta.text;
          onChunk(event.delta.text);
        }
      }

      // Get final message with properly parsed tool calls
      const finalMessage = await stream.finalMessage();

      const toolCalls: ToolCall[] = [];
      for (const block of finalMessage.content) {
        if (block.type === 'tool_use') {
          // Log what we're receiving from the SDK
          console.log('[AnthropicProvider] Tool use block:', {
            id: block.id,
            name: block.name,
            inputType: typeof block.input,
            inputIsString: typeof block.input === 'string',
            inputLength: typeof block.input === 'string' ? (block.input as string).length : 'N/A',
            inputPreview: typeof block.input === 'string'
              ? (block.input as string).substring(0, 200)
              : JSON.stringify(block.input).substring(0, 200)
          });

          const toolCall: ToolCall = {
            id: block.id,
            name: block.name,
            // Arguments can be either string or object - both are handled by downstream parsers
            arguments: block.input
          };
          toolCalls.push(toolCall);

          if (onToolCall) {
            onToolCall(toolCall);
          }
        }
      }

      return {
        content: fullContent,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        finishReason: finalMessage.stop_reason as any
      };
    } catch (error) {
      console.error('AnthropicProvider generateStreamWithSkills error:', error);
      throw new Error(`Anthropic API error: ${error.message}`);
    }
  }

  /**
   * Convert ChatMessage[] to Anthropic format
   */
  private convertMessages(messages: ChatMessage[]): Anthropic.MessageParam[] {
    return messages
      .filter(msg => msg.role !== 'system') // System messages handled separately
      .map(msg => {
        if (msg.role === 'tool') {
          return {
            role: 'user',
            content: [
              {
                type: 'tool_result' as const,
                tool_use_id: msg.tool_call_id!,
                content: msg.content
              }
            ]
          };
        } else if (msg.role === 'assistant' && msg.tool_calls) {
          const content: any[] = [];

          // Add text content if present
          if (msg.content) {
            content.push({
              type: 'text',
              text: msg.content
            });
          }

          // Add tool use blocks
          for (const tc of msg.tool_calls) {
            let input;
            if (typeof tc.arguments === 'string') {
              try {
                input = JSON.parse(tc.arguments);
              } catch (error: any) {
                console.error('[AnthropicProvider convertMessages] Failed to parse tool arguments:', error);
                console.error('[AnthropicProvider convertMessages] Tool name:', tc.name);
                console.error('[AnthropicProvider convertMessages] Arguments length:', tc.arguments.length);
                console.error('[AnthropicProvider convertMessages] Arguments preview:', tc.arguments.substring(0, 500));
                // Try to recover or throw a more informative error
                throw new Error(`Failed to parse tool arguments for ${tc.name}: ${error.message}`);
              }
            } else {
              input = tc.arguments;
            }

            content.push({
              type: 'tool_use',
              id: tc.id,
              name: tc.name,
              input: input
            });
          }

          return {
            role: 'assistant' as const,
            content
          };
        } else {
          return {
            role: msg.role as 'user' | 'assistant',
            content: msg.content
          };
        }
      });
  }
}
