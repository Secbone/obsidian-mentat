/**
 * Sliding Window Strategy - Keeps the last N messages
 *
 * This strategy maintains a fixed-size window of the most recent messages,
 * always preserving system messages and important context.
 */

import { ChatMessage } from '../../types';
import { ContextStrategy, ContextWindow, ContextOptions, ContextMetadata } from '../context-types';

export class SlidingWindowStrategy implements ContextStrategy {
  name = 'sliding-window';

  /**
   * Default window size if not specified
   */
  private readonly DEFAULT_WINDOW_SIZE = 50;

  /**
   * Prepare messages using sliding window approach
   */
  async prepare(messages: ChatMessage[], options?: ContextOptions): Promise<ContextWindow> {
    const windowSize = options?.maxMessages ?? this.DEFAULT_WINDOW_SIZE;

    // Separate system messages and other messages
    const systemMessages = messages.filter(m => m.role === 'system');
    const nonSystemMessages = messages.filter(m => m.role !== 'system');

    // Determine which messages to include
    let selectedMessages: ChatMessage[] = [];

    // Always include system messages if requested (or by default)
    if (options?.includeSystemMessages !== false) {
      selectedMessages.push(...systemMessages);
    }

    // Calculate how many non-system messages we can include
    const remainingSlots = Math.max(0, windowSize - selectedMessages.length);

    // Take the most recent non-system messages
    const recentMessages = nonSystemMessages.slice(-remainingSlots);

    // Apply additional filters if provided
    let filteredMessages = recentMessages;

    // Filter tool calls if requested
    if (options?.includeToolCalls === false) {
      filteredMessages = filteredMessages.filter(m =>
        m.role !== 'tool' && !m.tool_calls?.length
      );
    }

    // Apply custom filter if provided
    if (options?.filter) {
      filteredMessages = filteredMessages.filter(options.filter);
    }

    // Combine system messages with filtered recent messages
    selectedMessages = [
      ...selectedMessages.filter(m => m.role === 'system'),
      ...filteredMessages
    ];

    // Transform tool calls if requested
    if (options?.transformToolCalls) {
      selectedMessages = this.transformToolCalls(selectedMessages);
    }

    // Build metadata
    const metadata: ContextMetadata = {
      totalMessages: messages.length,
      windowSize: selectedMessages.length,
      strategy: this.name,
      tokenCount: this.estimateTokens(selectedMessages),
      isTruncated: messages.length > selectedMessages.length
    };

    // Add time range if messages exist
    if (selectedMessages.length > 0) {
      metadata.timeRange = {
        start: selectedMessages[0].timestamp,
        end: selectedMessages[selectedMessages.length - 1].timestamp
      };
    }

    return {
      messages: selectedMessages,
      metadata
    };
  }

  /**
   * Estimate token count for messages
   * Using approximate method: ~4 characters per token
   */
  estimateTokens(messages: ChatMessage[]): number {
    let totalChars = 0;

    for (const message of messages) {
      // Count content characters
      totalChars += message.content.length;

      // Add overhead for role
      totalChars += 20; // Approximate overhead for message structure

      // Add tool call overhead if present
      if (message.tool_calls) {
        for (const toolCall of message.tool_calls) {
          totalChars += toolCall.name.length;
          const args = typeof toolCall.arguments === 'string'
            ? toolCall.arguments
            : JSON.stringify(toolCall.arguments);
          totalChars += args.length;
          totalChars += 50; // Overhead for tool call structure
        }
      }

      // Add overhead for tool response
      if (message.role === 'tool' && message.tool_call_id) {
        totalChars += message.tool_call_id.length + 30;
      }
    }

    // Approximate 4 characters per token
    return Math.ceil(totalChars / 4);
  }

  /**
   * Validate if this strategy can handle the given options
   */
  validate(options: ContextOptions): boolean {
    // This strategy can handle all standard options
    if (options.maxMessages && options.maxMessages < 0) {
      return false;
    }

    // If maxTokens is specified, we can't guarantee exact token limits
    // but we can work with it
    if (options.maxTokens && options.maxTokens < 100) {
      return false; // Too small to be practical
    }

    return true;
  }

  /**
   * Transform tool calls for optimization
   */
  private transformToolCalls(messages: ChatMessage[]): ChatMessage[] {
    return messages.map(message => {
      if (!message.tool_calls?.length) {
        return message;
      }

      // Compress tool call arguments
      const transformedMessage = { ...message };
      transformedMessage.tool_calls = message.tool_calls.map(toolCall => {
        let compressedArgs = toolCall.arguments;

        // If arguments is a string, try to parse and re-stringify to remove whitespace
        if (typeof toolCall.arguments === 'string') {
          try {
            const parsed = JSON.parse(toolCall.arguments);
            compressedArgs = JSON.stringify(parsed);
          } catch {
            // Keep original if parsing fails
          }
        } else {
          // If it's already an object, stringify it compactly
          compressedArgs = JSON.stringify(toolCall.arguments);
        }

        return {
          ...toolCall,
          arguments: compressedArgs
        };
      });

      return transformedMessage;
    });
  }

  /**
   * Helper method to merge consecutive tool messages
   */
  private mergeConsecutiveToolMessages(messages: ChatMessage[]): ChatMessage[] {
    const merged: ChatMessage[] = [];
    let currentToolGroup: ChatMessage[] = [];

    for (const message of messages) {
      if (message.role === 'tool') {
        currentToolGroup.push(message);
      } else {
        // If we have accumulated tool messages, merge them
        if (currentToolGroup.length > 0) {
          merged.push(this.mergeToolMessages(currentToolGroup));
          currentToolGroup = [];
        }
        merged.push(message);
      }
    }

    // Don't forget the last group if it exists
    if (currentToolGroup.length > 0) {
      merged.push(this.mergeToolMessages(currentToolGroup));
    }

    return merged;
  }

  /**
   * Merge multiple tool messages into one
   */
  private mergeToolMessages(toolMessages: ChatMessage[]): ChatMessage {
    if (toolMessages.length === 1) {
      return toolMessages[0];
    }

    // Combine content with separators
    const combinedContent = toolMessages
      .map(m => `[${m.name || 'tool'}]: ${m.content}`)
      .join('\n---\n');

    return {
      role: 'tool',
      content: combinedContent,
      timestamp: toolMessages[0].timestamp,
      name: 'merged_tools',
      tool_call_id: toolMessages[0].tool_call_id
    };
  }
}