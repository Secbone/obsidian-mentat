import { describe, it, expect } from 'vitest';
import { ChatOrchestrator } from '../../src/chat/chat-orchestrator';
import { MemoryPlatformAdapter } from '../utils/memory-platform-adapter';
import { AgentManager } from '../../src/agents/agent-manager';
import { BaseAgent } from '../../src/agents/base-agent';

describe('Dynamic Workflow Integration & Subagent Delegation', () => {
  const settings = {
    userConfigFolder: 'Personal Agent/Config',
    draftReviewModeEnabled: true,
    aiProviders: [
      {
        id: 'test-openai',
        name: 'Test OpenAI',
        type: 'openai',
        enabled: true,
        model: 'gpt-4o',
        supportsEmbedding: true,
        supportsStreaming: true
      }
    ],
    defaultProvider: 'test-openai',
    taskRouting: {
      chat: 'test-openai',
      embedding: 'test-openai'
    },
    allowedSkills: [],
    skillInvocationMode: 'auto'
  };

  it('should register system subagents and support delegation tools', async () => {
    const platform = new MemoryPlatformAdapter();
    (platform as any).app = {
      vault: {
        adapter: {
          exists: async () => false,
          list: async () => ({ files: [], folders: [] })
        }
      }
    };
    
    // Mock Provider with fake responses
    const mockProvider = {
      id: 'test-openai',
      name: 'Test OpenAI',
      type: 'openai' as const,
      isAvailable: async () => true,
      supportsSkills: () => true,
      generate: async () => 'hello',
      generateStream: async () => {},
      generateWithSkills: async () => ({
        content: 'final response',
        finishReason: 'stop' as const
      }),
      generateStreamWithSkills: async (messages: any, onChunk: any, onToolCall: any, options: any) => {
        onChunk('final response from planner');
        return {
          content: 'final response from planner',
          finishReason: 'stop' as const,
          usage: {
            promptTokens: 100,
            completionTokens: 20,
            totalTokens: 120,
            cacheReadTokens: 30
          }
        };
      }
    };

    const mockRouter = {
      getProvider: async () => mockProvider,
      getProviderById: () => mockProvider,
      getAllProviders: () => [mockProvider]
    };

    const orchestrator = new ChatOrchestrator(
      platform,
      settings,
      mockRouter,
      {} // mock indexManager
    );

    await orchestrator.initialize();

    const agentManager = orchestrator.getAgentManager();
    
    // Check default agent registration
    const defaultAgent = agentManager.getAgent('default-chat-agent');
    expect(defaultAgent).toBeDefined();

    // Check system subagents registration
    const writerAgent = agentManager.getAgent('writer-agent');
    const reviewerAgent = agentManager.getAgent('reviewer-agent');
    expect(writerAgent).toBeDefined();
    expect(reviewerAgent).toBeDefined();

    // Check delegation skills are registered
    const registry = (orchestrator as any).skillRegistry;
    expect(registry.get('obsidian:delegate_task')).toBeDefined();
    expect(registry.get('obsidian:spawn_subagent')).toBeDefined();
  });
});
