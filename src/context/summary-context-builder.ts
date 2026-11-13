import type { ChatMessage } from '../contracts/conversation';
import type { ContextBuilder } from '../contracts/context-builder';
import { abortable, throwIfAborted } from '../utils/execution';

export interface Summarizer {
  compact(messages: ChatMessage[], options?: { keepRecent?: number; abortSignal?: AbortSignal }): Promise<string>;
}

export class SummaryContextBuilder implements ContextBuilder {
  readonly id = 'summary-v1';
  constructor(private summarizer: Summarizer) {}
  async build({ messages, keepRecent, signal }: Parameters<ContextBuilder['build']>[0]) {
    throwIfAborted(signal);
    const count=Number.isFinite(keepRecent) ? Math.max(1,Math.floor(keepRecent)):6;
    let start=Math.max(0,messages.length-count);
    while (start > 0 && (messages[start]?.role === 'tool' || messages[start]?.role === 'function')) start--;
    if (!start) return {messages,summaryLength:0};
    const recent=messages.slice(start);
    const summary=(await abortable(this.summarizer.compact(messages,{keepRecent:recent.length,abortSignal:signal}),signal)).trim();
    throwIfAborted(signal);
    if (!summary) return {messages,summaryLength:0};
    return { messages:[{role:'user',content:`--- Context Summary ---\n${summary}\n\n--- Continuing Conversation ---`,timestamp:Date.now()},...recent] as ChatMessage[],
      summaryLength:summary.length };
  }
}
