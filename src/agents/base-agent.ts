// BaseAgent - Base class for all agents with skill support

import { AIProvider, ChatMessage, ToolCall, GenerateResponse } from '../types';
import { SkillRegistry } from '../skills/core/skill-registry';
import { SkillExecutor } from '../skills/core/skill-executor';
import { SkillInvocationContext } from '../skills/strategies/skill-invocation-strategy';
import { SkillCall, isExecutableSkill } from '../skills/skill-types';
import { AgentConfig, AgentContext, AgentResponse, AgentEvent, DiagnosticsLogger } from './agent-types';

/**
 * Dependencies required by BaseAgent
 */
export interface AgentDependencies {
  skillRegistry: SkillRegistry;
  skillExecutor: SkillExecutor;
  skillInvocationContext: SkillInvocationContext;
  diagnosticsLogger?: DiagnosticsLogger;
}

/**
 * AgentState - State of the conversation execution loop
 * Borrowed from LangGraph's state design pattern
 */
export interface AgentState {
  messages: ChatMessage[];
  systemPrompt: string;
  maxTurns: number;
  turnCount: number;
  fullResponse: string;
  skillCalls: SkillCall[];
  onStream?: (chunk: string) => void;
  skills: any[];
}

/**
 * BaseAgent - Handles agent execution with skill support
 */
export class BaseAgent {
  protected config: AgentConfig;
  protected provider: AIProvider;
  protected skillRegistry: SkillRegistry;
  protected skillExecutor: SkillExecutor;
  protected skillInvocationContext: SkillInvocationContext;
  protected diagnosticsLogger?: DiagnosticsLogger;

  constructor(
    config: AgentConfig,
    provider: AIProvider,
    dependencies: AgentDependencies
  ) {
    this.config = config;
    this.provider = provider;
    this.skillRegistry = dependencies.skillRegistry;
    this.skillExecutor = dependencies.skillExecutor;
    this.skillInvocationContext = dependencies.skillInvocationContext;
    this.diagnosticsLogger = dependencies.diagnosticsLogger;
  }

  /**
   * Main entry point for RAGP event-driven execution.
   * Returns an AsyncGenerator yielding AgentEvents and returning AgentResponse.
   */
  /**
   * Main entry point for RAGP event-driven execution.
   * Returns an AsyncGenerator yielding AgentEvents and returning AgentResponse.
   */
  async *execute(
    prompt: string,
    context: AgentContext
  ): AsyncGenerator<AgentEvent, AgentResponse, any> {
    const startTime = Date.now();
    const systemPrompt = this.buildSystemPrompt();

    yield { type: 'status', message: '初始化智能体...' };

    if (context.abortSignal?.aborted) {
      throw new DOMException('The user aborted a request.', 'AbortError');
    }

    // If skills are disabled or not supported, run simple single-turn generation
    if (!this.config.enableSkills || !this.provider.supportsSkills?.()) {
      yield { type: 'status', message: '正在思考...' };

      if (context.abortSignal?.aborted) {
        throw new DOMException('The user aborted a request.', 'AbortError');
      }

      const messages: ChatMessage[] = [
        ...context.messages,
        { role: 'user', content: prompt, timestamp: Date.now() }
      ];

      let responseContent = '';
      try {
        responseContent = yield* this.streamModelSimple(prompt, {
          systemPrompt,
          temperature: this.config.temperature || 0.7,
          abortSignal: context.abortSignal
        });
      } catch (err: any) {
        yield { type: 'error', message: `大模型执行异常: ${err.message}` };
        throw err;
      }

      messages.push({
        role: 'assistant',
        content: responseContent,
        timestamp: Date.now()
      });

      return {
        content: responseContent,
        messages,
        metadata: {
          turns: 1,
          durationMs: Date.now() - startTime
        }
      };
    }

    // Otherwise, execute multi-turn loop with skills (RAGP)
    let promptTokens = 0;
    let completionTokens = 0;
    let totalTokens = 0;
    let cacheReadTokens = 0;
    let cacheCreationTokens = 0;

    const executedKeysHistory: string[] = [];

    // Configure cyclic loop detection parameters with safe defaults
    const maxCycleLength = context.metadata?.maxCycleLength ?? 4;
    const minRepeats = context.metadata?.minRepeats ?? 4;

    let state: AgentState = {
      messages: [
        ...context.messages,
        { role: 'user', content: prompt, timestamp: Date.now() }
      ],
      systemPrompt,
      maxTurns: Math.max(1, Math.min(99, context.metadata?.maxTurns ?? this.config.maxTurns ?? 20)),
      turnCount: 0,
      fullResponse: '',
      skillCalls: [],
      onStream: undefined, // Handled natively by yielding events
      skills: this.skillInvocationContext.getToolDefinitions(
        this.skillRegistry,
        this.provider.type === 'openai' ? 'openai' : 'anthropic'
      )
    };

    while (state.turnCount < state.maxTurns) {
      if (context.abortSignal?.aborted) {
        throw new DOMException('The user aborted a request.', 'AbortError');
      }

      state.turnCount++;

      // 运行时动态插嘴检测与上下文拼接 (Dynamic Steering)
      if (context.pendingSteerMessages && context.pendingSteerMessages.length > 0) {
        const steerTexts = [...context.pendingSteerMessages];
        context.pendingSteerMessages = []; // 清空

        for (const steerText of steerTexts) {
          // 产生一个人类引导的事件，推送给前端 UI 记录
          yield { type: 'steer', message: steerText };

          // 强行将这一步的人类干预追加到大模型当前轮的 context messages 中！
          state.messages.push({
            role: 'user',
            content: `[HUMAN DYNAMIC INTERVENTION]: ${steerText}`,
            timestamp: Date.now()
          });
        }
      }

      yield { type: 'status', message: `正在思考 (第 ${state.turnCount} 轮)...` };

      // Node A: Stream Model
      let result: GenerateResponse;
      try {
        result = yield* this.streamModel(state.messages, {
          temperature: this.config.temperature || 0.7,
          systemPrompt: state.systemPrompt,
          skills: state.skills,
          toolChoice: 'auto',
          abortSignal: context.abortSignal
        });

        if (result.usage) {
          promptTokens += result.usage.promptTokens;
          completionTokens += result.usage.completionTokens;
          totalTokens += result.usage.totalTokens;
          cacheReadTokens += result.usage.cacheReadTokens ?? 0;
          cacheCreationTokens += result.usage.cacheCreationTokens ?? 0;
        }
      } catch (err: any) {
        yield { type: 'error', message: `大模型决策异常: ${err.message}` };
        throw err;
      }

      // Update state with assistant response
      const assistantMessage: ChatMessage = {
        role: 'assistant',
        content: result.content,
        timestamp: Date.now(),
        tool_calls: result.toolCalls
      };
      
      state = this.mergeState(state, {
        fullResponse: state.fullResponse + result.content,
        messages: [assistantMessage]
      });

      // Check if there are tool calls (Edge)
      if (!result.toolCalls || result.toolCalls.length === 0) {
        break;
      }

      // Node B: Execute Tools
      const newMessages: ChatMessage[] = [];
      const newSkillCalls: SkillCall[] = [];

      for (const toolCall of result.toolCalls) {
        if (context.abortSignal?.aborted) {
          throw new DOMException('The user aborted a request.', 'AbortError');
        }

        const callKey = `${toolCall.name}:${typeof toolCall.arguments === 'string' ? toolCall.arguments : JSON.stringify(toolCall.arguments)}`;

        // Cyclic pattern detection algorithm
        const tempHistory = [...executedKeysHistory, callKey];
        let isLoop = false;
        for (let L = 1; L <= maxCycleLength; L++) {
          if (tempHistory.length < L * minRepeats) continue;
          let patternMatch = true;
          const pattern = tempHistory.slice(tempHistory.length - L);
          for (let r = 1; r < minRepeats; r++) {
            const slice = tempHistory.slice(
              tempHistory.length - L * (r + 1),
              tempHistory.length - L * r
            );
            if (slice.join('|') !== pattern.join('|')) {
              patternMatch = false;
              break;
            }
          }
          if (patternMatch) {
            isLoop = true;
            break;
          }
        }

        if (isLoop) {
          yield { type: 'status', message: `⚠️ 检测到工具调用 [${toolCall.name}] 陷入推理死循环，正在强制干预引导自愈...` };
          yield { type: 'skill_error', name: toolCall.name, error: 'Reasoning loop detected by AP6 Guard' };

          newMessages.push({
            role: 'tool',
            content: `⚠️ SYSTEM ALERT: You have executed the tool '${toolCall.name}' with the identical arguments consecutive times. This indicates you are caught in a repetitive reasoning loop. DO NOT repeat the same tool call with the same arguments. Please reconsider your plan, try a different parameter, use another tool (e.g. search or edit), or ask the user for clarification using 'obsidian:ask_user'.`,
            timestamp: Date.now(),
            tool_call_id: toolCall.id,
            name: toolCall.name
          });

          newSkillCalls.push({
            id: toolCall.id,
            skillName: toolCall.name,
            namespace: 'guard' as any,
            parameters: typeof toolCall.arguments === 'string' ? { raw: toolCall.arguments } : toolCall.arguments,
            status: 'error',
            timestamp: Date.now(),
            result: { success: false, error: 'Loop detected and prevented by AP6 Guard' }
          });
          continue;
        }

        // Add to history
        executedKeysHistory.push(callKey);

        if (this.skillInvocationContext.isMetaToolCall(toolCall.name)) {
          // Handle meta-tool call (spec/invoke)
          let args: Record<string, any>;
          try {
            args = this.safeParseToolArguments(toolCall);
          } catch (err: any) {
            // Parsing failed!
            // Yield skill_call with raw arguments so it appears in the UI console
            yield { type: 'skill_call', name: toolCall.name, params: toolCall.arguments };
            yield { type: 'status', message: `⚠️ 工具 [${toolCall.name}] 参数解析失败，正在引导智能体自我纠错...` };
            yield { type: 'skill_error', name: toolCall.name, error: err.message };

            newMessages.push({
              role: 'tool',
              content: `Error: Failed to parse arguments for tool '${toolCall.name}'. Details: ${err.message}. Please regenerate the tool call with valid, balanced JSON formatting.`,
              timestamp: Date.now(),
              tool_call_id: toolCall.id,
              name: toolCall.name
            });

            newSkillCalls.push({
              id: toolCall.id,
              skillName: toolCall.name,
              namespace: 'meta' as any,
              parameters: { raw_arguments: toolCall.arguments },
              status: 'error',
              timestamp: Date.now(),
              result: { success: false, error: err.message }
            });
            continue;
          }
          
          if (toolCall.name === 'spec') {
            const skillName = args.skill_name;
            yield { type: 'skill_call', name: `spec:${skillName}`, params: toolCall.arguments };

            try {
              const details = this.skillRegistry.getSkillDetails(skillName, 'markdown');
              const isSuccess = !details.startsWith('Error:');

              if (isSuccess) {
                yield { type: 'skill_success', name: `spec:${skillName}`, result: details };
                newMessages.push({
                  role: 'tool',
                  content: details,
                  timestamp: Date.now(),
                  tool_call_id: toolCall.id,
                  name: toolCall.name
                });
              } else {
                yield { type: 'skill_error', name: `spec:${skillName}`, error: details };
                newMessages.push({
                  role: 'tool',
                  content: details,
                  timestamp: Date.now(),
                  tool_call_id: toolCall.id,
                  name: toolCall.name
                });
              }

              newSkillCalls.push({
                id: toolCall.id,
                skillName: toolCall.name,
                namespace: 'meta' as any,
                parameters: args,
                status: isSuccess ? 'success' : 'error',
                timestamp: Date.now(),
                result: { success: isSuccess, data: isSuccess ? details : undefined, error: isSuccess ? undefined : details }
              });
            } catch (err: any) {
              yield { type: 'skill_error', name: `spec:${skillName}`, error: err.message };
              newMessages.push({
                role: 'tool',
                content: `Error: Exception during execution: ${err.message}`,
                timestamp: Date.now(),
                tool_call_id: toolCall.id,
                name: toolCall.name
              });
            }
          } else if (toolCall.name === 'invoke') {
            const skillName = args.skill_name;
            const skillParams = args.params || {};

            if (!skillName) {
              yield { type: 'status', message: `⚠️ 工具 [invoke] 缺少必填参数 skill_name` };
              yield { type: 'skill_error', name: 'invoke:unknown', error: 'Missing required parameter "skill_name"' };
              newMessages.push({
                role: 'tool',
                content: "Error: Missing required parameter 'skill_name' in invoke tool call. You must specify the namespace and skill name (e.g., 'obsidian:edit_note') in 'skill_name'.",
                timestamp: Date.now(),
                tool_call_id: toolCall.id,
                name: toolCall.name
              });
              continue;
            }

            const skill = this.skillRegistry.get(skillName);
            const requiresConfirmation = skill && isExecutableSkill(skill) && skill.metadata?.requiresConfirmation;
            let executeApproved = true;

            if (requiresConfirmation) {
              yield { type: 'status', message: `等待授权: ${skillName}` };

              let resolveConfirm!: (value: { approved: boolean; modifiedParams?: any }) => void;
              const confirmPromise = new Promise<{ approved: boolean; modifiedParams?: any }>((resolve) => {
                resolveConfirm = resolve;
              });

              // Interactive prompt yielding (Human-in-the-loop) with resolve callback
              yield {
                type: 'confirm_request',
                skillName: skillName,
                params: skillParams,
                message: `智能体申请执行操作: 【${skill.description || skillName}】。是否批准？`,
                resolve: resolveConfirm
              };

              if (context.abortSignal?.aborted) {
                throw new DOMException('The user aborted a request.', 'AbortError');
              }

              const userFeedback = await confirmPromise;
              executeApproved = userFeedback?.approved ?? true;
              if (userFeedback?.modifiedParams) {
                args.params = userFeedback.modifiedParams;
              }
            }

            if (!executeApproved) {
              yield { type: 'status', message: `用户已拒绝: ${skillName}` };
              newMessages.push({
                role: 'tool',
                content: 'Error: Execution cancelled by user.',
                timestamp: Date.now(),
                tool_call_id: toolCall.id,
                name: toolCall.name
              });
              continue;
            }

            yield { type: 'skill_call', name: `invoke:${skillName}`, params: args.params };

            try {
              // Parse skill name to get namespace and name
              const { namespace, name } = this.skillRegistry.parseName(skillName);

              // Execute the skill
              const runResult = await this.skillExecutor.execute(namespace, name, args.params);

              if (runResult.success) {
                yield { type: 'skill_success', name: `invoke:${skillName}`, result: runResult.data };
                newMessages.push({
                  role: 'tool',
                  content: JSON.stringify(runResult.data, null, 2),
                  timestamp: Date.now(),
                  tool_call_id: toolCall.id,
                  name: toolCall.name
                });
                this.handleSubagentMessages(skillName, runResult, newMessages, toolCall.id);
              } else {
                yield { type: 'status', message: `⚠️ 工具 [${skillName}] 运行失败，正在自动引导纠错...` };
                yield { type: 'skill_error', name: `invoke:${skillName}`, error: runResult.error || '执行失败' };
                newMessages.push({
                  role: 'tool',
                  content: `Error: ${runResult.error || 'Unknown error'}`,
                  timestamp: Date.now(),
                  tool_call_id: toolCall.id,
                  name: toolCall.name
                });
              }

              newSkillCalls.push({
                id: toolCall.id,
                skillName: toolCall.name,
                namespace: 'meta' as any,
                parameters: args,
                status: runResult.success ? 'success' : 'error',
                timestamp: Date.now(),
                result: runResult
              });
            } catch (err: any) {
              yield { type: 'status', message: `⚠️ 工具 [${skillName}] 解析或调用异常，正在自动纠错...` };
              yield { type: 'skill_error', name: `invoke:${skillName}`, error: err.message };
              newMessages.push({
                role: 'tool',
                content: `Error: Exception during execution: ${err.message}`,
                timestamp: Date.now(),
                tool_call_id: toolCall.id,
                name: toolCall.name
              });
            }
          }
        } else {
          // Direct skill call
          const skill = this.skillRegistry.get(toolCall.name);
          const requiresConfirmation = skill && isExecutableSkill(skill) && skill.metadata?.requiresConfirmation;
          let executeApproved = true;

          if (requiresConfirmation) {
            yield { type: 'status', message: `等待授权: ${toolCall.name}` };

            let resolveConfirm!: (value: { approved: boolean; modifiedParams?: any }) => void;
            const confirmPromise = new Promise<{ approved: boolean; modifiedParams?: any }>((resolve) => {
              resolveConfirm = resolve;
            });

            // Interactive prompt yielding (Human-in-the-loop) with resolve callback
            yield {
              type: 'confirm_request',
              skillName: toolCall.name,
              params: toolCall.arguments,
              message: `智能体申请执行操作: 【${skill.description || toolCall.name}】。是否批准？`,
              resolve: resolveConfirm
            };

            if (context.abortSignal?.aborted) {
              throw new DOMException('The user aborted a request.', 'AbortError');
            }

            const userFeedback = await confirmPromise;
            executeApproved = userFeedback?.approved ?? true;
            if (userFeedback?.modifiedParams) {
              toolCall.arguments = userFeedback.modifiedParams;
            }
          }

          if (!executeApproved) {
            yield { type: 'status', message: `用户已拒绝: ${toolCall.name}` };
            newMessages.push({
              role: 'tool',
              content: 'Error: Execution cancelled by user.',
              timestamp: Date.now(),
              tool_call_id: toolCall.id,
              name: toolCall.name
            });
            continue;
          }

          yield { type: 'skill_call', name: toolCall.name, params: toolCall.arguments };

          try {
            const runResult = await this.skillExecutor.executeFromToolCall(toolCall, { skipConfirmation: true });
            
            if (runResult.success) {
              yield { type: 'skill_success', name: toolCall.name, result: runResult.data };
              newMessages.push({
                role: 'tool',
                content: JSON.stringify(runResult.data, null, 2),
                timestamp: Date.now(),
                tool_call_id: toolCall.id,
                name: toolCall.name
              });
              this.handleSubagentMessages(toolCall.name, runResult, newMessages, toolCall.id);
            } else {
              yield { type: 'status', message: `⚠️ 工具 [${toolCall.name}] 运行失败，正在自动引导纠错...` };
              yield { type: 'skill_error', name: toolCall.name, error: runResult.error || '执行失败' };
              newMessages.push({
                role: 'tool',
                content: `Error: ${runResult.error || 'Unknown error'}`,
                timestamp: Date.now(),
                tool_call_id: toolCall.id,
                name: toolCall.name
              });
            }
            
            // Safe JSON parsing of parameters to avoid crashing the execute loop on malformed toolCall.arguments
            let parsedParams = {};
            try {
              parsedParams = typeof toolCall.arguments === 'string' ? JSON.parse(toolCall.arguments) : toolCall.arguments;
            } catch {
              parsedParams = { raw_arguments: toolCall.arguments };
            }

            newSkillCalls.push({
              id: toolCall.id,
              skillName: toolCall.name,
              namespace: toolCall.name.startsWith('mcp:') ? 'mcp' : 'obsidian',
              parameters: parsedParams,
              status: runResult.success ? 'success' : 'error',
              timestamp: Date.now(),
              result: runResult
            });
          } catch (execErr: any) {
            yield { type: 'status', message: `⚠️ 工具 [${toolCall.name}] 参数解析或运行异常，正在自动纠错...` };
            yield { type: 'skill_error', name: toolCall.name, error: execErr.message };
            
            // Avoid duplicate message if it was already pushed inside the try block before exception
            const isAlreadyPushed = newMessages.some(m => m.tool_call_id === toolCall.id);
            if (!isAlreadyPushed) {
              newMessages.push({
                role: 'tool',
                content: `Error: Exception during execution: ${execErr.message}`,
                timestamp: Date.now(),
                tool_call_id: toolCall.id,
                name: toolCall.name
              });
            }

            newSkillCalls.push({
              id: toolCall.id,
              skillName: toolCall.name,
              namespace: toolCall.name.startsWith('mcp:') ? 'mcp' : 'obsidian',
              parameters: { raw_arguments: toolCall.arguments },
              status: 'error',
              timestamp: Date.now(),
              result: { success: false, error: execErr.message }
            });
          }
        }
      }

      state = this.mergeState(state, {
        messages: newMessages,
        skillCalls: newSkillCalls
      });
    }

    const isLimitReached = state.turnCount >= state.maxTurns;
    if (isLimitReached) {
      console.warn('[BaseAgent] Reached maximum turns limit');
    }

    yield { type: 'status', message: '任务完成！' };

    // Attach usage stats to the last assistant message
    const assistantMsgs = state.messages.filter(m => m.role === 'assistant');
    if (assistantMsgs.length > 0) {
      const lastMsg = assistantMsgs[assistantMsgs.length - 1];
      lastMsg.metadata = {
        ...lastMsg.metadata,
        isMaxTurnsReached: isLimitReached || undefined,
        usage: {
          promptTokens,
          completionTokens,
          totalTokens,
          cacheReadTokens,
          cacheCreationTokens
        }
      };
    }

    return {
      content: state.fullResponse,
      messages: state.messages,
      skillCalls: state.skillCalls,
      metadata: {
        turns: state.turnCount,
        durationMs: Date.now() - startTime,
        usage: {
          promptTokens,
          completionTokens,
          totalTokens,
          cacheReadTokens,
          cacheCreationTokens
        }
      }
    };
  }

  /**
   * Helper: Bridges callback-based LLM stream with skills into an async generator of AgentEvents.
   * Utilizes a highly robust asynchronous queue bridge with cooperative abort support.
   */
  private async *streamModel(
    messages: ChatMessage[],
    options: any
  ): AsyncGenerator<AgentEvent, GenerateResponse, any> {
    const queue: AgentEvent[] = [];
    let resolveNext: (() => void) | null = null;
    let completed = false;
    let finalResult: GenerateResponse | null = null;
    let error: any = null;

    const onAbort = () => {
      completed = true;
      if (resolveNext) {
        resolveNext();
        resolveNext = null;
      }
    };

    if (options?.abortSignal) {
      if (options.abortSignal.aborted) {
        throw new DOMException('The user aborted a request.', 'AbortError');
      }
      options.abortSignal.addEventListener('abort', onAbort);
    }

    this.provider.generateStreamWithSkills!(
      messages,
      (chunk: string) => {
        queue.push({ type: 'chunk', text: chunk });
        if (resolveNext) {
          resolveNext();
          resolveNext = null;
        }
      },
      undefined,
      options
    ).then((result) => {
      finalResult = result;
      completed = true;
      if (resolveNext) {
        resolveNext();
        resolveNext = null;
      }
    }).catch((err) => {
      error = err;
      completed = true;
      if (resolveNext) {
        resolveNext();
        resolveNext = null;
      }
    });

    try {
      while (!completed || queue.length > 0) {
        if (options?.abortSignal?.aborted) {
          throw new DOMException('The user aborted a request.', 'AbortError');
        }
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            resolveNext = resolve;
          });
        }
        while (queue.length > 0) {
          yield queue.shift()!;
        }
      }
    } finally {
      if (options?.abortSignal) {
        options.abortSignal.removeEventListener('abort', onAbort);
      }
    }

    if (error) {
      throw error;
    }

    return finalResult!;
  }

  private async *streamModelSimple(
    prompt: string,
    options: any
  ): AsyncGenerator<AgentEvent, string, any> {
    const queue: AgentEvent[] = [];
    let resolveNext: (() => void) | null = null;
    let completed = false;
    let error: any = null;
    let fullResponse = '';

    const onAbort = () => {
      completed = true;
      if (resolveNext) {
        resolveNext();
        resolveNext = null;
      }
    };

    if (options?.abortSignal) {
      if (options.abortSignal.aborted) {
        throw new DOMException('The user aborted a request.', 'AbortError');
      }
      options.abortSignal.addEventListener('abort', onAbort);
    }

    this.provider.generateStream(
      prompt,
      (chunk: string) => {
        fullResponse += chunk;
        queue.push({ type: 'chunk', text: chunk });
        if (resolveNext) {
          resolveNext();
          resolveNext = null;
        }
      },
      options
    ).then(() => {
      completed = true;
      if (resolveNext) {
        resolveNext();
        resolveNext = null;
      }
    }).catch((err) => {
      error = err;
      completed = true;
      if (resolveNext) {
        resolveNext();
        resolveNext = null;
      }
    });

    try {
      while (!completed || queue.length > 0) {
        if (options?.abortSignal?.aborted) {
          throw new DOMException('The user aborted a request.', 'AbortError');
        }
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            resolveNext = resolve;
          });
        }
        while (queue.length > 0) {
          yield queue.shift()!;
        }
      }
    } finally {
      if (options?.abortSignal) {
        options.abortSignal.removeEventListener('abort', onAbort);
      }
    }

    if (error) {
      throw error;
    }

    return fullResponse;
  }

  private mergeState(current: AgentState, update: Partial<AgentState>): AgentState {
    return {
      ...current,
      ...update,
      messages: update.messages ? [...current.messages, ...update.messages] : current.messages,
      skillCalls: update.skillCalls ? [...current.skillCalls, ...update.skillCalls] : current.skillCalls
    };
  }
  private escapeLoneBackslashes(jsonStr: string): string {
    let result = '';
    for (let i = 0; i < jsonStr.length; i++) {
      const char = jsonStr[i];
      if (char === '\\') {
        const nextChar = jsonStr[i + 1];
        if (nextChar === undefined) {
          result += '\\\\';
        } else if (['"', '\\', '/', 'b', 'f', 'n', 'r', 't'].includes(nextChar)) {
          result += '\\' + nextChar;
          i++;
        } else if (nextChar === 'u') {
          const hex = jsonStr.substring(i + 2, i + 6);
          if (/^[0-9a-fA-F]{4}$/.test(hex)) {
            result += '\\u' + hex;
            i += 5;
          } else {
            result += '\\\\';
          }
        } else {
          result += '\\\\';
        }
      } else {
        result += char;
      }
    }
    return result;
  }



  /**
   * Safely parse tool call arguments
   */
  private safeParseToolArguments(toolCall: ToolCall): Record<string, any> {
    if (typeof toolCall.arguments !== 'string') {
      return toolCall.arguments;
    }

    const argsString = toolCall.arguments as string;

    try {
      return JSON.parse(argsString);
    } catch (error: any) {
      console.warn(`[BaseAgent] JSON strict parse failed for ${toolCall.name}, trying escape-healing...`);

      try {
        const healedArgsString = this.escapeLoneBackslashes(argsString);
        const parsed = JSON.parse(healedArgsString);
        
        console.log(`[BaseAgent] JSON parse healed successfully for ${toolCall.name}`);
        this.logDiagnosticIncident(toolCall.name, argsString, error.message, 'Healed (JSON Preprocessor)', healedArgsString);
        
        return parsed;
      } catch (healingError: any) {
        console.error(`[BaseAgent] JSON escape-healing failed for ${toolCall.name}:`, healingError.message);
        
        // Log final failure strictly for diagnostics
        this.logDiagnosticIncident(toolCall.name, argsString, error.message, 'Failed (Strict Parsing)');

        throw new Error(
          `Failed to parse tool call arguments for ${toolCall.name}: ${error.message}`
        );
      }
    }
  }

  /**
   * Appends a tool execution or parsing failure incident to the diagnostic log file
   */
  /**
   * Delegates a tool execution or parsing failure incident to the diagnostic logger
   */
  private async logDiagnosticIncident(
    toolName: string,
    originalArgs: string,
    errorMessage: string,
    strategy: string,
    repairedArgs?: string
  ): Promise<void> {
    try {
      if (this.diagnosticsLogger) {
        await this.diagnosticsLogger.logIncident({
          agentId: this.config.id,
          agentName: this.config.name,
          toolName,
          originalArgs,
          errorMessage,
          strategy,
          repairedArgs,
          success: !!repairedArgs
        });
      }
    } catch (err) {
      console.error('[BaseAgent] Failed to write diagnostic log:', err);
    }
  }
  private buildSystemPrompt(): string {
    return this.config.systemPrompt || 'You are a helpful AI assistant.';
  }

  // Getters
  getId(): string {
    return this.config.id;
  }

  getName(): string {
    return this.config.name;
  }

  getDescription(): string {
    return this.config.description;
  }

  getConfig(): AgentConfig {
    return { ...this.config };
  }

  /**
   * Helper to extract subagent messages and tag them with subagent metadata
   */
  private handleSubagentMessages(skillName: string, runResult: any, targetArray: ChatMessage[], toolCallId?: string): void {
    const isDelegate = skillName === 'obsidian:delegate_task' || skillName === 'obsidian:spawn_subagent' || 
                       skillName === 'delegate_task' || skillName === 'spawn_subagent';
    if (isDelegate && runResult.metadata?.subagentMessages) {
      const subMessages = runResult.metadata.subagentMessages.map((m: any) => ({
        ...m,
        metadata: {
          ...m.metadata,
          isSubagent: true,
          agentId: runResult.metadata.agentId || 'subagent',
          parentToolCallId: toolCallId
        }
      }));
      targetArray.push(...subMessages);
    }
  }
}
