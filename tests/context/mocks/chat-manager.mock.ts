import { ChatMessage } from '../../../src/types';

/**
 * Mock ChatManager for testing ContextManager
 * Provides configurable message history without Obsidian dependencies
 */
export class MockChatManager {
  private messages: ChatMessage[] = [];
  public sessionId: string = 'test-session-123';

  /**
   * Set the messages that will be returned by getHistory()
   */
  setMessages(messages: ChatMessage[]): void {
    this.messages = messages;
  }

  /**
   * Mock implementation of ChatManager.getHistory()
   * Returns a copy of the configured messages
   */
  async getHistory(): Promise<ChatMessage[]> {
    return [...this.messages];
  }

  /**
   * Reset the mock to empty state
   */
  reset(): void {
    this.messages = [];
    this.sessionId = 'test-session-123';
  }
}

/**
 * Helper function to create a MockChatManager instance
 * @param messages - Optional initial messages
 * @returns Configured MockChatManager instance
 */
export function createMockChatManager(messages?: ChatMessage[]): MockChatManager {
  const mock = new MockChatManager();
  if (messages) {
    mock.setMessages(messages);
  }
  return mock;
}
