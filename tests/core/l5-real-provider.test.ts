import { describe, it, expect } from 'vitest';
import { Context } from '../../src/core/cordis';
import { LLMRegistry } from '../../src/llm/llm.service';
import { adaptLegacyProvider } from '../../src/llm/legacy-adapter';
import { OpenAIProvider } from '../../src/providers/openai-provider';
import { ToolsRegistry } from '../../src/tools/tools.service';
import { ContextWindowService } from '../../src/session/context.service';
import { CompactionService, SummarizeCompactionStrategy } from '../../src/session/compaction.service';
import { AgentLoopService } from '../../src/agents/loop.service';
import { AgentModeRegistry, EMBEDDED_MODE } from '../../src/agents/agent-mode';
import { EmbeddedBackend } from '../../src/agents/backends/embedded.backend';
import { createSession } from '../../src/chat/session';

const KEY = process.env.DEEPSEEK_KEY || '';

describe('L5 real-provider integration (DeepSeek via new architecture)', () => {
  it('runs a chat through session -> agent-loop -> DeepSeek', async () => {
    const ctx = new Context();
    const llm = new LLMRegistry();
    const provider = new OpenAIProvider({
      id: 'deepseek', apiKey: KEY, baseURL: 'https://api.deepseek.com', model: 'deepseek-v4-flash',
      maxTokens: 128,
    } as never);
    llm.register(adaptLegacyProvider(provider as never));
    ctx.provide('llm', llm);
    ctx.provide('tools', new ToolsRegistry());
    ctx.provide('context-window', new ContextWindowService());
    const compaction = new CompactionService(new ContextWindowService()); compaction.register(new SummarizeCompactionStrategy());
    ctx.provide('compaction', compaction);
    ctx.provide('agent-loop', new AgentLoopService(llm, new ToolsRegistry(), new ContextWindowService(), compaction));

    const modes = new AgentModeRegistry();
    modes.register({ id: EMBEDDED_MODE, displayName: 'E', description: '', createBackend: ({ ctx: c, sessionId }) => new EmbeddedBackend(c, { sessionId }) });
    ctx.provide('modes', modes);

    const session = createSession(ctx, 's-real', EMBEDDED_MODE, modes);
    const events: string[] = [];
    for await (const ev of session.backend.streamChat({ sessionId: 's-real', messages: [{ role: 'user', content: '回复"OK"两个字即可', timestamp: Date.now() }] })) {
      events.push(ev.type);
    }
    console.log('REAL EVENTS:', JSON.stringify(events));
    expect(events).toContain('agent:start');
    expect(events).toContain('message:update');
    expect(events).toContain('agent:end');
    await session.dispose();
  }, 30000);
});
