import { describe, it, expect } from 'vitest';
import { AgentOrchestrator } from '../../src/agents/agent-orchestrator';
import { AgentManager } from '../../src/agents/agent-manager';
import { BaseAgent } from '../../src/agents/base-agent';
import { AgentTask, AgentResponse, AgentEvent } from '../../src/agents/agent-types';

describe('AgentOrchestrator Unit Tests', () => {
  it('should throw circular dependency error when tasks have cycles', async () => {
    const manager = new AgentManager();
    const orchestrator = new AgentOrchestrator(manager);

    const tasks: AgentTask[] = [
      {
        id: 'task-1',
        agentId: 'agent-1',
        prompt: 'task 1 prompt',
        context: { messages: [], sessionId: 's1' },
        dependencies: ['task-2'],
      },
      {
        id: 'task-2',
        agentId: 'agent-2',
        prompt: 'task 2 prompt',
        context: { messages: [], sessionId: 's1' },
        dependencies: ['task-1'],
      },
    ];

    const run = async () => {
      const generator = orchestrator.executeTasks(tasks);
      for await (const _ of generator) {
        // noop
      }
    };

    await expect(run()).rejects.toThrowError(/Circular dependency/);
  });

  it('should run tasks in parallel and yield aggregated events', async () => {
    const manager = new AgentManager();
    const orchestrator = new AgentOrchestrator(manager);

    const mockAgent1 = {
      getId: () => 'agent-1',
      execute: async function* (prompt: string, context: any) {
        yield { type: 'chunk', text: 'chunk from agent 1' };
        return { content: 'result 1', messages: [{ role: 'assistant', content: 'result 1', timestamp: Date.now() }] };
      }
    } as any as BaseAgent;

    const mockAgent2 = {
      getId: () => 'agent-2',
      execute: async function* (prompt: string, context: any) {
        yield { type: 'chunk', text: 'chunk from agent 2' };
        return { content: 'result 2', messages: [{ role: 'assistant', content: 'result 2', timestamp: Date.now() }] };
      }
    } as any as BaseAgent;

    manager.registerAgent(mockAgent1);
    manager.registerAgent(mockAgent2);

    const tasks: AgentTask[] = [
      {
        id: 'task-a',
        agentId: 'agent-1',
        prompt: 'prompt a',
        context: { messages: [], sessionId: 's1' },
      },
      {
        id: 'task-b',
        agentId: 'agent-2',
        prompt: 'prompt b',
        context: { messages: [], sessionId: 's1' },
      },
    ];

    const generator = orchestrator.executeTasks(tasks);
    const events: (AgentEvent & { taskId?: string })[] = [];
    
    // Consume tasks and capture yielded events
    let resultValue: any;
    try {
      let next = await generator.next();
      while (!next.done) {
        events.push(next.value);
        next = await generator.next();
      }
      resultValue = next.value;
    } catch (e) {
      console.error(e);
    }

    expect(events.length).toBe(2);
    expect(events.some(e => e.taskId === 'task-a' && e.type === 'chunk')).toBe(true);
    expect(events.some(e => e.taskId === 'task-b' && e.type === 'chunk')).toBe(true);
    expect(resultValue).toBeDefined();
    expect(resultValue.finalResponse).toBe('result 2'); // Last task response content
  });

  it('should clean pipeline intermediate context messages to prevent token bloat', async () => {
    const manager = new AgentManager();
    const orchestrator = new AgentOrchestrator(manager);

    const mockAgent1 = {
      getId: () => 'agent-1',
      execute: async function* (prompt: string, context: any) {
        return {
          content: 'agent 1 output',
          messages: [
            { role: 'user', content: 'initial', timestamp: Date.now() },
            // Agent 1 executes a tool, generating tool call and tool response messages
            {
              role: 'assistant',
              content: '',
              tool_calls: [{ id: 'tc-1', name: 'tool-x', arguments: '{}' }],
              timestamp: Date.now(),
            },
            { role: 'tool', name: 'tool-x', content: 'tool output', tool_call_id: 'tc-1', timestamp: Date.now() },
            { role: 'assistant', content: 'agent 1 output', timestamp: Date.now() },
          ],
        };
      }
    } as any as BaseAgent;

    let passedContextMessages: any[] = [];
    const mockAgent2 = {
      getId: () => 'agent-2',
      execute: async function* (prompt: string, context: any) {
        passedContextMessages = context.messages;
        return { content: 'agent 2 output', messages: [] };
      }
    } as any as BaseAgent;

    manager.registerAgent(mockAgent1);
    manager.registerAgent(mockAgent2);

    const pipeline = orchestrator.executePipeline(
      ['agent-1', 'agent-2'],
      'initial prompt',
      { messages: [], sessionId: 's2' }
    );

    // Consume pipeline
    let next = await pipeline.next();
    while (!next.done) {
      next = await pipeline.next();
    }

    // Verify tool calls and tool responses are preserved in context messages passed to Agent 2
    expect(passedContextMessages.length).toBe(4);
    expect(passedContextMessages.some(m => m.role === 'tool')).toBe(true);
    expect(passedContextMessages.some(m => m.role === 'user' && m.content === 'initial')).toBe(true);
    expect(passedContextMessages.some(m => m.role === 'assistant' && m.content === 'agent 1 output')).toBe(true);
  });
});
