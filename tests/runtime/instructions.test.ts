import { describe, expect, it, vi } from 'vitest';
vi.mock('obsidian');
import { z } from 'zod';
import { BaseAgent } from '../../src/agents/base-agent';
import { SkillRegistry } from '../../src/skills/core/skill-registry';
import { SkillExecutor } from '../../src/skills/core/skill-executor';
import { SkillInvocationContext } from '../../src/skills/strategies/skill-invocation-strategy';
import { ChatManager } from '../../src/chat/chat-manager';
import { EventBus } from '../../src/extensions/event-bus';
import { RunController } from '../../src/runtime/run-controller';
import { RunStore } from '../../src/runtime/run-store';
import { projectChat } from '../../src/ui/chat-cards/presenter';
import { MemoryPlatformAdapter } from '../utils/memory-platform-adapter';

function setup(platform = new MemoryPlatformAdapter()) {
  const plugin = { platform, loadData: async () => ({}), saveData: async () => {} };
  const manager = new ChatManager(plugin), bus = new EventBus(), registry = new SkillRegistry();
  const provider = { id: 'fake', type: 'openai', supportsSkills: () => true, getContextWindow: () => 32000,
    getCompactionThreshold: () => .8, getMaxOutputTokens: () => 1000,
    generateStreamWithSkills: vi.fn(async () => ({ content: 'done', finishReason: 'stop' })) } as any;
  const agent = new BaseAgent({ id: 'default-chat-agent', name: 'Chat', description: '', enableSkills: true }, provider,
    { skillRegistry: registry, skillExecutor: new SkillExecutor(registry, {} as any), skillInvocationContext: new SkillInvocationContext('native'), eventBus: bus });
  const store = new RunStore(platform);
  const runtime = new RunController(store, bus, manager, async (prompt, context) => { await agent.execute(prompt, context); });
  return { platform, manager, provider, store, runtime, registry };
}

describe('Durable instruction reception and consumption', () => {
  it.each([true, false])('keeps final-request instructions visible and consumes once after reload (skills=%s)', async enableSkills => {
    const s = setup(); let finish!: (result: any) => void;
    s.provider.generateStreamWithSkills.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await s.manager.getHistory(); await s.runtime.initialize();
    const sessionId = s.manager.getSessionInfo().sessionId;
    const id = await s.runtime.start('do A', { sessionId, messages: [], maxTurns: 20, enableSkills });
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    expect(await s.runtime.steer(id, 'also do B')).toBe(true);
    expect((await s.store.load(id)).instructions?.[0]).toMatchObject({ text: 'also do B', status: 'queued' });
    finish({ content: 'A done', finishReason: 'stop' }); await s.runtime.wait(id);
    expect(s.runtime.get(id)?.status).toBe('interrupted');
    const state = projectChat({ sessionId, history: [], records: s.runtime.list() });
    expect(state.cards.find(card => card.title === '补充指令 · 尚未处理')?.text).toBe('also do B');
    const restored = setup(s.platform); await restored.manager.getHistory(); await restored.runtime.initialize();
    await restored.runtime.resume(id);
    expect(restored.runtime.get(id)?.status).toBe('completed');
    expect(restored.runtime.get(id)?.instructions?.[0].status).toBe('consumed');
    expect(restored.runtime.get(id)?.messages.filter(message => message.metadata?.instructionId)).toHaveLength(1);
    expect(restored.provider.generateStreamWithSkills.mock.calls[0][0].some((message: any) => message.content.includes('also do B'))).toBe(true);
  });

  it('does not reinject when a process stops between transcript commit and instruction acknowledgement', async () => {
    const s = setup(); await s.manager.getHistory(); await s.runtime.initialize();
    const id = await s.runtime.start('do A', { sessionId: s.manager.getSessionInfo().sessionId, messages: [], maxTurns: 20, enableSkills: true });
    await s.runtime.wait(id);
    const record = s.runtime.get(id)!;
    record.status = 'interrupted'; record.instructions = [{ id: 'instruction-1', text: 'B', status: 'queued' }];
    record.messages.push({ role: 'user', content: '[HUMAN DYNAMIC INTERVENTION]: B', timestamp: Date.now(), metadata: { instructionId: 'instruction-1' } });
    await s.store.save(record);
    const restored = setup(s.platform); await restored.manager.getHistory(); await restored.runtime.initialize();
    await restored.runtime.resume(id);
    expect(restored.runtime.get(id)?.instructions?.[0].status).toBe('consumed');
    expect(restored.runtime.get(id)?.messages.filter(message => message.metadata?.instructionId === 'instruction-1')).toHaveLength(1);
  });

  it('retains an instruction across a question suspension and consumes it only after the pending tool is paired', async () => {
    const s = setup(); let finish!: (result: any) => void;
    s.registry.register({ name: 'pause', namespace: 'obsidian', description: '', schema: z.object({}), metadata: { executionCategory: 'interaction' },
      execute: async (_input, options) => ({ success: true, data: await options!.runtime!.interact({ id: 'question', operationId: options!.operationId!, kind: 'question', question: 'continue?' }) }) });
    s.provider.generateStreamWithSkills.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await s.manager.getHistory(); await s.runtime.initialize();
    const id = await s.runtime.start('do A', { sessionId: s.manager.getSessionInfo().sessionId, messages: [], maxTurns: 20, enableSkills: true });
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    await s.runtime.steer(id, 'also B');
    finish({ content: '', toolCalls: [{ id: 'q', name: 'obsidian:pause', arguments: '{}' }], finishReason: 'tool_calls' });
    await s.runtime.wait(id);
    expect(s.runtime.get(id)?.status).toBe('waiting_for_user');
    expect((await s.store.load(id)).instructions?.[0].status).toBe('queued');
    await s.runtime.respond(id, 'question', { kind: 'answered', answer: 'yes' });
    expect(s.runtime.get(id)?.status).toBe('completed');
    const input = s.provider.generateStreamWithSkills.mock.calls[1][0];
    expect(input.findIndex((message: any) => message.tool_call_id === 'q')).toBeLessThan(input.findIndex((message: any) => message.metadata?.instructionId));
    expect(s.runtime.get(id)?.instructions?.[0].status).toBe('consumed');
  });

  it('keeps a committed instruction queued when acknowledgement storage fails, then resumes without reinjection', async () => {
    const s = setup(); await s.manager.getHistory(); await s.runtime.initialize();
    const id = await s.runtime.start('A', { sessionId: s.manager.getSessionInfo().sessionId, messages: [], maxTurns: 20, enableSkills: true });
    await s.runtime.wait(id);
    const record = s.runtime.get(id)!;
    record.status = 'interrupted'; record.instructions = [{ id: 'instruction-ack', text: 'B', status: 'queued' }];
    record.messages.push({ role: 'user', content: '[HUMAN DYNAMIC INTERVENTION]: B', timestamp: Date.now(), metadata: { instructionId: 'instruction-ack' } });
    await s.store.save(record);
    const save = s.store.save.bind(s.store);
    const fail = vi.spyOn(s.store, 'save').mockImplementation(async snapshot => {
      if (snapshot.events.at(-1)?.type === 'instructions:consumed') throw new Error('ack disk failure');
      return save(snapshot);
    });
    await s.runtime.resume(id);
    expect(record.status).toBe('failed');
    expect(record.instructions[0].status).toBe('queued');
    fail.mockRestore();
    const restored = setup(s.platform); await restored.manager.getHistory(); await restored.runtime.initialize();
    await restored.runtime.resume(id);
    expect(restored.runtime.get(id)?.instructions?.[0].status).toBe('consumed');
    expect(restored.runtime.get(id)?.messages.filter(message => message.metadata?.instructionId === 'instruction-ack')).toHaveLength(1);
  });
});
