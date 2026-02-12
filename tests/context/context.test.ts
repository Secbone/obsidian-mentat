/**
 * Tests for Context class
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Context, ContextMetadata } from '../../src/context/context';
import { Message } from '../../src/context/message';

describe('Context', () => {
  let sampleMessages: Message[];

  beforeEach(() => {
    sampleMessages = [
      new Message({ role: 'system', content: 'System prompt', timestamp: 1000 }),
      new Message({ role: 'user', content: 'Question 1', timestamp: 2000 }),
      new Message({ role: 'assistant', content: 'Answer 1', timestamp: 3000 }),
      new Message({ role: 'user', content: 'Question 2', timestamp: 4000 }),
      new Message({ role: 'assistant', content: 'Answer 2', timestamp: 5000 })
    ];
  });

  describe('constructor', () => {
    it('should create context with messages', () => {
      const context = new Context(sampleMessages);

      expect(context.getMessageCount()).toBe(5);
      expect(context.getMessages()).toHaveLength(5);
    });

    it('should initialize metadata correctly', () => {
      const context = new Context(sampleMessages);
      const metadata = context.getMetadata();

      expect(metadata.totalMessages).toBe(5);
      expect(metadata.windowSize).toBe(5);
      expect(metadata.sessionStartTime).toBe(1000);
      expect(metadata.lastUpdated).toBe(5000);
      expect(metadata.statistics).toBeDefined();
      expect(metadata.tokenCount).toBeGreaterThan(0);
    });

    it('should accept custom metadata', () => {
      const context = new Context(sampleMessages, {
        sessionId: 'test-session-123',
        strategy: 'sliding-window'
      });
      const metadata = context.getMetadata();

      expect(metadata.sessionId).toBe('test-session-123');
      expect(metadata.strategy).toBe('sliding-window');
    });

    it('should create empty context', () => {
      const context = Context.empty();

      expect(context.isEmpty()).toBe(true);
      expect(context.getMessageCount()).toBe(0);
    });
  });

  describe('getMessages', () => {
    it('should return a copy of messages', () => {
      const context = new Context(sampleMessages);
      const messages = context.getMessages();

      expect(messages).toHaveLength(5);
      expect(messages).not.toBe(sampleMessages); // Different array instance
    });

    it('should not allow external mutation', () => {
      const context = new Context(sampleMessages);
      const messages = context.getMessages();

      messages.push(new Message({ role: 'user', content: 'New message' }));

      expect(context.getMessageCount()).toBe(5); // Original unchanged
    });
  });

  describe('getMetadata', () => {
    it('should return a copy of metadata', () => {
      const context = new Context(sampleMessages);
      const metadata1 = context.getMetadata();
      const metadata2 = context.getMetadata();

      expect(metadata1).toEqual(metadata2);
      expect(metadata1).not.toBe(metadata2); // Different object instance
    });
  });

  describe('getStatistics', () => {
    it('should return message statistics', () => {
      const context = new Context(sampleMessages);
      const stats = context.getStatistics();

      expect(stats.totalMessages).toBe(5);
      expect(stats.userMessageCount).toBe(2);
      expect(stats.assistantMessageCount).toBe(2);
      expect(stats.systemMessageCount).toBe(1);
    });
  });

  describe('getTokenCount', () => {
    it('should return estimated token count', () => {
      const context = new Context(sampleMessages);
      const tokenCount = context.getTokenCount();

      expect(tokenCount).toBeGreaterThan(0);
      expect(typeof tokenCount).toBe('number');
    });
  });

  describe('clone', () => {
    it('should create a deep copy of context', () => {
      const original = new Context(sampleMessages, { sessionId: 'test-123' });
      const clone = original.clone();

      expect(clone).not.toBe(original);
      expect(clone.getMessageCount()).toBe(original.getMessageCount());
      expect(clone.getMetadata().sessionId).toBe('test-123');
    });

    it('should not share message references', () => {
      const original = new Context(sampleMessages);
      const clone = original.clone();

      const originalMessages = original.getMessages();
      const clonedMessages = clone.getMessages();

      expect(originalMessages[0]).not.toBe(clonedMessages[0]);
    });
  });

  describe('filter', () => {
    it('should filter messages by predicate', () => {
      const context = new Context(sampleMessages);
      const filtered = context.filter(m => m.role === 'user');

      expect(filtered.getMessageCount()).toBe(2);
      expect(filtered.getMessages().every(m => m.role === 'user')).toBe(true);
    });

    it('should not mutate original context', () => {
      const context = new Context(sampleMessages);
      const filtered = context.filter(m => m.role === 'user');

      expect(context.getMessageCount()).toBe(5);
      expect(filtered.getMessageCount()).toBe(2);
    });

    it('should update metadata', () => {
      const context = new Context(sampleMessages);
      const filtered = context.filter(m => m.role === 'user');
      const metadata = filtered.getMetadata();

      expect(metadata.windowSize).toBe(2);
      expect(metadata.totalMessages).toBe(2);
    });
  });

  describe('limit', () => {
    it('should limit to last N messages', () => {
      const context = new Context(sampleMessages);
      const limited = context.limit(3);

      expect(limited.getMessageCount()).toBe(3);

      const messages = limited.getMessages();
      expect(messages[0].content).toBe('Answer 1');
      expect(messages[2].content).toBe('Answer 2');
    });

    it('should not mutate original context', () => {
      const context = new Context(sampleMessages);
      const limited = context.limit(2);

      expect(context.getMessageCount()).toBe(5);
      expect(limited.getMessageCount()).toBe(2);
    });

    it('should handle limit larger than message count', () => {
      const context = new Context(sampleMessages);
      const limited = context.limit(100);

      expect(limited.getMessageCount()).toBe(5);
    });
  });

  describe('slice', () => {
    it('should slice messages like array', () => {
      const context = new Context(sampleMessages);
      const sliced = context.slice(1, 3);

      expect(sliced.getMessageCount()).toBe(2);

      const messages = sliced.getMessages();
      expect(messages[0].content).toBe('Question 1');
      expect(messages[1].content).toBe('Answer 1');
    });

    it('should handle negative indices', () => {
      const context = new Context(sampleMessages);
      const sliced = context.slice(-2);

      expect(sliced.getMessageCount()).toBe(2);

      const messages = sliced.getMessages();
      expect(messages[0].content).toBe('Question 2');
      expect(messages[1].content).toBe('Answer 2');
    });
  });

  describe('updateMetadata', () => {
    it('should update metadata', () => {
      const context = new Context(sampleMessages);

      context.updateMetadata({ strategy: 'token-limit', customField: 'value' });

      const metadata = context.getMetadata();
      expect(metadata.strategy).toBe('token-limit');
      expect(metadata.customField).toBe('value');
    });
  });

  describe('isEmpty', () => {
    it('should return true for empty context', () => {
      const context = new Context([]);
      expect(context.isEmpty()).toBe(true);
    });

    it('should return false for non-empty context', () => {
      const context = new Context(sampleMessages);
      expect(context.isEmpty()).toBe(false);
    });
  });

  describe('getFirstMessage and getLastMessage', () => {
    it('should get first message', () => {
      const context = new Context(sampleMessages);
      const first = context.getFirstMessage();

      expect(first).toBeDefined();
      expect(first!.content).toBe('System prompt');
    });

    it('should get last message', () => {
      const context = new Context(sampleMessages);
      const last = context.getLastMessage();

      expect(last).toBeDefined();
      expect(last!.content).toBe('Answer 2');
    });

    it('should return undefined for empty context', () => {
      const context = new Context([]);

      expect(context.getFirstMessage()).toBeUndefined();
      expect(context.getLastMessage()).toBeUndefined();
    });
  });

  describe('getMessagesByRole', () => {
    it('should get messages by role', () => {
      const context = new Context(sampleMessages);
      const userMessages = context.getMessagesByRole('user');

      expect(userMessages).toHaveLength(2);
      expect(userMessages.every(m => m.role === 'user')).toBe(true);
    });

    it('should return empty array if no matches', () => {
      const context = new Context(sampleMessages);
      const toolMessages = context.getMessagesByRole('tool');

      expect(toolMessages).toHaveLength(0);
    });
  });

  describe('toJSON and fromJSON', () => {
    it('should serialize and deserialize correctly', () => {
      const original = new Context(sampleMessages, {
        sessionId: 'test-session',
        strategy: 'sliding-window'
      });

      const json = original.toJSON();
      const restored = Context.fromJSON(json);

      expect(restored.getMessageCount()).toBe(original.getMessageCount());
      expect(restored.getMetadata().sessionId).toBe('test-session');
      expect(restored.getMetadata().strategy).toBe('sliding-window');
    });

    it('should preserve message content', () => {
      const original = new Context(sampleMessages);
      const json = original.toJSON();
      const restored = Context.fromJSON(json);

      const originalMessages = original.getMessages();
      const restoredMessages = restored.getMessages();

      expect(restoredMessages).toHaveLength(originalMessages.length);

      for (let i = 0; i < originalMessages.length; i++) {
        expect(restoredMessages[i].content).toBe(originalMessages[i].content);
        expect(restoredMessages[i].role).toBe(originalMessages[i].role);
        expect(restoredMessages[i].timestamp).toBe(originalMessages[i].timestamp);
      }
    });
  });

  describe('empty', () => {
    it('should create empty context with metadata', () => {
      const context = Context.empty({ sessionId: 'empty-session' });

      expect(context.isEmpty()).toBe(true);
      expect(context.getMetadata().sessionId).toBe('empty-session');
    });
  });

  describe('getContext', () => {
    it('should return raw format by default', () => {
      const context = new Context(sampleMessages);
      const result = context.getContext();

      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(5);
      expect(result[0]).toHaveProperty('role');
      expect(result[0]).toHaveProperty('content');
      expect(result[0]).toHaveProperty('timestamp');
    });

    it('should return raw format explicitly', () => {
      const context = new Context(sampleMessages);
      const result = context.getContext('raw');

      expect(result).toHaveLength(5);
      expect(result[0].role).toBe('system');
      expect(result[0].content).toBe('System prompt');
    });

    it('should return LLM format with transformations', () => {
      const messagesWithSources = [
        new Message({ role: 'user', content: 'Question', sources: ['file1.md', 'file2.md'] }),
        new Message({ role: 'assistant', content: 'Answer' })
      ];
      const context = new Context(messagesWithSources);
      const result = context.getContext('llm');

      expect(result).toHaveLength(2);
      expect(result[0]).not.toHaveProperty('sources');
    });

    it('should return display format', () => {
      const context = new Context(sampleMessages);
      const result = context.getContext('display');

      expect(result).toHaveLength(5);
      expect(result[0]).toHaveProperty('role');
      expect(result[0]).toHaveProperty('content');
    });

    it('should apply maxMessages limit', () => {
      const context = new Context(sampleMessages);
      const result = context.getContext('raw', { maxMessages: 3 });

      expect(result).toHaveLength(3);
      expect(result[0].content).toBe('Answer 1');
      expect(result[2].content).toBe('Answer 2');
    });

    it('should filter system messages', () => {
      const context = new Context(sampleMessages);
      const result = context.getContext('raw', { includeSystemMessages: false });

      expect(result.every(m => m.role !== 'system')).toBe(true);
      expect(result).toHaveLength(4);
    });

    it('should filter tool calls', () => {
      const messagesWithTools = [
        new Message({ role: 'user', content: 'Question' }),
        new Message({ role: 'tool', content: 'Tool result', name: 'test_tool' }),
        new Message({ role: 'assistant', content: 'Answer' })
      ];
      const context = new Context(messagesWithTools);
      const result = context.getContext('raw', { includeToolCalls: false });

      expect(result).toHaveLength(2);
      expect(result.every(m => m.role !== 'tool')).toBe(true);
    });

    it('should apply custom filter', () => {
      const context = new Context(sampleMessages);
      const result = context.getContext('raw', {
        filter: (m) => m.content.includes('Question')
      });

      expect(result).toHaveLength(2);
      expect(result.every(m => m.content.includes('Question'))).toBe(true);
    });

    it('should truncate long messages in LLM format', () => {
      const longMessage = new Message({ role: 'user', content: 'x'.repeat(3000) });
      const context = new Context([longMessage]);
      const result = context.getContext('llm');

      expect(result[0].content.length).toBeLessThan(3000);
      expect(result[0].content).toContain('[truncated]');
    });

    it('should merge consecutive tool messages in LLM format', () => {
      const messagesWithManyTools = [
        new Message({ role: 'user', content: 'Question' }),
        new Message({ role: 'tool', content: 'Tool 1', name: 'tool1' }),
        new Message({ role: 'tool', content: 'Tool 2', name: 'tool2' }),
        new Message({ role: 'tool', content: 'Tool 3', name: 'tool3' }),
        new Message({ role: 'assistant', content: 'Answer' })
      ];
      const context = new Context(messagesWithManyTools);
      const result = context.getContext('llm');

      // Should merge 3 consecutive tool messages into 1
      expect(result).toHaveLength(3); // user, merged_tools, assistant
      expect(result[1].role).toBe('tool');
      expect(result[1].name).toBe('merged_tools');
      expect(result[1].content).toContain('Tool 1');
      expect(result[1].content).toContain('Tool 2');
      expect(result[1].content).toContain('Tool 3');
    });

    it('should not merge 1-2 consecutive tool messages', () => {
      const messagesWithFewTools = [
        new Message({ role: 'user', content: 'Question' }),
        new Message({ role: 'tool', content: 'Tool 1', name: 'tool1' }),
        new Message({ role: 'tool', content: 'Tool 2', name: 'tool2' }),
        new Message({ role: 'assistant', content: 'Answer' })
      ];
      const context = new Context(messagesWithFewTools);
      const result = context.getContext('llm');

      // Should NOT merge only 2 consecutive tool messages
      expect(result).toHaveLength(4);
      expect(result[1].role).toBe('tool');
      expect(result[2].role).toBe('tool');
    });

    it('should apply maxTokens limit', () => {
      const context = new Context(sampleMessages);
      const result = context.getContext('raw', { maxTokens: 20 });

      // Should limit messages to fit within token budget
      expect(result.length).toBeLessThan(5);
      expect(result.length).toBeGreaterThan(0);
    });

    it('should preserve system messages when limiting by tokens', () => {
      const context = new Context(sampleMessages);
      const result = context.getContext('raw', { maxTokens: 20 });

      // System messages should be preserved
      const hasSystemMessage = result.some(m => m.role === 'system');
      expect(hasSystemMessage).toBe(true);
    });

    it('should combine multiple options', () => {
      const context = new Context(sampleMessages);
      const result = context.getContext('llm', {
        maxMessages: 3,
        includeSystemMessages: false
      });

      expect(result.length).toBeLessThanOrEqual(3);
      expect(result.every(m => m.role !== 'system')).toBe(true);
      expect(result.every(m => !m.sources)).toBe(true);
    });
  });

  describe('getContext - tool result summarization', () => {
    it('should keep recent tool results with full content', () => {
      const messages = [
        new Message({ role: 'user', content: 'Question' }),
        new Message({ role: 'tool', content: 'x'.repeat(300), name: 'tool1' }),
        new Message({ role: 'tool', content: 'y'.repeat(300), name: 'tool2' }),
        new Message({ role: 'assistant', content: 'Answer' })
      ];
      const context = new Context(messages);
      const result = context.getContext('llm', { keepRecentToolResults: 2 });

      // Both tool results should have full content (they're the latest 2)
      const toolResults = result.filter(m => m.role === 'tool');
      expect(toolResults[0].content.length).toBe(300);
      expect(toolResults[1].content.length).toBe(300);
    });

    it('should summarize old tool results > 200 chars', () => {
      const messages = [
        new Message({ role: 'user', content: 'Q1' }),
        new Message({ role: 'tool', content: 'x'.repeat(300), name: 'old_tool' }),
        new Message({ role: 'user', content: 'Q2' }),
        new Message({ role: 'tool', content: 'y'.repeat(100), name: 'recent1' }),
        new Message({ role: 'tool', content: 'z'.repeat(100), name: 'recent2' }),
        new Message({ role: 'assistant', content: 'Answer' })
      ];
      const context = new Context(messages);
      const result = context.getContext('llm', { keepRecentToolResults: 2 });

      // Old tool result should be summarized
      const toolResults = result.filter(m => m.role === 'tool');
      expect(toolResults[0].content).toContain('[summarized]');
      expect(toolResults[0].content.length).toBeLessThan(300);

      // Recent tool results should be full
      expect(toolResults[1].content.length).toBe(100);
      expect(toolResults[2].content.length).toBe(100);
    });

    it('should not summarize old tool results <= 200 chars', () => {
      const messages = [
        new Message({ role: 'tool', content: 'x'.repeat(150), name: 'old_tool' }),
        new Message({ role: 'tool', content: 'y'.repeat(100), name: 'recent' })
      ];
      const context = new Context(messages);
      const result = context.getContext('llm', { keepRecentToolResults: 1 });

      const toolResults = result.filter(m => m.role === 'tool');
      expect(toolResults[0].content).not.toContain('[summarized]');
      expect(toolResults[0].content.length).toBe(150);
    });

    it('should use default keepRecentToolResults = 5', () => {
      // Create messages with tool results separated by user messages to avoid merging
      const messages: Message[] = [];
      for (let i = 0; i < 10; i++) {
        messages.push(new Message({ role: 'tool', content: 'x'.repeat(300), name: `tool${i}` }));
        if (i < 9) {
          messages.push(new Message({ role: 'user', content: `Q${i}` }));
        }
      }
      const context = new Context(messages);
      const result = context.getContext('llm'); // No options

      const toolResults = result.filter(m => m.role === 'tool');
      // Should have 10 tool results
      expect(toolResults).toHaveLength(10);

      // Last 5 should be full, first 5 should be summarized
      for (let i = 0; i < 5; i++) {
        expect(toolResults[i].content).toContain('[summarized]');
      }
      for (let i = 5; i < 10; i++) {
        expect(toolResults[i].content.length).toBe(300);
      }
    });

    it('should summarize tool results before merging consecutive tools', () => {
      const messages = [
        new Message({ role: 'user', content: 'Question' }),
        new Message({ role: 'tool', content: 'a'.repeat(300), name: 'old1' }),
        new Message({ role: 'tool', content: 'b'.repeat(300), name: 'old2' }),
        new Message({ role: 'tool', content: 'c'.repeat(300), name: 'old3' }),
        new Message({ role: 'tool', content: 'd'.repeat(100), name: 'recent1' }),
        new Message({ role: 'tool', content: 'e'.repeat(100), name: 'recent2' }),
        new Message({ role: 'assistant', content: 'Answer' })
      ];
      const context = new Context(messages);
      const result = context.getContext('llm', { keepRecentToolResults: 2 });

      // Should have 3 messages: user, merged_tools, assistant
      expect(result).toHaveLength(3);
      expect(result[1].role).toBe('tool');
      expect(result[1].name).toBe('merged_tools');

      // Merged content should contain summarized old results and full recent results
      const mergedContent = result[1].content;
      expect(mergedContent).toContain('[summarized]');
      expect(mergedContent).toContain('d'.repeat(100));
      expect(mergedContent).toContain('e'.repeat(100));
    });

    it('should handle mixed tool and non-tool messages correctly', () => {
      const messages = [
        new Message({ role: 'user', content: 'Q1' }),
        new Message({ role: 'tool', content: 'x'.repeat(300), name: 'tool1' }),
        new Message({ role: 'assistant', content: 'A1' }),
        new Message({ role: 'user', content: 'Q2' }),
        new Message({ role: 'tool', content: 'y'.repeat(300), name: 'tool2' }),
        new Message({ role: 'assistant', content: 'A2' })
      ];
      const context = new Context(messages);
      const result = context.getContext('llm', { keepRecentToolResults: 1 });

      const toolResults = result.filter(m => m.role === 'tool');
      // First tool should be summarized, second should be full
      expect(toolResults[0].content).toContain('[summarized]');
      expect(toolResults[1].content.length).toBe(300);
    });

    it('should preserve summarization format with first and last parts', () => {
      const longContent = 'START' + 'x'.repeat(300) + 'END';
      const messages = [
        new Message({ role: 'tool', content: longContent, name: 'old_tool' }),
        new Message({ role: 'tool', content: 'recent', name: 'recent_tool' })
      ];
      const context = new Context(messages);
      const result = context.getContext('llm', { keepRecentToolResults: 1 });

      const toolResults = result.filter(m => m.role === 'tool');
      const summarized = toolResults[0].content;

      // Should contain start and end parts
      expect(summarized).toContain('START');
      expect(summarized).toContain('END');
      expect(summarized).toContain('[summarized]');
      expect(summarized.length).toBeLessThan(longContent.length);
    });
  });
});
