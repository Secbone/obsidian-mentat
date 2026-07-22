# Agent System

This directory contains the agent runtime — the core loop that drives conversation, tool execution, streaming, context compaction, and extension integration.

## Architecture

```
ChatView (UI event consumer)
    │
    ▼
ChatOrchestrator.query()
    │  yield AsyncGenerator<AgentEvent>
    ▼
AgentManager.execute(agentId, prompt, context)
    │
    ▼
BaseAgent.execute()
    │  ┌─────────────────────────────────────────────┐
    │  │  while (turnCount < maxTurns)              │
    │  │    yield turn_start / message_start        │
    │  │    yield streamModel() → chunk/message_update│
    │  │    yield message_end                       │
    │  │    yield executeToolCalls()                │
    │  │      ├─ 分组: read(并行) / write(串行)...  │
    │  │      ├─ 循环检测 (AP6 Guard)               │
    │  │      └─ yield tool_execution_start/end     │
    │  │    yield turn_end                          │
    │  │    │                                       │
    │  │    ├─ Compactor.check()                    │
    │  │    │  (每 3 轮, token > 75% 时压缩)        │
    │  │    └─ ExtensionEvents emit                 │
    │  └─────────────────────────────────────────────┘
    │
    ▼
AgentResponse { content, messages, metadata }
```

## Files

| File | Role |
|------|------|
| `agent-types.ts` | All type definitions (AgentEvent, AgentConfig, AgentContext, etc.) |
| `base-agent.ts` | Core execution loop (stream, tools, compression, events) |
| `compactor.ts` | Context compaction using LLM summarization |
| `agent-manager.ts` | Agent registry and execution dispatch |
| `agent-orchestrator.ts` | Multi-agent DAG and pipeline execution |

## Core Concepts

### AgentEvent — the streaming protocol

`BaseAgent.execute()` is an `AsyncGenerator` that **yields** events and **returns** an `AgentResponse`. All UI updates, tool status, confirmation requests, and errors flow through events:

```typescript
type AgentEvent =
  // Lifecycle
  | { type: 'agent_start' }
  | { type: 'agent_end'; messages: ChatMessage[] }

  // Turn
  | { type: 'turn_start'; turnIndex: number }
  | { type: 'turn_end'; turnIndex: number; message: ChatMessage; toolResults: unknown[] }

  // Message streaming
  | { type: 'message_start'; role: string }
  | { type: 'message_update'; delta: string }
  | { type: 'message_end'; role: string; content: string }

  // Tool calls
  | { type: 'tool_execution_start'; toolCallId: string; toolName: string; args: unknown }
  | { type: 'tool_execution_end'; toolCallId: string; result: unknown; isError: boolean }

  // Context compaction
  | { type: 'compaction_start' }
  | { type: 'compaction_end'; summaryLength: number }

  // Legacy (backward compatible)
  | { type: 'chunk'; text: string }
  | { type: 'skill_call'; name: string; params: unknown }
  | { type: 'skill_success'; name: string; result: unknown }
  | { type: 'skill_error'; name: string; error: string }

  // Confirmation & steering
  | { type: 'confirm_request'; skillName: string; params: unknown; message: string }
  | { type: 'steer'; message: string }
  | { type: 'status'; message: string }
  | { type: 'error'; message: string };
```

### Consuming events

```typescript
const stream = agent.execute(prompt, context);
for await (const event of stream) {
  switch (event.type) {
    case 'chunk':          output += event.text; break;
    case 'tool_execution_start':  showTool(event.toolName); break;
    case 'tool_execution_end':    updateToolStatus(event.toolCallId); break;
    case 'compaction_start':      showBanner('Compacting...'); break;
    case 'agent_end':             done(event.messages); break;
  }
}
const result: AgentResponse = await stream.return(undefined);
// Or get the return value via the last `current.value` after the generator finishes
```

### Tool execution mode

```typescript
interface AgentConfig {
  toolExecutionMode?: 'sequential' | 'parallel'; // default: 'parallel'
  maxParallelTools?: number;                       // default: 5
}
```

Tools are grouped by `executionCategory` (declared in skill metadata):
- `read` → all parallel (safe to read simultaneously)
- `write` / `mutate` / `external` → serial per group (prevent race conditions)

```typescript
// Skills declare their category in metadata:
{
  name: 'read_note',
  metadata: {
    executionCategory: 'read',
    requiresConfirmation: false,
    permissions: ['read']
  }
}
```

### Context compaction

When the estimated token count exceeds 75% of budget (default 32k), the compactor triggers every 3 turns:

1. Keep the last 6 messages intact
2. Send older messages to the LLM for summarization
3. Replace compressed region with `--- Context Summary ---\n...\n--- Continuing Conversation ---`
4. Full history preserved in the session file (compaction only affects LLM context)

Configurable via settings:

```typescript
interface CompactionConfig {
  enabled: boolean;           // default: true
  threshold: number;          // 0.75 (75% of budget)
  keepRecentMessages: number; // 6
  maxContextTokens: number;   // 32000
  checkInterval: number;      // 3 (turns between checks)
}
```

### Usage

```typescript
// Default agent is created by ChatOrchestrator
const stream = chatOrchestrator.query('What files mention RAG?', {
  enableSkills: true,
  maxTurns: 20,
  context: {
    messages: contextMessages,
    sessionId: session.sessionId,
    confirmHandler: async (skillName, params, message) => {
      return { approved: true };
    }
  }
});
```

## Extending

### Extension events

The `ExtensionManager.eventBus` mirrors the agent lifecycle for extensions to hook into:

```typescript
eventBus.on('before_tool', ({ toolName, args }) => {
  console.log(`About to execute: ${toolName}`);
});
```

See [src/extensions/](../extensions/) for the full extension API.

### Creating a custom agent

```typescript
class ResearchAgent extends BaseAgent {
  constructor(provider: AIProvider, deps: AgentDependencies) {
    super(
      { id: 'research', name: 'Research Agent', description: '', enableSkills: true },
      provider,
      deps
    );
  }

  async *execute(prompt: string, context: AgentContext) {
    // Custom pre-processing
    const enhancedPrompt = `[RESEARCH MODE]\n${prompt}`;
    yield* super.execute(enhancedPrompt, context);
  }
}
```
