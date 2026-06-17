// AgentOrchestrator - Orchestrates multi-agent workflows

import { AgentManager } from './agent-manager';
import { AgentTask, AgentOrchestrationResult, AgentContext, AgentResponse, AgentEvent } from './agent-types';

/**
 * AsyncEventQueue - Standard async helper queue for concurrent event processing
 */
class AsyncEventQueue<T> {
  private queue: T[] = [];
  private resolveNext: (() => void) | null = null;
  private isDone = false;

  push(item: T) {
    this.queue.push(item);
    if (this.resolveNext) {
      this.resolveNext();
      this.resolveNext = null;
    }
  }

  setDone() {
    this.isDone = true;
    if (this.resolveNext) {
      this.resolveNext();
      this.resolveNext = null;
    }
  }

  async next(): Promise<{ value: T | undefined; done: boolean }> {
    while (this.queue.length === 0 && !this.isDone) {
      await new Promise<void>((resolve) => {
        this.resolveNext = resolve;
      });
    }
    if (this.queue.length > 0) {
      return { value: this.queue.shift(), done: false };
    }
    return { value: undefined, done: true };
  }
}

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
  async *executeTasks(tasks: AgentTask[]): AsyncGenerator<AgentEvent & { taskId?: string }, AgentOrchestrationResult, unknown> {
    const results = new Map<string, AgentResponse>();
    const completed = new Set<string>();
    const cleanupListeners: (() => void)[] = [];

    try {
      // Topological sort execution
      while (completed.size < tasks.length) {
        const readyTasks = tasks.filter(task =>
          !completed.has(task.id) &&
          (task.dependencies || []).every(dep => completed.has(dep))
        );

        if (readyTasks.length === 0) {
          throw new Error('Circular dependency detected or no tasks ready');
        }

        // Create a local AbortController for this tier execution
        const tierAbortController = new AbortController();

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

          // Link abort signals: task context abortSignal OR tierAbortController
          let linkedSignal: AbortSignal;
          if (task.context.abortSignal) {
            const controller = new AbortController();
            const onParentAbort = () => controller.abort();
            const onTierAbort = () => controller.abort();
            
            task.context.abortSignal.addEventListener('abort', onParentAbort);
            tierAbortController.signal.addEventListener('abort', onTierAbort);
            
            cleanupListeners.push(() => {
              task.context.abortSignal?.removeEventListener('abort', onParentAbort);
              tierAbortController.signal.removeEventListener('abort', onTierAbort);
            });
            linkedSignal = controller.signal;
          } else {
            linkedSignal = tierAbortController.signal;
          }

          const taskContextWithSignal = {
            ...enrichedContext,
            abortSignal: linkedSignal
          };

          return {
            id: task.id,
            context: taskContextWithSignal,
            stream: agent.execute(task.prompt, taskContextWithSignal)
          };
        });

        const eventQueue = new AsyncEventQueue<AgentEvent & { taskId: string }>();
        let activeTaskCount = activeStreams.length;
        let hasError: any = null;

        // Start background runners for each stream to collect events in parallel
        activeStreams.forEach(({ id, context, stream }) => {
          void (async () => {
            try {
              let current = await stream.next();
              while (!current.done) {
                eventQueue.push({ ...(current.value as AgentEvent), taskId: id });
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
              // Abort all other tasks in this tier immediately on error to prevent resource leaks
              tierAbortController.abort();
            } finally {
              activeTaskCount--;
              if (activeTaskCount === 0) {
                eventQueue.setDone();
              }
            }
          })();
        });

        // Yield events as they are pushed to the queue
        try {
          let currentEvent = await eventQueue.next();
          while (!currentEvent.done) {
            if (hasError) {
              throw hasError;
            }
            if (currentEvent.value) {
              yield currentEvent.value;
            }
            currentEvent = await eventQueue.next();
          }
        } catch (err) {
          tierAbortController.abort();
          throw err;
        }

        if (hasError) {
          throw hasError;
        }
      }
    } finally {
      // Clean up all AbortSignal listeners registered for the execution
      cleanupListeners.forEach(cleanup => cleanup());
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
  ): AsyncGenerator<AgentEvent & { activeAgentId?: string }, AgentResponse, unknown> {
    let currentContext = initialContext;
    let currentPrompt = initialPrompt;
    let finalResponse: AgentResponse | null = null;

    for (let i = 0; i < agentIds.length; i++) {
      const agentId = agentIds[i];
      if (currentContext.abortSignal?.aborted) {
        throw new DOMException('The user aborted a request.', 'AbortError');
      }

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

      currentContext = {
        ...currentContext,
        messages: response.messages
      };
      
      // Avoid double-spending: subsequent agent prompts point to the history
      currentPrompt = "Please process and revise the technical note draft outputted by the previous agent in the message history.";
      finalResponse = response;
    }

    return finalResponse!;
  }

  /**
   * Enrich context with dependency results
   * Formats dependency outputs cleanly as structured user contexts
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
          role: 'user',
          content: `[Dependency Task Result (Task ID: ${depId})]\n${depResult.content}`,
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
