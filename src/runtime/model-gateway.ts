import type { AIProvider, ChatMessage, GenerateOptions, GenerateResponse } from '../types';
import type { RunRuntime } from './types';
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
  constructor(private provider: AIProvider) {}
  async generateSimple(messages: ChatMessage[], onChunk: (text: string) => void, options: GenerateOptions, runtime?: RunRuntime): Promise<GenerateResponse> {
    if (this.provider.generateStreamWithSkills && this.provider.supportsSkills?.()) return this.generate(messages, onChunk, { ...options, skills: undefined }, runtime);
    const outputLimit = this.provider.getMaxOutputTokens?.() ?? 16384;
    await runtime?.record('model:requested', { providerId: this.provider.id, outputLimit });
    let content = '', response: GenerateResponse | undefined;
    try {
      await this.provider.generateStream(messages.map(m => `[${m.role}]: ${m.content}`).join('\n\n'), chunk => { content += chunk; onChunk(chunk); }, { ...options, maxTokens: outputLimit, onResponse: result => { response = result; } });
      const result = response || { content };
      result.diagnostics = { ...result.diagnostics, outputLimit };
      await runtime?.modelResult(result);
      return result;
    } catch (error) {
      if (error instanceof ModelResponseError) {
        error.response.diagnostics = { ...error.response.diagnostics, outputLimit };
        await runtime?.modelResult(error.response);
      }
      throw error;
    }
  }

  async generate(messages: ChatMessage[], onChunk: (text: string) => void, options: GenerateOptions, runtime?: RunRuntime): Promise<GenerateResponse> {
    messages = messages.filter(message => !message.metadata?.isSubagent);
    validateToolPairs(messages);
    const configured = this.provider.getMaxOutputTokens?.() ?? 16384;
    const inputEstimate = Compactor.estimateTokens(messages) + Math.ceil((options.systemPrompt?.length || 0) / 2);
    const remaining = this.provider.getContextWindow() - inputEstimate - 256;
    const outputLimit = Math.floor(Math.min(options.maxTokens ?? configured, configured, remaining));
    if (!Number.isFinite(outputLimit) || outputLimit < 1) throw new Error('上下文没有足够输出空间，请压缩后继续。');
    await runtime?.record('model:requested', { providerId: this.provider.id, inputEstimate, outputLimit });
    try {
      const result = await this.provider.generateStreamWithSkills!(messages, onChunk, undefined, { ...options, maxTokens: outputLimit });
      result.diagnostics = { ...result.diagnostics, outputLimit };
      await runtime?.modelResult(result);
      if (result.finishReason === 'length') throw new ModelResponseError('模型输出被长度限制截断，当前进度已保存；请按单个产物拆分后继续。', result);
      return result;
    } catch (error) {
      if (error instanceof ModelResponseError && !error.response.diagnostics?.outputLimit) {
        error.response.diagnostics = { ...error.response.diagnostics, outputLimit };
        await runtime?.modelResult(error.response);
      }
      throw error;
    }
  }
}
