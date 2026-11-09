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
import { formatDiffAsText, DiffLine } from '../utils/diff';
import { throwIfAborted, isAbortError, errorDetails } from '../utils/execution';

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
    context.runId ||= `run-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    context.transcript = [...context.messages];
    const identity = { sessionId: context.sessionId, runId: context.runId, agentId: this.config.id };
    let partial = '';
    let partialStart = context.transcript.length;
    const emit = (event: AgentEvent) => this.eventBus?.emit({ ...event, ...identity });
    emit({ type: 'agent:start' });
    const gen = this.executeGenerator(prompt, context);
    try {
      let result = await gen.next();
      while (!result.done) {
        const event = result.value;
        if (event.type === 'message:start') {
          partial = '';
          partialStart = context.transcript.length;
        }
        if (event.type === 'message:update') partial += event.delta;
        if (event.type === 'message:end') partial = '';
        emit(event);
        result = await gen.next();
      }
      const response = result.value;
      throwIfAborted(context.abortSignal);
      response.messages = context.transcript;
      await context.onCheckpoint?.(response.messages);
      emit({ type: 'agent:end', messages: response.messages, status: response.metadata?.status as 'completed' | 'max_turns_exceeded' || 'completed' });
      return response;
    } catch (error) {
      const cancelled = isAbortError(error);
      const savedAssistant = context.transcript.slice(partialStart).some(message => message.role === 'assistant');
      if (partial && !savedAssistant) context.transcript.push({ role: 'assistant', content: partial, timestamp: Date.now(), metadata: { interrupted: true } });
      // Pending tool calls must remain paired without claiming their side effects stopped.
      const completed = new Set(context.transcript.filter(m => m.role === 'tool').map(m => m.tool_call_id));
      for (const message of [...context.transcript]) {
        for (const call of message.tool_calls || []) {
          if (!completed.has(call.id)) {
            context.transcript.push({ role: 'tool', tool_call_id: call.id, name: call.name, timestamp: Date.now(), content: 'Error: 执行已中断，结果未确认；请先检查实际结果，不要直接重复写入。' });
          }
        }
      }
      await this.recordIncident(context, cancelled ? 'cancelled' : 'execution', error);
      try { await context.onCheckpoint?.(context.transcript); } catch (saveError) {
        await this.recordIncident(context, 'storage', saveError);
        emit({ type: 'system:error', message: `会话保存失败：${String(saveError)}` });
      }
      emit({ type: 'system:error', message: cancelled ? 'AbortError: 已停止生成' : (error instanceof Error ? error.message : String(error)) });
      emit({ type: 'agent:end', messages: context.transcript, status: cancelled ? 'cancelled' : 'failed' });
      throw error;
    }
  }

  private async checkpoint(context: AgentContext, messages: ChatMessage[]): Promise<void> {
    context.transcript!.push(...messages);
    await context.onCheckpoint?.([...context.transcript!]);
  }

  private async recordIncident(context: AgentContext, kind: string, error: unknown, toolName = 'model', originalArgs = ''): Promise<void> {
    await this.diagnosticsLogger?.logIncident({
      agentId: this.config.id, agentName: this.config.name, sessionId: context.sessionId,
      runId: context.runId, kind, toolName, originalArgs,
      errorMessage: error instanceof Error ? error.message : String(error),
      strategy: kind, success: false, details: { ...errorDetails(error), providerId: this.provider.id, providerName: this.provider.name },
    });
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

    yield { type: 'system:status', message: '初始化智能体...' };

    const userMessage: ChatMessage = {
      role: 'user', content: prompt, timestamp: Date.now(),
      metadata: context.metadata?.sessionContextPayload ? { sessionContextPayload: context.metadata.sessionContextPayload } : undefined,
    };
    await this.checkpoint(context, [userMessage]);

    if (context.abortSignal?.aborted) {
      throw new DOMException('The user aborted a request.', 'AbortError');
    }

    // If skills are disabled or not supported, run simple single-turn generation
    if (context.metadata?.enableSkills === false || !this.config.enableSkills || !this.provider.supportsSkills?.()) {
      yield { type: 'system:status', message: '正在思考...' };

      if (context.abortSignal?.aborted) {
        throw new DOMException('The user aborted a request.', 'AbortError');
      }

      const messages: ChatMessage[] = [
        ...context.messages,
        userMessage
      ];

      let responseContent = '';
      yield { type: 'message:start', role: 'assistant' };
      responseContent = yield* this.streamModelSimple(messages.map(m => `[${m.role}]: ${m.content}`).join('\n\n'), {
        systemPrompt,
        temperature: this.config.temperature || 0.7,
        abortSignal: context.abortSignal
      });

      messages.push({
        role: 'assistant',
        content: responseContent,
        timestamp: Date.now()
      });
      await this.checkpoint(context, [messages[messages.length - 1]]);
      yield { type: 'message:end', role: 'assistant', content: responseContent };

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
          yield { type: 'system:steer', message: steerText };

          // 强行将这一步的人类干预追加到大模型当前轮 of context messages 中！
          const intervention: ChatMessage = {
            role: 'user',
            content: `[HUMAN DYNAMIC INTERVENTION]: ${steerText}`,
            timestamp: Date.now()
          };
          state.messages.push(intervention);
          await this.checkpoint(context, [intervention]);
        }
      }

      // 自动上下文压缩检查
      if (this.compactor && (state.turnCount === 1 || state.turnCount % 3 === 0)) {
        const totalTokens = Compactor.estimateTokens(state.messages);
        const budget = this.provider.getContextWindow();
        const threshold = this.provider.getCompactionThreshold();
        if (totalTokens > budget * threshold) {
          yield { type: 'system:status', message: `正在压缩上下文 (${Math.round(totalTokens / 1000)}k tokens)...` };
          yield { type: 'context:compact:start' };

          const summary = await this.compactor.compact(state.messages, { keepRecent: 6, abortSignal: context.abortSignal });
          if (summary) {
            const keepRecent = 6;
            const recentMessages = state.messages.slice(-keepRecent);
            state.messages = [
              {
                role: 'user',
                content: `--- Context Summary ---\n${summary}\n\n--- Continuing Conversation ---`,
                timestamp: Date.now()
              } as ChatMessage,
              ...recentMessages
            ];
            yield { type: 'context:compact:end', summaryLength: summary.length };
          }
        }
      }

      yield { type: 'system:status', message: `正在思考 (第 ${state.turnCount} 轮)...` };

      yield { type: 'turn:start', turnIndex: state.turnCount };
      yield { type: 'message:start', role: 'assistant' };

      // Node A: Stream Model
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

      const result = yield* this.streamModel(modelMessages, {
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

      // Update state with assistant response
      const assistantMessage: ChatMessage = {
        role: 'assistant',
        content: result.content,
        timestamp: Date.now(),
        tool_calls: result.toolCalls,
        metadata: { usage: result.usage, contextTokens: result.usage?.promptTokens, contextWindow: this.provider.getContextWindow(), runId: context.runId }
      };

      await this.checkpoint(context, [assistantMessage]);
      yield { type: 'message:end', role: 'assistant', content: result.content };

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

      yield { type: 'turn:end', turnIndex: state.turnCount, message: assistantMessage, toolResults };
    }

    const lastAssistant = state.messages.filter(m => m.role === 'assistant').at(-1);
    const isLimitReached = state.turnCount >= state.maxTurns && !!lastAssistant?.tool_calls?.length;
    if (isLimitReached) {
      console.warn('[BaseAgent] Reached maximum turns limit');
      yield { type: 'system:status', message: '已达到工具轮数上限，当前进度已保存。' };
    }

    if (!isLimitReached) yield { type: 'system:status', message: '任务完成！' };

    // Attach usage stats to the last assistant message
    const assistantMsgs = state.messages.filter(m => m.role === 'assistant');
    if (assistantMsgs.length > 0) {
      const lastMsg = assistantMsgs[assistantMsgs.length - 1];
      lastMsg.metadata = {
        ...lastMsg.metadata,
        isMaxTurnsReached: isLimitReached || undefined,
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
    if (!this.provider.generateStreamWithSkills) throw new Error('当前 AI 服务商不支持工具调用');
    const result = yield* this.bridgeStream(
      onChunk => this.provider.generateStreamWithSkills!(messages, onChunk, undefined, options), options.abortSignal
    );
    if (!result) throw new Error('模型响应为空，请重试当前请求。');
    return result;
  }

  private async *streamModelSimple(prompt: string, options: StreamOptions): AsyncGenerator<AgentEvent, string, unknown> {
    let content = '';
    yield* this.bridgeStream(async onChunk => {
      await this.provider.generateStream(prompt, chunk => { content += chunk; onChunk(chunk); }, options);
      return content;
    }, options.abortSignal);
    return content;
  }

  private async *bridgeStream<T>(start: (onChunk: (chunk: string) => void) => Promise<T>, signal?: AbortSignal): AsyncGenerator<AgentEvent, T, unknown> {
    throwIfAborted(signal);
    const queue: AgentEvent[] = [];
    let wake: (() => void) | undefined;
    let completed = false;
    let value: T;
    let failure: unknown;
    const notify = () => { wake?.(); wake = undefined; };
    const onAbort = () => {
      failure = new DOMException('已停止生成', 'AbortError');
      completed = true;
      notify();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    // Always observe the provider promise, including its late rejection after cancellation.
    Promise.resolve().then(() => {
      throwIfAborted(signal);
      return start(chunk => { if (!completed) { queue.push({ type: 'message:update', delta: chunk }); notify(); } });
    }).then(result => { value = result; completed = true; notify(); }, error => { failure = error; completed = true; notify(); });
    try {
      while (!completed || queue.length) {
        throwIfAborted(signal);
        if (!queue.length && !completed) await new Promise<void>(resolve => { wake = resolve; });
        throwIfAborted(signal);
        while (queue.length) yield queue.shift()!;
      }
      if (failure) throw failure;
      return value!;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
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
        yield { type: 'system:status', message: `⚠️ 检测到工具调用 [${toolCall.name}] 陷入推理死循环，正在强制干预引导自愈...` };
        yield { type: 'tool:start', toolCallId: toolCall.id, toolName: toolCall.name, args: toolCall.arguments };
        yield { type: 'tool:end', toolCallId: toolCall.id, toolName: toolCall.name, result: null, isError: true };

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
    if (results.length) await this.checkpoint(context, results.flatMap(r => r.toolMessages));
    if (executableCalls.length === 0) return results;

    const mode = this.config.toolExecutionMode || 'parallel';

    if (mode === 'parallel') {
      // Phase 2: 按 executionCategory 分组
      // read → 完全并行安全
      // write / mutate / external / unknown → 各自组内串行，组间互斥
      const readCalls: ToolCall[] = [];
      const serialCalls: ToolCall[] = [];

      for (const tc of executableCalls) {
        const cat = this.getToolCategory(tc);
        if (cat === 'read') {
          readCalls.push(tc);
        } else {
          serialCalls.push(tc);
        }
      }

      // 先并行执行所有只读调用
      if (readCalls.length > 0) {
        const parallelism = Math.max(1, Math.min(20, this.config.maxParallelTools || 5));
        for (let offset = 0; offset < readCalls.length; offset += parallelism) {
          const batch = readCalls.slice(offset, offset + parallelism);
          throwIfAborted(context.abortSignal);
          for (const tc of batch) yield { type: 'tool:start', toolCallId: tc.id, toolName: tc.name, args: tc.arguments };
          const readCollected = await Promise.all(batch.map(async tc => {
            const collected = await collectGeneratorEvents(this.executeSingleToolCall(tc, context));
            await this.checkpoint(context, collected.result.toolMessages);
            return collected;
          }));
        for (let i = 0; i < batch.length; i++) {
          const tc = batch[i];
          const { events, result: runResult } = readCollected[i];
          for (const event of events) yield event;
          const sr = runResult.skillCalls?.[0]?.result;
          yield { type: 'tool:end', toolCallId: tc.id, toolName: tc.name, result: sr ?? null, isError: sr ? !sr.success : true };
          results.push(runResult);
        }
        }
      }

      // 再串行执行所有写操作（保持原始顺序）
      for (const tc of serialCalls) {
        throwIfAborted(context.abortSignal);
        yield { type: 'tool:start', toolCallId: tc.id, toolName: tc.name, args: tc.arguments };
        const runRes = yield* this.executeSingleToolCall(tc, context);
        await this.checkpoint(context, runRes.toolMessages);
        const sr = runRes.skillCalls?.[0]?.result;
        yield { type: 'tool:end', toolCallId: tc.id, toolName: tc.name, result: sr ?? null, isError: sr ? !sr.success : true };
        results.push(runRes);
      }
    } else {
      // 串行执行（保持原始 toolCalls 顺序）
      for (const tc of executableCalls) {
        throwIfAborted(context.abortSignal);
        yield { type: 'tool:start', toolCallId: tc.id, toolName: tc.name, args: tc.arguments };
        const runRes = yield* this.executeSingleToolCall(tc, context);
        await this.checkpoint(context, runRes.toolMessages);
        const sr = runRes.skillCalls?.[0]?.result;
        yield { type: 'tool:end', toolCallId: tc.id, toolName: tc.name, result: sr ?? null, isError: sr ? !sr.success : true };
        results.push(runRes);
      }
    }

    return results;
  }

  private getToolCategory(call: ToolCall): string | undefined {
    let toolName = call.name;
    if (toolName === 'spec') return 'read';
    if (toolName === 'invoke') {
      try {
        const args = typeof call.arguments === 'string' ? safeParseJson(call.arguments) : call.arguments;
        toolName = (args as Record<string, unknown>).skill_name as string;
        if (!toolName || toolName === 'invoke') return undefined;
      } catch { return undefined; }
    }
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
      yield { type: 'system:status', message: `⚠️ 工具 [${toolName}] 参数解析失败，正在引导智能体自我纠错...` };

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
      const errorMsg = "Missing required parameter 'skill_name' in invoke tool call. You must specify the namespace and skill name (e.g., 'obsidian:edit_note') in 'skill_name'.";
      yield { type: 'system:status', message: `⚠️ 工具 [invoke] 缺少必填参数 skill_name` };
      return {
        toolMessages: [{
          role: 'tool',
          content: errorMsg,
          timestamp: Date.now(),
          tool_call_id: toolCall.id,
          name: toolName
        }],
        skillCalls: [{
          id: toolCall.id,
          skillName: toolName,
          namespace: 'meta',
          parameters: argsObj,
          status: 'error',
          timestamp: Date.now(),
          result: { success: false, error: errorMsg }
        }]
      };
    }

    if (isSpec) {
      try {
        const details = this.skillRegistry.getSkillDetails(targetSkillName, 'markdown');
        const isSuccess = !details.startsWith('Error:');

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
        const errorMsg = err instanceof Error ? err.message : String(err);
        return {
          toolMessages: [{
            role: 'tool',
            content: `Error: Exception during execution: ${errorMsg}`,
            timestamp: Date.now(),
            tool_call_id: toolCall.id,
            name: toolName
          }],
          skillCalls: [{
            id: toolCall.id,
            skillName: toolName,
            namespace: 'meta',
            parameters: argsObj,
            status: 'error',
            timestamp: Date.now(),
            result: { success: false, error: errorMsg }
          }]
        };
      }
    }

    try {
      let runResult: SkillResult;
      const executionOptions = { abortSignal: context.abortSignal, sessionId: context.sessionId, runId: context.runId, agentId: this.config.id,
        timeout: ['obsidian:web_fetch', 'obsidian:run_command'].includes(targetSkillName) && typeof (targetParams as Record<string, unknown>)?.timeout === 'number'
          ? (targetParams as Record<string, number>).timeout + 1000 : undefined };
      if (isMeta) {
        const { namespace, name } = this.skillRegistry.parseName(targetSkillName);
        runResult = await this.skillExecutor.execute(namespace, name, targetParams as Record<string, unknown>, executionOptions);
      } else {
        const execToolCall = { ...toolCall, arguments: targetParams as Record<string, unknown> };
        runResult = await this.skillExecutor.executeFromToolCall(execToolCall, executionOptions);
      }

      if (runResult.success) {
        const diff = (runResult.metadata as Record<string, unknown> | undefined)?.diff;
        let content = JSON.stringify(runResult.data, null, 2) ?? '';
        if (diff && Array.isArray(diff)) {
          const filePath = (runResult.data as Record<string, unknown> | undefined)?.path as string || '';
          content = formatDiffAsText(filePath, diff as DiffLine[]) + '\n\n' + content;
        }

        const mainMessage: ChatMessage = {
          role: 'tool',
          content,
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
        await this.recordIncident(context, 'tool', new Error(runResult.error || 'Unknown tool error'), targetSkillName, JSON.stringify(targetParams));
        yield { type: 'system:status', message: `⚠️ 工具 [${targetSkillName}] 运行失败，正在自动引导纠错...` };
        
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
      yield { type: 'system:status', message: `⚠️ 工具 [${targetSkillName}] 参数解析或运行异常，正在自动纠错...` };

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
