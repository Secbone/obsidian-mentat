// BaseAgent - Base class for all agents with skill support

import { AIProvider, ChatMessage, ToolCall, GenerateResponse } from '../types';
import { SkillRegistry } from '../skills/core/skill-registry';
import { SkillExecutor } from '../skills/core/skill-executor';
import { SkillInvocationContext } from '../skills/strategies/skill-invocation-strategy';
import { SkillCall, isExecutableSkill } from '../skills/skill-types';
import { AgentConfig, AgentContext, AgentResponse, AgentEvent } from './agent-types';

/**
 * Dependencies required by BaseAgent
 */
export interface AgentDependencies {
  skillRegistry: SkillRegistry;
  skillExecutor: SkillExecutor;
  skillInvocationContext: SkillInvocationContext;
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
  }

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

    // If skills are disabled or not supported, run simple single-turn generation
    if (!this.config.enableSkills || !this.provider.supportsSkills?.()) {
      yield { type: 'status', message: '正在思考...' };

      const messages: ChatMessage[] = [
        ...context.messages,
        { role: 'user', content: prompt, timestamp: Date.now() }
      ];

      let responseContent = '';
      try {
        responseContent = yield* this.streamModelSimple(prompt, {
          systemPrompt,
          temperature: this.config.temperature || 0.7
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
    const executedKeysHistory: string[] = [];
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
          toolChoice: 'auto'
        });
      } catch (err: any) {
        yield { type: 'error', message: `大模型决策异常: ${err.message}` };
        throw err;
      }

      // Look for Markdown Block Tool Calls (MBTC)
      if (!result.toolCalls || result.toolCalls.length === 0) {
        const blockCalls = this.parseBlockToolCalls(result.content);
        if (blockCalls.length > 0) {
          result.toolCalls = blockCalls;
        }
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
        const callKey = `${toolCall.name}:${typeof toolCall.arguments === 'string' ? toolCall.arguments : JSON.stringify(toolCall.arguments)}`;

        // Check if the last two executed keys are identical to the current one (consecutive 3x)
        const isConsecutiveLoop = executedKeysHistory.length >= 2 &&
                                  executedKeysHistory[executedKeysHistory.length - 1] === callKey &&
                                  executedKeysHistory[executedKeysHistory.length - 2] === callKey;

        if (isConsecutiveLoop) {
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
            namespace: 'guard',
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
              namespace: 'meta',
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
                namespace: 'meta',
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

              // Interactive prompt yielding (Human-in-the-loop)
              const userFeedback: { approved: boolean; modifiedParams?: any } = yield {
                type: 'confirm_request',
                skillName: skillName,
                params: skillParams,
                message: `智能体申请执行操作: 【${skill.metadata?.description || skillName}】。是否批准？`
              };

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
                namespace: 'meta',
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

            // Interactive prompt yielding (Human-in-the-loop)
            const userFeedback: { approved: boolean; modifiedParams?: any } = yield {
              type: 'confirm_request',
              skillName: toolCall.name,
              params: toolCall.arguments,
              message: `智能体申请执行操作: 【${skill.metadata?.description || toolCall.name}】。是否批准？`
            };

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
            const runResult = await this.skillExecutor.executeFromToolCall(toolCall);
            
            if (runResult.success) {
              yield { type: 'skill_success', name: toolCall.name, result: runResult.data };
              newMessages.push({
                role: 'tool',
                content: JSON.stringify(runResult.data, null, 2),
                timestamp: Date.now(),
                tool_call_id: toolCall.id,
                name: toolCall.name
              });
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

    if (state.turnCount >= state.maxTurns) {
      console.warn('[BaseAgent] Reached maximum turns limit');
    }

    yield { type: 'status', message: '任务完成！' };

    return {
      content: state.fullResponse,
      messages: state.messages,
      skillCalls: state.skillCalls,
      metadata: {
        turns: state.turnCount,
        durationMs: Date.now() - startTime
      }
    };
  }

  /**
   * Helper: Bridges callback-based LLM stream with skills into an async generator of AgentEvents.
   * Utilizes a highly robust asynchronous queue bridge.
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

    while (!completed || queue.length > 0) {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          resolveNext = resolve;
        });
      }
      while (queue.length > 0) {
        yield queue.shift()!;
      }
    }

    if (error) {
      throw error;
    }

    return finalResult!;
  }

  /**
   * Helper: Bridges callback-based LLM simple stream into an async generator of AgentEvents.
   * Utilizes a highly robust asynchronous queue bridge.
   */
  private async *streamModelSimple(
    prompt: string,
    options: any
  ): AsyncGenerator<AgentEvent, string, any> {
    const queue: AgentEvent[] = [];
    let resolveNext: (() => void) | null = null;
    let completed = false;
    let error: any = null;
    let fullResponse = '';

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

    while (!completed || queue.length > 0) {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          resolveNext = resolve;
        });
      }
      while (queue.length > 0) {
        yield queue.shift()!;
      }
    }

    if (error) {
      throw error;
    }

    return fullResponse;
  }

  /**
   * Reducer to cleanly merge state updates.
   * Appends messages and skill calls to preserve history.
   */
  private mergeState(current: AgentState, update: Partial<AgentState>): AgentState {
    return {
      ...current,
      ...update,
      messages: update.messages ? [...current.messages, ...update.messages] : current.messages,
      skillCalls: update.skillCalls ? [...current.skillCalls, ...update.skillCalls] : current.skillCalls
    };
  }

  /**
   * Execute a tool call
   */
  private async executeToolCall(
    toolCall: ToolCall,
    onStream?: (chunk: string) => void
  ): Promise<SkillCall> {
    // Check if this is a meta-tool call (spec or invoke)
    if (this.skillInvocationContext.isMetaToolCall(toolCall.name)) {
      return await this.handleMetaToolCall(toolCall, onStream);
    } else {
      return await this.handleDirectSkillCall(toolCall, onStream);
    }
  }

  /**
   * Handle meta-tool calls (spec/invoke)
   */
  private async handleMetaToolCall(
    toolCall: ToolCall,
    onStream?: (chunk: string) => void
  ): Promise<SkillCall> {
    const args = this.safeParseToolArguments(toolCall);

    const skillCall: SkillCall = {
      id: toolCall.id,
      skillName: toolCall.name,
      namespace: 'meta',
      parameters: args,
      status: 'executing',
      timestamp: Date.now()
    };

    let resultContent: string;
    let success = true;

    if (toolCall.name === 'spec') {
      // Handle spec: get skill specification
      const skillName = args.skill_name;

      if (!skillName) {
        success = false;
        resultContent = "Error: Missing required parameter 'skill_name' in spec tool call. You must specify which skill you want to see specification for.";
        if (onStream) {
          onStream(`✗ failed\n\n`);
        }
      } else {
        if (onStream) {
          onStream(`\n\n📖 Getting spec: ${skillName}\n`);
        }

        const details = this.skillRegistry.getSkillDetails(skillName, 'markdown');

        if (details.startsWith('Error:')) {
          success = false;
          resultContent = details;
          if (onStream) {
            onStream(`✗ not found\n\n`);
          }
        } else {
          resultContent = details;
          if (onStream) {
            onStream(`✓ loaded\n\n`);
          }
        }
      }
    } else if (toolCall.name === 'invoke') {
      // Handle invoke: execute the actual skill
      const skillName = args.skill_name;
      const skillParams = args.params || {};

      if (!skillName) {
        success = false;
        resultContent = "Error: Missing required parameter 'skill_name' in invoke tool call. You must specify the namespace and skill name (e.g., 'obsidian:edit_note') in 'skill_name'.";
        if (onStream) {
          onStream(`✗ failed\n\n`);
        }
      } else {
        // Get skill for display purposes
        const skill = this.skillRegistry.get(skillName);
        const shortName = skillName.split(':').pop() || skillName;
        const displayParam = this.getSkillDisplayParam(skillName, skillParams);
        const requiresConfirmation = skill && isExecutableSkill(skill) && skill.metadata?.requiresConfirmation;

        // Notify about skill call
        if (onStream) {
          if (requiresConfirmation) {
            const paramStr = displayParam ? `(${displayParam})` : '()';
            onStream(`\n\n⚠️ ${shortName}${paramStr}\n`);
          } else {
            const paramStr = displayParam ? `(${displayParam})` : '()';
            onStream(`\n\n${shortName}${paramStr}\n`);
          }
        }

        // Parse skill name to get namespace and name
        const { namespace, name } = this.skillRegistry.parseName(skillName);

        // Execute the skill
        const result = await this.skillExecutor.execute(namespace, name, skillParams);

        success = result.success;
        resultContent = result.success
          ? JSON.stringify(result.data, null, 2)
          : `Error: ${result.error}`;

        // Notify about completion
        if (onStream) {
          if (result.success) {
            onStream(`✓ success\n\n`);
          } else if (result.error && result.error.includes('cancelled')) {
            onStream(`✗ cancelled\n\n`);
          } else {
            onStream(`✗ failed\n\n`);
          }
        }
      }
    } else {
      success = false;
      resultContent = `Unknown meta-tool: ${toolCall.name}`;
    }

    skillCall.status = success ? 'success' : 'error';
    skillCall.result = {
      success,
      data: success ? resultContent : undefined,
      error: success ? undefined : resultContent
    };
    skillCall.executionTime = Date.now() - skillCall.timestamp;

    return skillCall;
  }

  /**
   * Handle direct skill calls
   */
  private async handleDirectSkillCall(
    toolCall: ToolCall,
    onStream?: (chunk: string) => void
  ): Promise<SkillCall> {
    const args = this.safeParseToolArguments(toolCall);

    const skillCall: SkillCall = {
      id: toolCall.id,
      skillName: toolCall.name,
      namespace: toolCall.name.startsWith('mcp:') ? 'mcp' : 'obsidian',
      parameters: args,
      status: 'executing',
      timestamp: Date.now()
    };

    // Check if skill requires confirmation
    const skill = this.skillRegistry.get(toolCall.name);
    const requiresConfirmation = skill && isExecutableSkill(skill) && skill.metadata?.requiresConfirmation;
    const isAskUser = toolCall.name === 'obsidian:ask_user';

    // Notify about skill call
    if (onStream) {
      const shortName = toolCall.name.split(':').pop() || toolCall.name;
      const displayParam = this.getSkillDisplayParam(toolCall.name, args);

      if (isAskUser) {
        onStream(`\n\n${shortName}()\n`);
      } else if (requiresConfirmation) {
        const paramStr = displayParam ? `(${displayParam})` : '()';
        onStream(`\n\n⚠️ ${shortName}${paramStr}\n`);
      } else {
        const paramStr = displayParam ? `(${displayParam})` : '()';
        onStream(`\n\n${shortName}${paramStr}\n`);
      }
    }

    // Execute the skill
    const result = await this.skillExecutor.executeFromToolCall(toolCall);

    skillCall.status = result.success ? 'success' : 'error';
    skillCall.result = result;
    skillCall.executionTime = Date.now() - skillCall.timestamp;

    // Notify about completion
    if (onStream) {
      if (result.success) {
        onStream(`✓ success\n\n`);
      } else if (result.error && result.error.includes('cancelled')) {
        onStream(`✗ cancelled\n\n`);
      } else {
        onStream(`✗ failed\n\n`);
      }
    }

    return skillCall;
  }

  /**
   * Scans a JSON string, identifies raw backslashes that do not form valid JSON
   * escape sequences, and double-escapes them so they can be parsed successfully.
   */
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
   * Parses Markdown block-style tool calls (MBTC) from assistant response text.
   * Format: ```obsidian:edit_note path="Research/KTO.md" heading="KTO" ...
   * content inside block
   * ```
   */
  private parseBlockToolCalls(text: string): ToolCall[] {
    const toolCalls: ToolCall[] = [];
    // Match obsidian:edit_note, obsidian:editnote, obsidian:create_note, or obsidian:createnote block syntax
    const blockRegex = /```(obsidian:edit_note|obsidian:editnote|obsidian:create_note|obsidian:createnote)\s*([^\n]*)\n([\s\S]*?)```/g;
    
    let match;
    let index = 1;
    while ((match = blockRegex.exec(text)) !== null) {
      const [_, skillName, attributesStr, bodyContent] = match;
      
      // Map to official registered skill names if underscores are omitted
      let officialName = skillName;
      if (officialName === 'obsidian:editnote') officialName = 'obsidian:edit_note';
      else if (officialName === 'obsidian:createnote') officialName = 'obsidian:create_note';
      
      const params: Record<string, any> = { content: bodyContent.trim() };
      
      // Parse attributes in the header, e.g. path="Research/KTO.md" heading="KTO"
      if (attributesStr) {
        const attrRegex = /(\w+)\s*=\s*['"]([^'"]*)['"]/g;
        let attrMatch;
        while ((attrMatch = attrRegex.exec(attributesStr)) !== null) {
          const [__, key, value] = attrMatch;
          if (value === 'true') params[key] = true;
          else if (value === 'false') params[key] = false;
          else params[key] = value;
        }
      }
      
      toolCalls.push({
        id: `block_call_${Date.now()}_${index++}`,
        name: officialName,
        arguments: params
      });
    }
    
    return toolCalls;
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
  private async logDiagnosticIncident(
    toolName: string,
    originalArgs: string,
    errorMessage: string,
    strategy: string,
    repairedArgs?: string
  ): Promise<void> {
    try {
      const vault = this.skillExecutor.getContext().vault;
      if (!vault) return;

      const logDir = '.mentat';
      const logPath = `${logDir}/diagnostics.jsonl`;

      // Check if folder exists, if not, create it
      if (!(await vault.adapter.exists(logDir))) {
        await vault.adapter.mkdir(logDir);
      }

      const logEntry = {
        timestamp: Date.now(),
        time: new Date().toISOString(),
        agentId: this.config.id,
        agentName: this.config.name,
        toolName,
        originalArgs,
        errorMessage,
        strategy,
        repairedArgs,
        success: !!repairedArgs
      };

      await vault.adapter.append(logPath, JSON.stringify(logEntry) + '\n');
    } catch (err) {
      console.error('[BaseAgent] Failed to write diagnostic log:', err);
    }
  }

  /**
   * Scans a JSON string to escape raw control characters and repair unescaped quotes inside string literals
   */
  private repairJsonString(json: string): string {
    let output = '';
    let inString = false;
    let i = 0;

    while (i < json.length) {
      const char = json[i];

      if (inString) {
        if (char === '\\') {
          // Skip escape sequence
          output += char;
          if (i + 1 < json.length) {
            output += json[i + 1];
            i += 2;
          } else {
            i++;
          }
          continue;
        }

        if (char === '\n') {
          output += '\\n';
          i++;
          continue;
        }

        if (char === '\r') {
          output += '\\r';
          i++;
          continue;
        }

        if (char === '"') {
          // Look ahead to check if this is the actual closing quote of the string.
          // In standard JSON, a closing quote must be followed by optional whitespace and then one of: , } ] or : (for keys) or end of string.
          let j = i + 1;
          while (j < json.length && /\s/.test(json[j])) {
            j++;
          }

          const nextChar = json[j];
          const isValidClosing =
            j === json.length ||
            nextChar === ',' ||
            nextChar === '}' ||
            nextChar === ']' ||
            nextChar === ':';

          if (isValidClosing) {
            inString = false;
            output += char;
          } else {
            // Unescaped quote! Escape it
            output += '\\"';
          }
        } else {
          output += char;
        }
        i++;
      } else {
        if (char === '"') {
          inString = true;
        }
        output += char;
        i++;
      }
    }

    return output;
  }

  /**
   * Scans a truncated or unterminated JSON string, closes any open string literals,
   * and balances all open curly braces and square brackets in reverse nesting order.
   */
  private repairTruncatedJson(json: string): string {
    let inString = false;
    let escaped = false;
    const stack: ('{' | '[')[] = [];
    let i = 0;

    while (i < json.length) {
      const char = json[i];

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === '\\') {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
      } else {
        if (char === '"') {
          inString = true;
        } else if (char === '{') {
          stack.push('{');
        } else if (char === '[') {
          stack.push('[');
        } else if (char === '}') {
          if (stack[stack.length - 1] === '{') {
            stack.pop();
          }
        } else if (char === ']') {
          if (stack[stack.length - 1] === '[') {
            stack.pop();
          }
        }
      }
      i++;
    }

    let repaired = json;
    if (inString) {
      // If we ended with a trailing escape backslash, slice it off first
      if (escaped && repaired.endsWith('\\')) {
        repaired = repaired.slice(0, -1);
      }
      repaired += '"';
    }

    // Pop remaining open brackets/braces from the stack and append their closing matches
    while (stack.length > 0) {
      const open = stack.pop();
      if (open === '{') {
        repaired += '}';
      } else if (open === '[') {
        repaired += ']';
      }
    }

    return repaired;
  }

  /**
   * Get display parameter for skill execution messages
   */
  private getSkillDisplayParam(skillName: string, parameters: Record<string, any>): string {
    // File operations - show filename only
    if (parameters.path) {
      const filename = parameters.path.split('/').pop() || parameters.path;
      return filename;
    }

    // Query operations
    if (parameters.query) {
      return `"${parameters.query.substring(0, 30)}"`;
    }

    if (parameters.pattern) {
      return parameters.pattern;
    }

    if (parameters.tags && Array.isArray(parameters.tags)) {
      return `tags: [${parameters.tags.slice(0, 2).join(', ')}]`;
    }

    return '';
  }

  /**
   * Build system prompt
   */
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
}
