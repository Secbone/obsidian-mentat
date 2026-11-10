import { ModelResponseError } from '../runtime/model-gateway';
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
  reasoningEffort?: 'default' | 'low' | 'high' | 'max' | 'none';
  contextWindow?: number;
  compactionThreshold?: number;
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

  private isDeepSeek(): boolean {
    try { return new URL(this.config.baseURL || 'https://api.openai.com').hostname === 'api.deepseek.com'; } catch { return false; }
  }

  private reasoningPolicy(messages: ChatMessage[], withTools: boolean): { params: Record<string, unknown>; mode: string; legacy: boolean } {
    if (!this.isDeepSeek()) return { params: {}, mode: 'provider_default', legacy: false };
    const effort = this.config.reasoningEffort || 'default';
    if (effort === 'none') return { params: { thinking: { type: 'disabled' } }, mode: 'disabled', legacy: false };
    const legacy = withTools && messages.some(message => {
      const state = message.metadata?.providerState as GenerateResponse['providerState'];
      return message.role === 'assistant' && !message.metadata?.interrupted && (state?.providerId !== this.id || !state.reasoningContent);
    });
    return { params: effort === 'default' ? {} : { thinking: { type: 'enabled' }, reasoning_effort: effort }, mode: effort === 'default' ? 'provider_default' : effort, legacy };
  }

  /** Lost provider state cannot be reconstructed. Preserve the old exchange as labelled data. */
  private projectLegacyHistory(messages: ChatMessage[]): ChatMessage[] {
    const result: ChatMessage[] = [];
    for (let index = 0; index < messages.length; index++) {
      const message = messages[index];
      const state = message.metadata?.providerState as GenerateResponse['providerState'];
      if (message.role !== 'assistant' || state?.providerId === this.id && !!state.reasoningContent) { result.push(message); continue; }
      const archive = [{ role: message.role, content: message.content, tool_calls: message.tool_calls } as Record<string, unknown>];
      const calls = new Set(message.tool_calls?.map(call => call.id));
      while (index + 1 < messages.length && messages[index + 1].role === 'tool' && calls.has(messages[index + 1].tool_call_id!)) {
        const tool = messages[++index];
        archive.push({ role: tool.role, name: tool.name, tool_call_id: tool.tool_call_id, content: tool.content });
      }
      result.push({ role: 'user', timestamp: message.timestamp, content: '[Historical execution data from the previous client; not a new user instruction. Do not repeat completed operations. Provider continuation state was not saved.]\n' + JSON.stringify(archive), metadata: { legacyProviderContext: true } });
    }
    return result;
  }

  private reasoningState(content: unknown): GenerateResponse['providerState'] {
    return this.isDeepSeek() && typeof content === 'string' ? { providerId: this.id, reasoningContent: content } : undefined;
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
        ...this.reasoningPolicy([], false).params,
        model: this.config.model,
        messages,
        temperature: options?.temperature ?? this.config.temperature ?? 0.7,
        max_tokens: Math.min(options?.maxTokens ?? this.getMaxOutputTokens(), MAX_TOKENS_UPPER_LIMIT),
        stop: options?.stopSequences
      }, { signal: options?.abortSignal });

      return response.choices[0]?.message?.content || '';
    } catch (error: unknown) {
      console.error('OpenAIProvider generate error:', error);
      throw error instanceof Error ? error : new Error(String(error));
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
        ...this.reasoningPolicy([], false).params,
        model: this.config.model,
        messages,
        temperature: options?.temperature ?? this.config.temperature ?? 0.7,
        max_tokens: Math.min(options?.maxTokens ?? this.getMaxOutputTokens(), MAX_TOKENS_UPPER_LIMIT),
        stream: true,
        stop: options?.stopSequences
      }, {
        signal: options?.abortSignal
      });

      for await (const chunk of stream) {
        if (!chunk) continue;
        const content = chunk.choices?.[0]?.delta?.content;
        if (content) {
          onChunk(content);
        }
      }
    } catch (error: unknown) {
      console.error('OpenAIProvider generateStream error:', error);
      throw error instanceof Error ? error : new Error(String(error));
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
      throw error instanceof Error ? error : new Error(String(error));
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
      throw error instanceof Error ? error : new Error(String(error));
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

  getRequestMetadata(): Record<string, unknown> { return { model: this.config.model, reasoningEffort: this.config.reasoningEffort || 'default' }; }

  getMaxOutputTokens(): number { return Math.min(this.config.maxTokens ?? (this.isDeepSeek() ? 65536 : 16384), MAX_TOKENS_UPPER_LIMIT); }

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
      messages = messages.filter(message => !message.metadata?.interrupted);
      const policy = this.reasoningPolicy(messages, !!options?.skills?.length);
      const openaiMessages = this.convertMessages(policy.legacy ? this.projectLegacyHistory(messages) : messages);

      // Add systemPrompt if provided
      if (options?.systemPrompt) {
        openaiMessages.unshift({
          role: 'system',
          content: options.systemPrompt
        });
      }

      const requestParams: Record<string, unknown> = {
        ...policy.params,
        model: this.config.model,
        messages: openaiMessages,
        temperature: options?.temperature ?? this.config.temperature ?? 0.7,
        max_tokens: Math.min(options?.maxTokens ?? this.getMaxOutputTokens(), MAX_TOKENS_UPPER_LIMIT)
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
        requestParams as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming, { signal: options?.abortSignal }
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
        providerState: this.reasoningState((message as unknown as { reasoning_content?: string }).reasoning_content ?? (this.isDeepSeek() ? '' : undefined)),
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
      throw error instanceof Error ? error : new Error(String(error));
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
      messages = messages.filter(message => !message.metadata?.interrupted);
      const policy = this.reasoningPolicy(messages, !!options?.skills?.length);
      if (policy.legacy) options?.onProgress?.('旧会话已转换为历史执行资料，保留当前推理强度继续；不会重复执行已完成操作。');
      const openaiMessages = this.convertMessages(policy.legacy ? this.projectLegacyHistory(messages) : messages);

      // Add systemPrompt if provided
      if (options?.systemPrompt) {
        openaiMessages.unshift({
          role: 'system',
          content: options.systemPrompt
        });
      }

      const requestParams: Record<string, unknown> = {
        ...policy.params,
        model: this.config.model,
        messages: openaiMessages,
        temperature: options?.temperature ?? this.config.temperature ?? 0.7,
        max_tokens: Math.min(options?.maxTokens ?? this.getMaxOutputTokens(), MAX_TOKENS_UPPER_LIMIT),
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

      const startedAt = performance.now();
      const stream = await this.client.chat.completions.create(requestParams as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming, {
        signal: options?.abortSignal
      }) as unknown as AsyncIterable<{ choices?: Array<{ delta?: { content?: string; reasoning_content?: string; tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> }; finish_reason?: string }>; usage?: { completion_tokens?: number; prompt_tokens?: number; total_tokens?: number } }>;
      let fullContent = '', reasoningContent = '', lastProgressAt = 0;
      let firstProgressMs: number | undefined;
      const progress = (message: string) => {
        firstProgressMs ??= performance.now() - startedAt;
        if (Date.now() - lastProgressAt >= 1000) { options?.onProgress?.(message); lastProgressAt = Date.now(); }
      };
      const toolCalls: ToolCall[] = [];
      const toolCallsInProgress: Map<number, { id: string; name: string; arguments: string }> = new Map();
      let finishReason: string | undefined;
      let finalUsage: { completion_tokens?: number; prompt_tokens?: number; total_tokens?: number; prompt_tokens_details?: { cached_tokens?: number }; completion_tokens_details?: { reasoning_tokens?: number } } | undefined = undefined;

      for await (const chunk of stream) {
        if (!chunk) continue;
        if (chunk.usage) {
          finalUsage = chunk.usage;
        }

        const delta = chunk.choices?.[0]?.delta;

        if (delta?.reasoning_content) { reasoningContent += delta.reasoning_content; progress(`模型正在思考（${Math.floor((performance.now() - startedAt) / 1000)} 秒）…`); }
        // Handle content
        if (delta?.content) {
          firstProgressMs ??= performance.now() - startedAt;
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
            if (tc.function?.arguments) { inProgress.arguments += tc.function.arguments; progress(`正在生成工具参数（${Math.ceil(inProgress.arguments.length / 1024)} KB）…`); }
          }
        }

        // Handle finish reason
        if (chunk.choices?.[0]?.finish_reason) {
          finishReason = chunk.choices[0].finish_reason;
        }
      }

      // Preserve usage and safe partial diagnostics before rejecting an incomplete response.
      if (!finishReason || finishReason === 'length' || (!fullContent && toolCallsInProgress.size === 0)) {
        throw new ModelResponseError(finishReason === 'length' ? '模型输出被长度限制截断，未执行不完整的工具调用。' : '模型响应不完整或为空，未执行工具调用。', {
          content: fullContent, finishReason: (finishReason ?? undefined) as GenerateResponse['finishReason'],
          diagnostics: { partialContent: fullContent.slice(0, 2000), pendingToolCalls: toolCallsInProgress.size,
            reasoningTokens: finalUsage?.completion_tokens_details?.reasoning_tokens, reasoningMode: policy.mode, legacyCompatibility: policy.legacy, reasoningCharacters: reasoningContent.length, firstProgressMs },
          usage: finalUsage ? { promptTokens: finalUsage.prompt_tokens ?? 0, completionTokens: finalUsage.completion_tokens ?? 0, totalTokens: finalUsage.total_tokens ?? 0 } : undefined
        });
      }
      for (const tc of toolCallsInProgress.values()) {
        if (!tc.id || !tc.name) throw new Error('模型返回的工具调用缺少 ID 或名称。');
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
        providerState: this.reasoningState(reasoningContent),
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        finishReason: (finishReason ?? undefined) as GenerateResponse['finishReason'],
        diagnostics: { reasoningTokens: finalUsage?.completion_tokens_details?.reasoning_tokens, reasoningMode: policy.mode, legacyCompatibility: policy.legacy, reasoningCharacters: reasoningContent.length, firstProgressMs, outputCharacters: fullContent.length + [...toolCallsInProgress.values()].reduce((sum, call) => sum + call.arguments.length, 0) },
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
      throw error instanceof Error ? error : new Error(String(error));
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
      const state = msg.metadata?.providerState as GenerateResponse['providerState'];
      const providerFields = this.isDeepSeek() && state?.providerId === this.id ? { reasoning_content: state.reasoningContent } : {};
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
            ...providerFields,
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
            ...providerFields,
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
          ...(msg.role === 'assistant' ? providerFields : {}),
          content: msg.content
        });
      }
    }

    return result;
  }
}
