import { describe, it, expect } from 'vitest';
import { Context } from '../../src/core/cordis';
import { ContextWindowService } from '../../src/session/context.service';
import { CompactionService, CompactionServicePlugin, SummarizeCompactionStrategy } from '../../src/session/compaction.service';
import { LLMRegistry } from '../../src/llm/llm.service';
import type { ChatMessage } from '../../src/types';

function msg(content: string): ChatMessage {
  return { role: 'user', content, timestamp: Date.now() };
}

describe('CompactionService (L3.2)', () => {
  it('compacts when over budget, keeps the most recent turns', async () => {
    const cw = new ContextWindowService();
    const svc = new CompactionService(cw);
    svc.register(new SummarizeCompactionStrategy());

    const messages = Array.from({ length: 20 }, (_, i) => msg(`msg-${i}\n` + 'x'.repeat(300)));
    const llm = new LLMRegistry();
    const res = await svc.maybeCompact({ messages, maxTokens: 4000 }, llm, 400);
    expect(res.compacted).toBe(true);
    expect(res.messages[0].role).toBe('system');
    expect(res.messages[0].content).toContain('12 条'); // 20 - keep(8) = 12
    expect(res.messages.length).toBeLessThan(messages.length);
  });

  it('does not compact under budget', async () => {
    const svc = new CompactionService(new ContextWindowService());
    svc.register(new SummarizeCompactionStrategy());
    const llm = new LLMRegistry();
    const res = await svc.maybeCompact({ messages: [msg('short')], maxTokens: 1000 }, llm, 1000);
    expect(res.compacted).toBe(false);
    expect(res.messages).toHaveLength(1);
  });

  it('CompactionServicePlugin registers summarize by default and unload recovers', async () => {
    const ctx = new Context();
    ctx.provide('context-window', new ContextWindowService());
    await ctx.plugin(CompactionServicePlugin);
    const svc = ctx.get<CompactionService>('compaction', false)!;
    expect(svc.active.id).toBe('summarize');
    await ctx.fiber.dispose();
    expect(ctx.get('compaction', false)).toBeUndefined();
  });
});
