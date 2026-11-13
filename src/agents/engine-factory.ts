import type { AgentEngine, EngineDefinition } from '../contracts/agent-engine';
import type { AgentConfig } from './agent-types';
import type { AIProvider } from '../types';
import { BaseAgent, type AgentDependencies } from './base-agent';
import { HostAgentEngine } from './host-engine';

export type AgentEngineFactory = (config: AgentConfig, provider: AIProvider, dependencies: AgentDependencies, engineId?: string) => AgentEngine;

/** Factories are selected in main. Runtime compatibility is checked before any model or tool call. */
export function createEngineFactory(definitions: Readonly<Record<string, EngineDefinition>> = {}): AgentEngineFactory {
  const installed = { ...definitions };
  return (config, provider, dependencies, engineId = 'native') => {
    if (engineId !== 'native') {
      const definition = installed[engineId];
      if (!definition || definition.binding.id !== engineId) throw new Error(`Agent 引擎未安装或 ID 不匹配：${engineId}`);
      return new HostAgentEngine(config, definition, provider, dependencies);
    }
    const agent = new BaseAgent(config, provider, dependencies);
    return {
      getId: () => agent.getId(), getName: () => agent.getName(), getDescription: () => agent.getDescription(), getConfig: () => agent.getConfig(),
      execute: async (prompt, context) => {
        await context.runtime?.bindEngine?.({ id: 'base-agent', version: '1', codecVersion: 1 });
        return agent.execute(prompt, context);
      },
    };
  };
}
