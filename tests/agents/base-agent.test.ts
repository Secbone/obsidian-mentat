import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { BaseAgent } from '../../src/agents/base-agent';
import { SkillRegistry } from '../../src/skills/core/skill-registry';
import { SkillExecutor } from '../../src/skills/core/skill-executor';
import { SkillInvocationContext } from '../../src/skills/strategies/skill-invocation-strategy';
import { AIProvider, AgentEvent } from '../../src/types';
import { AgentConfig, AgentContext, DiagnosticsLogger } from '../../src/agents/agent-types';
import { EventBus } from '../../src/extensions/event-bus';

class MockDiagnosticsLogger implements DiagnosticsLogger {
  incidents: any[] = [];
  async logIncident(incident: any): Promise<void> {
    this.incidents.push(incident);
  }
}

describe('BaseAgent Unit Tests', () => {
  const mockSkillContext = {
    vault: {} as any,
    metadataCache: {} as any,
    workspace: {} as any,
    indexManager: {} as any,
  } as any;

  function setupAgent(config: AgentConfig, provider: AIProvider, extra: any = {}) {
    const bus = new EventBus();
    const skillRegistry = extra.skillRegistry ?? new SkillRegistry();
    const skillExecutor = extra.skillExecutor ?? new SkillExecutor(skillRegistry, mockSkillContext, bus);
    const skillInvocationContext = extra.skillInvocationContext ?? new SkillInvocationContext('native');
    const diagnosticsLogger = extra.diagnosticsLogger;
    const agent = new BaseAgent(config, provider, {
      skillRegistry,
      skillExecutor,
      skillInvocationContext,
      diagnosticsLogger,
      eventBus: bus,
    });
    return { agent, bus, skillRegistry, skillExecutor };
  }

  it('should run simple execution without skills enabled', async () => {
    const config: AgentConfig = {
      id: 'test-agent',
      name: 'Test Agent',
      description: 'Test Description',
      enableSkills: false,
    };

    const mockProvider: AIProvider = {
      id: 'mock',
      name: 'Mock Provider',
      type: 'openai',
      isAvailable: async () => true,
      generate: async () => 'hello',
      generateStream: async (prompt, onChunk) => {
        onChunk('hello');
      },
      embed: async () => [],
      generateEmbedding: async () => ({ embedding: [] }),
      supportsSkills: () => false,
    };

    const { agent, bus } = setupAgent(config, mockProvider);
    const events: AgentEvent[] = [];
    bus.on('*', e => events.push(e));

    const context: AgentContext = {
      messages: [],
      sessionId: 'session-123',
    };

    await agent.execute('hi', context);
    expect(events.some(e => e.type === 'chunk' && e.text === 'hello')).toBe(true);
  });

  it('should support AbortSignal cancellation', async () => {
    const config: AgentConfig = {
      id: 'test-agent',
      name: 'Test Agent',
      description: 'Test Description',
      enableSkills: false,
    };

    const mockProvider: AIProvider = {
      id: 'mock',
      name: 'Mock Provider',
      type: 'openai',
      isAvailable: async () => true,
      generate: async () => 'hello',
      generateStream: async (prompt, onChunk, options) => {
        if (options?.abortSignal?.aborted) {
          throw new DOMException('Aborted', 'AbortError');
        }
        onChunk('hello');
      },
      embed: async () => [],
      generateEmbedding: async () => ({ embedding: [] }),
      supportsSkills: () => false,
    };

    const { agent } = setupAgent(config, mockProvider);

    const controller = new AbortController();
    const context: AgentContext = {
      messages: [],
      sessionId: 'session-123',
      abortSignal: controller.signal,
    };

    controller.abort();

    await expect(agent.execute('hi', context)).rejects.toThrowError(/aborted|AbortError/);
  });

  it('should trigger loop prevention guard when cyclic pattern is detected', async () => {
    const config: AgentConfig = {
      id: 'test-agent',
      name: 'Test Agent',
      description: 'Test Description',
      enableSkills: true,
    };

    let callCount = 0;
    const mockProvider: AIProvider = {
      id: 'mock',
      name: 'Mock Provider',
      type: 'openai',
      isAvailable: async () => true,
      generate: async () => 'hello',
      supportsSkills: () => true,
      generateStreamWithSkills: async (messages, onChunk, onToolCall, options) => {
        callCount++;
        return {
          content: '',
          toolCalls: [
            {
              id: `call-${callCount}`,
              name: 'obsidian:test_tool',
              arguments: '{"param":"val"}',
            },
          ],
          finishReason: 'tool_calls',
        };
      },
      embed: async () => [],
      generateEmbedding: async () => ({ embedding: [] }),
      generateStream: async () => {},
    };

    const { agent, bus, skillRegistry } = setupAgent(config, mockProvider);

    skillRegistry.register({
      name: 'test_tool',
      namespace: 'obsidian',
      description: 'test tool',
      schema: z.object({
        param: z.string().optional()
      }),
      execute: async () => ({ success: true, data: { result: 'ok' } }),
    });

    const context: AgentContext = {
      messages: [],
      sessionId: 'session-123',
      metadata: {
        maxCycleLength: 1,
        minRepeats: 3,
        maxTurns: 5,
      }
    };

    const events: AgentEvent[] = [];
    bus.on('*', e => events.push(e));

    await agent.execute('hi', context);

    const guardEvent = events.find(
      e => e.type === 'skill_error' && e.name === 'obsidian:test_tool' && e.error === 'Reasoning loop detected by AP6 Guard'
    );
    expect(guardEvent).toBeDefined();
  });

  it('should support Promise-based Human-in-the-Loop resolver', async () => {
    const config: AgentConfig = {
      id: 'test-agent',
      name: 'Test Agent',
      description: 'Test Description',
      enableSkills: true,
    };

    let returnedResponse = false;
    const mockProvider: AIProvider = {
      id: 'mock',
      name: 'Mock Provider',
      type: 'openai',
      isAvailable: async () => true,
      generate: async () => 'hello',
      supportsSkills: () => true,
      generateStreamWithSkills: async (messages, onChunk, onToolCall) => {
        if (!returnedResponse) {
          returnedResponse = true;
          return {
            content: '',
            toolCalls: [
              {
                id: 'call-123',
                name: 'obsidian:need_confirm',
                arguments: '{}',
              },
            ],
            finishReason: 'tool_calls',
          };
        } else {
          onChunk('final answer');
          return {
            content: 'final answer',
            finishReason: 'stop',
          };
        }
      },
      embed: async () => [],
      generateEmbedding: async () => ({ embedding: [] }),
      generateStream: async () => {},
    };

    const skillRegistry = new SkillRegistry();
    let skillWasExecuted = false;
    skillRegistry.register({
      name: 'need_confirm',
      namespace: 'obsidian',
      description: 'needs confirmation',
      schema: z.object({}),
      metadata: { requiresConfirmation: true },
      execute: async () => {
        skillWasExecuted = true;
        return { success: true, data: { result: 'confirmed' } };
      },
    });

    const bus = new EventBus();
    const skillExecutor = new SkillExecutor(skillRegistry, mockSkillContext, bus);
    const skillInvocationContext = new SkillInvocationContext('native');
    const agent = new BaseAgent(config, mockProvider, {
      skillRegistry,
      skillExecutor,
      skillInvocationContext,
      eventBus: bus,
    });

    const context: AgentContext = {
      messages: [],
      sessionId: 'session-123',
    };

    const events: AgentEvent[] = [];
    bus.on('confirm_request', (event: any) => {
      setTimeout(() => {
        (bus as any).emit({ type: 'confirm_response', id: event.skillName, approved: true });
      }, 0);
    });
    bus.on('*', e => events.push(e));

    await agent.execute('hi', context);

    expect(events.some(e => e.type === 'confirm_request')).toBe(true);
    expect(skillWasExecuted).toBe(true);
  });

  it('should delegate tool failure to DiagnosticsLogger', async () => {
    const config: AgentConfig = {
      id: 'test-agent',
      name: 'Test Agent',
      description: 'Test Description',
      enableSkills: true,
    };

    const mockProvider: AIProvider = {
      id: 'mock',
      name: 'Mock Provider',
      type: 'openai',
      isAvailable: async () => true,
      generate: async () => 'hello',
      supportsSkills: () => true,
      generateStreamWithSkills: async (messages, onChunk, onToolCall) => {
        return {
          content: '',
          toolCalls: [
            {
              id: 'call-1',
              name: 'obsidian:invoke',
              arguments: '{"invalid":', // Invalid JSON
            },
          ],
          finishReason: 'tool_calls',
        };
      },
      embed: async () => [],
      generateEmbedding: async () => ({ embedding: [] }),
      generateStream: async () => {},
    };

    const diagnosticsLogger = new MockDiagnosticsLogger();

    const bus = new EventBus();
    const skillRegistry = new SkillRegistry();
    skillRegistry.register({
      name: 'invoke',
      namespace: 'obsidian',
      description: 'error tool',
      schema: z.object({}),
      execute: async () => ({ success: false, error: 'forced error' }),
    });

    const skillExecutor = new SkillExecutor(skillRegistry, mockSkillContext, bus);
    const skillInvocationContext = new SkillInvocationContext('native');
    skillInvocationContext.isMetaToolCall = (name: string) => name === 'obsidian:invoke';

    const agent = new BaseAgent(config, mockProvider, {
      skillRegistry,
      skillExecutor,
      skillInvocationContext,
      diagnosticsLogger,
      eventBus: bus,
    });

    const context: AgentContext = {
      messages: [],
      sessionId: 'session-123',
    };

    await agent.execute('hi', context);

    expect(diagnosticsLogger.incidents.length).toBeGreaterThan(0);
    expect(diagnosticsLogger.incidents[0].toolName).toBe('obsidian:invoke');
    expect(diagnosticsLogger.incidents[0].strategy).toBe('Failed (Strict Parsing)');
  });
});
