// BaseAgent - Base class for all agents with skill support

import { safeParseJson, normalizeJsonArguments } from '../utils/json-healer';
import { AIProvider, ChatMessage, ToolCall, GenerateResponse } from '../types';
import { SkillRegistry } from '../skills/core/skill-registry';
import { SkillExecutor } from '../skills/core/skill-executor';
import { SkillInvocationContext } from '../skills/strategies/skill-invocation-strategy';
import { SkillCall, isExecutableSkill, SkillResult, SkillNamespace } from '../skills/skill-types';
import { AgentConfig, AgentContext, AgentResponse, AgentEvent, DiagnosticsLogger } from './agent-types';
import { Compactor } from './compactor';
import { EventBus } from '../extensions/event-bus';

interface ToolCallResult {
  toolMessages: ChatMessage[];
  skillCalls: SkillCall[];
}

/**
 * Collects all events from an AsyncGenerator and returns the final return value.
 * Used for parallel tool execution where yield* cannot be used across concurrent tasks.
 */
async function collectGeneratorEvents<TEvent, TReturn>(
  gen: AsyncGenerator<TEvent, TReturn, unknown>
): Promise<{ events: TEvent[]; result: TReturn }> {
  const events: TEvent[] = [];
  let next = await gen.next();
  while (!next.done) {
    events.push(next.value);
    next = await gen.next();
  }
  return { events, result: next.value as TReturn };
}

interface StreamOptions {
  temperature?: number;
  systemPrompt?: string;
  skills?: unknown[];
  toolChoice?: string;
  abortSignal?: AbortSignal;
  [key: string]: unknown;
}

/**
 * Dependencies required by BaseAgent
 */
export interface AgentDependencies {
  skillRegistry: SkillRegistry;
  skillExecutor: SkillExecutor;
  skillInvocationContext: SkillInvocationContext;
  diagnosticsLogger?: DiagnosticsLogger;
  compactor?: Compactor;
  eventBus?: EventBus;
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
  skills: unknown[];
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
  protected compactor: Compactor;
  protected eventBus?: EventBus;

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
    this.compactor = dependencies.compactor ?? new Compactor(provider);
    this.eventBus = dependencies.eventBus;
  }

  /**
   * Main entry point for RAGP execution.
   * Returns Promise<AgentResponse>. Emits events to EventBus for UI and extensions.
   */
  async execute(
    prompt: string,
    context: AgentContext
  ): Promise<AgentResponse> {
    const gen = this.executeGenerator(prompt, context);
    let result = await gen.next();
    while (!result.done) {
      this.eventBus?.emit(result.value as AgentEvent);
      result = await gen.next();
    }
    return result.value as AgentResponse;
  }

  /**
   * Internal generator — yields AgentEvent, returns AgentResponse.
   */
  private async *executeGenerator(
    prompt: string,
    context: AgentContext
  ): AsyncGenerator<AgentEvent, AgentResponse, unknown> {
    const startTime = Date.now();
    const systemPrompt = this.buildSystemPrompt();

    yield { type: 'agent_start' };
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
      } catch (err: unknown) {
        yield { type: 'error', message: `大模型执行异常: ${err instanceof Error ? err.message : String(err)}` };
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
    const maxCycleLength = (context.metadata as Record<string, number> | undefined)?.maxCycleLength ?? 4;
    const minRepeats = (context.metadata as Record<string, number> | undefined)?.minRepeats ?? 4;

    const userMessage: ChatMessage = {
      role: 'user',
      content: prompt,
      timestamp: Date.now()
    };

    if (context.metadata?.sessionContextPayload) {
      userMessage.metadata = {
        ...userMessage.metadata,
        sessionContextPayload: context.metadata.sessionContextPayload
      };
    }

    let state: AgentState = {
      messages: [
        ...context.messages,
        userMessage
      ],
      systemPrompt,
      maxTurns: Math.max(1, Math.min(99, (context.metadata?.maxTurns as number | undefined) ?? this.config.maxTurns ?? 20)),
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

          // 强行将这一步的人类干预追加到大模型当前轮 of context messages 中！
          state.messages.push({
            role: 'user',
            content: `[HUMAN DYNAMIC INTERVENTION]: ${steerText}`,
            timestamp: Date.now()
          });
        }
      }

      // 自动上下文压缩检查
      if (this.compactor && state.turnCount > 1 && state.turnCount % 3 === 0) {
        const totalTokens = Compactor.estimateTokens(state.messages);
        const budget = (context.metadata as Record<string, unknown>)?.maxContextTokens as number ?? 32000;
        if (totalTokens > budget * 0.75) {
          yield { type: 'status', message: `正在压缩上下文 (${Math.round(totalTokens / 1000)}k tokens)...` };
          yield { type: 'compaction_start' };

          const summary = await this.compactor.compact(state.messages, { keepRecent: 6 });
          if (summary) {
            const keepRecent = 6;
            const recentMessages = state.messages.slice(-keepRecent);
            state.messages = [
              {
                role: 'system',
                content: `--- Context Summary ---\n${summary}\n\n--- Continuing Conversation ---`,
                timestamp: Date.now()
              } as ChatMessage,
              ...recentMessages
            ];
            yield { type: 'compaction_end', summaryLength: summary.length };
          }
        }
      }

      yield { type: 'status', message: `正在思考 (第 ${state.turnCount} 轮)...` };

      yield { type: 'turn_start', turnIndex: state.turnCount };
      yield { type: 'message_start', role: 'assistant' };

      // Node A: Stream Model
      let result: GenerateResponse;
      try {
        const modelMessages = state.messages.map((m, idx) => {
          const isFirstUser = idx === state.messages.findIndex(msg => msg.role === 'user');
          const payload = m.metadata?.sessionContextPayload || context.metadata?.sessionContextPayload;
          if (isFirstUser && payload) {
            return {
              ...m,
              content: `${payload}\n\n[User Query]\n${m.content}`
            };
          }
          return m;
        });

        result = yield* this.streamModel(modelMessages, {
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
      } catch (err: unknown) {
        yield { type: 'error', message: `大模型决策异常: ${err instanceof Error ? err.message : String(err)}` };
        throw err;
      }

      // Update state with assistant response
      const assistantMessage: ChatMessage = {
        role: 'assistant',
        content: result.content,
        timestamp: Date.now(),
        tool_calls: result.toolCalls
      };

      yield { type: 'message_end', role: 'assistant', content: result.content };

      state = this.mergeState(state, {
        fullResponse: state.fullResponse + result.content,
        messages: [assistantMessage]
      });

      // Check if there are tool calls (Edge)
      if (!result.toolCalls || result.toolCalls.length === 0) {
        break;
      }

      // Node B: Execute Tools
      const toolResults = yield* this.executeToolCalls(
        result.toolCalls,
        context,
        executedKeysHistory,
        maxCycleLength,
        minRepeats
      );

      const newMessages = toolResults.map(r => r.toolMessages).flat();
      const newSkillCalls = toolResults.map(r => r.skillCalls).flat();

      state = this.mergeState(state, {
        messages: newMessages,
        skillCalls: newSkillCalls
      });

      yield { type: 'turn_end', turnIndex: state.turnCount, message: assistantMessage, toolResults };
    }

    const isLimitReached = state.turnCount >= state.maxTurns;
    if (isLimitReached) {
      console.warn('[BaseAgent] Reached maximum turns limit');
      yield { type: 'error', message: '⚠️ 智能体执行已达到最大轮数限制，已被强制熔断。' };
    }

    yield { type: 'status', message: '任务完成！' };

    // 在新事件中附加 metadata
    yield { type: 'agent_end', messages: state.messages };

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
        status: isLimitReached ? 'max_turns_exceeded' : 'completed',
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
    options: StreamOptions
  ): AsyncGenerator<AgentEvent, GenerateResponse, unknown> {
    const queue: AgentEvent[] = [];
    let resolveNext: (() => void) | null = null;
    let completed = false;
    let finalResult: GenerateResponse | null = null;
    let error: unknown = null;

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

    if (!this.provider.generateStreamWithSkills) {
      yield { type: 'error', message: '当前 AI 服务商不支持技能工具调用，请切换到 OpenAI 或 Anthropic 提供商。' };
      return { content: '', toolCalls: [], finishReason: 'stop' };
    }

    this.provider.generateStreamWithSkills(
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
      throw error instanceof Error ? error : new Error(String(error));
    }

    return finalResult!;
  }

  private async *streamModelSimple(
    prompt: string,
    options: StreamOptions
  ): AsyncGenerator<AgentEvent, string, unknown> {
    const queue: AgentEvent[] = [];
    let resolveNext: (() => void) | null = null;
    let completed = false;
    let error: unknown = null;
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
      throw error instanceof Error ? error : new Error(String(error));
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
  private getNamespaceForTool(toolName: string): SkillNamespace {
    if (toolName === 'spec' || toolName === 'invoke') {
      return 'meta';
    }
    return toolName.startsWith('mcp:') ? 'mcp' : 'obsidian';
  }

  private async *executeToolCalls(
    toolCalls: ToolCall[],
    context: AgentContext,
    executedKeysHistory: string[],
    maxCycleLength: number,
    minRepeats: number
  ): AsyncGenerator<AgentEvent, ToolCallResult[], unknown> {
    const results: Array<{ toolMessages: ChatMessage[]; skillCalls: SkillCall[] }> = [];

    // Phase 1: 检测循环（所有 toolCall 同步检测，不执行）
    const validCalls: Array<{ toolCall: ToolCall; isLoop: boolean }> = [];
    for (const toolCall of toolCalls) {
      if (context.abortSignal?.aborted) {
        throw new DOMException('The user aborted a request.', 'AbortError');
      }

      let normalizedArgs = '';
      try {
        const parsed = typeof toolCall.arguments === 'string' ? safeParseJson(toolCall.arguments) : toolCall.arguments;
        normalizedArgs = normalizeJsonArguments(parsed);
      } catch {
        normalizedArgs = typeof toolCall.arguments === 'string' ? toolCall.arguments : JSON.stringify(toolCall.arguments);
      }
      const callKey = `${toolCall.name}:${normalizedArgs}`;

      // Cyclic pattern detection algorithm (AP6 Guard)
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
        yield { type: 'tool_execution_start', toolCallId: toolCall.id, toolName: toolCall.name, args: toolCall.arguments };
        yield { type: 'skill_error', name: toolCall.name, error: 'Reasoning loop detected by AP6 Guard' };
        yield { type: 'tool_execution_end', toolCallId: toolCall.id, result: null, isError: true };

        results.push({
          toolMessages: [{
            role: 'tool',
            content: `⚠️ SYSTEM ALERT: You have executed the tool '${toolCall.name}' with the identical arguments consecutive times. This indicates you are caught in a repetitive reasoning loop. DO NOT repeat the same tool call with the same arguments. Please reconsider your plan, try a different parameter, use another tool (e.g. search or edit), or ask the user for clarification using 'obsidian:ask_user'.`,
            timestamp: Date.now(),
            tool_call_id: toolCall.id,
            name: toolCall.name
          }],
          skillCalls: [{
            id: toolCall.id,
            skillName: toolCall.name,
            namespace: 'guard',
            parameters: typeof toolCall.arguments === 'string' ? { raw: toolCall.arguments } : toolCall.arguments,
            status: 'error',
            timestamp: Date.now(),
            result: { success: false, error: 'Loop detected and prevented by AP6 Guard' }
          }]
        });
      } else {
        executedKeysHistory.push(callKey);
        validCalls.push({ toolCall, isLoop: false });
      }
    }

    const executableCalls = validCalls.filter(c => !c.isLoop).map(c => c.toolCall);
    if (executableCalls.length === 0) return results;

    const mode = this.config.toolExecutionMode || 'parallel';
    const limit = this.config.maxParallelTools || 5;

    if (mode === 'parallel') {
      // Phase 2: 按 executionCategory 分组
      // read → 完全并行安全
      // write / mutate / external / unknown → 各自组内串行，组间互斥
      const readCalls: ToolCall[] = [];
      const serialCalls: ToolCall[] = [];

      for (const tc of executableCalls) {
        const cat = this.getToolCategory(tc.name);
        if (cat === 'read') {
          readCalls.push(tc);
        } else {
          serialCalls.push(tc);
        }
      }

      // 先并行执行所有只读调用
      if (readCalls.length > 0) {
        const readCollected = await Promise.all(
          readCalls.map(tc =>
            collectGeneratorEvents(this.executeSingleToolCall(tc, context))
          )
        );

        for (let i = 0; i < readCalls.length; i++) {
          const tc = readCalls[i];
          const { events, result: runResult } = readCollected[i];
          yield { type: 'tool_execution_start', toolCallId: tc.id, toolName: tc.name, args: tc.arguments };
          for (const event of events) yield event;
          yield { type: 'tool_execution_end', toolCallId: tc.id, result: runResult, isError: false };
          results.push(runResult);
        }
      }

      // 再串行执行所有写操作（保持原始顺序）
      for (const tc of serialCalls) {
        yield { type: 'tool_execution_start', toolCallId: tc.id, toolName: tc.name, args: tc.arguments };
        const runRes = yield* this.executeSingleToolCall(tc, context);
        yield { type: 'tool_execution_end', toolCallId: tc.id, result: runRes, isError: false };
        results.push(runRes);
      }
    } else {
      // 串行执行（保持原始 toolCalls 顺序）
      for (const tc of executableCalls) {
        yield { type: 'tool_execution_start', toolCallId: tc.id, toolName: tc.name, args: tc.arguments };
        const runRes = yield* this.executeSingleToolCall(tc, context);
        yield { type: 'tool_execution_end', toolCallId: tc.id, result: runRes, isError: false };
        results.push(runRes);
      }
    }

    return results;
  }

  private getToolCategory(toolName: string): string | undefined {
    if (toolName === 'spec' || toolName === 'invoke') return 'read';
    if (toolName.startsWith('mcp:')) return 'external';

    const skill = this.skillRegistry.get(toolName) || this.skillRegistry.get(toolName.replace(/__/g, ':'));
    if (skill && isExecutableSkill(skill)) {
      return skill.metadata?.executionCategory;
    }
    return undefined;
  }

  private async *executeSingleToolCall(
    toolCall: ToolCall,
    context: AgentContext
  ): AsyncGenerator<AgentEvent, { toolMessages: ChatMessage[]; skillCalls: SkillCall[] }, unknown> {
    const toolName = toolCall.name;

    // Parse arguments
    let args: unknown;
    try {
      args = safeParseJson(
        typeof toolCall.arguments === 'string' ? toolCall.arguments : JSON.stringify(toolCall.arguments),
        (healedStr, errorMsg) => {
          console.log(`[BaseAgent] JSON parse healed successfully for ${toolName}`);
          void this.logDiagnosticIncident(toolName, typeof toolCall.arguments === 'string' ? toolCall.arguments : JSON.stringify(toolCall.arguments), errorMsg, 'Healed (JSON Preprocessor)', healedStr);
        },
        (errorMsg) => {
          void this.logDiagnosticIncident(toolName, typeof toolCall.arguments === 'string' ? toolCall.arguments : JSON.stringify(toolCall.arguments), errorMsg, 'Failed (Strict Parsing)');
        }
      );
    } catch (err: unknown) {
      // Parsing failed
      yield { type: 'skill_call', name: toolName, params: toolCall.arguments };
      yield { type: 'status', message: `⚠️ 工具 [${toolName}] 参数解析失败，正在引导智能体自我纠错...` };
      yield { type: 'skill_error', name: toolName, error: err instanceof Error ? err.message : String(err) };

      return {
        toolMessages: [{
          role: 'tool',
          content: `Error: Failed to parse arguments for tool '${toolName}'. Details: ${err instanceof Error ? err.message : String(err)}. Please regenerate the tool call with valid, balanced JSON formatting.`,
          timestamp: Date.now(),
          tool_call_id: toolCall.id,
          name: toolName
        }],
        skillCalls: [{
          id: toolCall.id,
          skillName: toolName,
          namespace: this.getNamespaceForTool(toolName),
          parameters: typeof toolCall.arguments === 'string' ? { raw_arguments: toolCall.arguments } : toolCall.arguments,
          status: 'error',
          timestamp: Date.now(),
          result: { success: false, error: err instanceof Error ? err.message : String(err) }
        }]
      };
    }

    const argsObj = args as Record<string, unknown>;

    let targetSkillName = toolName;
    let targetParams: unknown = argsObj;
    let isMeta = false;
    let isSpec = false;

    if (toolName === 'spec') {
      isMeta = true;
      isSpec = true;
      targetSkillName = argsObj.skill_name as string;
    } else if (toolName === 'invoke') {
      isMeta = true;
      targetSkillName = argsObj.skill_name as string;
      targetParams = argsObj.params || {};
    }

    if (toolName === 'invoke' && !targetSkillName) {
      yield { type: 'status', message: `⚠️ 工具 [invoke] 缺少必填参数 skill_name` };
      yield { type: 'skill_error', name: 'invoke:unknown', error: 'Missing required parameter "skill_name"' };
      return {
        toolMessages: [{
          role: 'tool',
          content: "Error: Missing required parameter 'skill_name' in invoke tool call. You must specify the namespace and skill name (e.g., 'obsidian:edit_note') in 'skill_name'.",
          timestamp: Date.now(),
          tool_call_id: toolCall.id,
          name: toolName
        }],
        skillCalls: []
      };
    }

    if (isSpec) {
      yield { type: 'skill_call', name: `spec:${targetSkillName}`, params: argsObj };
      try {
        const details = this.skillRegistry.getSkillDetails(targetSkillName, 'markdown');
        const isSuccess = !details.startsWith('Error:');

        if (isSuccess) {
          yield { type: 'skill_success', name: `spec:${targetSkillName}`, result: details };
        } else {
          yield { type: 'skill_error', name: `spec:${targetSkillName}`, error: details };
        }

        return {
          toolMessages: [{
            role: 'tool',
            content: details,
            timestamp: Date.now(),
            tool_call_id: toolCall.id,
            name: toolName
          }],
          skillCalls: [{
            id: toolCall.id,
            skillName: toolName,
            namespace: 'meta',
            parameters: argsObj,
            status: isSuccess ? 'success' : 'error',
            timestamp: Date.now(),
            result: { success: isSuccess, data: isSuccess ? details : undefined, error: isSuccess ? undefined : details }
          }]
        };
      } catch (err: unknown) {
        yield { type: 'skill_error', name: `spec:${targetSkillName}`, error: err instanceof Error ? err.message : String(err) };
        return {
          toolMessages: [{
            role: 'tool',
            content: `Error: Exception during execution: ${err instanceof Error ? err.message : String(err)}`,
            timestamp: Date.now(),
            tool_call_id: toolCall.id,
            name: toolName
          }],
          skillCalls: []
        };
      }
    }

    const callNameForEvent = isMeta ? `invoke:${targetSkillName}` : toolName;
    yield { type: 'skill_call', name: callNameForEvent, params: targetParams };

    try {
      let runResult: SkillResult;
      if (isMeta) {
        const { namespace, name } = this.skillRegistry.parseName(targetSkillName);
        runResult = await this.skillExecutor.execute(namespace, name, targetParams as Record<string, unknown>, { abortSignal: context.abortSignal });
      } else {
        const execToolCall = { ...toolCall, arguments: targetParams as Record<string, unknown> };
        runResult = await this.skillExecutor.executeFromToolCall(execToolCall, { abortSignal: context.abortSignal });
      }

      if (runResult.success) {
        yield { type: 'skill_success', name: callNameForEvent, result: runResult.data };
        const mainMessage: ChatMessage = {
          role: 'tool',
          content: JSON.stringify(runResult.data, null, 2),
          timestamp: Date.now(),
          tool_call_id: toolCall.id,
          name: toolName
        };
        const subMessages = this.getSubagentMessages(targetSkillName, runResult, toolCall.id);

        return {
          toolMessages: [mainMessage, ...subMessages],
          skillCalls: [{
            id: toolCall.id,
            skillName: toolName,
            namespace: this.getNamespaceForTool(toolName),
            parameters: argsObj,
            status: 'success',
            timestamp: Date.now(),
            result: runResult
          }]
        };
      } else {
        yield { type: 'status', message: `⚠️ 工具 [${targetSkillName}] 运行失败，正在自动引导纠错...` };
        yield { type: 'skill_error', name: callNameForEvent, error: runResult.error || '执行失败' };
        
        return {
          toolMessages: [{
            role: 'tool',
            content: `Error: ${runResult.error || 'Unknown error'}`,
            timestamp: Date.now(),
            tool_call_id: toolCall.id,
            name: toolName
          }],
          skillCalls: [{
            id: toolCall.id,
            skillName: toolName,
            namespace: this.getNamespaceForTool(toolName),
            parameters: argsObj,
            status: 'error',
            timestamp: Date.now(),
            result: runResult
          }]
        };
      }
    } catch (err: unknown) {
      yield { type: 'status', message: `⚠️ 工具 [${targetSkillName}] 参数解析或运行异常，正在自动纠错...` };
      yield { type: 'skill_error', name: callNameForEvent, error: err instanceof Error ? err.message : String(err) };

      return {
        toolMessages: [{
          role: 'tool',
          content: `Error: Exception during execution: ${err instanceof Error ? err.message : String(err)}`,
          timestamp: Date.now(),
          tool_call_id: toolCall.id,
          name: toolName
        }],
        skillCalls: [{
          id: toolCall.id,
          skillName: toolCall.name,
          namespace: this.getNamespaceForTool(toolName),
          parameters: argsObj,
          status: 'error',
          timestamp: Date.now(),
          result: { success: false, error: err instanceof Error ? err.message : String(err) }
        }]
      };
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
  private getSubagentMessages(skillName: string, runResult: SkillResult, toolCallId?: string): ChatMessage[] {
    const isDelegate = skillName === 'obsidian:delegate_task' || skillName === 'obsidian:spawn_subagent' || 
                       skillName === 'delegate_task' || skillName === 'spawn_subagent';
    if (isDelegate && runResult.metadata?.subagentMessages) {
      return (runResult.metadata.subagentMessages as ChatMessage[]).map((m: ChatMessage) => ({
        ...m,
        metadata: {
          ...m.metadata,
          isSubagent: true,
          agentId: runResult.metadata?.agentId as string || 'subagent',
          parentToolCallId: toolCallId
        }
      }));
    }
    return [];
  }
}
