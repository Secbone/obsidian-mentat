import type { PluginObject, Context } from '../core/cordis';
import type { ChatMessage } from '../types';
import type { ContextWindowService } from './context.service';
import type { LLMRegistry } from '../llm/llm.service';

export interface CompactionContext {
  messages: ChatMessage[];
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface CompactionResult {
  messages: ChatMessage[]; // post-compaction message list
  summary: string;
  compacted: boolean;
}

/**
 * A pluggable compaction strategy (L3.2). Strategies decide whether to
 * compact and how; the agent loop asks the registered policy.
 */
export interface CompactionStrategy {
  id: string;
  shouldCompact(stats: { totalTokens: number; maxTokens: number }): boolean;
  compact(ctx: CompactionContext, llm: LLMRegistry): Promise<CompactionResult>;
}

/**
 * Default strategy: summarize older messages once the budget is exceeded,
 * keeping the most recent turns and a single condensed system summary.
 */
export class SummarizeCompactionStrategy implements CompactionStrategy {
  readonly id = 'summarize';

  shouldCompact(stats: { totalTokens: number; maxTokens: number }): boolean {
    return stats.totalTokens > stats.maxTokens * 1.1;
  }

  async compact(ctx: CompactionContext, _llm: LLMRegistry): Promise<CompactionResult> {
    const keep = Math.max(1, Math.floor(ctx.messages.length * 0.4));
    const toCompact = ctx.messages.slice(0, Math.max(0, ctx.messages.length - keep));
    const summaryText = `【上下文压缩】已压缩 ${toCompact.length} 条历史消息。`;
    return {
      summary: summaryText,
      compacted: true,
      messages: [
        { role: 'system', content: summaryText, timestamp: Date.now() },
        ...ctx.messages.slice(Math.max(0, ctx.messages.length - keep)),
      ],
    };
  }
}

/** Compaction service: holds the registered strategies + the active window budget. */
export class CompactionService {
  private strategies = new Map<string, CompactionStrategy>();
  private activeId = 'summarize';
  constructor(private contextWindow: ContextWindowService) {}

  register(strategy: CompactionStrategy): () => void {
    if (this.strategies.has(strategy.id)) throw new Error(`compaction strategy "${strategy.id}" already registered`);
    this.strategies.set(strategy.id, strategy);
    return () => this.strategies.delete(strategy.id);
  }

  setActive(id: string): void { this.activeId = id; }
  get active(): CompactionStrategy { return this.strategies.get(this.activeId) ?? this.strategies.get('summarize')!; }

  async maybeCompact(ctx: CompactionContext, llm: LLMRegistry, maxTokens = 4000): Promise<CompactionResult> {
    const stats = this.contextWindow.stats(ctx.messages, maxTokens);
    const strategy = this.active;
    if (strategy.shouldCompact({ totalTokens: stats.totalTokens, maxTokens })) {
      return strategy.compact(ctx, llm);
    }
    return { messages: ctx.messages, summary: '', compacted: false };
  }
}

export const CompactionServicePlugin: PluginObject = {
  inject: ['context-window'],
  apply(ctx: Context) {
    const cw = ctx.get<ContextWindowService>('context-window')!;
    const service = new CompactionService(cw);
    service.register(new SummarizeCompactionStrategy());
    return ctx.provide('compaction', service);
  },
};
