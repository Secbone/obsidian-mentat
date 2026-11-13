import { RunController } from '../../src/runtime/run-controller';
import { RunStore } from '../../src/runtime/run-store';
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('obsidian');
import { z } from 'zod';
import { BaseAgent } from '../../src/agents/base-agent';
import { EventBus } from '../../src/extensions/event-bus';
import { SkillRegistry } from '../../src/skills/core/skill-registry';
import { SkillExecutor } from '../../src/skills/core/skill-executor';
import { SkillInvocationContext } from '../../src/skills/strategies/skill-invocation-strategy';
import { ChatManager } from '../../src/chat/chat-manager';
import { ChatOrchestrator } from '../../src/chat/chat-orchestrator';
import { ChatView } from '../../src/ui/chat-view';
import { MemoryPlatformAdapter } from '../utils/memory-platform-adapter';
import { AgentEvent } from '../../src/agents/agent-types';
import { SummaryContextBuilder } from '../../src/context/summary-context-builder';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
function setup(overrides: Record<string, unknown> = {}, config: Record<string, unknown> = {}) {
  const provider = { id: 'fake', name: 'fake', type: 'openai', supportsSkills: () => true,
    getContextWindow: () => 32000, getCompactionThreshold: () => .8,
    generateStreamWithSkills: vi.fn(async () => ({ content: 'answer', finishReason: 'stop' })), ...overrides } as any;
  const bus = new EventBus(), events: AgentEvent[] = [], registry = new SkillRegistry();
  const logger = { logIncident: vi.fn(async () => {}) };
  bus.on('*', e => events.push(e));
  const executor = new SkillExecutor(registry, {} as any, bus, logger);
  const agent = new BaseAgent({ id: 'default-chat-agent', name: 'Chat', description: '', enableSkills: true, ...config }, provider,
    { skillRegistry: registry, skillExecutor: executor, skillInvocationContext: new SkillInvocationContext('native'), eventBus: bus, diagnosticsLogger: logger });
  return { provider, bus, events, registry, executor, agent, logger };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('Chat reliability regressions', () => {
  it('does not duplicate streamed output when saving the completed assistant fails', async () => {
    const { agent } = setup({ generateStreamWithSkills: async (_: any, chunk: any) => {
      chunk('answer');
      return { content: 'answer', finishReason: 'stop' };
    } });
    let saved: any[] = [];
    await expect(agent.execute('q', { messages: [], sessionId: 's', onCheckpoint: async messages => {
      saved = [...messages];
      if (messages.some(m => m.role === 'assistant')) throw new Error('disk full');
    } })).rejects.toThrow('disk full');
    expect(saved.filter(m => m.role === 'assistant').map(m => m.content)).toEqual(['answer']);
  });

  it('persists checkpoints, restores a session and supplies the previous exchange to the next request', async () => {
    const platform = new MemoryPlatformAdapter();
    const plugin = { platform, loadData: async () => ({}), saveData: async () => {} } as any;
    let manager = new ChatManager(plugin);
    const { agent, provider, events } = setup();
    await agent.execute('first', { messages: [], sessionId: 's', onCheckpoint: messages => manager.replaceMessages(messages) });
    manager = new ChatManager(plugin);
    const saved = await manager.getHistory();
    expect(saved.map(m => m.content)).toEqual(['first', 'answer']);
    await agent.execute('second', { messages: saved, sessionId: 's', onCheckpoint: messages => manager.replaceMessages(messages) });
    expect(provider.generateStreamWithSkills.mock.calls[1][0].map((m: any) => m.content)).toEqual(['first', 'answer', 'second']);
    expect((await manager.getHistory()).length).toBe(4);
    expect(events.filter(e => e.type === 'agent:end')).toHaveLength(2);
    expect(events.every(e => e.sessionId === 's' && !!e.runId && e.agentId === 'default-chat-agent')).toBe(true);
  });

  it('cancels a pending stream with partial output saved and observes late rejection', async () => {
    const started = deferred(), pending = deferred<any>(), ac = new AbortController();
    const { agent, events, logger } = setup({ generateStreamWithSkills: async (_: any, chunk: any) => { chunk('partial'); started.resolve(); return pending.promise; } });
    let saved: any[] = [];
    const running = agent.execute('q', { messages: [], sessionId: 's', abortSignal: ac.signal, onCheckpoint: async m => { saved = m; } });
    const rejection = expect(running).rejects.toMatchObject({ name: 'AbortError' });
    await started.promise;
    await vi.waitFor(() => expect(events.some(e => e.type === 'message:update')).toBe(true));
    ac.abort(); await rejection;
    pending.reject(new Error('late transport failure'));
    await Promise.resolve();
    expect(saved.at(-1).content).toBe('partial');
    expect(saved.at(-1).metadata.interrupted).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'agent:end', status: 'cancelled' });
    expect(logger.logIncident).toHaveBeenCalledWith(expect.objectContaining({ kind: 'cancelled', sessionId: 's' }));
  });

  it('emits completion for plain chat and treats a normal last allowed turn as success', async () => {
    const plain = setup({ supportsSkills: () => false, generateStream: async (_: any, chunk: any) => chunk('plain') }, { enableSkills: false });
    await plain.agent.execute('q', { messages: [], sessionId: 's' });
    expect(plain.events.at(-1)).toMatchObject({ type: 'agent:end', status: 'completed' });
    const normal = setup();
    const result = await normal.agent.execute('q', { messages: [], sessionId: 's', metadata: { maxTurns: 1 } });
    expect(result.metadata?.status).toBe('completed');
    expect(normal.events.some(e => e.type === 'system:error')).toBe(false);
  });

  it('preserves checkpoints and propagates the original network error', async () => {
    const error = Object.assign(new TypeError('network error'), { code: 'ERR_NETWORK_CHANGED' });
    const { agent, events, logger } = setup({ generateStreamWithSkills: async () => { throw error; } });
    let saved: any[] = [];
    await expect(agent.execute('q', { messages: [], sessionId: 's', onCheckpoint: async m => { saved = m; } })).rejects.toBe(error);
    expect(saved[0].content).toBe('q');
    expect(events.at(-1)).toMatchObject({ type: 'agent:end', status: 'failed' });
    expect(logger.logIncident).toHaveBeenCalledWith(expect.objectContaining({ details: expect.objectContaining({ code: 'ERR_NETWORK_CHANGED' }) }));
  });

  it('merges vault context into the provided UI context and propagates execution failure', async () => {
    const obj = Object.create(ChatOrchestrator.prototype) as any;
    obj.options = {}; obj.activeQueries = 0;
    obj.defaultAgent = { getId: () => 'a' };
    obj.buildVaultSessionContextPayload = async () => 'vault context';
    const error = new Error('execution failed');
    obj.agentManager = { execute: vi.fn(async () => { throw error; }) };
    await expect(obj.sendMessage('q', { context: { messages: [], sessionId: 's', metadata: { maxTurns: 3 } } })).rejects.toBe(error);
    expect(obj.agentManager.execute.mock.calls[0][2].metadata).toMatchObject({ sessionContextPayload: 'vault context', maxTurns: 3 });
  });

  it('never starts an already-cancelled tool and cleans authorization listeners', async () => {
    const { executor, registry, bus } = setup();
    const execute = vi.fn(async () => ({ success: true }));
    registry.register({ name: 'write', namespace: 'obsidian', description: '', schema: z.object({}), execute, metadata: { requiresConfirmation: true } });
    const ac = new AbortController(); ac.abort();
    await executor.execute('obsidian', 'write', {}, { abortSignal: ac.signal });
    expect(execute).not.toHaveBeenCalled();
    vi.useFakeTimers();
    const ac2 = new AbortController();
    const waiting = executor.execute('obsidian', 'write', {}, { abortSignal: ac2.signal });
    ac2.abort(); await waiting;
    expect(execute).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    bus.emit({ type: 'confirm:response', taskId: 'unrelated', approved: true });
  });

  it('keeps the mutation barrier until a timed-out tool actually settles', async () => {
    vi.useFakeTimers();
    const { executor, registry, logger } = setup();
    const pending = deferred<any>(); let seenSignal: AbortSignal | undefined;
    const first = vi.fn((_input, opts) => { seenSignal = opts.abortSignal; return pending.promise; });
    const second = vi.fn(async () => ({ success: true }));
    registry.register({ name: 'first', namespace: 'obsidian', description: '', schema: z.object({}), execute: first, metadata: { executionCategory: 'write' } });
    registry.register({ name: 'second', namespace: 'obsidian', description: '', schema: z.object({}), execute: second, metadata: { executionCategory: 'write' } });
    const a = executor.execute('obsidian', 'first', {}, { timeout: 10 });
    await vi.advanceTimersByTimeAsync(11);
    expect((await a).success).toBe(false);
    expect(seenSignal?.aborted).toBe(true);
    const b = executor.execute('obsidian', 'second', {}, { timeout: 100 });
    await Promise.resolve(); expect(second).not.toHaveBeenCalled();
    pending.resolve({ success: true });
    expect((await b).success).toBe(true);
    expect(logger.logIncident).toHaveBeenCalledWith(expect.objectContaining({ kind: 'tool-late-result', success: true }));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('serializes invoke writes and saves each actual tool result', async () => {
    const { agent, provider, registry } = setup(); let active = 0, peak = 0;
    registry.register({ name: 'edit', namespace: 'obsidian', description: '', schema: z.object({}), metadata: { executionCategory: 'write' },
      execute: async () => { peak = Math.max(peak, ++active); await Promise.resolve(); active--; return { success: true, data: 'written' }; } });
    provider.generateStreamWithSkills.mockResolvedValueOnce({ content: '', finishReason: 'tool_calls', toolCalls: [1, 2].map(n => ({ id: String(n), name: 'invoke', arguments: JSON.stringify({ skill_name: 'obsidian:edit', params: {} }) })) });
    const checkpoints: any[][] = [];
    const result = await agent.execute('q', { messages: [], sessionId: 's', onCheckpoint: async m => { checkpoints.push([...m]); } });
    expect(peak).toBe(1);
    expect(result.messages.filter(m => m.role === 'tool')).toHaveLength(2);
    expect(checkpoints.some(m => m.filter(x => x.role === 'tool').length === 1)).toBe(true);
  });

  it('retains the write barrier when skills are reloaded for the same vault', async () => {
    const { registry } = setup();
    const context = { vault: {} } as any;
    const oldExecutor = new SkillExecutor(registry, context);
    const reloadedExecutor = new SkillExecutor(registry, context);
    const pending = deferred<any>(), second = vi.fn(async () => ({ success: true }));
    registry.register({ name: 'old', namespace: 'obsidian', description: '', schema: z.object({}), execute: () => pending.promise, metadata: { executionCategory: 'write' } });
    registry.register({ name: 'new', namespace: 'obsidian', description: '', schema: z.object({}), execute: second, metadata: { executionCategory: 'write' } });
    const a = oldExecutor.execute('obsidian', 'old', {});
    const b = reloadedExecutor.execute('obsidian', 'new', {});
    await Promise.resolve(); expect(second).not.toHaveBeenCalled();
    pending.resolve({ success: true }); await Promise.all([a, b]);
    expect(second).toHaveBeenCalledOnce();
  });

  it('ignores child and stale UI events and leaves completion to the runtime', async () => {
    vi.useFakeTimers();
    const view = Object.create(ChatView.prototype) as any;
    view.chatManager = {getSessionInfo:() => ({sessionId:'s'})};
    view.runs = {list:() => [{id:'parent'}]};
    view.render = vi.fn();
    view.handleRuntimeEvent({type:'agent:end',messages:[],agentId:'child',sessionId:'s',runId:'child'});
    view.handleRuntimeEvent({type:'agent:end',messages:[],agentId:'default-chat-agent',sessionId:'s',runId:'old'});
    await vi.runAllTimersAsync(); expect(view.render).not.toHaveBeenCalled();
    view.handleRuntimeEvent({type:'agent:end',messages:[],agentId:'default-chat-agent',sessionId:'s',runId:'parent'});
    await vi.runAllTimersAsync(); expect(view.render).toHaveBeenCalledOnce();
  });

  it('runs the card UI send path twice with durable history and runtime completion', async () => {
    const { agent, bus } = setup();
    const platform = new MemoryPlatformAdapter();
    const manager = new ChatManager({ platform, loadData: async () => ({}), saveData: async () => {} } as any);
    const view = Object.create(ChatView.prototype) as any;
    let prompt = 'first';
    Object.assign(view, {
      chatManager: manager, eventBus: bus, history:[],themeRegistry:{dispose:vi.fn()},
      inputHandler: { getRawTextContent: () => prompt, getContextPillPaths: () => [], clearInput: vi.fn(), focusInput: vi.fn(),dispose:vi.fn() },
      renderDocumentList: vi.fn(),
      plugin: { settings: { skillsEnabled: true, maxTurns: 20 } },
      theme: { render:vi.fn(), updateInputState:vi.fn() },
      chatOrchestrator: { sendMessage: (_q: string, options: any) => agent.execute(_q, options.context), reportFailure: vi.fn() },
    });
    const runtime = new RunController(new RunStore(platform), bus, manager, async (_q, context) => { await agent.execute(_q, context); });
    await runtime.initialize();
    view.runs = runtime;
    view.runtimeUnsubscribe = bus.on('*', (event: AgentEvent) => view.handleRuntimeEvent(event));
    await view.handleSend();
    await runtime.wait(runtime.list()[0].id);
    prompt = 'second';
    await view.handleSend();
    await runtime.wait(runtime.list()[0].id);
    view.render();
    const state = view.theme.render.mock.calls.at(-1)[0];
    expect(state.cards.filter((c:any) => c.kind === 'reply').map((c:any) => c.text)).toEqual(['answer','answer']);
    expect(state.busy).toBe(false);
    expect(state.inputMode).toBe('send');
    await view.onClose();
    expect((await manager.getHistory()).map(m => m.content)).toEqual(['first', 'answer', 'second', 'answer']);
    expect(view.chatOrchestrator.reportFailure).not.toHaveBeenCalled();
  });

  it('detaches a closing chat view without cancelling its plugin-owned run', async()=>{
    const view=Object.create(ChatView.prototype) as any;
    view.runtimeUnsubscribe=vi.fn();view.streamUnsubscribe=vi.fn();view.themeRegistry={dispose:vi.fn()};
    view.plugin={runController:{cancel:vi.fn()}};
    await view.onClose();
    expect(view.runtimeUnsubscribe).toHaveBeenCalledOnce();
    expect(view.plugin.runController.cancel).not.toHaveBeenCalled();
  });

  it('keeps the raw archive when the model receives a compacted context', async () => {
    const { agent, provider } = setup({ getContextWindow: () => 4096 });
    (agent as any).contextBuilder = new SummaryContextBuilder({ compact: vi.fn(async () => 'compacted decisions') });
    const history = Array.from({ length: 10 }, (_, n) => ({ role: n % 2 ? 'assistant' : 'user', content: `original-${n} ${'x'.repeat(2000)}`, timestamp: n + 1 })) as any[];
    const result = await agent.execute('next', { messages: history, sessionId: 's' });
    expect(provider.generateStreamWithSkills.mock.calls[0][0][0].content).toContain('compacted decisions');
    expect(result.messages[0].content).toBe(history[0].content);
    expect(result.messages).toHaveLength(12);
    expect(result.messages.some(m => m.content.includes('Context Summary'))).toBe(false);
  });

  it('bounds parallel reads and emits start before waiting for tool completion', async () => {
    const { agent, provider, registry, events } = setup({}, { maxParallelTools: 2 });
    const gate = deferred<any>(); let active = 0, peak = 0;
    registry.register({ name: 'read', namespace: 'obsidian', description: '', schema: z.object({}), metadata: { executionCategory: 'read' }, execute: async () => {
      peak = Math.max(peak, ++active); await gate.promise; active--; return { success: true, data: 'read' };
    } });
    provider.generateStreamWithSkills.mockResolvedValueOnce({ content: '', finishReason: 'tool_calls', toolCalls: [1, 2, 3].map(n => ({ id: String(n), name: 'obsidian:read', arguments: '{}' })) });
    const running = agent.execute('q', { messages: [], sessionId: 's' });
    await vi.waitFor(() => expect(active).toBe(2));
    expect(events.filter(e => e.type === 'tool:start')).toHaveLength(2);
    gate.resolve(); await running;
    expect(peak).toBe(2);
    expect(events.filter(e => e.type === 'tool:end')).toHaveLength(3);
  });
});
