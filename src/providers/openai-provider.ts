// OpenAI-compatible API Provider
// Supports OpenAI, DeepSeek, and any OpenAI-compatible endpoints

import { AIProvider, GenerateOptions, GenerateResponse, ChatMessage, ToolCall } from '../types';
import OpenAI from 'openai';
import { obsidianFetch } from '../obsidian/obsidian-fetch';
import { convertToOpenAIMessages } from './openai-messages';

export interface OpenAIProviderConfig {
  id: string;
  apiKey: string;
  baseURL: string;
  model: string;
  embeddingModel?: string;
  temperature?: number;
  maxTokens?: number;
  contextWindow?: number;
  compactionThreshold?: number;
  /** Optional logger to record errors (e.g. ctx.logger.get('provider:<id>')). */
  logger?: (error: unknown, stage: string) => void;
}

// OpenAI API max_tokens upper limit
const MAX_TOKENS_UPPER_LIMIT = 393216;


/** Format an OpenAI SDK error, expanding the underlying network cause. */
function formatOpenAIError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const anyErr = error as { cause?: unknown; status?: number; code?: string; request?: unknown };
  const parts = [error.message];
  if (typeof anyErr.code === 'string' && anyErr.code !== 'undefined') parts.push(`code=${anyErr.code}`);
  if (typeof anyErr.status === 'number') parts.push(`status=${anyErr.status}`);
  if (anyErr.cause instanceof Error && anyErr.cause.message && anyErr.cause.message !== error.message) {
    parts.push(`cause=${anyErr.cause.message}`);
  }
  return parts.join(' | ');
}

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
      dangerouslyAllowBrowser: true, // Required for Obsidian plugin environment
      // Prefer the native global fetch — it supports SSE streaming (SDK
      // requests stream:true) and now works once the broken proxy is cleared.
      // obsidianFetch (requestUrl) is only a fallback for when fetch itself
      // is unavailable; requestUrl cannot stream SSE and causes
      // 'net::ERR_INVALID_ARGUMENT' on stream:true responses.
      fetch: (...args: Parameters<typeof fetch>) => {
        try { return globalThis.fetch(args[0] as never, args[1] as RequestInit); }
        catch { return obsidianFetch(args[0] as string, args[1] as RequestInit); }
      },
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
      this.config.logger?.(error, 'generate');
      throw new Error(`OpenAI API error: ${formatOpenAIError(error)}`);
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
      this.config.logger?.(error, 'generateStream');
      throw new Error(`OpenAI API error: ${formatOpenAIError(error)}`);
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
      this.config.logger?.(error, 'generateEmbedding');
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
      this.config.logger?.(error, 'generateEmbeddings');
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

  private static CONTEXT_WINDOWS: [string, number][] = [
    ['gpt-4-turbo', 128000],
    ['gpt-4o-mini', 128000],
    ['gpt-4o', 128000],
    ['gpt-4', 8192],
    ['gpt-3.5-turbo', 16384],
    ['o1', 200000],
    ['o3', 200000],
    ['deepseek-reasoner', 65536],
    ['deepseek-chat', 65536],
    ['deepseek', 128000],
  ];

  getContextWindow(): number {
    if (this.config.contextWindow) return this.config.contextWindow;
    const model = this.config.model.toLowerCase();
    for (const [prefix, size] of OpenAIProvider.CONTEXT_WINDOWS) {
      if (model.startsWith(prefix)) return size;
    }
    return 8192;
  }

  getCompactionThreshold(): number {
    return this.config.compactionThreshold ?? 0.8;
  }

  /**
   * Generate with skills support (non-streaming)
   */
  async generateWithSkills(
    messages: ChatMessage[],
    options?: GenerateOptions
  ): Promise<GenerateResponse> {
    try {
      const openaiMessages = convertToOpenAIMessages(messages);

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
      this.config.logger?.(error, 'generateWithSkills');
      throw new Error(`OpenAI API error: ${formatOpenAIError(error)}`);
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
      const openaiMessages = convertToOpenAIMessages(messages);

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

      // Diagnostic: log the full request payload for architecture comparison.
      const _diagTools = ((requestParams.tools as Array<{function?: {name?: string; parameters?: unknown}}>) ?? []).map(
        (t) => ({ name: t.function?.name, params: t.function?.parameters })
      );
      const _diagSystem = ((requestParams.messages as Array<{role?: string; content?: string}>)[0]?.role === 'system')
        ? (requestParams.messages as Array<{content?: string}>)[0]?.content
        : undefined;
      console.log('[LLM-REQUEST]', JSON.stringify({
        model: this.config.model,
        systemPrompt: _diagSystem?.slice(0, 2000),
        messageCount: openaiMessages.length,
        messageRoles: openaiMessages.map((m) => m.role),
        messages: openaiMessages.map((m) => ({
          role: m.role,
          content: typeof m.content === 'string' ? m.content.slice(0, 500) : m.content,
          ...(m.role === 'tool' ? { tool_call_id: (m as {tool_call_id?: string}).tool_call_id } : {}),
          ...(m.role === 'assistant' && (m as {tool_calls?: unknown[]}).tool_calls ? { has_tool_calls: true } : {}),
        })),
        tools: _diagTools,
      }));

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
      this.config.logger?.(error, 'generateStreamWithSkills');
      throw new Error(`OpenAI API error: ${formatOpenAIError(error)}`);
    }
  }

}
