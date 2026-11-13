import { describe, expect, it, vi } from 'vitest';
vi.mock('obsidian');
import { z } from 'zod';
import { createEngineFactory } from '../../src/agents/engine-factory';
import type { EngineDefinition } from '../../src/contracts/agent-engine';
import { SkillRegistry } from '../../src/skills/core/skill-registry';
import { SkillExecutor } from '../../src/skills/core/skill-executor';
import { SkillInvocationContext } from '../../src/skills/strategies/skill-invocation-strategy';
import { ChatManager } from '../../src/chat/chat-manager';
import { EventBus } from '../../src/extensions/event-bus';
import { RunController } from '../../src/runtime/run-controller';
import { RunStore } from '../../src/runtime/run-store';
import { MemoryPlatformAdapter } from '../utils/memory-platform-adapter';

const alternate: EngineDefinition = { binding: { id: 'portable-loop', version: '1', codecVersion: 1 },
  async run(input, host) {
    const paired = new Set(input.messages.filter(message => message.role === 'tool').map(message => message.tool_call_id));
    for (const message of input.messages) for (const call of message.tool_calls || []) if (!paired.has(call.id)) await host.invoke(call);
    for (let turn = 0; turn < input.maxTurns; turn++) {
      await host.instructions();
      const response = await host.model({ tools: [{ name: 'obsidian__write', description: '', inputSchema: { type: 'object', properties: {} } }] });
      if (!response.toolCalls?.length) return { content: response.content };
      for (const call of response.toolCalls) await host.invoke(call);
      await host.checkpoint({ turn });
    }
    return { content: '', status: 'max_turns_exceeded' };
  } };

function fixture(engineId: string, platform = new MemoryPlatformAdapter(), extra: Record<string, EngineDefinition> = {}) {
  const chat = new ChatManager({ platform, loadData: async () => ({}), saveData: async () => {} });
  const registry = new SkillRegistry(), bus = new EventBus();
  const effect = vi.fn(async () => ({ success: true, data: 'written' }));
  registry.register({ name: 'write', namespace: 'obsidian', description: '', schema: z.object({}), metadata: { executionCategory: 'write', requiresConfirmation: true }, execute: effect });
  const provider = { id: 'fake', name: 'fake', type: 'openai', supportsSkills: () => true, getContextWindow: () => 32000,
    getMaxOutputTokens: () => 2048, getCompactionThreshold: () => .8, generateStreamWithSkills: vi.fn()
      .mockResolvedValueOnce({ content: '', toolCalls: [{ id: 'w', name: 'obsidian__write', arguments: '{}' }], finishReason: 'tool_calls' })
      .mockResolvedValue({ content: 'done', finishReason: 'stop' }) } as any;
  const context = { files: { getAbstractFileByPath: () => null, getMarkdownFiles: () => [], read: async () => '' }, metadataCache: { getFileCache: () => null } };
  const agent = createEngineFactory({ 'portable-loop': alternate, ...extra })({ id: 'default-chat-agent', name: 'test', description: '', enableSkills: true }, provider,
    { skillRegistry: registry, skillExecutor: new SkillExecutor(registry, context, bus), skillInvocationContext: new SkillInvocationContext('native'), eventBus: bus }, engineId);
  const runtime = new RunController(new RunStore(platform), bus, chat, async (prompt, input) => { await agent.execute(prompt, input); });
  return { runtime, chat, effect, provider, platform };
}
for (const engineId of ['native', 'portable-loop']) describe(`Agent engine shared host contract: ${engineId}`, () => {
  it('uses the same persistent approval, resume and completed-operation ledger', async () => {
    const s = fixture(engineId); await s.chat.getHistory(); await s.runtime.initialize();
    const id = await s.runtime.start('write once', { sessionId: s.chat.getSessionInfo().sessionId, messages: [], maxTurns: 5, enableSkills: true });
    await s.runtime.wait(id);
    expect(s.runtime.get(id)?.status).toBe('waiting_for_approval'); expect(s.effect).not.toHaveBeenCalled();
    await s.runtime.respond(id, 'w:approval', { kind: 'approved' });
    expect(s.runtime.get(id)?.status).toBe('completed'); expect(s.effect).toHaveBeenCalledOnce();
    expect(s.runtime.get(id)?.engineBinding?.id).toBe(engineId === 'native' ? 'base-agent' : engineId);
    expect(s.runtime.get(id)?.messages.filter(message => message.tool_call_id === 'w')).toHaveLength(1);
  });
  it('shares cancellation and does not execute effects after stopping', async () => {
    const s = fixture(engineId); s.provider.generateStreamWithSkills.mockImplementation(() => new Promise(() => {}));
    await s.chat.getHistory(); await s.runtime.initialize();
    const id = await s.runtime.start('wait', { sessionId: s.chat.getSessionInfo().sessionId, messages: [], maxTurns: 5, enableSkills: true });
    await vi.waitFor(() => expect(s.provider.generateStreamWithSkills).toHaveBeenCalled());
    await s.runtime.cancel(id); expect(s.runtime.get(id)?.status).toBe('cancelled'); expect(s.effect).not.toHaveBeenCalled();
  });
  it('refuses to resume another engine binding before a model or tool executes', async () => {
    const s = fixture(engineId); s.provider.generateStreamWithSkills.mockReset().mockRejectedValue(new Error('network failure'));
    await s.chat.getHistory(); await s.runtime.initialize();
    const id = await s.runtime.start('work', { sessionId: s.chat.getSessionInfo().sessionId, messages: [], maxTurns: 5, enableSkills: true });
    await s.runtime.wait(id); expect(s.runtime.get(id)?.status).toBe('failed');
    const next = fixture(engineId === 'native' ? 'portable-loop' : 'native', s.platform);
    await next.chat.getHistory(); await next.runtime.initialize(); await next.runtime.resume(id);
    expect(next.runtime.get(id)?.status).toBe('interrupted');
    expect(next.runtime.get(id)?.error).toMatch(/引擎|engine|兼容/i);
    expect(next.provider.generateStreamWithSkills).not.toHaveBeenCalled(); expect(next.effect).not.toHaveBeenCalled();
  });
});

describe('Host authority across third-party engine control flow', () => {
  it('does not let an engine swallow an approval suspension and report success', async () => {
    const definition: EngineDefinition = { binding: { id: 'catching-engine', version: '1', codecVersion: 1 }, run: async (_input, host) => {
      try { await host.invoke({ id: 'w', name: 'obsidian__write', arguments: '{}' }); } catch { /* SDKs may catch all tool exceptions. */ }
      return { content: 'claimed success' };
    } };
    const s = fixture('catching-engine', undefined, { 'catching-engine': definition });
    await s.chat.getHistory(); await s.runtime.initialize();
    const id = await s.runtime.start('work', { sessionId: s.chat.getSessionInfo().sessionId, messages: [], maxTurns: 5, enableSkills: true });
    await s.runtime.wait(id);
    expect(s.runtime.get(id)?.status).toBe('waiting_for_approval'); expect(s.effect).not.toHaveBeenCalled();
    expect(s.runtime.get(id)?.messages.some(message => message.content === 'claimed success')).toBe(false);
  });
});
