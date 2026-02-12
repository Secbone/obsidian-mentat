/**
 * Tests for Message class and utilities
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Message, MessageRole, calculateMessageStats, estimateTokens, estimateTotalTokens } from '../../src/context/message';

describe('Message', () => {
  describe('constructor', () => {
    it('should create a message with required fields', () => {
      const msg = new Message({ role: 'user', content: 'Hello' });

      expect(msg.role).toBe('user');
      expect(msg.content).toBe('Hello');
      expect(msg.timestamp).toBeDefined();
      expect(typeof msg.timestamp).toBe('number');
    });

    it('should create a message with all fields', () => {
      const timestamp = Date.now();
      const msg = new Message({
        role: 'assistant',
        content: 'Hi there',
        timestamp,
        sources: ['file1.md', 'file2.md'],
        name: 'test-assistant',
        tool_call_id: 'call_123',
        tool_calls: [{ id: 'tc1', name: 'search', arguments: '{}' }]
      });

      expect(msg.role).toBe('assistant');
      expect(msg.content).toBe('Hi there');
      expect(msg.timestamp).toBe(timestamp);
      expect(msg.sources).toEqual(['file1.md', 'file2.md']);
      expect(msg.name).toBe('test-assistant');
      expect(msg.tool_call_id).toBe('call_123');
      expect(msg.tool_calls).toHaveLength(1);
    });

    it('should auto-generate timestamp if not provided', () => {
      const before = Date.now();
      const msg = new Message({ role: 'user', content: 'Test' });
      const after = Date.now();

      expect(msg.timestamp).toBeGreaterThanOrEqual(before);
      expect(msg.timestamp).toBeLessThanOrEqual(after);
    });
  });

  describe('isToolCall', () => {
    it('should return true for tool role', () => {
      const msg = new Message({ role: 'tool', content: 'Result' });
      expect(msg.isToolCall()).toBe(true);
    });

    it('should return true for function role', () => {
      const msg = new Message({ role: 'function', content: 'Result' });
      expect(msg.isToolCall()).toBe(true);
    });

    it('should return false for user role', () => {
      const msg = new Message({ role: 'user', content: 'Question' });
      expect(msg.isToolCall()).toBe(false);
    });

    it('should return false for assistant role', () => {
      const msg = new Message({ role: 'assistant', content: 'Answer' });
      expect(msg.isToolCall()).toBe(false);
    });
  });

  describe('isError', () => {
    it('should return true for tool message with Error prefix', () => {
      const msg = new Message({ role: 'tool', content: 'Error: Something went wrong' });
      expect(msg.isError()).toBe(true);
    });

    it('should return false for tool message without Error prefix', () => {
      const msg = new Message({ role: 'tool', content: 'Success: Operation completed' });
      expect(msg.isError()).toBe(false);
    });

    it('should return false for non-tool message with Error prefix', () => {
      const msg = new Message({ role: 'user', content: 'Error: I have a question' });
      expect(msg.isError()).toBe(false);
    });
  });

  describe('hasToolCalls', () => {
    it('should return true when tool_calls array has items', () => {
      const msg = new Message({
        role: 'assistant',
        content: 'Let me search for that',
        tool_calls: [{ id: 'tc1', name: 'search', arguments: '{}' }]
      });
      expect(msg.hasToolCalls()).toBe(true);
    });

    it('should return false when tool_calls is empty', () => {
      const msg = new Message({
        role: 'assistant',
        content: 'Answer',
        tool_calls: []
      });
      expect(msg.hasToolCalls()).toBe(false);
    });

    it('should return false when tool_calls is undefined', () => {
      const msg = new Message({ role: 'assistant', content: 'Answer' });
      expect(msg.hasToolCalls()).toBe(false);
    });
  });

  describe('clone', () => {
    it('should create a deep copy of the message', () => {
      const original = new Message({
        role: 'user',
        content: 'Test',
        timestamp: 12345,
        sources: ['file1.md']
      });

      const clone = original.clone();

      expect(clone).not.toBe(original);
      expect(clone.role).toBe(original.role);
      expect(clone.content).toBe(original.content);
      expect(clone.timestamp).toBe(original.timestamp);
      expect(clone.sources).toEqual(original.sources);
      expect(clone.sources).not.toBe(original.sources); // Different array instance
    });

    it('should clone tool calls', () => {
      const original = new Message({
        role: 'assistant',
        content: 'Calling tool',
        tool_calls: [{ id: 'tc1', name: 'search', arguments: '{}' }]
      });

      const clone = original.clone();

      expect(clone.tool_calls).toEqual(original.tool_calls);
      expect(clone.tool_calls).not.toBe(original.tool_calls);
    });
  });

  describe('toJSON and fromJSON', () => {
    it('should serialize and deserialize correctly', () => {
      const original = new Message({
        role: 'assistant',
        content: 'Test message',
        timestamp: 12345,
        sources: ['file1.md'],
        name: 'assistant',
        tool_call_id: 'call_123',
        tool_calls: [{ id: 'tc1', name: 'search', arguments: { query: 'test' } }]
      });

      const json = original.toJSON();
      const restored = Message.fromJSON(json);

      expect(restored.role).toBe(original.role);
      expect(restored.content).toBe(original.content);
      expect(restored.timestamp).toBe(original.timestamp);
      expect(restored.sources).toEqual(original.sources);
      expect(restored.name).toBe(original.name);
      expect(restored.tool_call_id).toBe(original.tool_call_id);
      expect(restored.tool_calls).toEqual(original.tool_calls);
    });
  });
});

describe('calculateMessageStats', () => {
  it('should calculate statistics for empty array', () => {
    const stats = calculateMessageStats([]);

    expect(stats.totalMessages).toBe(0);
    expect(stats.userMessageCount).toBe(0);
    expect(stats.assistantMessageCount).toBe(0);
    expect(stats.systemMessageCount).toBe(0);
    expect(stats.toolCallCount).toBe(0);
    expect(stats.errorCount).toBe(0);
  });

  it('should calculate statistics correctly', () => {
    const messages = [
      new Message({ role: 'system', content: 'System prompt' }),
      new Message({ role: 'user', content: 'Question 1' }),
      new Message({ role: 'assistant', content: 'Answer 1' }),
      new Message({ role: 'user', content: 'Question 2' }),
      new Message({ role: 'assistant', content: 'Answer 2' }),
      new Message({ role: 'tool', content: 'Tool result' }),
      new Message({ role: 'tool', content: 'Error: Failed' }),
    ];

    const stats = calculateMessageStats(messages);

    expect(stats.totalMessages).toBe(7);
    expect(stats.userMessageCount).toBe(2);
    expect(stats.assistantMessageCount).toBe(2);
    expect(stats.systemMessageCount).toBe(1);
    expect(stats.toolCallCount).toBe(2);
    expect(stats.errorCount).toBe(1);
  });
});

describe('estimateTokens', () => {
  it('should estimate tokens for simple message', () => {
    const msg = new Message({ role: 'user', content: 'Hello' });
    const tokens = estimateTokens(msg);

    // "Hello" = 5 chars + 10 overhead = 15 chars / 4 = ~4 tokens
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(10);
  });

  it('should estimate more tokens for longer content', () => {
    const shortMsg = new Message({ role: 'user', content: 'Hi' });
    const longMsg = new Message({ role: 'user', content: 'This is a much longer message with many more words' });

    const shortTokens = estimateTokens(shortMsg);
    const longTokens = estimateTokens(longMsg);

    expect(longTokens).toBeGreaterThan(shortTokens);
  });

  it('should include tool call overhead', () => {
    const msgWithoutTools = new Message({ role: 'assistant', content: 'Answer' });
    const msgWithTools = new Message({
      role: 'assistant',
      content: 'Answer',
      tool_calls: [{ id: 'tc1', name: 'search', arguments: { query: 'test query' } }]
    });

    const tokensWithoutTools = estimateTokens(msgWithoutTools);
    const tokensWithTools = estimateTokens(msgWithTools);

    expect(tokensWithTools).toBeGreaterThan(tokensWithoutTools);
  });
});

describe('estimateTotalTokens', () => {
  it('should return 0 for empty array', () => {
    expect(estimateTotalTokens([])).toBe(0);
  });

  it('should sum tokens for multiple messages', () => {
    const messages = [
      new Message({ role: 'user', content: 'Hello' }),
      new Message({ role: 'assistant', content: 'Hi there' }),
      new Message({ role: 'user', content: 'How are you?' })
    ];

    const total = estimateTotalTokens(messages);
    const sum = messages.reduce((acc, msg) => acc + estimateTokens(msg), 0);

    expect(total).toBe(sum);
    expect(total).toBeGreaterThan(0);
  });
});
