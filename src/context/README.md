# Context Module

Comprehensive context management system for chat message history, providing optimized views for different consumers (LLM, UI, export).

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Core Components](#core-components)
- [Strategies](#strategies)
- [Usage Examples](#usage-examples)
- [API Reference](#api-reference)
- [Integration Points](#integration-points)
- [Performance Considerations](#performance-considerations)
- [Extension Guide](#extension-guide)

## Overview

The context module manages chat message history and provides three distinct context types optimized for different use cases:

- **LLMContext** - Optimized for AI models (filtered, token-limited, compressed)
- **DisplayContext** - Enhanced for UI with metadata and formatting hints
- **RawContext** - Complete unmodified history for export and debugging

### Key Features

- **Strategy Pattern**: Three built-in strategies for context preparation
- **Intelligent Caching**: 5-minute TTL cache for prepared contexts
- **Token Management**: Accurate token estimation (~4 chars per token)
- **Export/Import**: Data persistence with checksum validation
- **Flexible Configuration**: Customizable defaults and options
- **Type Safety**: Full TypeScript support with comprehensive interfaces

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      ContextManager                          │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐            │
│  │   Cache    │  │ Strategies │  │   Config   │            │
│  └────────────┘  └────────────┘  └────────────┘            │
└─────────────────────────────────────────────────────────────┘
                           │
        ┌──────────────────┼──────────────────┐
        │                  │                  │
        ▼                  ▼                  ▼
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│ LLMContext   │  │DisplayContext│  │ RawContext   │
│              │  │              │  │              │
│ - Filtered   │  │ - Enhanced   │  │ - Complete   │
│ - Optimized  │  │ - Metadata   │  │ - Statistics │
│ - Compressed │  │ - Grouped    │  │ - Export     │
└──────────────┘  └──────────────┘  └──────────────┘
        │                  │                  │
        └──────────────────┼──────────────────┘
                           │
                           ▼
                  ┌─────────────────┐
                  │   Strategies    │
                  ├──────────────��──┤
                  │ Sliding Window  │
                  │ Token Limit     │
                  │ Relevance       │
                  └─────────────────┘
```

## Core Components

### ContextManager

The main orchestrator that manages context retrieval, caching, and strategy selection.

**Responsibilities:**
- Coordinate context preparation using strategies
- Manage caching with configurable TTL
- Apply context-specific optimizations
- Handle export/import operations
- Register and manage strategies

**Key Methods:**
- `getContextForLLM(options?)` - Get optimized context for AI models
- `getContextForDisplay(options?)` - Get enhanced context for UI
- `getRawContext()` - Get complete unmodified history
- `registerStrategy(strategy)` - Add custom strategies
- `setDefaultStrategy(name)` - Change default strategy
- `clearCache()` - Clear cached contexts
- `exportForPersistence()` - Export with checksum
- `importFromPersistence(data)` - Import with validation

### Context Types

#### LLMContext

Optimized for AI model consumption with aggressive filtering and compression.

**Features:**
- Message filtering (system, tool calls)
- Token limit enforcement
- Tool call compression
- Message truncation (>2000 chars)
- Metadata removal
- Consecutive tool message merging

**Metadata:**
```typescript
{
  totalMessages: number;
  windowSize: number;
  strategy: string;
  tokenCount: number;
  toolCallsCompressed: boolean;
  messagesFiltered: number;
  optimizations: string[];
}
```

#### DisplayContext

Enhanced for UI rendering with rich metadata and formatting hints.

**Features:**
- Display metadata for each message
- Message grouping (conversation, tool-sequence, error-sequence)
- Timestamp formatting
- Code block detection
- Link and source detection
- Error type classification
- Copy button placeholders

**Display Metadata:**
```typescript
{
  timestamp: string;           // Human-readable
  isFirst: boolean;
  isLast: boolean;
  hasToolCalls: boolean;
  toolCallCount: number;
  toolCallStatus: 'pending' | 'success' | 'error';
  isError: boolean;
  errorType: string;
  codeBlockCount: number;
  hasLinks: boolean;
  hasSources: boolean;
  isTruncated: boolean;
  originalLength: number;
  isStreaming: boolean;
  copyButtons: Array<{ id: string; copied: boolean }>;
}
```

#### RawContext

Complete unmodified message history with comprehensive statistics.

**Features:**
- Full message history
- Session metadata
- Message statistics by role
- Export format metadata
- Checksum for integrity

**Statistics:**
```typescript
{
  sessionId: string;
  sessionStartTime: number;
  lastUpdated: number;
  userMessageCount: number;
  assistantMessageCount: number;
  toolCallCount: number;
  errorCount: number;
  exportFormat: 'raw';
  version: string;
}
```

## Strategies

### Sliding Window Strategy

Keeps the last N messages, always preserving system messages.

**Name:** `sliding-window`

**Default Configuration:**
- `maxMessages`: 50
- `includeSystemMessages`: true

**How It Works:**
1. Separates system messages from other messages
2. Always includes system messages (if enabled)
3. Takes the most recent N non-system messages
4. Applies filters (tool calls, custom)
5. Transforms tool calls if requested

**Use Cases:**
- Simple recent conversation history
- Fixed-size context windows
- Predictable memory usage
- Quick context preparation

**Example:**
```typescript
const context = await contextManager.getContextForLLM({
  strategy: 'sliding-window',
  maxMessages: 30,
  includeSystemMessages: true,
  includeToolCalls: true
});
```

**Token Estimation:**
- ~4 characters per token
- Includes message structure overhead (~20 chars)
- Includes tool call overhead (~50 chars per call)

### Token Limit Strategy

Limits context by estimated token count, prioritizing important messages.

**Name:** `token-limit`

**Default Configuration:**
- `maxTokens`: 4000
- `includeSystemMessages`: true
- `MAX_MESSAGE_LENGTH`: 2000 chars

**How It Works:**
1. Categorizes messages by priority:
   - System messages (highest priority)
   - Error messages (high priority)
   - Recent messages (normal priority)
2. Builds context starting with high-priority messages
3. Fills remaining space with recent messages
4. Truncates long messages if needed
5. Merges consecutive tool messages to save tokens

**Use Cases:**
- Strict API token budgets
- Cost optimization
- Large conversation histories
- Token-aware applications

**Example:**
```typescript
const context = await contextManager.getContextForLLM({
  strategy: 'token-limit',
  maxTokens: 3000,
  transformToolCalls: true
});
```

**Token Estimation:**
- Content length + 25 chars overhead
- Tool call: name + args + 50 chars overhead
- Tool response: content + 50 chars + name + ID
- ~4 characters per token

**Priority System:**
1. System messages (always included first)
2. Recent error messages (last 3)
3. Recent messages (newest first, until limit)

### Relevance Strategy

Keeps relevant conversation pairs based on scoring algorithm.

**Name:** `relevance`

**Default Configuration:**
- `maxTokens`: 4000
- `MIN_CONVERSATION_PAIRS`: 3

**How It Works:**
1. Identifies conversation pairs (user → assistant + tools)
2. Scores conversations based on:
   - Recency (0-100 points)
   - Error messages (+50 points)
   - Code blocks (+30 points)
   - Questions (+20 points)
   - Tool usage (+25 points)
   - Length >3 messages (+15 points)
   - Important keywords (+10 points each)
3. Always includes minimum recent conversation pairs
4. Fills remaining space with highest-scored conversations
5. Summarizes conversations if needed to fit

**Use Cases:**
- Complex conversations with context awareness
- Long-running sessions
- Maintaining conversation coherence
- Intelligent context selection

**Example:**
```typescript
const context = await contextManager.getContextForLLM({
  strategy: 'relevance',
  maxTokens: 4000,
  includeToolCalls: true
});
```

**Scoring Algorithm:**
```typescript
score = recencyScore           // (index / total) * 100
      + errorBonus             // +50 if contains errors
      + codeBlockBonus         // +30 if contains code
      + questionBonus          // +20 if contains questions
      + toolUsageBonus         // +25 if uses tools
      + lengthBonus            // +15 if >3 messages
      + keywordBonus           // +10 per important keyword
```

**Important Keywords:**
- important, critical, error, failed, success
- complete, finish, bug, issue, problem, solution

## Usage Examples

### Basic Usage with ChatManager

```typescript
import { ChatManager } from './chat-manager';
import { ContextManager } from './context-manager';

// Initialize
const chatManager = new ChatManager();
const contextManager = new ContextManager(chatManager);

// Get context for LLM
const llmContext = await contextManager.getContextForLLM();
console.log(`Using ${llmContext.messages.length} messages`);
console.log(`Estimated tokens: ${llmContext.metadata.tokenCount}`);

// Get context for display
const displayContext = await contextManager.getContextForDisplay();
console.log(`Displaying ${displayContext.messages.length} messages`);
console.log(`Grouped into ${displayContext.metadata.messageGroups?.length} groups`);

// Get raw context
const rawContext = await contextManager.getRawContext();
console.log(`Total messages: ${rawContext.metadata.totalMessages}`);
console.log(`User messages: ${rawContext.metadata.userMessageCount}`);
```

### Switching Strategies

```typescript
// Use sliding window strategy
const slidingContext = await contextManager.getContextForLLM({
  strategy: 'sliding-window',
  maxMessages: 30
});

// Use token limit strategy
const tokenContext = await contextManager.getContextForLLM({
  strategy: 'token-limit',
  maxTokens: 3000
});

// Use relevance strategy
const relevanceContext = await contextManager.getContextForLLM({
  strategy: 'relevance',
  maxTokens: 4000
});

// Change default strategy
contextManager.setDefaultStrategy('relevance');
```

### Custom Filtering

```typescript
// Filter out specific message types
const context = await contextManager.getContextForLLM({
  includeSystemMessages: false,
  includeToolCalls: false,
  filter: (message) => {
    // Only include user and assistant messages
    return message.role === 'user' || message.role === 'assistant';
  }
});

// Filter by content
const codeContext = await contextManager.getContextForLLM({
  filter: (message) => {
    // Only include messages with code blocks
    return message.content.includes('```');
  }
});
```

### Configuring Options

```typescript
// Custom configuration
const contextManager = new ContextManager(chatManager, {
  defaultStrategy: 'relevance',
  llmDefaults: {
    maxMessages: 100,
    maxTokens: 8000,
    includeSystemMessages: true,
    includeToolCalls: true,
    transformToolCalls: true
  },
  displayDefaults: {
    includeSystemMessages: true,
    includeToolCalls: true
  },
  enableCache: true,
  cacheTTL: 10 * 60 * 1000 // 10 minutes
});
```

### Using Different Context Types

```typescript
// For LLM API calls
const llmContext = await contextManager.getContextForLLM({
  maxTokens: 4000,
  transformToolCalls: true
});
await sendToLLM(llmContext.messages);

// For UI rendering
const displayContext = await contextManager.getContextForDisplay();
displayContext.messages.forEach(msg => {
  console.log(`[${msg._display?.timestamp}] ${msg.role}: ${msg.content}`);
  if (msg._display?.hasToolCalls) {
    console.log(`  → ${msg._display.toolCallCount} tool calls`);
  }
});

// For export/backup
const rawContext = await contextManager.getRawContext();
await saveToFile(rawContext);
```

### Export and Import

```typescript
// Export context
const exportData = await contextManager.exportForPersistence();
await fs.writeFile('chat-history.json', JSON.stringify(exportData, null, 2));

// Import context
const importData = JSON.parse(await fs.readFile('chat-history.json', 'utf-8'));
await contextManager.importFromPersistence(importData);
// Throws error if checksum validation fails
```

### Cache Management

```typescript
// Clear cache when messages change
chatManager.on('messageAdded', () => {
  contextManager.clearCache();
});

// Or disable caching entirely
const contextManager = new ContextManager(chatManager, {
  enableCache: false
});

// Check available strategies
const strategies = contextManager.getAvailableStrategies();
console.log('Available strategies:', strategies);
// Output: ['sliding-window', 'token-limit', 'relevance']
```

## API Reference

### ContextManager

#### Constructor

```typescript
constructor(chatManager: ChatManager, config?: ContextManagerConfig)
```

**Parameters:**
- `chatManager`: ChatManager instance
- `config`: Optional configuration

**Config Options:**
```typescript
interface ContextManagerConfig {
  defaultStrategy?: string;           // Default: 'sliding-window'
  llmDefaults?: ContextOptions;       // Default LLM options
  displayDefaults?: ContextOptions;   // Default display options
  strategies?: Map<string, ContextStrategy>;
  enableCache?: boolean;              // Default: true
  cacheTTL?: number;                  // Default: 300000 (5 min)
}
```

#### Methods

##### getContextForLLM(options?)

Get context optimized for LLM consumption.

```typescript
async getContextForLLM(options?: ContextOptions): Promise<LLMContext>
```

**Options:**
```typescript
interface ContextOptions {
  maxMessages?: number;              // Max messages to include
  maxTokens?: number;                // Max token count
  includeSystemMessages?: boolean;   // Include system messages
  includeToolCalls?: boolean;        // Include tool calls
  transformToolCalls?: boolean;      // Compress tool calls
  strategy?: string;                 // Strategy name
  filter?: (message: ChatMessage) => boolean;  // Custom filter
}
```

**Returns:** `LLMContext` with optimized messages and metadata

##### getContextForDisplay(options?)

Get context enhanced for UI display.

```typescript
async getContextForDisplay(options?: ContextOptions): Promise<DisplayContext>
```

**Returns:** `DisplayContext` with enhanced messages and display metadata

##### getRawContext()

Get complete unmodified context.

```typescript
async getRawContext(): Promise<RawContext>
```

**Returns:** `RawContext` with full history and statistics

##### registerStrategy(strategy)

Register a custom strategy.

```typescript
registerStrategy(strategy: ContextStrategy): void
```

**Parameters:**
- `strategy`: Strategy implementing `ContextStrategy` interface

##### setDefaultStrategy(name)

Set the default strategy.

```typescript
setDefaultStrategy(name: string): void
```

**Parameters:**
- `name`: Strategy name (must be registered)

**Throws:** Error if strategy not found

##### getAvailableStrategies()

Get list of available strategy names.

```typescript
getAvailableStrategies(): string[]
```

**Returns:** Array of strategy names

##### clearCache()

Clear the context cache.

```typescript
clearCache(): void
```

##### exportForPersistence()

Export context for persistence.

```typescript
async exportForPersistence(): Promise<ExportData>
```

**Returns:** Export data with checksum

##### importFromPersistence(data)

Import context from persistence.

```typescript
async importFromPersistence(data: ExportData): Promise<void>
```

**Parameters:**
- `data`: Export data with checksum

**Throws:** Error if checksum validation fails

### ContextStrategy Interface

```typescript
interface ContextStrategy {
  name: string;

  prepare(
    messages: ChatMessage[],
    options?: ContextOptions
  ): Promise<ContextWindow>;

  estimateTokens(messages: ChatMessage[]): number;

  validate?(options: ContextOptions): boolean;
}
```

## Integration Points

### ChatManager Integration

The ContextManager requires a ChatManager instance to access message history.

```typescript
// src/context/chat-manager.ts
const chatManager = new ChatManager();
const contextManager = new ContextManager(chatManager);

// ChatManager provides:
// - getHistory(): Promise<ChatMessage[]>
// - replaceMessages(messages: ChatMessage[]): Promise<void>
```

### BaseAgent Usage

Agents use ContextManager to prepare context for LLM calls.

```typescript
// In BaseAgent or similar
class BaseAgent {
  private contextManager: ContextManager;

  async prepareContext(): Promise<ChatMessage[]> {
    const context = await this.contextManager.getContextForLLM({
      strategy: 'token-limit',
      maxTokens: 4000,
      transformToolCalls: true
    });

    return context.messages;
  }
}
```

### ChatOrchestrator Usage

Orchestrator manages context across multiple agents.

```typescript
// In ChatOrchestrator
class ChatOrchestrator {
  async handleUserMessage(message: string) {
    // Get context for current agent
    const context = await this.contextManager.getContextForLLM({
      strategy: this.currentAgent.preferredStrategy,
      maxTokens: this.currentAgent.maxTokens
    });

    // Send to agent
    await this.currentAgent.process(context.messages);
  }
}
```

### UI Layer (ChatView) Usage

UI components use DisplayContext for rendering.

```typescript
// In ChatView or similar
class ChatView {
  async renderMessages() {
    const displayContext = await this.contextManager.getContextForDisplay();

    // Render message groups
    displayContext.metadata.messageGroups?.forEach(group => {
      this.renderGroup(group);
    });

    // Render individual messages with metadata
    displayContext.messages.forEach(msg => {
      const display = msg._display;

      // Use display metadata for rendering
      if (display?.hasToolCalls) {
        this.renderToolCalls(msg, display.toolCallCount);
      }

      if (display?.codeBlockCount > 0) {
        this.renderCodeBlocks(msg, display.copyButtons);
      }

      if (display?.isError) {
        this.renderError(msg, display.errorType);
      }
    });
  }
}
```

## Performance Considerations

### Caching

- **TTL**: 5 minutes by default (configurable)
- **Cache Key**: Based on context type and options
- **Invalidation**: Manual via `clearCache()` or automatic on TTL expiry
- **Memory**: Caches prepared contexts (not raw messages)

**Best Practices:**
```typescript
// Clear cache when messages change
chatManager.on('messageAdded', () => {
  contextManager.clearCache();
});

// Adjust TTL based on usage patterns
const contextManager = new ContextManager(chatManager, {
  cacheTTL: 2 * 60 * 1000  // 2 minutes for high-frequency updates
});
```

### Token Estimation

- **Method**: Character-based approximation
- **Ratio**: ~4 characters per token
- **Accuracy**: Approximate (sufficient for most use cases)
- **Overhead**: Includes message structure and tool call overhead

**Estimation Formula:**
```
tokens = ceil((content_length + structure_overhead) / 4)

structure_overhead = 25 (base)
                   + tool_call_overhead (50 per call)
                   + tool_response_overhead (50 + name + id)
```

### Memory Usage

- **Caching**: Stores prepared contexts (not duplicating raw messages)
- **Strategy Execution**: Temporary arrays during preparation
- **Message Copying**: Shallow copies for transformations

**Memory Optimization:**
```typescript
// Disable caching for memory-constrained environments
const contextManager = new ContextManager(chatManager, {
  enableCache: false
});

// Use sliding window for predictable memory usage
const context = await contextManager.getContextForLLM({
  strategy: 'sliding-window',
  maxMessages: 20  // Fixed size
});
```

### Strategy Complexity

| Strategy | Time Complexity | Space Complexity | Best For |
|----------|----------------|------------------|----------|
| Sliding Window | O(n) | O(1) | Simple, fast |
| Token Limit | O(n) | O(n) | Token budgets |
| Relevance | O(n²) | O(n) | Quality context |

**Performance Tips:**
- Use `sliding-window` for real-time applications
- Use `token-limit` for API cost optimization
- Use `relevance` for complex conversations where quality matters
- Clear cache after bulk message operations
- Adjust `maxMessages` or `maxTokens` based on performance needs

## Extension Guide

### Creating Custom Strategies

Implement the `ContextStrategy` interface to create custom strategies.

#### Step 1: Implement the Interface

```typescript
import { ContextStrategy, ContextWindow, ContextOptions } from './context-types';
import { ChatMessage } from '../types';

export class CustomStrategy implements ContextStrategy {
  name = 'custom-strategy';

  async prepare(
    messages: ChatMessage[],
    options?: ContextOptions
  ): Promise<ContextWindow> {
    // Your custom logic here
    const selectedMessages = this.selectMessages(messages, options);

    return {
      messages: selectedMessages,
      metadata: {
        totalMessages: messages.length,
        windowSize: selectedMessages.length,
        strategy: this.name,
        tokenCount: this.estimateTokens(selectedMessages),
        isTruncated: messages.length > selectedMessages.length
      }
    };
  }

  estimateTokens(messages: ChatMessage[]): number {
    // Implement token estimation
    return messages.reduce((total, msg) => {
      return total + Math.ceil((msg.content.length + 25) / 4);
    }, 0);
  }

  validate(options: ContextOptions): boolean {
    // Optional: validate options
    return true;
  }

  private selectMessages(
    messages: ChatMessage[],
    options?: ContextOptions
  ): ChatMessage[] {
    // Your selection logic
    return messages;
  }
}
```

#### Step 2: Register the Strategy

```typescript
import { CustomStrategy } from './strategies/custom-strategy';

const contextManager = new ContextManager(chatManager);
contextManager.registerStrategy(new CustomStrategy());

// Use the custom strategy
const context = await contextManager.getContextForLLM({
  strategy: 'custom-strategy'
});
```

#### Step 3: Set as Default (Optional)

```typescript
contextManager.setDefaultStrategy('custom-strategy');

// Now used by default
const context = await contextManager.getContextForLLM();
```

### Strategy Requirements

Your custom strategy must:

1. **Implement `prepare()`**: Core logic for message selection
2. **Implement `estimateTokens()`**: Token count estimation
3. **Return valid `ContextWindow`**: With messages and metadata
4. **Handle options**: Respect `ContextOptions` parameters
5. **Maintain order**: Keep messages in chronological order

### Best Practices

1. **Respect Options**: Honor `includeSystemMessages`, `includeToolCalls`, `filter`
2. **Token Estimation**: Use consistent estimation method (~4 chars/token)
3. **Metadata**: Provide accurate metadata (totalMessages, windowSize, etc.)
4. **Performance**: Optimize for large message histories
5. **Validation**: Implement `validate()` for option checking
6. **Documentation**: Document strategy behavior and use cases

### Example: Priority-Based Strategy

```typescript
export class PriorityStrategy implements ContextStrategy {
  name = 'priority';

  async prepare(
    messages: ChatMessage[],
    options?: ContextOptions
  ): Promise<ContextWindow> {
    const maxTokens = options?.maxTokens ?? 4000;

    // Assign priorities
    const prioritized = messages.map(msg => ({
      message: msg,
      priority: this.calculatePriority(msg)
    }));

    // Sort by priority (highest first)
    prioritized.sort((a, b) => b.priority - a.priority);

    // Select messages within token limit
    const selected: ChatMessage[] = [];
    let tokens = 0;

    for (const item of prioritized) {
      const msgTokens = this.estimateMessageTokens(item.message);
      if (tokens + msgTokens <= maxTokens) {
        selected.push(item.message);
        tokens += msgTokens;
      }
    }

    // Restore chronological order
    selected.sort((a, b) => a.timestamp - b.timestamp);

    return {
      messages: selected,
      metadata: {
        totalMessages: messages.length,
        windowSize: selected.length,
        strategy: this.name,
        tokenCount: tokens,
        isTruncated: messages.length > selected.length
      }
    };
  }

  private calculatePriority(message: ChatMessage): number {
    let priority = 0;

    // System messages: highest priority
    if (message.role === 'system') priority += 1000;

    // Error messages: high priority
    if (message.content.includes('Error:')) priority += 500;

    // Recent messages: higher priority
    const age = Date.now() - message.timestamp;
    priority += Math.max(0, 100 - (age / 60000)); // Decay over time

    // User questions: medium priority
    if (message.role === 'user' && message.content.includes('?')) {
      priority += 50;
    }

    return priority;
  }

  estimateTokens(messages: ChatMessage[]): number {
    return messages.reduce((total, msg) => {
      return total + this.estimateMessageTokens(msg);
    }, 0);
  }

  private estimateMessageTokens(message: ChatMessage): number {
    return Math.ceil((message.content.length + 25) / 4);
  }
}
```

### Testing Custom Strategies

```typescript
import { describe, it, expect } from 'vitest';
import { CustomStrategy } from './custom-strategy';

describe('CustomStrategy', () => {
  it('should select messages correctly', async () => {
    const strategy = new CustomStrategy();
    const messages = [
      { role: 'user', content: 'Hello', timestamp: 1000 },
      { role: 'assistant', content: 'Hi', timestamp: 2000 }
    ];

    const result = await strategy.prepare(messages);

    expect(result.messages.length).toBeGreaterThan(0);
    expect(result.metadata.strategy).toBe('custom-strategy');
  });

  it('should estimate tokens accurately', () => {
    const strategy = new CustomStrategy();
    const messages = [
      { role: 'user', content: 'Test message', timestamp: 1000 }
    ];

    const tokens = strategy.estimateTokens(messages);
    expect(tokens).toBeGreaterThan(0);
  });
});
```

---

## Summary

The context module provides a flexible, performant system for managing chat message history with three built-in strategies and support for custom extensions. Use the appropriate strategy based on your needs:

- **Sliding Window**: Simple, fast, predictable
- **Token Limit**: Cost-optimized, token-aware
- **Relevance**: Intelligent, context-aware

For more information, see the source code in `src/context/`.
