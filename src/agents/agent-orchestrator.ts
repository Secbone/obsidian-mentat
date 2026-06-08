// AgentOrchestrator - Orchestrates multi-agent workflows

import { AgentManager } from './agent-manager';
import { AgentTask, AgentOrchestrationResult, AgentContext, AgentResponse, AgentEvent } from './agent-types';

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
  async *executeTasks(tasks: AgentTask[]): AsyncGenerator<AgentEvent & { taskId?: string }, AgentOrchestrationResult, any> {
    const results = new Map<string, AgentResponse>();
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

      // Execute ready tasks in parallel in this tier and yield events concurrently
      const activeStreams = readyTasks.map(task => {
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

        return {
          id: task.id,
          context: enrichedContext,
          stream: agent.execute(task.prompt, enrichedContext)
        };
      });

      const eventQueue: (AgentEvent & { taskId: string })[] = [];
      let resolveNextEvent: (() => void) | null = null;
      let activeTaskCount = activeStreams.length;
      let hasError: any = null;

      // Start background runners for each stream to collect events in parallel
      activeStreams.forEach(async ({ id, context, stream }) => {
        try {
          let current = await stream.next();
          while (!current.done) {
            eventQueue.push({ ...(current.value as AgentEvent), taskId: id });
            if (resolveNextEvent) {
              resolveNextEvent();
              resolveNextEvent = null;
            }
            if (context.abortSignal?.aborted) {
              break;
            }
            current = await stream.next();
          }
          if (!context.abortSignal?.aborted && !hasError) {
            const result = current.value as AgentResponse;
            results.set(id, result);
            completed.add(id);
          }
        } catch (err) {
          hasError = err;
        } finally {
          activeTaskCount--;
          if (resolveNextEvent) {
            resolveNextEvent();
            resolveNextEvent = null;
          }
        }
      });

      // Yield events as they are pushed to the queue
      while (activeTaskCount > 0 || eventQueue.length > 0) {
        if (hasError) {
          throw hasError;
        }
        if (eventQueue.length === 0) {
          await new Promise<void>((resolve) => {
            resolveNextEvent = resolve;
          });
        }
        while (eventQueue.length > 0) {
          yield eventQueue.shift()!;
        }
      }

      if (hasError) {
        throw hasError;
      }
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
  async *executePipeline(
    agentIds: string[],
    initialPrompt: string,
    initialContext: AgentContext
  ): AsyncGenerator<AgentEvent & { activeAgentId?: string }, AgentResponse, any> {
    let currentContext = initialContext;
    let currentPrompt = initialPrompt;
    let finalResponse: AgentResponse | null = null;

    for (const agentId of agentIds) {
      const agent = this.agentManager.getAgent(agentId);
      if (!agent) {
        throw new Error(`Agent not found: ${agentId}`);
      }

      const stream = agent.execute(currentPrompt, currentContext);
      let current = await stream.next();

      while (!current.done) {
        const event = current.value as AgentEvent;
        yield { ...event, activeAgentId: agentId };
        current = await stream.next();
      }

      const response = current.value as AgentResponse;

      // Clean context: filter out intermediate Tool Call messages to prevent context window bloat
      const cleanedMessages = response.messages.filter(msg => {
        if (msg.role === 'tool' || msg.role === 'function') {
          return false;
        }
        if (msg.role === 'assistant' && (!msg.content && msg.tool_calls)) {
          return false;
        }
        return true;
      });

      currentContext = {
        ...currentContext,
        messages: cleanedMessages
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
