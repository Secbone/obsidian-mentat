# Agent System

This directory contains the agent runtime — the core loop that drives conversation, tool execution, streaming, context compaction, and extension integration.

## Architecture

```
ChatView (subscribes to EventBus)
    │  eventBus.on('*', handler)
    ▼
ChatOrchestrator.sendMessage()  // fire-and-forget, returns void
    │
    ▼
AgentManager.execute(agentId, prompt, context)
    │
    ▼
BaseAgent.execute(prompt, context)  // returns Promise<AgentResponse>
    │  internally: executeGenerator() yields AgentEvent
    │  execute() wraps it, emits each event to eventBus
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

### EventBus — the single communication channel

`BaseAgent.execute()` returns `Promise<AgentResponse>`. During execution, it internally yields `AgentEvent` from a private generator and emits each one to the shared `EventBus`. All consumers (ChatView, extensions, SkillExecutor confirmation) subscribe to the same EventBus.

```typescript
// BaseAgent.execute() — entry point
async execute(prompt: string, context: AgentContext): Promise<AgentResponse> {
  const gen = this.executeGenerator(prompt, context);
  let result = await gen.next();
  while (!result.done) {
    this.eventBus?.emit(result.value as AgentEvent);
    result = await gen.next();
  }
  return result.value as AgentResponse;
}
```

### AgentEvent — event types

Events use multi-level namespaces (`domain:entity:action`). The EventBus supports wildcard subscription at any level (`tool:*`, `message:*`, `*`).

```typescript
type AgentEvent =
  // Agent lifecycle
  | { type: 'agent:start' }
  | { type: 'agent:end'; messages: ChatMessage[] }

  // Turn lifecycle (one LLM call + optional tool execution)
  | { type: 'turn:start'; turnIndex: number }
  | { type: 'turn:end'; turnIndex: number; message: ChatMessage; toolResults: unknown[] }

  // Message streaming
  | { type: 'message:start'; role: string }
  | { type: 'message:update'; delta: string; accumulatedText?: string }
  | { type: 'message:end'; role: string; content: string }

  // Tool calls (single source of truth)
  | { type: 'tool:start'; toolCallId: string; toolName: string; args: unknown }
  | { type: 'tool:end'; toolCallId: string; toolName: string; result: SkillResult | null; isError: boolean }

  // Context compaction
  | { type: 'context:compact:start' }
  | { type: 'context:compact:end'; summaryLength: number }

  // HITL confirmation (bidirectional)
  | { type: 'confirm:request'; taskId: string; skillName: string; params: unknown; message: string }
  | { type: 'confirm:response'; taskId: string; approved: boolean }

  // System-level
  | { type: 'system:status'; message: string }
  | { type: 'system:error'; message: string }
  | { type: 'system:steer'; message: string };
```

### Consuming events

Subscribe to the EventBus with exact, namespace, or wildcard patterns:

```typescript
// Namespace wildcard — all tool events
const unsub = eventBus.on('tool:*', (event: AgentEvent) => {
  switch (event.type) {
    case 'tool:start': showTool(event.toolName); break;
    case 'tool:end':   updateToolStatus(event.toolCallId, event.isError); break;
  }
});

// Global wildcard
eventBus.on('*', (event: AgentEvent) => {
  switch (event.type) {
    case 'message:update':      output += event.delta; break;
    case 'context:compact:start': showBanner('Compacting...'); break;
    case 'agent:end':           done(event.messages); break;
  }
});
```

The EventBus dispatches each emitted event to three tiers of handlers:
1. **Exact match** — `'tool:end'`
2. **Namespace wildcards** — `'tool:*'`, `'context:compact:*'`, ... (progressive prefix)
3. **Global wildcard** — `'*'`

### AgentDependencies

BaseAgent receives the following via `AgentDependencies`:

| Dependency | Required | Purpose |
|------------|----------|---------|
| `skillRegistry` | yes | Look up skill definitions and metadata |
| `skillExecutor` | yes | Execute tool calls |
| `skillInvocationContext` | yes | Generate LLM tool definitions (OpenAI/Anthropic format) |
| `diagnosticsLogger` | no | Log tool execution failures |
| `compactor` | no | Context compaction (auto-created if omitted) |
| `eventBus` | no | Emit events to UI/extensions |

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

### Cyclic loop detection (AP6 Guard)

Detects repetitive tool call patterns:
- Scans a sliding window of `maxCycleLength × minRepeats` calls
- If a cycle is detected (`toolName + normalized args` repeats), the call is blocked
- LLM receives a system alert to break the loop

### Context compaction

When estimated tokens exceed 75% of budget (default 32k), the compactor triggers every 3 turns:

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
// ChatOrchestrator sends a message (fire-and-forget, returns void)
chatOrchestrator.sendMessage('What files mention RAG?', {
  context: {
    messages: contextMessages,
    sessionId: session.sessionId,
    metadata: { maxTurns: 20 }
  }
});

// Results arrive via EventBus subscription in ChatView
```

## Extending

### Extension events

Extensions subscribe to the same EventBus the agent emits to:

```typescript
eventBus.on('*', (event: AgentEvent) => {
  if (event.type === 'tool_execution_start') {
    console.log(`About to execute: ${event.toolName}`);
  }
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

  async execute(prompt: string, context: AgentContext): Promise<AgentResponse> {
    const enhancedPrompt = `[RESEARCH MODE]\n${prompt}`;
    return super.execute(enhancedPrompt, context);
  }
}
```
