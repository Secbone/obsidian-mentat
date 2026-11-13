import type { Observer } from '../observability/observer';
import { projectRunEvent } from '../observability/run-projection';
import type { AgentContext, AgentEvent } from '../agents/agent-types';
import type { ChatMessage } from '../types';
import type { ChatManager } from '../chat/chat-manager';
import { EventBus } from '../extensions/event-bus';
import { RunStore } from './run-store';
import { InteractionRequest, RunBlocked, RunRecord, RunRuntime, RunSuspended, RunLiveState } from './types';
import { errorDetails, isAbortError } from '../utils/execution';

type Execute = (prompt: string, context: AgentContext) => Promise<void>;
export class RunController {
  private records = new Map<string, RunRecord>();
  private active = new Map<string, { controller: AbortController; context: AgentContext; promise: Promise<void> }>();
  private disposed = false;
  private live = new Map<string, RunLiveState>();
  private inFlight = new Map<string, Map<string, Set<Promise<unknown>>>>();
  private pendingIngress = new Map<string, Set<string>>();
  private unsubscribe: () => void;
  constructor(readonly store: RunStore, private bus: EventBus, private chat: ChatManager, private execute: Execute, private observer?: Observer) {
    this.unsubscribe = bus.on('*', event => this.captureProgress(event));
  }
  private captureProgress(event: AgentEvent): void {
    const record = event.runId ? this.records.get(event.runId) : undefined;
    if (!record || event.sessionId !== record.sessionId || event.agentId !== record.agentId || record.status !== 'running') return;
    if (!['message:start','message:update','message:end','system:status','context:compact:start','context:compact:end'].includes(event.type)) return;
    const live = this.live.get(record.id) || {};
    if (event.type === 'message:start' && event.role === 'assistant') {
      live.message = { index: (this.getContext(record.id)?.transcript || record.messages).length, content: '', startedAt: Date.now(), complete: false };
    } else if (event.type === 'message:update') {
      live.message ||= { index: (this.getContext(record.id)?.transcript || record.messages).length, content: '', startedAt: Date.now(), complete: false };
      live.message.content = event.accumulatedText ?? live.message.content + event.delta;
      live.phase = '正在生成回复';
    } else if (event.type === 'message:end' && live.message) {
      live.message.content = event.content; live.message.complete = true;
    } else if (event.type === 'system:status') live.phase = event.message;
    else if (event.type === 'context:compact:start') live.phase = '正在压缩上下文';
    else if (event.type === 'context:compact:end') live.phase = '等待模型响应';
    this.live.set(record.id, live);
  }
  getLiveState(id: string): RunLiveState | undefined { return this.live.get(id); }
  getDisplayMessages(id: string): ChatMessage[] {
    const record = this.records.get(id);
    if (!record) return [];
    const transcript = this.getContext(id)?.transcript;
    return transcript && transcript.length >= record.baseMessageCount + 1 ? transcript : record.messages;
  }

  async initialize(): Promise<void> {
    for (const record of await this.store.list()) {
      if (record.status === 'running') {
        record.status = 'interrupted';
        if (record.partial) { record.messages.push({ role: 'assistant', content: record.partial, timestamp: Date.now(), metadata: { interrupted: true } }); record.partial = undefined; }
        for (const [scope, text] of Object.entries(record.childPartials || {})) if (text && record.children?.[scope]) record.children[scope].push({ role: 'assistant', content: text, timestamp: Date.now(), metadata: { interrupted: true } });
        record.childPartials = {};
        for (const op of Object.values(record.operations)) if (op.status === 'running') op.status = op.category === 'read' ? 'planned' : 'unknown';
        record.error = '上次运行被中断；请检查未确认操作，再从检查点继续。';
        await this.event(record, 'run:interrupted', { message: record.error, reason: 'process_restart' });
      }
      this.records.set(record.id, record);
    }
  }
  list(sessionId?: string): RunRecord[] {
    return [...this.records.values()].filter(r => !sessionId || r.sessionId === sessionId).sort((a,b) => b.createdAt - a.createdAt);
  }
  get(id: string): RunRecord | undefined { return this.records.get(id); }
  getContext(id: string): AgentContext | undefined { return this.active.get(id)?.context; }
  hasUnsettledWork(): boolean {
    return !!(this.active.size || this.inFlight.size || this.pendingIngress.size) || [...this.records.values()].some(record =>
      ['running','waiting_for_user','waiting_for_approval','interrupted'].includes(record.status)
      || Object.values(record.operations).some(operation => operation.status === 'unknown' || operation.status === 'running')
      || Object.values(record.interactions).some(interaction => !interaction.outcome)
      || record.status !== 'cancelled' && record.instructions?.some(instruction => instruction.status === 'queued'));
  }
  private notify(record: RunRecord): void {
    this.bus.emit({ type: 'run:changed', sessionId: record.sessionId, runId: record.id, agentId: record.agentId, status: record.status, error: record.error });
  }
  private async event(record: RunRecord, type: string, details?: Record<string, unknown>, operationId?: string): Promise<void> {
    const sequence = record.events.length + 1;
    record.updatedAt = Date.now();
    const event = { id: `${record.id}:${sequence}`, sequence, timestamp: record.updatedAt, type, operationId, details };
    record.events.push(event);
    const attempt = Math.max(1, record.events.filter(e => e.type === 'run:started' || e.type === 'run:resumed').length);
    try { await this.store.save(record); }
    catch (error) {
      this.observer?.error('storage:checkpoint:failed', error, { component: 'storage', runId: record.id, sessionId: record.sessionId });
      throw error;
    }
    const observed = projectRunEvent(record, event, attempt);
    this.observer?.event(type, observed);
    if (type === 'model:requested' && !operationId) this.live.set(record.id, { ...this.live.get(record.id), message: undefined, phase: '等待模型响应', phaseStartedAt: event.timestamp });
    this.notify(record);
  }
  private runtime(record: RunRecord, scope = ''): RunRuntime {
    const key = (id: string) => scope + id;
    return {
      runId: record.id,
      scope,
      sessionId: record.sessionId,
      child: id => {
        const childKey = key(id) + '/';
        return { runtime: this.runtime(record, childKey), messages: record.children?.[childKey] || [], checkpoint: async messages => {
          record.children ||= {}; record.children[childKey] = [...messages];
          if (record.childPartials) delete record.childPartials[childKey];
          await this.event(record, 'subagent:checkpoint', { messageCount: messages.length }, key(id));
        } };
      },
      partial: async text => {
        if (scope) { record.childPartials ||= {}; record.childPartials[scope] = text; }
        else record.partial = text;
        await this.store.save(record);
      },
      observe: (type, details) => {
        this.observer?.event(type, { component: type.split(':')[0], runId: record.id, sessionId: record.sessionId,
          attemptId: `${record.id}:attempt-${Math.max(1, record.events.filter(e => e.type === 'run:started' || e.type === 'run:resumed').length)}`,
          requestId: typeof details?.requestId === 'string' ? details.requestId : undefined, attributes: details });
      },
      record: (type, details, operationId) => this.event(record, type, details, operationId ? key(operationId) : undefined),
      getOperation: id => { const op = record.operations[key(id)]; return op ? { ...op, id } : undefined; },
      trackOperation: (id, completion) => {
        const operations = this.inFlight.get(record.id) || new Map<string, Set<Promise<unknown>>>();
        const pending = operations.get(key(id)) || new Set<Promise<unknown>>();
        pending.add(completion); operations.set(key(id), pending); this.inFlight.set(record.id, operations);
        const settled = () => {
          pending.delete(completion);
          if (!pending.size) operations.delete(key(id));
          if (!operations.size) this.inFlight.delete(record.id);
        };
        void completion.then(settled, settled);
      },
      takeInstructions: async () => scope ? [] : (record.instructions || []).filter(i => i.status === 'queued' && !this.pendingIngress.get(record.id)?.has(i.id)).map(({id, text}) => ({id, text})),
      ackInstructions: async ids => {
        if (scope) return;
        const selected = new Set(ids);
        const consumed = (record.instructions || []).filter(i => selected.has(i.id) && i.status === 'queued' && !this.pendingIngress.get(record.id)?.has(i.id));
        for (const instruction of consumed) instruction.status = 'consumed';
        try { await this.event(record, 'instructions:consumed', { instructionIds: consumed.map(i => i.id) }); }
        catch (error) { for (const instruction of consumed) instruction.status = 'queued'; throw error; }
      },
      setOperation: async operation => {
        record.operations[key(operation.id)] = { ...operation, id: key(operation.id) };
        await this.event(record, `operation:${operation.status}`, { name: operation.name, category: operation.category, outcome: operation.result?.outcome, error: operation.result?.error }, key(operation.id));
        this.notify(record);
      },
      modelResult: async result => {
        await this.event(record, 'model:result', { finishReason: result.finishReason, usage: result.usage, response: result.diagnostics });
      },
      interact: async input => {
        const request = { ...input, id: key(input.id), operationId: key(input.operationId) };
        const existing = record.interactions[request.id];
        if (existing?.outcome) {
          if (existing.fingerprint !== request.fingerprint) {
            delete record.interactions[request.id];
            await this.event(record, 'interaction:invalidated', { reason: '文件或操作已变化，请重新授权' }, request.operationId);
          } else return existing.outcome;
        }
        record.interactions[request.id] = request;
        record.status = request.kind === 'approval' ? 'waiting_for_approval' : 'waiting_for_user';
        await this.event(record, 'interaction:requested', { interactionId: request.id, kind: request.kind }, request.operationId);
        this.notify(record);
        this.bus.emit({ type: 'interaction:request', request, runId: record.id, sessionId: record.sessionId, agentId: record.agentId });
        throw new RunSuspended(request);
      },
    };
  }
  async start(prompt: string, options: { sessionId: string; messages: ChatMessage[]; maxTurns: number; enableSkills: boolean; providerId?: string }): Promise<string> {
    if (this.disposed) throw new Error('运行管理器已停止');
    if (this.store.warnings.length) throw new Error('部分运行记录损坏，自动执行已暂停。请导出诊断并恢复记录后重试。');
    if (Object.values([...this.records.values()].flatMap(r => Object.values(r.operations))).some(op => op.status === 'unknown')) throw new Error('存在尚未核对的操作，请从运行记录中核对实际结果后继续');
    if (options.sessionId !== this.chat.getSessionInfo().sessionId) throw new Error('会话已变化，请刷新聊天页面');
    if (this.list(options.sessionId).some(r => ['running','waiting_for_user','waiting_for_approval','interrupted'].includes(r.status) || Object.values(r.operations).some(op => op.status === 'unknown'))) throw new Error('当前会话还有未结束的运行，请先继续或停止它。');
    const createdAt = Math.max(Date.now(), ...this.list().map(r => r.createdAt + 1));
    const id = `run-${createdAt}-${Math.random().toString(36).slice(2)}`;
    const record: RunRecord = { version: 1, id, sessionId: options.sessionId, prompt, agentId: 'default-chat-agent', providerId: options.providerId,
      maxTurns: options.maxTurns, enableSkills: options.enableSkills, status: 'running', createdAt, updatedAt: createdAt,
      messages: [...options.messages, { role: 'user', content: prompt, timestamp: Date.now() }], baseMessageCount: options.messages.length,
      operations: {}, interactions: {}, events: [] };
    this.records.set(id, record);
    try {
      await this.event(record, 'run:started');
      await this.chat.replaceMessages(record.messages);
    } catch (error) { record.status = 'interrupted'; record.error = String(error); this.notify(record); throw error; }
    // Consumers attach before any model or tool can produce events.
    this.notify(record);
    void this.drive(record, false);
    return id;
  }
  async open(id: string): Promise<void> {
    const record = this.records.get(id);
    if (!record) throw new Error('运行不存在');
    if (this.list(record.sessionId)[0]?.id !== id) throw new Error('该会话已有更新的运行，请打开该会话最新记录，避免覆盖后续对话');
    if (this.active.size && !this.active.has(id)) throw new Error('请先停止当前运行，再切换会话');
    await this.chat.restoreSession(record.sessionId, record.messages);
  }
  async resume(id: string): Promise<void> {
    if (this.store.warnings.length) throw new Error('请先恢复损坏的运行记录，再继续执行');
    const record = this.records.get(id);
    if (!record || this.disposed) throw new Error('运行不存在或插件已停止');
    if (this.list(record.sessionId)[0]?.id !== id) throw new Error('此运行之后已有新对话，请在最新对话中继续');
    if (record.sessionId !== this.chat.getSessionInfo().sessionId) throw new Error('请在原会话中恢复此运行，避免覆盖其他会话');
    if (this.active.has(id)) throw new Error('运行仍在执行，请稍后再试');
    if (!['interrupted','waiting_for_user','waiting_for_approval','failed'].includes(record.status)) throw new Error('此运行不能继续');
    if (Object.values(record.operations).some(op => op.status === 'unknown')) throw new Error('存在结果未知的操作，请先核对实际结果');
    if (Object.values(record.interactions).some(i => !i.outcome)) {
      this.notify(record);
      return;
    }
    record.status = 'running'; record.error = undefined;
    await this.event(record, 'run:resumed');
    this.notify(record);
    await this.drive(record, true);
  }
  async respond(id: string, interactionId: string, outcome: NonNullable<InteractionRequest['outcome']>): Promise<void> {
    if (this.store.warnings.length) throw new Error('请先恢复损坏的运行记录，再继续执行');
    const record = this.records.get(id), request = record?.interactions[interactionId];
    if (!record || !request || request.outcome || !['waiting_for_user','waiting_for_approval','interrupted'].includes(record.status)) throw new Error('交互已结束或响应重复');
    this.assertCurrent(record);
    if (Object.values(record.operations).some(op => op.status === 'unknown')) throw new Error('存在结果未知的操作，请先核对');
    if (request.kind === 'approval' && !['approved','rejected','cancelled','expired'].includes(outcome.kind)) throw new Error('审批响应不合法');
    if (request.kind === 'question' && !['answered','cancelled','expired'].includes(outcome.kind)) throw new Error('问答响应不合法');
    if (outcome.kind === 'answered' && request.requiresInput && !outcome.answer?.trim()) throw new Error('回答不能为空');
    request.outcome = outcome;
    await this.event(record, 'interaction:resolved', { interactionId, outcome: outcome.kind }, request.operationId);
    if (['cancelled','expired','rejected'].includes(outcome.kind)) { await this.cancel(id, `人工交互${outcome.kind === 'expired' ? '已过期' : outcome.kind === 'rejected' ? '已拒绝' : '已取消'}`); return; }
    await this.wait(id);
    await this.resume(id);
  }
  async reconcile(id: string, operationId: string, result: import('../skills/skill-types').SkillResult | null): Promise<void> {
    const record = this.records.get(id), operation = record?.operations[operationId];
    if (!record || !operation || operation.status !== 'unknown' || this.active.has(id)) throw new Error('没有可核对的操作');
    this.assertCurrent(record);
    if (this.inFlight.get(id)?.has(operationId)) throw new Error('操作仍在实际执行或保存结果，请等待结束后再核对，避免重复执行');
    operation.status = result ? 'finished' : 'planned';
    operation.result = result || undefined;
    if (!result) for (const [key, interaction] of Object.entries(record.interactions)) if (interaction.operationId === operationId) delete record.interactions[key];
    await this.event(record, 'operation:reconciled', { applied: !!result }, operationId);
    this.notify(record);
  }
  async cancel(id: string, reason = '已停止生成'): Promise<void> {
    const record = this.records.get(id); if (!record) return;
    const active = this.active.get(id);
    if (active) { this.live.set(id, { ...this.live.get(id), cancelling: true }); this.notify(record); active.controller.abort(new DOMException(reason, 'AbortError')); await active.promise; return; }
    if (['completed','cancelled'].includes(record.status)) return;
    this.assertCurrent(record);
    record.status = 'cancelled'; record.error = reason;
    for (const request of Object.values(record.interactions)) request.outcome ||= { kind: 'cancelled' };
    this.closePendingCalls(record, reason);
    await this.event(record, 'run:cancelled', { reason });
    await this.chat.replaceMessages(record.messages);
    this.notify(record);
  }
  private assertCurrent(record: RunRecord): void {
    if (record.sessionId !== this.chat.getSessionInfo().sessionId || this.list(record.sessionId)[0]?.id !== record.id) throw new Error('此操作不属于当前会话最新运行，请先打开对应会话');
  }
  private closePendingCalls(record: RunRecord, reason: string): void {
    const done = new Set(record.messages.filter(m => m.role === 'tool').map(m => m.tool_call_id));
    for (const m of [...record.messages]) for (const tc of m.tool_calls || []) if (!done.has(tc.id)) {
      const op = record.operations[tc.id];
      record.messages.push({ role: 'tool', name: tc.name, tool_call_id: tc.id, content: op?.result ? JSON.stringify(op.result) : `Error: ${reason}；未执行或结果尚未确认，请先核对。`, timestamp: Date.now() });
      done.add(tc.id);
    }
  }
  private async drive(record: RunRecord, resume: boolean): Promise<void> {
    const controller = new AbortController();
    const context: AgentContext = { messages: resume ? [...record.messages] : record.messages.slice(0,record.baseMessageCount), sessionId: record.sessionId, runId: record.id,
      abortSignal: controller.signal, pendingSteerMessages: [], runtime: this.runtime(record),
      metadata: { recoverFromTruncation: resume && [...record.events].reverse().find(event => event.type === 'model:result')?.details?.finishReason === 'length', maxTurns: record.maxTurns, resume, providerId: record.providerId, enableSkills: record.enableSkills },
      onCheckpoint: async messages => {
        record.messages = [...messages]; record.partial = undefined;
        await this.store.save(record);
        await this.chat.replaceMessages(messages);
        this.notify(record);
      } };
    const promise = Promise.resolve().then(async () => {
      try {
        await this.execute(record.prompt, context);
        const queuedInstructions = record.instructions?.some(i => i.status === 'queued');
        record.status = context.metadata?.completionStatus === 'max_turns_exceeded' || queuedInstructions ? 'interrupted' : 'completed';
        record.error = queuedInstructions ? '补充指令已保存但尚未处理，请从检查点继续。' : record.status === 'interrupted' ? '本次执行达到轮次上限，可从检查点继续。' : undefined;
        await this.event(record, `run:${record.status}`, record.error ? { message: record.error } : undefined);
      } catch (error) {
        if (error instanceof RunSuspended) return;
        record.status = this.disposed || error instanceof RunBlocked ? 'interrupted' : isAbortError(error) ? 'cancelled' : 'failed';
        record.error = error instanceof Error ? error.message : String(error);
        await this.event(record, `run:${record.status}`, errorDetails(error));
      } finally {
        this.active.delete(record.id);
        this.live.delete(record.id);
        this.notify(record);
      }
    }).catch(error => { this.observer?.error('runtime:boundary:failed', error, { component: 'runtime', runId: record.id, sessionId: record.sessionId }); console.error('[RunController] Persistence/execution failed:', error); record.status = 'interrupted'; record.error = String(error); this.active.delete(record.id); this.notify(record); });
    this.active.set(record.id, { controller, context, promise });
    await promise;
  }
  async steer(id: string, text: string): Promise<boolean> {
    const active = this.active.get(id);
    const record = this.records.get(id);
    if (!active || !record || record.status !== 'running' || active.controller.signal.aborted || !text.trim()) return false;
    this.assertCurrent(record);
    const instruction = { id: `instruction-${Date.now()}-${Math.random().toString(36).slice(2)}`, text, status: 'queued' as const };
    const pending = this.pendingIngress.get(id) || new Set<string>();
    pending.add(instruction.id); this.pendingIngress.set(id, pending);
    record.instructions ||= []; record.instructions.push(instruction);
    try { await this.event(record, 'instruction:queued', { instructionId: instruction.id }); }
    catch (error) {
      record.instructions = record.instructions.filter(i => i !== instruction);
      // Another checkpoint may have captured the pending receipt before its write failed.
      try { await this.store.save(record); }
      catch (rollbackError) {
        this.observer?.error('storage:instruction_rollback:failed', rollbackError, { component: 'storage', runId: id, sessionId: record.sessionId });
        throw new Error('补充指令接收失败，撤回记录也未能保存；请先检查存储后重试。', { cause: rollbackError });
      }
      throw error;
    }
    finally {
      pending.delete(instruction.id);
      if (!pending.size) this.pendingIngress.delete(id);
    }
    return true;
  }
  async wait(id: string): Promise<void> { await this.active.get(id)?.promise; }
  async dispose(): Promise<void> {
    this.disposed = true;
    for (const item of this.active.values()) item.controller.abort(new DOMException('插件卸载，执行已中断', 'AbortError'));
    await Promise.all([...this.active.values()].map(a => a.promise));
    await this.store.flush();
    this.unsubscribe();
    this.live.clear();
  }
}
