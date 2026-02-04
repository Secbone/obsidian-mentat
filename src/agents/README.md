# Agent System

This directory contains the Agent system that abstracts conversation capabilities into reusable agent classes.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                    ChatOrchestrator                      │
│  - Initializes skill system                             │
│  - Creates and manages default agent                    │
│  - Provides chat interface                              │
└────────────────────┬────────────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────────────┐
│                   AgentManager                           │
│  - Registers and manages agent instances                │
│  - Tracks current active agent                          │
│  - Provides execution interface                         │
└────────────────────┬────────────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────────────┐
│                    BaseAgent                             │
│  - Executes agent tasks with skill support              │
│  - Handles multi-turn conversation loops                │
│  - Manages tool/skill calls                             │
│  - Supports streaming responses                         │
└─────────────────────────────────────────────────────────┘
```

## Core Components

### 1. AgentTypes (`agent-types.ts`)

Defines core types for the agent system:

- **AgentConfig**: Configuration for an agent (id, name, description, system prompt, etc.)
- **AgentContext**: Execution context (messages, session ID, metadata)
- **AgentResponse**: Response from agent execution (content, messages, skill calls)
- **AgentTask**: Task definition for multi-agent orchestration
- **AgentOrchestrationResult**: Result of multi-agent workflow

### 2. BaseAgent (`base-agent.ts`)

The core agent class that handles conversation execution:

**Features:**
- Multi-turn conversation loops with skill support
- Streaming response generation
- Tool/skill call execution (both meta-tools and direct calls)
- Error handling and recovery
- Configurable behavior (temperature, max turns, etc.)

**Key Methods:**
- `execute(prompt, context, onStream)` - Execute agent task
- `executeWithSkills()` - Execute with skill support (multi-turn loop)
- `executeSimple()` - Execute without skills (single turn)

**Example:**
```typescript
const agent = new BaseAgent(
  {
    id: 'my-agent',
    name: 'My Agent',
    description: 'A helpful agent',
    enableSkills: true,
    maxTurns: 5,
    temperature: 0.7,
    systemPrompt: 'You are a helpful assistant.'
  },
  provider,
  {
    skillRegistry,
    skillExecutor,
    skillInvocationContext
  }
);

const response = await agent.execute(
  'Help me find notes about TypeScript',
  { messages: [], sessionId: '123' },
  (chunk) => console.log(chunk)
);
```

### 3. AgentManager (`agent-manager.ts`)

Manages multiple agent instances:

**Features:**
- Register/unregister agents
- Track current active agent
- Execute with current agent
- List all agents

**Example:**
```typescript
const manager = new AgentManager();

// Register agents
manager.registerAgent(chatAgent);
manager.registerAgent(codeAgent);

// Set active agent
manager.setCurrentAgent('chat-agent');

// Execute with current agent
const response = await manager.executeWithCurrentAgent(
  'Hello',
  context,
  onStream
);
```

### 4. AgentOrchestrator (`agent-orchestrator.ts`)

Orchestrates complex multi-agent workflows:

**Features:**
- Task-based execution with dependency management
- Pipeline execution (sequential agents)
- Parallel task execution
- Context enrichment with dependency results

**Example - Pipeline:**
```typescript
const orchestrator = new AgentOrchestrator(agentManager);

// Execute agents in sequence
const result = await orchestrator.executePipeline(
  ['research-agent', 'summary-agent', 'writer-agent'],
  'Write a blog post about AI',
  initialContext
);
```

**Example - Task Dependencies:**
```typescript
const tasks: AgentTask[] = [
  {
    id: 'task1',
    agentId: 'research-agent',
    prompt: 'Research AI trends',
    context: initialContext
  },
  {
    id: 'task2',
    agentId: 'analysis-agent',
    prompt: 'Analyze the research',
    context: initialContext,
    dependencies: ['task1']  // Waits for task1
  },
  {
    id: 'task3',
    agentId: 'writer-agent',
    prompt: 'Write summary',
    context: initialContext,
    dependencies: ['task2']  // Waits for task2
  }
];

const result = await orchestrator.executeTasks(tasks);
```

## Integration with ChatOrchestrator

The `ChatOrchestrator` creates and manages a default `BaseAgent` instance:

```typescript
// In ChatOrchestrator.initialize()
private async createDefaultAgent(): Promise<void> {
  const provider = await this.plugin.aiRouter.getProvider(TaskType.CHAT);
  const systemPrompt = await this.buildSystemPrompt();

  const agentConfig: AgentConfig = {
    id: 'default-chat-agent',
    name: 'Chat Agent',
    description: 'Default chat agent with skill support',
    enableSkills: true,
    maxTurns: 5,
    temperature: 0.7,
    systemPrompt
  };

  const dependencies: AgentDependencies = {
    skillRegistry: this.skillRegistry,
    skillExecutor: this.skillExecutor,
    skillInvocationContext: this.skillInvocationContext
  };

  this.defaultAgent = new BaseAgent(agentConfig, provider, dependencies);
  this.agentManager.registerAgent(this.defaultAgent);
  this.agentManager.setCurrentAgent(this.defaultAgent.getId());
}
```

## Extending the System

### Creating Custom Agents

You can create specialized agents by extending `BaseAgent`:

```typescript
export class CodeAgent extends BaseAgent {
  constructor(config: AgentConfig, provider: AIProvider, deps: AgentDependencies) {
    super(config, provider, deps);
  }

  // Override to add custom behavior
  async execute(prompt: string, context: AgentContext, onStream?: (chunk: string) => void): Promise<AgentResponse> {
    // Add code-specific preprocessing
    const enhancedPrompt = this.enhanceForCode(prompt);

    // Call parent implementation
    return super.execute(enhancedPrompt, context, onStream);
  }

  private enhanceForCode(prompt: string): string {
    return `[Code Mode] ${prompt}\n\nFocus on code quality and best practices.`;
  }
}
```

### Adding New Agent Types

1. Create a new agent class extending `BaseAgent`
2. Register it with `AgentManager`
3. Use it via `AgentManager.setCurrentAgent()` or `AgentOrchestrator`

## Benefits

✅ **Separation of Concerns** - Agent logic separated from orchestration
✅ **Reusability** - Agents can be reused across different contexts
✅ **Extensibility** - Easy to add new agent types
✅ **Multi-Agent Support** - Built-in support for complex workflows
✅ **Skill Integration** - Seamless integration with skill system
✅ **Testability** - Each component can be tested independently

## Migration from RAGOrchestrator

The old `RAGOrchestrator` has been refactored into `ChatOrchestrator`:

**Key Changes:**
- Removed RAG-specific logic (retrieval, chunks, sources)
- Simplified to pure conversation orchestration
- Agent loop logic moved to `BaseAgent`
- Skill system preserved and integrated with agents

**API Changes:**
```typescript
// Old API
await ragOrchestrator.query(
  userQuery,
  selectedFiles,  // ❌ Removed
  contextMessages,
  onStream,
  options
);

// New API
await chatOrchestrator.query(
  userQuery,
  onStream,
  {
    contextMessages,
    enableSkills: true,
    maxTurns: 5
  }
);
```

## Future Enhancements

- **Agent Templates**: Pre-configured agent templates for common tasks
- **Agent Persistence**: Save and restore agent states
- **Agent Communication**: Direct agent-to-agent communication
- **Agent Monitoring**: Track agent performance and metrics
- **Dynamic Agent Selection**: Automatically select best agent for task
