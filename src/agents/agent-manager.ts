// AgentManager - Manages agent instances and execution

import { BaseAgent } from './base-agent';
import { AgentContext, AgentResponse, AgentEvent } from './agent-types';

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
   */
  getCurrentAgent(): BaseAgent | null {
    return this.currentAgent;
  }

  /**
   * Execute with the current agent
   */
  async *executeWithCurrentAgent(
    prompt: string,
    context: AgentContext
  ): AsyncGenerator<AgentEvent, AgentResponse, any> {
    if (!this.currentAgent) {
      throw new Error('No current agent set');
    }
    return yield* this.currentAgent.execute(prompt, context);
  }
}
