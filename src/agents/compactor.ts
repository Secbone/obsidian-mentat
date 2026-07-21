// Compactor - Context compaction using LLM summarization

import { AIProvider, ChatMessage } from '../types';

export interface CompactionOptions {
  keepRecent?: number;
  summaryPrompt?: string;
  systemPrompt?: string;
}

/**
 * Compactor - Compresses older conversation messages into a summary
 * while keeping recent messages intact. Used to stay within context window limits.
 */
export class Compactor {
  constructor(private provider: AIProvider) {}

  /**
   * Compact older messages into a summary string.
   * Returns empty string if there are fewer messages than keepRecent.
   */
  async compact(
    messages: ChatMessage[],
    options: CompactionOptions = {}
  ): Promise<string> {
    const keepRecent = options.keepRecent ?? 6;
    const messagesToCompact = messages.slice(0, -keepRecent);

    if (messagesToCompact.length === 0) return '';

    const conversationText = messagesToCompact
      .map(m => {
        const role = m.role.toUpperCase();
        const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        return `[${role}]: ${content}`;
      })
      .join('\n\n');

    const prompt = options.summaryPrompt || [
      'Summarize the conversation above. Focus on:',
      '- Decisions and conclusions made',
      '- User preferences and requirements',
      '- Key facts and context needed to continue',
      '- Completed tasks and their outcomes',
      'Be concise but thorough. The summary will be used as context for future turns.',
      'Start your summary directly without preamble.'
    ].join('\n');

    try {
      const summary = await this.provider.generate(
        `${conversationText}\n\n---\n${prompt}`,
        { systemPrompt: options.systemPrompt, temperature: 0.3 }
      );
      return summary.trim();
    } catch (error) {
      console.warn('[Compactor] Failed to generate summary, returning empty:', error);
      return '';
    }
  }

  /**
   * Estimate tokens from messages using character-based approximation.
   * Used for budget checking before compaction.
   */
  static estimateTokens(messages: ChatMessage[]): number {
    let totalChars = 0;
    for (const m of messages) {
      totalChars += (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length) + 10;
      if (m.tool_calls) {
        totalChars += JSON.stringify(m.tool_calls).length;
      }
    }
    return Math.ceil(totalChars / 4);
  }
}
