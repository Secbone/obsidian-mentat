// Chat Manager - Handles chat history persistence and management

import { ChatMessage } from '../types';
import PersonalAgentPlugin from '../main';
import { Context, Message, ContextOptions } from '../context';

interface ChatHistory {
  sessionId: string;
  messages: ChatMessage[];
  selectedFiles: string[]; // File paths of selected documents
  lastUpdated: number;
}

export class ChatManager {
  private plugin: PersonalAgentPlugin;
  private history: ChatMessage[] = [];
  private selectedFiles: Set<string> = new Set(); // Selected document paths
  private sessionId: string;
  private readonly STORAGE_KEY = 'mentat-chat-history';
  private readonly MAX_HISTORY_SIZE = 100; // Keep last 100 messages

  constructor(plugin: PersonalAgentPlugin) {
    this.plugin = plugin;
    this.sessionId = this.generateSessionId();
  }

  /**
   * Add a message to history
   */
  async addMessage(role: 'user' | 'assistant', content: string): Promise<void> {
    const message: ChatMessage = {
      role,
      content,
      timestamp: Date.now(),
      sources: [] // Not used for pure chat
    };

    this.history.push(message);

    // Trim history if too large
    if (this.history.length > this.MAX_HISTORY_SIZE) {
      this.history = this.history.slice(-this.MAX_HISTORY_SIZE);
    }

    await this.saveHistory();
  }

  /**
   * Replace history with new messages (for complete conversation with tool calls)
   * This replaces the old context messages with the new complete message array
   */
  async replaceMessages(messages: ChatMessage[]): Promise<void> {
    this.history = messages;

    // Trim history if too large
    if (this.history.length > this.MAX_HISTORY_SIZE) {
      this.history = this.history.slice(-this.MAX_HISTORY_SIZE);
    }

    await this.saveHistory();
  }

  /**
   * Get all messages in current session
   */
  async getHistory(): Promise<ChatMessage[]> {
    await this.loadHistory();
    return [...this.history];
  }

  /**
   * Clear all chat history
   */
  async clearHistory(): Promise<void> {
    this.history = [];
    this.sessionId = this.generateSessionId();
    await this.saveHistory();
  }

  /**
   * Get session information
   */
  getSessionInfo(): { sessionId: string; startTime?: number; lastUpdated?: number } {
    return {
      sessionId: this.sessionId,
      startTime: this.history[0]?.timestamp,
      lastUpdated: this.history[this.history.length - 1]?.timestamp
    };
  }

  /**
   * Create a Context object from current chat history
   */
  async createContext(): Promise<Context> {
    await this.loadHistory();

    // Convert ChatMessage[] to Message[]
    const messages = this.history.map(chatMsg => new Message({
      role: chatMsg.role,
      content: chatMsg.content,
      timestamp: chatMsg.timestamp,
      sources: chatMsg.sources,
      name: chatMsg.name,
      tool_call_id: chatMsg.tool_call_id,
      tool_calls: chatMsg.tool_calls
    }));

    return new Context(messages, {
      sessionId: this.sessionId,
      sessionStartTime: this.history[0]?.timestamp,
      lastUpdated: this.history[this.history.length - 1]?.timestamp
    });
  }

  /**
   * Get context optimized for LLM (convenience method)
   */
  async getContextForLLM(options?: ContextOptions): Promise<any[]> {
    const context = await this.createContext();
    return context.getContext('llm', options);
  }

  /**
   * Get context enhanced for display (convenience method)
   */
  async getContextForDisplay(options?: ContextOptions): Promise<any[]> {
    const context = await this.createContext();
    return context.getContext('display', options);
  }

  /**
   * Get raw context (convenience method)
   */
  async getRawContext(): Promise<any[]> {
    const context = await this.createContext();
    return context.getContext('raw');
  }

  /**
   * Save history to plugin data
   */
  private async saveHistory(): Promise<void> {
    const data: ChatHistory = {
      sessionId: this.sessionId,
      messages: this.history,
      selectedFiles: Array.from(this.selectedFiles),
      lastUpdated: Date.now()
    };

    // Use Obsidian's data storage (stored in .obsidian/plugins/mentat/)
    const pluginData = await this.plugin.loadData() || {};
    pluginData[this.STORAGE_KEY] = data;
    await this.plugin.saveData(pluginData);
  }

  /**
   * Load history from plugin data
   */
  private async loadHistory(): Promise<void> {
    if (this.history.length > 0) return; // Already loaded

    const pluginData = await this.plugin.loadData();
    if (!pluginData || !pluginData[this.STORAGE_KEY]) {
      return;
    }

    const data: ChatHistory = pluginData[this.STORAGE_KEY];

    // Only load if session is recent (within 7 days)
    const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
    if (data.lastUpdated > sevenDaysAgo) {
      this.history = data.messages;
      this.sessionId = data.sessionId;
      this.selectedFiles = new Set(data.selectedFiles || []);
    }
  }

  /**
   * Generate a unique session ID
   */
  private generateSessionId(): string {
    return `session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Add a document to the selected files
   */
  addDocument(filePath: string): void {
    this.selectedFiles.add(filePath);
    this.saveHistory();
  }

  /**
   * Remove a document from the selected files
   */
  removeDocument(filePath: string): void {
    this.selectedFiles.delete(filePath);
    this.saveHistory();
  }

  /**
   * Get all selected file paths
   */
  getSelectedFiles(): string[] {
    return Array.from(this.selectedFiles);
  }

  /**
   * Clear all selected documents
   */
  clearDocuments(): void {
    this.selectedFiles.clear();
    this.saveHistory();
  }

  /**
   * Export chat history as markdown
   */
  async exportAsMarkdown(): Promise<string> {
    let markdown = `# Chat History\n\n`;
    markdown += `Session: ${this.sessionId}\n\n`;
    markdown += `---\n\n`;

    for (const msg of this.history) {
      const date = new Date(msg.timestamp).toLocaleString();
      markdown += `## ${msg.role === 'user' ? 'You' : 'Assistant'} - ${date}\n\n`;
      markdown += `${msg.content}\n\n`;
      markdown += `---\n\n`;
    }

    return markdown;
  }
}
