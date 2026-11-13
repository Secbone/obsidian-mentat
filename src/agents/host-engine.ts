import type { AgentEngine, AgentHost, EngineDefinition } from '../contracts/agent-engine';
import type { AgentConfig, AgentContext, AgentResponse } from './agent-types';
import type { AgentDependencies } from './base-agent';
import type { AIProvider, ChatMessage } from '../types';
import { ModelGateway } from '../runtime/model-gateway';
import { abortable, throwIfAborted } from '../utils/execution';
import { RunBlocked, RunSuspended } from '../runtime/types';
import { Compactor } from './compactor';
import { SummaryContextBuilder } from '../context/summary-context-builder';
import { fingerprint } from '../runtime/fingerprint';
import { normalizeTools } from '../providers/model-adapters';
import { validateToolPairs } from '../runtime/model-gateway';

/** Third-party loops receive capabilities, never the plugin, vault or operation ledger. */
export class HostAgentEngine implements AgentEngine {
  constructor(private config: AgentConfig, private definition: EngineDefinition, private provider: AIProvider, private dependencies: AgentDependencies) {}
  getId(): string { return this.config.id; }
  getName(): string { return this.config.name; }
  getDescription(): string { return this.config.description; }
  getConfig(): AgentConfig { return { ...this.config }; }
  async execute(prompt: string, context: AgentContext): Promise<AgentResponse> {
    const identity = { runId: context.runId, sessionId: context.sessionId, agentId: this.config.id };
    await context.runtime?.bindEngine?.(this.definition.binding);
    context.transcript = [...context.messages];
    const messages = context.transcript;
    const checkpoint = async () => { throwIfAborted(context.abortSignal); await context.onCheckpoint?.([...messages]); };
    if (!context.metadata?.resume) { messages.push({ role: 'user', content: prompt, timestamp: Date.now() }); await checkpoint(); }
    const emit = (event: Parameters<NonNullable<AgentDependencies['eventBus']>['emit']>[0]) => this.dependencies.eventBus?.emit({ ...event, ...identity });
    emit({ type: 'agent:start' });
    const gateway = new ModelGateway(this.provider);
    const builder = this.dependencies.contextBuilder || new SummaryContextBuilder(this.dependencies.compactor || new Compactor(this.provider));
    const maxTurns = Number(context.metadata?.maxTurns || this.config.maxTurns || 20);
    let turns = 0, operations = 0, boundaryError: RunBlocked | RunSuspended | undefined;
    const host: AgentHost = {
      signal: context.abortSignal,
      tools: () => this.config.enableSkills && context.metadata?.enableSkills !== false
        ? structuredClone(normalizeTools(this.dependencies.skillInvocationContext.getToolDefinitions(this.dependencies.skillRegistry, 'openai'))) : [],
      model: async request => {
        if (++turns > maxTurns) { boundaryError = new RunBlocked('Agent 引擎达到本次模型调用预算，请从检查点继续'); throw boundaryError; }
        emit({ type: 'message:start', role: 'assistant' });
        const savedContext = context.runtime?.getContextSnapshot?.();
        const providerBinding = await fingerprint({ providerId: this.provider.id, request: this.provider.getRequestMetadata?.(), window: this.provider.getContextWindow() });
        const reusable = savedContext && savedContext.strategyId === builder.id && savedContext.providerBinding === providerBinding
          && savedContext.sourceMessageCount <= messages.length && savedContext.sourceDigest === await fingerprint(messages.slice(0, savedContext.sourceMessageCount));
        let working = reusable ? [...structuredClone(savedContext.messages), ...messages.slice(savedContext.sourceMessageCount)] : [...messages];
        if (Compactor.estimateTokens(working) > this.provider.getContextWindow() * this.provider.getCompactionThreshold()) {
          const built = await builder.build({ messages: working, keepRecent: 6, signal: context.abortSignal });
          validateToolPairs(built.messages); working = built.messages;
          if (built.summaryLength) await context.runtime?.saveContextSnapshot?.({ version: 1, strategyId: builder.id, providerId: this.provider.id, providerBinding,
            sourceMessageCount: messages.length, sourceDigest: await fingerprint(messages), messages: working, estimatedTokens: Compactor.estimateTokens(working) });
        }
        let prefix = '';
        const result = await gateway.generate(working, text => { prefix += text; emit({ type: 'message:update', delta: text, accumulatedText: prefix }); },
          { ...request, systemPrompt: request.systemPrompt ?? this.config.systemPrompt, skills: request.tools?.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.inputSchema })), abortSignal: context.abortSignal }, context.runtime);
        messages.push({ role: 'assistant', content: result.content, timestamp: Date.now(), tool_calls: result.toolCalls, metadata: { providerState: result.providerState, runId: context.runId } });
        await checkpoint(); emit({ type: 'message:end', role: 'assistant', content: result.content }); return result;
      },
      invoke: async call => {
        if (!this.config.enableSkills || context.metadata?.enableSkills === false) throw new Error('当前 Agent 未获工具调用能力');
        if (++operations > maxTurns * 10) { boundaryError = new RunBlocked('Agent 引擎达到本次工具调用预算，请从检查点继续'); throw boundaryError; }
        throwIfAborted(context.abortSignal);
        const declared = messages.flatMap(message => message.tool_calls || []).find(previous => previous.id === call.id);
        if (declared && JSON.stringify(declared) !== JSON.stringify(call)) throw new Error('操作 ID 已绑定其他工具决策');
        const paired = messages.find(message => message.role === 'tool' && message.tool_call_id === call.id);
        if (paired) return JSON.parse(paired.content);
        if (!declared) { messages.push({ role: 'assistant', content: '', timestamp: Date.now(), tool_calls: [call] }); await checkpoint(); }
        let result;
        try { result = await this.dependencies.skillExecutor.executeFromToolCall(call, { operationId: call.id, runtime: context.runtime,
          abortSignal: context.abortSignal, sessionId: context.sessionId, runId: context.runId, agentId: this.config.id }); }
        catch (error) { if (error instanceof RunBlocked || error instanceof RunSuspended) boundaryError = error; throw error; }
        messages.push({ role: 'tool', name: call.name, tool_call_id: call.id, content: JSON.stringify(result), timestamp: Date.now() });
        await checkpoint();
        if (result.outcome === 'unknown') { boundaryError = new RunBlocked('工具操作结果未知，请先核对实际结果'); throw boundaryError; }
        return result;
      },
      checkpoint: async state => { await checkpoint(); await context.runtime?.saveEngineCheckpoint?.({ binding: this.definition.binding, state, transcriptLength: messages.length }); },
      instructions: async () => {
        const results = new Set(messages.filter(message => message.role === 'tool').map(message => message.tool_call_id));
        if (messages.some(message => message.tool_calls?.some(call => !results.has(call.id)))) return [];
        const queued = await context.runtime?.takeInstructions?.() || [];
        const added: ChatMessage[] = [];
        for (const instruction of queued) {
          if (!messages.some(message => message.metadata?.instructionId === instruction.id)) {
            const message: ChatMessage = { role: 'user', content: instruction.text, timestamp: Date.now(), metadata: { instructionId: instruction.id } };
            messages.push(message); added.push(message);
          }
        }
        if (queued.length) { await checkpoint(); await context.runtime?.ackInstructions(queued.map(instruction => instruction.id)); }
        return added;
      },
      progress: message => emit({ type: 'system:status', message }),
    };
    const saved = context.runtime?.getEngineCheckpoint?.();
    const result = await abortable(this.definition.run({ prompt, messages: structuredClone(messages), state: saved?.transcriptLength === messages.length ? saved.state : undefined, maxTurns }, host), context.abortSignal);
    if (boundaryError) throw boundaryError;
    throwIfAborted(context.abortSignal);
    if (result.state !== undefined) await host.checkpoint(result.state);
    if (result.content && messages.at(-1)?.content !== result.content) { messages.push({ role: 'assistant', content: result.content, timestamp: Date.now() }); await checkpoint(); }
    context.metadata = { ...context.metadata, completionStatus: result.status || 'completed' };
    emit({ type: 'agent:end', messages, status: result.status || 'completed' });
    return { content: result.content, messages, metadata: { status: result.status || 'completed' } };
  }
}
