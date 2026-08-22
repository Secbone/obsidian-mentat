import type { PluginObject, Context } from '../core/cordis';
import type { ChatMessage } from '../types';

export interface ContextWindowOptions {
  maxTokens?: number;
  budgetRatio?: number;
}

export interface MessageStats {
  totalTokens: number;
  messageCount: number;
  exceedsBudget: boolean;
}

/**
 * Context window service (L3.1): token estimation, windowing and budgeting
 * over the platform-neutral ChatMessage model. Consumed by the agent loop for
 * staging messages and by compaction to decide when to summarize.
 */
export class ContextWindowService {
  constructor(private options: ContextWindowOptions = {}) {}

  estimateTokens(content: string): number {
    // Simple heuristic: ~4 chars/token, with a small ceiling. Swap with a
    // real tokenizer (Tiktoken) later without changing the API.
    return Math.max(1, Math.ceil(content.length / 4));
  }

  estimateMessageTokens(m: ChatMessage): number {
    return this.estimateTokens(m.content) + 4 /* role overhead */;
  }

  stats(messages: ChatMessage[], maxTokens?: number): MessageStats {
    const total = messages.reduce((acc, m) => acc + this.estimateMessageTokens(m), 0);
    const cap = maxTokens ?? this.options.maxTokens ?? 4096;
    return {
      totalTokens: total,
      messageCount: messages.length,
      exceedsBudget: total > cap,
    };
  }

  /** Slice to the newest messages that fit the budget (approx). */
  window(messages: ChatMessage[], maxTokens?: number): ChatMessage[] {
    const cap = maxTokens ?? this.options.maxTokens ?? 4096;
    const out: ChatMessage[] = [];
    let used = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      const t = this.estimateMessageTokens(messages[i]);
      if (used + t > cap) break;
      out.unshift(messages[i]);
      used += t;
    }
    return out;
  }
}

export const ContextWindowServicePlugin: PluginObject = {
  inject: ['llm'],
  apply(ctx: Context) {
    const service = new ContextWindowService();
    return ctx.provide('context-window', service);
  },
};
