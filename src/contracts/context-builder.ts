import type { ChatMessage } from './conversation';

/** Build model context without modifying the canonical conversation or splitting tool exchanges. */
export interface ContextBuilder {
  readonly id: string;
  build(input: { messages: ChatMessage[]; keepRecent: number; signal?: AbortSignal }): Promise<{ messages: ChatMessage[]; summaryLength: number }>;
}
