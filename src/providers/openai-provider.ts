// OpenAI-compatible API Provider
// Supports OpenAI, DeepSeek, and any OpenAI-compatible endpoints

import { AIProvider, GenerateOptions, GenerateResponse, ChatMessage, ToolCall } from '../types';
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

// OpenAI API max_tokens upper limit
const MAX_TOKENS_UPPER_LIMIT = 393216;

export class OpenAIProvider implements AIProvider {
  id: string;
  name: string;
  type = 'openai' as const;
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
        max_tokens: Math.min(options?.maxTokens ?? this.config.maxTokens ?? 16384, MAX_TOKENS_UPPER_LIMIT),
        stop: options?.stopSequences
      });

      return response.choices[0]?.message?.content || '';
    } catch (error: unknown) {
      console.error('OpenAIProvider generate error:', error);
      throw new Error(`OpenAI API error: ${error instanceof Error ? error.message : String(error)}`);
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
        max_tokens: Math.min(options?.maxTokens ?? this.config.maxTokens ?? 16384, MAX_TOKENS_UPPER_LIMIT),
        stream: true,
        stop: options?.stopSequences
      }, {
        signal: options?.abortSignal
      });

      for await (const chunk of stream) {
        const content = chunk.choices[0]?.delta?.content;
        if (content) {
          onChunk(content);
        }
      }
    } catch (error: unknown) {
      console.error('OpenAIProvider generateStream error:', error);
      throw new Error(`OpenAI API error: ${error instanceof Error ? error.message : String(error)}`);
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
    } catch (error: unknown) {
      console.error('OpenAIProvider generateEmbedding error:', error);
      throw new Error(`OpenAI Embedding error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async embed(text: string): Promise<number[]> {
    const result = await this.generateEmbedding(text);
    return result.embedding;
  }

  async generateEmbeddings(texts: string[]): Promise<{ embeddings: number[][]; tokens?: number }> {
    try {
      if (!this.config.embeddingModel) {
        throw new Error('No embedding model configured for this provider');
      }

      const response = await this.client.embeddings.create({
        model: this.config.embeddingModel,
        input: texts
      });

      return {
        embeddings: response.data.map(d => d.embedding),
        tokens: response.usage?.total_tokens
      };
    } catch (error: unknown) {
      console.error('OpenAIProvider generateEmbeddings error:', error);
      throw new Error(`OpenAI Embeddings error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async embeds(texts: string[]): Promise<number[][]> {
    const result = await this.generateEmbeddings(texts);
    return result.embeddings;
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
    } catch (error: unknown) {
      console.error('OpenAIProvider availability check failed:', error);
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
      const openaiMessages = this.convertMessages(messages);

      // Add systemPrompt if provided
      if (options?.systemPrompt) {
        openaiMessages.unshift({
          role: 'system',
          content: options.systemPrompt
        });
      }

      const requestParams: Record<string, unknown> = {
        model: this.config.model,
        messages: openaiMessages,
        temperature: options?.temperature ?? this.config.temperature ?? 0.7,
        max_tokens: Math.min(options?.maxTokens ?? this.config.maxTokens ?? 16384, MAX_TOKENS_UPPER_LIMIT)
      };

      // Add tools if provided
      if (options?.skills && options.skills.length > 0) {
        requestParams.tools = options.skills.map((skill: unknown) => {
          const s = skill as { name?: string; description?: string; parameters?: Record<string, unknown> };
          return {
            type: 'function',
            function: s
          };
        });

        if (options.toolChoice) {
          requestParams.tool_choice = options.toolChoice;
        }
      }

      const response = await this.client.chat.completions.create(
        requestParams as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming
      );

      const choice = response.choices[0];
      const message = choice.message;

      // Extract tool calls if present
      const toolCalls: ToolCall[] = [];
      if (message.tool_calls) {
        for (const tc of message.tool_calls) {
          toolCalls.push({
            id: tc.id,
            name: tc.function.name.replace(/__/g, ':'),
            arguments: tc.function.arguments
          });
        }
      }

      return {
        content: message.content || '',
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        finishReason: (choice.finish_reason ?? undefined) as GenerateResponse['finishReason'],
        usage: response.usage ? {
          promptTokens: response.usage.prompt_tokens,
          completionTokens: response.usage.completion_tokens,
          totalTokens: response.usage.total_tokens,
          cacheReadTokens: (response.usage as unknown as { prompt_tokens_details?: { cached_tokens?: number } }).prompt_tokens_details?.cached_tokens ?? 0,
          cacheCreationTokens: 0
        } : undefined
      };
    } catch (error: unknown) {
      console.error('OpenAIProvider generateWithSkills error:', error);
      throw new Error(`OpenAI API error: ${error instanceof Error ? error.message : String(error)}`);
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
      const openaiMessages = this.convertMessages(messages);

      // Add systemPrompt if provided
      if (options?.systemPrompt) {
        openaiMessages.unshift({
          role: 'system',
          content: options.systemPrompt
        });
      }

      const requestParams: Record<string, unknown> = {
        model: this.config.model,
        messages: openaiMessages,
        temperature: options?.temperature ?? this.config.temperature ?? 0.7,
        max_tokens: Math.min(options?.maxTokens ?? this.config.maxTokens ?? 16384, MAX_TOKENS_UPPER_LIMIT),
        stream: true,
        stream_options: { include_usage: true }
      };

      // Add tools if provided
      if (options?.skills && options.skills.length > 0) {
        requestParams.tools = options.skills.map((skill: unknown) => {
          const s = skill as { name?: string; description?: string; parameters?: Record<string, unknown> };
          return {
            type: 'function',
            function: s
          };
        });

        if (options.toolChoice) {
          requestParams.tool_choice = options.toolChoice;
        }
      }

      const stream = await this.client.chat.completions.create(requestParams as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming, {
        signal: options?.abortSignal
      }) as unknown as AsyncIterable<{ choices?: Array<{ delta?: { content?: string; tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> }; finish_reason?: string }>; usage?: { completion_tokens?: number; prompt_tokens?: number; total_tokens?: number } }>;
      let fullContent = '';
      const toolCalls: ToolCall[] = [];
      const toolCallsInProgress: Map<number, { id: string; name: string; arguments: string }> = new Map();
      let finishReason: string | undefined;
      let finalUsage: { completion_tokens?: number; prompt_tokens?: number; total_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } | undefined = undefined;

      for await (const chunk of stream) {
        if (chunk.usage) {
          finalUsage = chunk.usage;
        }

        const delta = chunk.choices?.[0]?.delta;

        // Handle content
        if (delta?.content) {
          fullContent += delta.content;
          onChunk(delta.content);
        }

        // Handle tool calls
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const index = tc.index;

            if (!toolCallsInProgress.has(index)) {
              toolCallsInProgress.set(index, {
                id: tc.id || '',
                name: tc.function?.name?.replace(/__/g, ':') || '',
                arguments: ''
              });
            }

            const inProgress = toolCallsInProgress.get(index)!;

            if (tc.id) inProgress.id = tc.id;
            if (tc.function?.name) inProgress.name = tc.function.name.replace(/__/g, ':');
            if (tc.function?.arguments) inProgress.arguments += tc.function.arguments;
          }
        }

        // Handle finish reason
        if (chunk.choices?.[0]?.finish_reason) {
          finishReason = chunk.choices[0].finish_reason;
        }
      }

      // Convert in-progress tool calls to final format
      for (const tc of toolCallsInProgress.values()) {
        const toolCall: ToolCall = {
          id: tc.id,
          name: tc.name,
          arguments: tc.arguments
        };
        toolCalls.push(toolCall);

        // Notify about tool call
        if (onToolCall) {
          onToolCall(toolCall);
        }
      }

      return {
        content: fullContent,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        finishReason: (finishReason ?? undefined) as GenerateResponse['finishReason'],
        usage: finalUsage ? {
          promptTokens: finalUsage.prompt_tokens ?? 0,
          completionTokens: finalUsage.completion_tokens ?? 0,
          totalTokens: finalUsage.total_tokens ?? 0,
          cacheReadTokens: finalUsage.prompt_tokens_details?.cached_tokens ?? 0,
          cacheCreationTokens: 0
        } : undefined
      };
    } catch (error: unknown) {
      console.error('OpenAIProvider generateStreamWithSkills error:', error);
      throw new Error(`OpenAI API error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Convert ChatMessage[] to OpenAI format
   * Filters out system messages (defensive programming - system prompt should be passed via options)
   * Ensures tool_calls / tool response pairing integrity (required by OpenAI-compatible APIs)
   *
   * Handles two types of orphans caused by message truncation:
   * 1. Orphan tool messages: tool response without a preceding assistant that declared the tool_call
   * 2. Orphan assistant tool_calls: assistant declared tool_calls but some/all responses are missing
   */
  private convertMessages(messages: ChatMessage[]): OpenAI.Chat.ChatCompletionMessageParam[] {
    const filtered = messages.filter(msg => msg.role !== 'system');

    // Pre-scan: collect all tool_call_ids that have tool responses
    const respondedToolCallIds = new Set<string>();
    for (const msg of filtered) {
      if (msg.role === 'tool' && msg.tool_call_id) {
        respondedToolCallIds.add(msg.tool_call_id);
      }
    }

    // Forward pass: track declared tool_call IDs and build result
    const seenToolCallIds = new Set<string>();
    const result: OpenAI.Chat.ChatCompletionMessageParam[] = [];

    for (const msg of filtered) {
      if (msg.role === 'assistant' && msg.tool_calls) {
        // Register all declared tool_call IDs
        for (const tc of msg.tool_calls) {
          seenToolCallIds.add(tc.id);
        }

        // Keep only tool_calls that have matching tool responses
        const validToolCalls = msg.tool_calls.filter(tc => respondedToolCallIds.has(tc.id));

        if (validToolCalls.length > 0) {
          result.push({
            role: 'assistant' as const,
            content: msg.content || null,
            tool_calls: validToolCalls.map(tc => ({
              id: tc.id,
              type: 'function' as const,
              function: {
                name: tc.name,
                arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments)
              }
            }))
          });
        } else {
          // All tool_calls are orphans - send as plain assistant message
          result.push({
            role: 'assistant' as const,
            content: msg.content || ''
          });
        }
      } else if (msg.role === 'tool') {
        if (!msg.tool_call_id || !seenToolCallIds.has(msg.tool_call_id)) {
          // Orphan tool message - convert to user message to preserve context
          console.warn('OpenAIProvider: orphan tool message (no matching preceding assistant tool_calls), converting to user message');
          result.push({
            role: 'user' as const,
            content: `[Tool Result${msg.name ? ` (${msg.name})` : ''}]: ${msg.content}`
          });
        } else {
          result.push({
            role: 'tool' as const,
            content: msg.content,
            tool_call_id: msg.tool_call_id
          });
        }
      } else {
        result.push({
          role: msg.role as 'user' | 'assistant',
          content: msg.content
        });
      }
    }

    return result;
  }
}
