/**
 * Token Limit Strategy - Limits context by estimated token count
 *
 * This strategy ensures the context stays within a specified token limit,
 * prioritizing recent messages while preserving important context.
 */

import { ChatMessage } from '../../types';
import { ContextStrategy, ContextWindow, ContextOptions, ContextMetadata } from '../context-types';

export class TokenLimitStrategy implements ContextStrategy {
  name = 'token-limit';

  /**
   * Default token limit if not specified
   */
  private readonly DEFAULT_TOKEN_LIMIT = 4000;

  /**
   * Maximum characters per message before truncation
   */
  private readonly MAX_MESSAGE_LENGTH = 2000;

  /**
   * Prepare messages within token limit
   */
  async prepare(messages: ChatMessage[], options?: ContextOptions): Promise<ContextWindow> {
    const tokenLimit = options?.maxTokens ?? this.DEFAULT_TOKEN_LIMIT;

    // Separate messages by priority
    const { systemMessages, errorMessages, recentMessages } = this.categorizeMessages(messages);

    // Build context starting with high-priority messages
    const selectedMessages: ChatMessage[] = [];
    let currentTokenCount = 0;

    // 1. Always include system messages if allowed
    if (options?.includeSystemMessages !== false) {
      for (const msg of systemMessages) {
        const tokens = this.estimateMessageTokens(msg);
        if (currentTokenCount + tokens <= tokenLimit) {
          selectedMessages.push(msg);
          currentTokenCount += tokens;
        }
      }
    }

    // 2. Include recent error messages (last 3)
    const recentErrors = errorMessages.slice(-3);
    for (const msg of recentErrors) {
      const tokens = this.estimateMessageTokens(msg);
      if (currentTokenCount + tokens <= tokenLimit) {
        selectedMessages.push(msg);
        currentTokenCount += tokens;
      }
    }

    // 3. Fill remaining space with recent messages
    const remainingTokens = tokenLimit - currentTokenCount;
    const recentMessagesToAdd = this.selectMessagesWithinLimit(
      recentMessages,
      remainingTokens,
      options
    );

    // Combine all messages in chronological order
    const allSelectedMessages = [...selectedMessages, ...recentMessagesToAdd]
      .sort((a, b) => a.timestamp - b.timestamp);

    // Apply transformations if requested
    let finalMessages = allSelectedMessages;

    // Filter tool calls if requested
    if (options?.includeToolCalls === false) {
      finalMessages = finalMessages.filter(m =>
        m.role !== 'tool' && !m.tool_calls?.length
      );
    }

    // Apply custom filter
    if (options?.filter) {
      finalMessages = finalMessages.filter(options.filter);
    }

    // Transform tool calls for optimization
    if (options?.transformToolCalls) {
      finalMessages = this.transformToolCalls(finalMessages);
    }

    // Truncate long messages if needed
    finalMessages = this.truncateLongMessages(finalMessages);

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
    return messages.reduce((total, msg) => {
      return total + this.estimateMessageTokens(msg);
    }, 0);
  }

  /**
   * Estimate token count for a single message
   */
  private estimateMessageTokens(message: ChatMessage): number {
    let chars = 0;

    // Content tokens
    chars += message.content.length;

    // Role and structure overhead
    chars += 25;

    // Tool calls overhead
    if (message.tool_calls) {
      for (const toolCall of message.tool_calls) {
        chars += toolCall.name.length + 20;
        const args = typeof toolCall.arguments === 'string'
          ? toolCall.arguments
          : JSON.stringify(toolCall.arguments);
        chars += args.length;
        chars += 50; // Structure overhead
      }
    }

    // Tool response overhead
    if (message.role === 'tool') {
      chars += 50;
      if (message.name) chars += message.name.length;
      if (message.tool_call_id) chars += message.tool_call_id.length;
    }

    // Estimate ~4 characters per token (rough approximation)
    return Math.ceil(chars / 4);
  }

  /**
   * Validate strategy options
   */
  validate(options: ContextOptions): boolean {
    if (options.maxTokens && options.maxTokens < 100) {
      return false; // Too small to be practical
    }
    return true;
  }

  /**
   * Categorize messages by priority
   */
  private categorizeMessages(messages: ChatMessage[]): {
    systemMessages: ChatMessage[];
    errorMessages: ChatMessage[];
    recentMessages: ChatMessage[];
  } {
    const systemMessages: ChatMessage[] = [];
    const errorMessages: ChatMessage[] = [];
    const recentMessages: ChatMessage[] = [];

    for (const message of messages) {
      if (message.role === 'system') {
        systemMessages.push(message);
      } else if (message.role === 'tool' && message.content.includes('Error:')) {
        errorMessages.push(message);
      } else {
        recentMessages.push(message);
      }
    }

    return { systemMessages, errorMessages, recentMessages };
  }

  /**
   * Select messages that fit within token limit
   */
  private selectMessagesWithinLimit(
    messages: ChatMessage[],
    tokenLimit: number,
    options?: ContextOptions
  ): ChatMessage[] {
    const selected: ChatMessage[] = [];
    let currentTokens = 0;

    // Work backwards from most recent
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];

      // Skip if filtering tool calls
      if (options?.includeToolCalls === false &&
        (message.role === 'tool' || message.tool_calls?.length)) {
        continue;
      }

      const messageTokens = this.estimateMessageTokens(message);

      // Check if adding this message would exceed limit
      if (currentTokens + messageTokens > tokenLimit) {
        // If this is an important message and we have room for a truncated version
        if (message.role === 'user' && currentTokens < tokenLimit * 0.9) {
          const truncated = this.truncateMessage(message, tokenLimit - currentTokens);
          selected.unshift(truncated);
          break;
        }
        continue;
      }

      selected.unshift(message);
      currentTokens += messageTokens;
    }

    return selected;
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

        // Compress JSON arguments
        if (typeof toolCall.arguments === 'string') {
          try {
            const parsed = JSON.parse(toolCall.arguments);
            compressedArgs = JSON.stringify(parsed);
          } catch {
            // Keep original if parsing fails
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

  /**
   * Truncate long messages
   */
  private truncateLongMessages(messages: ChatMessage[]): ChatMessage[] {
    return messages.map(message => {
      if (message.content.length <= this.MAX_MESSAGE_LENGTH) {
        return message;
      }

      return {
        ...message,
        content: message.content.substring(0, this.MAX_MESSAGE_LENGTH - 20) +
          '\n... [truncated]'
      };
    });
  }

  /**
   * Truncate a single message to fit within token limit
   */
  private truncateMessage(message: ChatMessage, maxTokens: number): ChatMessage {
    // Estimate how many characters we can keep
    const maxChars = maxTokens * 4; // Rough estimate

    if (message.content.length <= maxChars) {
      return message;
    }

    return {
      ...message,
      content: message.content.substring(0, maxChars - 50) +
        '\n... [truncated to fit token limit]'
    };
  }

  /**
   * Merge consecutive tool messages to save tokens
   */
  private mergeConsecutiveToolMessages(messages: ChatMessage[]): ChatMessage[] {
    const merged: ChatMessage[] = [];
    let toolGroup: ChatMessage[] = [];

    for (const message of messages) {
      if (message.role === 'tool') {
        toolGroup.push(message);
      } else {
        if (toolGroup.length > 0) {
          merged.push(this.mergeToolGroup(toolGroup));
          toolGroup = [];
        }
        merged.push(message);
      }
    }

    // Handle remaining tool messages
    if (toolGroup.length > 0) {
      merged.push(this.mergeToolGroup(toolGroup));
    }

    return merged;
  }

  /**
   * Merge a group of tool messages
   */
  private mergeToolGroup(tools: ChatMessage[]): ChatMessage {
    if (tools.length === 1) {
      return tools[0];
    }

    const contents = tools.map(t => {
      const name = t.name || 'tool';
      const status = t.content.includes('Error:') ? '[ERROR]' : '[OK]';
      return `${status} ${name}: ${t.content}`;
    });

    return {
      role: 'tool',
      content: contents.join('\n---\n'),
      timestamp: tools[0].timestamp,
      name: 'merged_tools',
      tool_call_id: tools[0].tool_call_id
    };
  }
}