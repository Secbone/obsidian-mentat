/**
 * Context Manager - Manages different views of chat message history
 *
 * Provides three distinct methods for retrieving context:
 * - getContextForLLM: Optimized for AI models (filtered, token-limited)
 * - getContextForDisplay: Enhanced for UI display (with metadata)
 * - getRawContext: Original unmodified message history
 */

import { ChatMessage } from '../types';
import {
  ContextManagerConfig,
  ContextOptions,
  ContextStrategy,
  ContextWindow,
  DisplayContext,
  DisplayMessage,
  ExportData,
  LLMContext,
  MessageGroup,
  RawContext
} from './context-types';
import { SlidingWindowStrategy } from './strategies/sliding-window-strategy';
import { TokenLimitStrategy } from './strategies/token-limit-strategy';
import { RelevanceStrategy } from './strategies/relevance-strategy';
import { ChatManager } from './chat-manager';

export class ContextManager {
  private chatManager: ChatManager;
  private strategies: Map<string, ContextStrategy>;
  private defaultStrategy: string;
  private config: ContextManagerConfig;
  private cache: Map<string, { context: any; timestamp: number }>;
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  constructor(chatManager: ChatManager, config?: ContextManagerConfig) {
    this.chatManager = chatManager;
    this.strategies = new Map();
    this.cache = new Map();

    // Initialize default strategies
    this.registerStrategy(new SlidingWindowStrategy());
    this.registerStrategy(new TokenLimitStrategy());
    this.registerStrategy(new RelevanceStrategy());

    // Apply configuration
    this.config = {
      defaultStrategy: config?.defaultStrategy ?? 'sliding-window',
      llmDefaults: config?.llmDefaults ?? {
        maxMessages: 50,
        includeSystemMessages: true,
        includeToolCalls: true,
        transformToolCalls: true
      },
      displayDefaults: config?.displayDefaults ?? {
        includeSystemMessages: true,
        includeToolCalls: true
      },
      enableCache: config?.enableCache ?? true,
      cacheTTL: config?.cacheTTL ?? this.CACHE_TTL,
      ...config
    };

    this.defaultStrategy = this.config.defaultStrategy!;

    // Register additional strategies from config
    if (config?.strategies) {
      config.strategies.forEach((strategy, name) => {
        this.strategies.set(name, strategy);
      });
    }
  }

  /**
   * Get context optimized for LLM consumption
   * Applies filtering, token limits, and transformations
   */
  async getContextForLLM(options?: ContextOptions): Promise<LLMContext> {
    const cacheKey = `llm-${JSON.stringify(options)}`;

    // Check cache
    if (this.config.enableCache && this.cache.has(cacheKey)) {
      const cached = this.cache.get(cacheKey)!;
      if (Date.now() - cached.timestamp < this.config.cacheTTL!) {
        return cached.context as LLMContext;
      }
    }

    // Merge with defaults
    const mergedOptions: ContextOptions = {
      ...this.config.llmDefaults,
      ...options
    };

    // Get strategy
    const strategyName = mergedOptions.strategy ?? this.defaultStrategy;
    const strategy = this.strategies.get(strategyName);

    if (!strategy) {
      throw new Error(`Strategy '${strategyName}' not found`);
    }

    // Get messages from chat manager
    const allMessages = await this.chatManager.getHistory();

    // Prepare context using strategy
    const contextWindow = await strategy.prepare(allMessages, mergedOptions);

    // Apply LLM-specific optimizations
    const optimizedMessages = this.optimizeForLLM(contextWindow.messages, mergedOptions);

    // Build LLM context
    const llmContext: LLMContext = {
      messages: optimizedMessages,
      metadata: {
        ...contextWindow.metadata,
        toolCallsCompressed: mergedOptions.transformToolCalls ?? false,
        messagesFiltered: allMessages.length - optimizedMessages.length,
        optimizations: this.getAppliedOptimizations(mergedOptions)
      }
    };

    // Cache result
    if (this.config.enableCache) {
      this.cache.set(cacheKey, {
        context: llmContext,
        timestamp: Date.now()
      });
    }

    return llmContext;
  }

  /**
   * Get context enhanced for UI display
   * Adds display metadata and formatting hints
   */
  async getContextForDisplay(options?: ContextOptions): Promise<DisplayContext> {
    const cacheKey = `display-${JSON.stringify(options)}`;

    // Check cache
    if (this.config.enableCache && this.cache.has(cacheKey)) {
      const cached = this.cache.get(cacheKey)!;
      if (Date.now() - cached.timestamp < this.config.cacheTTL!) {
        return cached.context as DisplayContext;
      }
    }

    // Merge with defaults
    const mergedOptions: ContextOptions = {
      ...this.config.displayDefaults,
      ...options
    };

    // Get all messages (display typically shows everything)
    const allMessages = await this.chatManager.getHistory();

    // Apply display filters if any
    let displayMessages = allMessages;
    if (mergedOptions.filter) {
      displayMessages = displayMessages.filter(mergedOptions.filter);
    }

    // Enhance messages for display
    const enhancedMessages = this.enhanceForDisplay(displayMessages);

    // Group messages if requested
    const messageGroups = this.groupMessages(enhancedMessages);

    // Build display context
    const displayContext: DisplayContext = {
      messages: enhancedMessages,
      metadata: {
        totalMessages: allMessages.length,
        windowSize: enhancedMessages.length,
        strategy: 'display',
        messageGroups,
        isGrouped: true
      }
    };

    // Cache result
    if (this.config.enableCache) {
      this.cache.set(cacheKey, {
        context: displayContext,
        timestamp: Date.now()
      });
    }

    return displayContext;
  }

  /**
   * Get raw unmodified context
   * Complete message history for export or debugging
   */
  async getRawContext(): Promise<RawContext> {
    const messages = await this.chatManager.getHistory();

    // Calculate statistics
    const userMessageCount = messages.filter(m => m.role === 'user').length;
    const assistantMessageCount = messages.filter(m => m.role === 'assistant').length;
    const toolCallCount = messages.filter(m => m.role === 'tool').length;
    const errorCount = messages.filter(m =>
      m.role === 'tool' && m.content.includes('Error:')
    ).length;

    const rawContext: RawContext = {
      messages,
      metadata: {
        totalMessages: messages.length,
        windowSize: messages.length,
        strategy: 'raw',
        sessionId: this.chatManager['sessionId'],
        sessionStartTime: messages[0]?.timestamp,
        lastUpdated: messages[messages.length - 1]?.timestamp,
        userMessageCount,
        assistantMessageCount,
        toolCallCount,
        errorCount,
        exportFormat: 'raw',
        version: '1.0.0',
        includesToolCalls: true,
        includesSources: true,
        includesTimestamps: true
      }
    };

    return rawContext;
  }

  /**
   * Register a custom strategy
   */
  registerStrategy(strategy: ContextStrategy): void {
    this.strategies.set(strategy.name, strategy);
  }

  /**
   * Set the default strategy
   */
  setDefaultStrategy(name: string): void {
    if (!this.strategies.has(name)) {
      throw new Error(`Strategy '${name}' not found`);
    }
    this.defaultStrategy = name;
    this.config.defaultStrategy = name;
  }

  /**
   * Get available strategy names
   */
  getAvailableStrategies(): string[] {
    return Array.from(this.strategies.keys());
  }

  /**
   * Clear the context cache
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Export context for persistence
   */
  async exportForPersistence(): Promise<ExportData> {
    const raw = await this.getRawContext();

    return {
      version: '1.0.0',
      exported: Date.now(),
      session: {
        sessionId: raw.metadata.sessionId,
        startTime: raw.metadata.sessionStartTime,
        lastUpdated: raw.metadata.lastUpdated
      },
      messages: raw.messages,
      checksum: this.calculateChecksum(raw.messages)
    };
  }

  /**
   * Import context from persistence
   */
  async importFromPersistence(data: ExportData): Promise<void> {
    if (!this.validateChecksum(data)) {
      throw new Error('Invalid checksum - data may be corrupted');
    }

    await this.chatManager.replaceMessages(data.messages);
  }

  /**
   * Optimize messages for LLM consumption
   */
  private optimizeForLLM(messages: ChatMessage[], options: ContextOptions): ChatMessage[] {
    let optimized = [...messages];

    // Remove redundant metadata
    optimized = optimized.map(msg => {
      const cleaned: ChatMessage = {
        role: msg.role,
        content: msg.content,
        timestamp: msg.timestamp
      };

      // Keep essential fields
      if (msg.name) cleaned.name = msg.name;
      if (msg.tool_call_id) cleaned.tool_call_id = msg.tool_call_id;
      if (msg.tool_calls) cleaned.tool_calls = msg.tool_calls;

      // Remove sources for LLM (they're in content if needed)
      // Don't include sources field

      return cleaned;
    });

    // Truncate very long messages
    optimized = optimized.map(msg => {
      if (msg.content.length > 2000) {
        return {
          ...msg,
          content: msg.content.substring(0, 1900) + '\n... [truncated]'
        };
      }
      return msg;
    });

    // Merge consecutive tool messages if many
    const toolMessageGroups: number[][] = [];
    let currentGroup: number[] = [];

    optimized.forEach((msg, idx) => {
      if (msg.role === 'tool') {
        currentGroup.push(idx);
      } else {
        if (currentGroup.length > 2) {
          toolMessageGroups.push(currentGroup);
        }
        currentGroup = [];
      }
    });

    if (currentGroup.length > 2) {
      toolMessageGroups.push(currentGroup);
    }

    // Merge tool message groups from end to start to preserve indices
    toolMessageGroups.reverse().forEach(group => {
      const toolMessages = group.map(idx => optimized[idx]);
      const merged = this.mergeToolMessages(toolMessages);
      optimized.splice(group[0], group.length, merged);
    });

    return optimized;
  }

  /**
   * Merge multiple tool messages
   */
  private mergeToolMessages(tools: ChatMessage[]): ChatMessage {
    if (tools.length === 1) return tools[0];

    const contents = tools.map(t => {
      const name = t.name || 'tool';
      const status = t.content.includes('Error:') ? '[ERROR]' : '[OK]';
      return `${status} ${name}: ${t.content.substring(0, 200)}${t.content.length > 200 ? '...' : ''}`;
    });

    return {
      role: 'tool',
      content: contents.join('\n'),
      timestamp: tools[0].timestamp,
      name: 'merged_tools',
      tool_call_id: tools[0].tool_call_id
    };
  }

  /**
   * Enhance messages for display
   */
  private enhanceForDisplay(messages: ChatMessage[]): DisplayMessage[] {
    return messages.map((msg, index) => {
      const enhanced: DisplayMessage = {
        ...msg,
        _display: {
          timestamp: new Date(msg.timestamp).toLocaleString(),
          isFirst: index === 0,
          isLast: index === messages.length - 1,
          hasToolCalls: !!msg.tool_calls?.length,
          toolCallCount: msg.tool_calls?.length || 0,
          toolCallStatus: this.getToolCallStatus(msg),
          isError: msg.role === 'tool' && msg.content.includes('Error:'),
          errorType: this.detectErrorType(msg),
          codeBlockCount: this.countCodeBlocks(msg.content),
          hasLinks: /https?:\/\//.test(msg.content),
          hasSources: msg.content.includes('**Sources:**') || msg.content.includes('Sources:'),
          isTruncated: false,
          originalLength: msg.content.length
        }
      };

      // Add copy button placeholders for code blocks
      if (enhanced._display!.codeBlockCount > 0) {
        enhanced._display!.copyButtons = Array(enhanced._display!.codeBlockCount)
          .fill(null)
          .map((_, i) => ({
            id: `copy-${msg.timestamp}-${i}`,
            copied: false
          }));
      }

      return enhanced;
    });
  }

  /**
   * Group messages for display
   */
  private groupMessages(messages: DisplayMessage[]): MessageGroup[] {
    const groups: MessageGroup[] = [];
    let currentGroup: DisplayMessage[] = [];
    let groupType: 'conversation' | 'tool-sequence' | 'error-sequence' = 'conversation';

    messages.forEach((msg, idx) => {
      if (msg.role === 'user') {
        // Save previous group if exists
        if (currentGroup.length > 0) {
          groups.push({
            id: `group-${groups.length}`,
            messages: currentGroup,
            timestamp: currentGroup[0].timestamp,
            type: groupType
          });
        }
        // Start new conversation group
        currentGroup = [msg];
        groupType = 'conversation';
      } else if (msg.role === 'tool' && msg._display?.isError) {
        // Error sequence
        if (groupType !== 'error-sequence') {
          if (currentGroup.length > 0) {
            groups.push({
              id: `group-${groups.length}`,
              messages: currentGroup,
              timestamp: currentGroup[0].timestamp,
              type: groupType
            });
          }
          currentGroup = [msg];
          groupType = 'error-sequence';
        } else {
          currentGroup.push(msg);
        }
      } else {
        currentGroup.push(msg);
      }
    });

    // Add last group
    if (currentGroup.length > 0) {
      groups.push({
        id: `group-${groups.length}`,
        messages: currentGroup,
        timestamp: currentGroup[0].timestamp,
        type: groupType
      });
    }

    return groups;
  }

  /**
   * Get tool call status from message
   */
  private getToolCallStatus(msg: ChatMessage): 'pending' | 'success' | 'error' | undefined {
    if (!msg.tool_calls?.length && msg.role !== 'tool') {
      return undefined;
    }

    if (msg.role === 'tool') {
      return msg.content.includes('Error:') ? 'error' : 'success';
    }

    return 'pending';
  }

  /**
   * Detect error type from message
   */
  private detectErrorType(msg: ChatMessage): string | undefined {
    if (!msg.content.includes('Error:')) {
      return undefined;
    }

    const content = msg.content.toLowerCase();
    if (content.includes('network')) return 'network';
    if (content.includes('timeout')) return 'timeout';
    if (content.includes('permission')) return 'permission';
    if (content.includes('not found')) return 'not_found';
    if (content.includes('syntax')) return 'syntax';
    if (content.includes('type')) return 'type';

    return 'unknown';
  }

  /**
   * Count code blocks in content
   */
  private countCodeBlocks(content: string): number {
    const matches = content.match(/```/g);
    return matches ? Math.floor(matches.length / 2) : 0;
  }

  /**
   * Get list of applied optimizations
   */
  private getAppliedOptimizations(options: ContextOptions): string[] {
    const optimizations: string[] = [];

    if (options.transformToolCalls) {
      optimizations.push('tool-call-compression');
    }

    if (options.includeSystemMessages === false) {
      optimizations.push('system-message-removal');
    }

    if (options.includeToolCalls === false) {
      optimizations.push('tool-call-filtering');
    }

    optimizations.push('message-truncation');
    optimizations.push('metadata-removal');

    return optimizations;
  }

  /**
   * Calculate checksum for data integrity
   */
  private calculateChecksum(messages: ChatMessage[]): string {
    const content = JSON.stringify(messages);
    let hash = 0;

    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }

    return hash.toString(16);
  }

  /**
   * Validate checksum
   */
  private validateChecksum(data: ExportData): boolean {
    if (!data.checksum) return true; // No checksum to validate

    const calculated = this.calculateChecksum(data.messages);
    return calculated === data.checksum;
  }
}