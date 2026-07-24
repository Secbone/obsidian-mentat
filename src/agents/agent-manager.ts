// AgentManager - Manages agent instances and execution

import { BaseAgent } from './base-agent';
import { AgentContext, AgentResponse } from './agent-types';

/**
 * AgentManager - Manages multiple agent instances
 */
export class AgentManager {
  private agents: Map<string, BaseAgent> = new Map();
  private currentAgent: BaseAgent | null = null;

  /**
   * Register an agent
   */
  registerAgent(agent: BaseAgent): void {
    this.agents.set(agent.getId(), agent);
  }

  /**
   * Unregister an agent
   */
  unregisterAgent(agentId: string): void {
    if (this.currentAgent?.getId() === agentId) {
      this.currentAgent = null;
    }
    this.agents.delete(agentId);
  }

  /**
   * Get an agent by ID
   */
  getAgent(agentId: string): BaseAgent | undefined {
    return this.agents.get(agentId);
  }

  /**
   * List all registered agents
   */
  listAgents(): BaseAgent[] {
    return Array.from(this.agents.values());
  }

  /**
   * Set the current active agent
   * @deprecated Use stateless execute(agentId, prompt, context) instead.
   */
  setCurrentAgent(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }
    this.currentAgent = agent;
  }

  /**
   * Get the current active agent
   * @deprecated Use stateless execute(agentId, prompt, context) instead.
   */
  getCurrentAgent(): BaseAgent | null {
    return this.currentAgent;
  }

  /**
   * Execute with the current agent
   * @deprecated Use stateless execute(agentId, prompt, context) instead.
   */
  async executeWithCurrentAgent(
    prompt: string,
    context: AgentContext
  ): Promise<AgentResponse> {
    if (!this.currentAgent) {
      throw new Error('No current agent set');
    }
    return this.currentAgent.execute(prompt, context);
  }

  /**
   * Execute with a specific agent by ID (Stateless)
   */
  async execute(
    agentId: string,
    prompt: string,
    context: AgentContext
  ): Promise<AgentResponse> {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }
    return agent.execute(prompt, context);
  }
}
