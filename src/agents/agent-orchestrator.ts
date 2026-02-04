// AgentOrchestrator - Orchestrates multi-agent workflows

import { AgentManager } from './agent-manager';
import { AgentTask, AgentOrchestrationResult, AgentContext, AgentResponse } from './agent-types';

/**
 * AgentOrchestrator - Handles complex multi-agent workflows
 */
export class AgentOrchestrator {
  private agentManager: AgentManager;

  constructor(agentManager: AgentManager) {
    this.agentManager = agentManager;
  }

  /**
   * Execute multiple agent tasks with dependency management
   */
  async executeTasks(tasks: AgentTask[]): Promise<AgentOrchestrationResult> {
    const results = new Map<string, AgentResponse>();
    const taskMap = new Map(tasks.map(t => [t.id, t]));
    const completed = new Set<string>();

    // Topological sort execution
    while (completed.size < tasks.length) {
      const readyTasks = tasks.filter(task =>
        !completed.has(task.id) &&
        (task.dependencies || []).every(dep => completed.has(dep))
      );

      if (readyTasks.length === 0) {
        throw new Error('Circular dependency detected or no tasks ready');
      }

      // Execute ready tasks in parallel
      await Promise.all(readyTasks.map(async task => {
        const agent = this.agentManager.getAgent(task.agentId);
        if (!agent) {
          throw new Error(`Agent not found: ${task.agentId}`);
        }

        // Enrich context with dependency results
        const enrichedContext = this.enrichContext(
          task.context,
          task.dependencies || [],
          results
        );

        const result = await agent.execute(task.prompt, enrichedContext);

        results.set(task.id, result);
        completed.add(task.id);
      }));
    }

    // Generate final response from last task
    const lastTask = tasks[tasks.length - 1];
    const finalResponse = results.get(lastTask.id)?.content || '';

    return {
      tasks: results,
      finalResponse
    };
  }

  /**
   * Execute agents in pipeline (sequential) mode
   */
  async executePipeline(
    agentIds: string[],
    initialPrompt: string,
    initialContext: AgentContext
  ): Promise<AgentResponse> {
    let currentContext = initialContext;
    let currentPrompt = initialPrompt;
    let finalResponse: AgentResponse | null = null;

    for (const agentId of agentIds) {
      const agent = this.agentManager.getAgent(agentId);
      if (!agent) {
        throw new Error(`Agent not found: ${agentId}`);
      }

      const response = await agent.execute(currentPrompt, currentContext);

      currentContext = {
        ...currentContext,
        messages: response.messages
      };
      currentPrompt = response.content;
      finalResponse = response;
    }

    return finalResponse!;
  }

  /**
   * Enrich context with dependency results
   */
  private enrichContext(
    baseContext: AgentContext,
    dependencies: string[],
    results: Map<string, AgentResponse>
  ): AgentContext {
    const enrichedMessages = [...baseContext.messages];

    for (const depId of dependencies) {
      const depResult = results.get(depId);
      if (depResult) {
        enrichedMessages.push({
          role: 'assistant',
          content: `[Dependency ${depId}]: ${depResult.content}`,
          timestamp: Date.now()
        });
      }
    }

    return {
      ...baseContext,
      messages: enrichedMessages
    };
  }
}
