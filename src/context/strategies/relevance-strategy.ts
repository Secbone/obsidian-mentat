/**
 * Relevance Strategy - Keeps relevant conversation pairs and important messages
 *
 * This strategy maintains conversation context by keeping user-assistant pairs
 * and prioritizing messages based on relevance indicators.
 */

import { ChatMessage } from '../../types';
import { ContextStrategy, ContextWindow, ContextOptions, ContextMetadata } from '../context-types';

export class RelevanceStrategy implements ContextStrategy {
  name = 'relevance';

  /**
   * Default token limit for relevance-based selection
   */
  private readonly DEFAULT_TOKEN_LIMIT = 4000;

  /**
   * Minimum conversation pairs to keep
   */
  private readonly MIN_CONVERSATION_PAIRS = 3;

  /**
   * Prepare messages based on relevance
   */
  async prepare(messages: ChatMessage[], options?: ContextOptions): Promise<ContextWindow> {
    const tokenLimit = options?.maxTokens ?? this.DEFAULT_TOKEN_LIMIT;

    // Identify conversation structure
    const conversations = this.identifyConversations(messages);

    // Score conversations by relevance
    const scoredConversations = this.scoreConversations(conversations);

    // Select high-priority messages
    const priorityMessages = this.selectPriorityMessages(messages);

    // Build context with priority messages and relevant conversations
    const selectedMessages = this.buildRelevantContext(
      priorityMessages,
      scoredConversations,
      tokenLimit,
      options
    );

    // Apply transformations
    let finalMessages = selectedMessages;

    // Filter tool calls if requested
    if (options?.includeToolCalls === false) {
      finalMessages = this.filterToolCalls(finalMessages);
    }

    // Apply custom filter
    if (options?.filter) {
      finalMessages = finalMessages.filter(options.filter);
    }

    // Transform tool calls for optimization
    if (options?.transformToolCalls) {
      finalMessages = this.transformToolCalls(finalMessages);
    }

    // Build metadata
    const metadata: ContextMetadata = {
      totalMessages: messages.length,
      windowSize: finalMessages.length,
      strategy: this.name,
      tokenCount: this.estimateTokens(finalMessages),
      isTruncated: messages.length > finalMessages.length
    };

    // Add time range
    if (finalMessages.length > 0) {
      metadata.timeRange = {
        start: finalMessages[0].timestamp,
        end: finalMessages[finalMessages.length - 1].timestamp
      };
    }

    return {
      messages: finalMessages,
      metadata
    };
  }

  /**
   * Estimate token count for messages
   */
  estimateTokens(messages: ChatMessage[]): number {
    let totalChars = 0;

    for (const message of messages) {
      totalChars += message.content.length;
      totalChars += 25; // Role and structure overhead

      // Tool calls overhead
      if (message.tool_calls) {
        for (const toolCall of message.tool_calls) {
          totalChars += toolCall.name.length + 20;
          const args = typeof toolCall.arguments === 'string'
            ? toolCall.arguments
            : JSON.stringify(toolCall.arguments);
          totalChars += args.length + 50;
        }
      }

      // Tool response overhead
      if (message.role === 'tool') {
        totalChars += 50;
        if (message.name) totalChars += message.name.length;
        if (message.tool_call_id) totalChars += message.tool_call_id.length;
      }
    }

    return Math.ceil(totalChars / 4);
  }

  /**
   * Validate strategy options
   */
  validate(options: ContextOptions): boolean {
    if (options.maxTokens && options.maxTokens < 500) {
      return false; // Need reasonable space for relevance-based selection
    }
    return true;
  }

  /**
   * Identify conversation pairs and sequences
   */
  private identifyConversations(messages: ChatMessage[]): Conversation[] {
    const conversations: Conversation[] = [];
    let currentConv: ChatMessage[] = [];
    let lastUserIndex = -1;

    messages.forEach((message, index) => {
      if (message.role === 'user') {
        // Start new conversation
        if (currentConv.length > 0) {
          conversations.push({
            messages: currentConv,
            startIndex: lastUserIndex,
            endIndex: index - 1,
            score: 0
          });
        }
        currentConv = [message];
        lastUserIndex = index;
      } else if (message.role === 'assistant' || message.role === 'tool') {
        currentConv.push(message);
      } else if (message.role === 'system') {
        // System messages are handled separately
        if (currentConv.length === 0) {
          conversations.push({
            messages: [message],
            startIndex: index,
            endIndex: index,
            score: 1000 // High priority for system messages
          });
        }
      }
    });

    // Add the last conversation
    if (currentConv.length > 0) {
      conversations.push({
        messages: currentConv,
        startIndex: lastUserIndex,
        endIndex: messages.length - 1,
        score: 0
      });
    }

    return conversations;
  }

  /**
   * Score conversations based on relevance indicators
   */
  private scoreConversations(conversations: Conversation[]): Conversation[] {
    const totalConvs = conversations.length;

    return conversations.map((conv, index) => {
      let score = 0;

      // Recency score (more recent = higher score)
      const recencyScore = (index / totalConvs) * 100;
      score += recencyScore;

      // Check for important content
      const content = conv.messages.map(m => m.content).join(' ').toLowerCase();

      // Error messages are important
      if (content.includes('error:') || content.includes('exception')) {
        score += 50;
      }

      // Code blocks are often important
      if (content.includes('```')) {
        score += 30;
      }

      // Questions and answers are important
      if (conv.messages.some(m => m.role === 'user' && m.content.includes('?'))) {
        score += 20;
      }

      // Tool usage indicates action taken
      if (conv.messages.some(m => m.tool_calls?.length || m.role === 'tool')) {
        score += 25;
      }

      // Long conversations might be more substantial
      if (conv.messages.length > 3) {
        score += 15;
      }

      // Detect keywords that indicate importance
      const importantKeywords = [
        'important', 'critical', 'error', 'failed', 'success',
        'complete', 'finish', 'bug', 'issue', 'problem', 'solution'
      ];
      const keywordCount = importantKeywords.filter(kw => content.includes(kw)).length;
      score += keywordCount * 10;

      return { ...conv, score };
    });
  }

  /**
   * Select high-priority messages that must be included
   */
  private selectPriorityMessages(messages: ChatMessage[]): ChatMessage[] {
    const priority: ChatMessage[] = [];

    // Always include first system message
    const firstSystem = messages.find(m => m.role === 'system');
    if (firstSystem) {
      priority.push(firstSystem);
    }

    // Include recent error messages (last 2)
    const errors = messages
      .filter(m => m.role === 'tool' && m.content.includes('Error:'))
      .slice(-2);
    priority.push(...errors);

    return priority;
  }

  /**
   * Build relevant context from scored conversations
   */
  private buildRelevantContext(
    priorityMessages: ChatMessage[],
    scoredConversations: Conversation[],
    tokenLimit: number,
    options?: ContextOptions
  ): ChatMessage[] {
    const selected: ChatMessage[] = [...priorityMessages];
    let currentTokens = this.estimateTokens(selected);

    // Sort conversations by score (highest first)
    const sortedConvs = [...scoredConversations].sort((a, b) => b.score - a.score);

    // Always try to include the most recent conversations
    const recentConvs = scoredConversations.slice(-this.MIN_CONVERSATION_PAIRS);

    // Add recent conversations first
    for (const conv of recentConvs) {
      const convTokens = this.estimateTokens(conv.messages);
      if (currentTokens + convTokens <= tokenLimit) {
        // Avoid duplicates
        const newMessages = conv.messages.filter(m =>
          !selected.some(s => s.timestamp === m.timestamp)
        );
        selected.push(...newMessages);
        currentTokens += this.estimateTokens(newMessages);
      }
    }

    // Fill remaining space with high-score conversations
    for (const conv of sortedConvs) {
      // Skip if already added
      if (recentConvs.includes(conv)) continue;

      const convTokens = this.estimateTokens(conv.messages);
      if (currentTokens + convTokens <= tokenLimit) {
        // Avoid duplicates
        const newMessages = conv.messages.filter(m =>
          !selected.some(s => s.timestamp === m.timestamp)
        );
        if (newMessages.length > 0) {
          selected.push(...newMessages);
          currentTokens += this.estimateTokens(newMessages);
        }
      } else if (currentTokens < tokenLimit * 0.9) {
        // Try to fit a summarized version if we have space
        const summarized = this.summarizeConversation(conv, tokenLimit - currentTokens);
        if (summarized.length > 0) {
          selected.push(...summarized);
          currentTokens += this.estimateTokens(summarized);
        }
      }

      // Stop if we're close to the limit
      if (currentTokens >= tokenLimit * 0.95) {
        break;
      }
    }

    // Sort by timestamp to maintain chronological order
    return selected.sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Summarize a conversation to fit within token limit
   */
  private summarizeConversation(conv: Conversation, maxTokens: number): ChatMessage[] {
    const summarized: ChatMessage[] = [];
    const maxChars = maxTokens * 4;

    // Always keep the user message if possible
    const userMsg = conv.messages.find(m => m.role === 'user');
    if (userMsg) {
      const truncatedUser = this.truncateMessage(userMsg, maxChars / 2);
      summarized.push(truncatedUser);
    }

    // Keep the most important assistant response
    const assistantMsg = conv.messages.find(m => m.role === 'assistant');
    if (assistantMsg) {
      const truncatedAssistant = this.truncateMessage(assistantMsg, maxChars / 2);
      summarized.push(truncatedAssistant);
    }

    return summarized;
  }

  /**
   * Truncate a message to fit within character limit
   */
  private truncateMessage(message: ChatMessage, maxChars: number): ChatMessage {
    if (message.content.length <= maxChars) {
      return message;
    }

    return {
      ...message,
      content: message.content.substring(0, maxChars - 30) +
        '\n... [summarized]'
    };
  }

  /**
   * Filter out tool-related messages
   */
  private filterToolCalls(messages: ChatMessage[]): ChatMessage[] {
    return messages.filter(m => {
      // Keep non-tool messages
      if (m.role !== 'tool' && !m.tool_calls?.length) {
        return true;
      }

      // Keep error tool messages
      if (m.role === 'tool' && m.content.includes('Error:')) {
        return true;
      }

      return false;
    });
  }

  /**
   * Transform tool calls for optimization
   */
  private transformToolCalls(messages: ChatMessage[]): ChatMessage[] {
    return messages.map(message => {
      if (!message.tool_calls?.length) {
        return message;
      }

      const transformed = { ...message };
      transformed.tool_calls = message.tool_calls.map(toolCall => {
        let compressedArgs = toolCall.arguments;

        if (typeof toolCall.arguments === 'string') {
          try {
            const parsed = JSON.parse(toolCall.arguments);
            compressedArgs = JSON.stringify(parsed);
          } catch {
            // Keep original
          }
        } else {
          compressedArgs = JSON.stringify(toolCall.arguments);
        }

        return {
          ...toolCall,
          arguments: compressedArgs
        };
      });

      return transformed;
    });
  }
}

/**
 * Internal interface for conversation tracking
 */
interface Conversation {
  messages: ChatMessage[];
  startIndex: number;
  endIndex: number;
  score: number;
}