import { describe, it, expect } from 'vitest';
import { ContextWindowService, ContextWindowServicePlugin } from '../../src/session/context.service';
import { Context } from '../../src/core/cordis';
import type { ChatMessage } from '../../src/types';

function msg(content: string): ChatMessage {
  return { role: 'user', content, timestamp: Date.now() };
}

describe('ContextWindowService (L3.1)', () => {
  it('estimates tokens and computes stats/budget', () => {
    const svc = new ContextWindowService({ maxTokens: 100 });
    const s = svc.stats([msg('a'.repeat(100)), msg('b'.repeat(100))], 40);
    expect(s.totalTokens).toBeGreaterThan(0);
    expect(s.messageCount).toBe(2);
    expect(s.exceedsBudget).toBe(true); // far over 40
  });

  it('windows to the newest messages that fit the budget', () => {
    const svc = new ContextWindowService({ maxTokens: 30 });
    // First message is large (≈54 tokens) — must be dropped.
    const messages = [msg('a'.repeat(220)), msg('b'.repeat(10)), msg('c'.repeat(10))];
    const win = svc.window(messages, 30);
    expect(win.length).toBeLessThan(messages.length);           // oldest dropped
    expect(win.some((m) => m.content.startsWith('a'.repeat(220)))).toBe(false);
  });

  it('ContextWindowServicePlugin provides and unload recovers', async () => {
    const ctx = new Context();
    ctx.provide('llm', {} as never);
    await ctx.plugin(ContextWindowServicePlugin);
    expect(ctx.get<ContextWindowService>('context-window', false)).toBeInstanceOf(ContextWindowService);
    await ctx.fiber.dispose();
    expect(ctx.get('context-window', false)).toBeUndefined();
  });
});
