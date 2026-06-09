import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { BaseAgent } from '../../src/agents/base-agent';
import { SkillRegistry } from '../../src/skills/core/skill-registry';
import { SkillExecutor } from '../../src/skills/core/skill-executor';
import { SkillInvocationContext } from '../../src/skills/strategies/skill-invocation-strategy';
import { AIProvider, AgentEvent } from '../../src/types';
import { AgentConfig, AgentContext, DiagnosticsLogger } from '../../src/agents/agent-types';

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

    const skillRegistry = new SkillRegistry();
    const skillExecutor = new SkillExecutor(skillRegistry, mockSkillContext);
    const skillInvocationContext = new SkillInvocationContext('native');

    const agent = new BaseAgent(config, mockProvider, {
      skillRegistry,
      skillExecutor,
      skillInvocationContext,
    });

    const context: AgentContext = {
      messages: [],
      sessionId: 'session-123',
    };

    const events: AgentEvent[] = [];
    const generator = agent.execute('hi', context);
    for await (const event of generator) {
      events.push(event);
    }

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

    const skillRegistry = new SkillRegistry();
    const skillExecutor = new SkillExecutor(skillRegistry, mockSkillContext);
    const skillInvocationContext = new SkillInvocationContext('native');

    const agent = new BaseAgent(config, mockProvider, {
      skillRegistry,
      skillExecutor,
      skillInvocationContext,
    });

    const controller = new AbortController();
    const context: AgentContext = {
      messages: [],
      sessionId: 'session-123',
      abortSignal: controller.signal,
    };

    controller.abort();

    const run = async () => {
      const generator = agent.execute('hi', context);
      for await (const _ of generator) {
        // noop
      }
    };

    await expect(run()).rejects.toThrowError(/aborted|AbortError/);
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

    const skillRegistry = new SkillRegistry();
    skillRegistry.register({
      name: 'test_tool',
      namespace: 'obsidian',
      description: 'test tool',
      schema: z.object({
        param: z.string().optional()
      }),
      execute: async () => ({ success: true, data: { result: 'ok' } }),
    });

    const skillExecutor = new SkillExecutor(skillRegistry, mockSkillContext);
    const skillInvocationContext = new SkillInvocationContext('native');

    const agent = new BaseAgent(config, mockProvider, {
      skillRegistry,
      skillExecutor,
      skillInvocationContext,
    });

    const context: AgentContext = {
      messages: [],
      sessionId: 'session-123',
      metadata: {
        maxCycleLength: 1,
        minRepeats: 3, // pattern length 1, repeated 3 times: tool, tool, tool
        maxTurns: 5,
      }
    };

    const events: AgentEvent[] = [];
    const generator = agent.execute('hi', context);
    
    for await (const event of generator) {
      events.push(event);
    }

    // Check if the loop prevention warning event was emitted
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

    const skillExecutor = new SkillExecutor(skillRegistry, mockSkillContext);
    const skillInvocationContext = new SkillInvocationContext('native');

    const agent = new BaseAgent(config, mockProvider, {
      skillRegistry,
      skillExecutor,
      skillInvocationContext,
    });

    let confirmCalled = false;
    const context: AgentContext = {
      messages: [],
      sessionId: 'session-123',
      confirmHandler: async (skillName, params, message) => {
        confirmCalled = true;
        return { approved: true };
      }
    };

    const generator = agent.execute('hi', context);
    
    // Consume generator and check confirm_request event
    const runGenerator = async () => {
      for await (const event of generator) {
        if (event.type === 'confirm_request') {
          expect(event.skillName).toBe('obsidian:need_confirm');
        }
      }
    };

    await runGenerator();
    expect(confirmCalled).toBe(true);
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

    const skillRegistry = new SkillRegistry();
    skillRegistry.register({
      name: 'invoke',
      namespace: 'obsidian',
      description: 'error tool',
      schema: z.object({}),
      execute: async () => ({ success: false, error: 'forced error' }),
    });

    const skillExecutor = new SkillExecutor(skillRegistry, mockSkillContext);
    const skillInvocationContext = new SkillInvocationContext('native');
    // Force obsidian:invoke to be treated as meta-tool call so it goes through safeParseToolArguments
    skillInvocationContext.isMetaToolCall = (name: string) => name === 'obsidian:invoke';

    const diagnosticsLogger = new MockDiagnosticsLogger();

    const agent = new BaseAgent(config, mockProvider, {
      skillRegistry,
      skillExecutor,
      skillInvocationContext,
      diagnosticsLogger,
    });

    const context: AgentContext = {
      messages: [],
      sessionId: 'session-123',
    };

    const generator = agent.execute('hi', context);
    for await (const _ of generator) {
      // consume
    }

    expect(diagnosticsLogger.incidents.length).toBeGreaterThan(0);
    expect(diagnosticsLogger.incidents[0].toolName).toBe('obsidian:invoke');
    expect(diagnosticsLogger.incidents[0].strategy).toBe('Failed (Strict Parsing)');
  });
});
