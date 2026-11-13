import { abortable, errorDetails, throwIfAborted } from '../utils/execution';
import type { AIProvider, ChatMessage, GenerateOptions, GenerateResponse } from '../types';
import type { RunRuntime } from './types';
import type { ChatModel } from '../contracts/model';
import { asChatModel, normalizeTools } from '../providers/model-adapters';
import { Compactor } from '../agents/compactor';

export class ModelResponseError extends Error {
  constructor(message: string, readonly response: GenerateResponse) { super(message); this.name = 'ModelResponseError'; }
}

/** Keep assistant tool requests and their responses in the same context unit. */
export function recentMessageUnit(messages: ChatMessage[], count: number): ChatMessage[] {
  let start = Math.max(0, messages.length - count);
  while (start > 0 && messages[start]?.role === 'tool') start--;
  return messages.slice(start);
}
export function validateToolPairs(messages: ChatMessage[]): void {
  const pending = new Set<string>();
  for (const message of messages) {
    if (message.role === 'tool') {
      if (!message.tool_call_id || !pending.delete(message.tool_call_id)) throw new Error('上下文包含未配对或重复的工具结果，请从完整检查点恢复。');
    } else {
      if (pending.size) throw new Error('上下文缺少工具结果，请先完成或核对待处理操作。');
      for (const call of message.tool_calls || []) {
        if (pending.has(call.id)) throw new Error('上下文包含重复的工具调用 ID');
        pending.add(call.id);
      }
    }
  }
  if (pending.size) throw new Error('上下文缺少工具结果，禁止提交不完整请求。');
}
export class ModelGateway {
  private model: ChatModel;
  constructor(provider: AIProvider | ChatModel) { this.model = asChatModel(provider); }
  private progress(onChunk: (text: string) => void, options: GenerateOptions, runtime: RunRuntime | undefined, requestId: string, start: number) {
    let firstProgressMs: number | undefined;
    const mark = () => {
      if (firstProgressMs !== undefined) return;
      firstProgressMs = performance.now() - start;
      runtime?.observe?.('model:first_progress', { requestId, elapsedMs: firstProgressMs });
    };
    const timer = runtime?.observe ? setInterval(() => runtime.observe?.('model:progress', { requestId, elapsedMs: performance.now() - start,
      phase: firstProgressMs === undefined ? 'waiting_for_response' : 'receiving' }), 10000) : undefined;
    return {
      chunk: (text: string) => { mark(); onChunk(text); },
      options: { ...options, onProgress: (message: string) => { mark(); options.onProgress?.(message); } },
      finish: () => { if (timer) clearInterval(timer); },
    };
  }
  async generateSimple(messages: ChatMessage[], onChunk: (text: string) => void, options: GenerateOptions, runtime?: RunRuntime): Promise<GenerateResponse> {
    return this.generate(messages, onChunk, { ...options, skills: undefined }, runtime);
  }

  async generate(messages: ChatMessage[], onChunk: (text: string) => void, options: GenerateOptions, runtime?: RunRuntime): Promise<GenerateResponse> {
    messages = messages.filter(message => !message.metadata?.isSubagent && !message.metadata?.interrupted);
    validateToolPairs(messages);
    const configured = this.model.maxOutputTokens;
    const tools = normalizeTools(options.skills);
    if (tools.length && !this.model.capabilities.tools) throw new Error('当前模型不支持工具调用');
    const inputEstimate = Compactor.estimateTokens(messages) + Math.ceil(((options.systemPrompt?.length || 0) + JSON.stringify(tools).length) / 2);
    const remaining = this.model.contextWindow - inputEstimate - 256;
    const outputLimit = Math.floor(Math.min(options.maxTokens ?? configured, configured, remaining));
    if (!Number.isFinite(outputLimit) || outputLimit < 1) throw new Error('上下文没有足够输出空间，请压缩后继续。');
    const requestId = `model-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const startedAt = performance.now();
    await runtime?.record('model:requested', { requestId, providerId: this.model.id, requestConfig: this.model.requestMetadata(), inputEstimate, outputLimit });
    const progress = this.progress(onChunk, options, runtime, requestId, startedAt);
    try {
      const result = await abortable(this.model.stream({ ...options, messages, tools, maxTokens: outputLimit }, event => {
        if (options.abortSignal?.aborted) return;
        if (event.type === 'text') progress.chunk(event.text); else progress.options.onProgress(event.message);
      }, options.abortSignal), options.abortSignal);
      throwIfAborted(options.abortSignal);
      if (!result.finishReason) throw new ModelResponseError('模型响应缺少结束标识，禁止执行不完整工具调用。', result);
      result.diagnostics = { ...result.diagnostics, outputLimit, requestId, elapsedMs: performance.now() - startedAt };
      await runtime?.modelResult(result);
      if (result.finishReason === 'length') throw new ModelResponseError('模型输出被长度限制截断，当前进度已保存；请按单个产物拆分后继续。', result);
      return result;
    } catch (error) {
      if (error instanceof ModelResponseError && !error.response.diagnostics?.outputLimit) {
        error.response.diagnostics = { ...error.response.diagnostics, outputLimit, requestId, elapsedMs: performance.now() - startedAt };
        await runtime?.modelResult(error.response);
      } else if (!(error instanceof ModelResponseError)) {
        await runtime?.record('model:failed', { requestId, elapsedMs: performance.now() - startedAt, error: errorDetails(error) });
      }
      throw error;
    } finally { progress.finish(); }
  }
}
