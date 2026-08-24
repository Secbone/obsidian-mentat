import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Context } from '../../src/core/cordis';
import { HeadlessPlatform } from '../../src/platform/headless/headless-platform';
import { LLMRegistry } from '../../src/llm/llm.service';
import { ToolsService } from '../../src/tools/tools.service';
import { VaultToolsPlugin } from '../../src/tools/vault/vault-tools';
import { ContextWindowServicePlugin } from '../../src/session/context.service';
import { CompactionServicePlugin } from '../../src/session/compaction.service';
import { AgentLoopServicePlugin } from '../../src/agents/loop.service';
import { AgentModeRegistry, EMBEDDED_MODE } from '../../src/agents/agent-mode';
import { EmbeddedBackend } from '../../src/agents/backends/embedded.backend';
import { createSession } from '../../src/chat/session';
import type { LLMProvider } from '../../src/llm/contract';

/**
 * L5.3 dual-form validation: the SAME core layer (llm/tools/knowledge/
 * agent-loop/session) runs over the headless platform — no Obsidian. Proves
 * the architecture is host-agnostic end-to-end (a real agent turn over fs).
 */
describe('L5.3 headless end-to-end (no Obsidian)', () => {
  it('runs a full agent conversation over the headless platform', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mentat-e2e-'));
    mkdirSync(join(root, 'notes'));
    writeFileSync(join(root, 'notes/hello.md'), '# Hello\nworld note');
    const platform = new HeadlessPlatform(root, root);

    const ctx = new Context();
    // core services over the headless platform
    ctx.provide('documents', platform.documents);
    ctx.provide('search', platform.search);
    ctx.provide('storage', platform.storage);

    // llm (mock chat + tools)
    const llm = new LLMRegistry();
    llm.register({
      id: 'mock', name: 'Mock', capabilities: { chat: true, streaming: true, embeddings: false, tools: true },
      generate: async () => 'done',
      generateStream: async () => {},
      generateWithTools: async (_m, onChunk) => {
        onChunk?.({ delta: 'reading ' });
        return { content: 'reading hello.md', toolCalls: [{ id: 't', name: 'vault_read', arguments: { path: 'notes/hello.md' } }] };
      },
      getContextWindow: () => 8000, getCompactionThreshold: () => 6000, isAvailable: async () => true,
    } as LLMProvider);
    ctx.provide('llm', llm);

    // tools over headless documents
    await ctx.plugin(ToolsService);
    await ctx.plugin(VaultToolsPlugin);
    // window + compaction + agent-loop
    await ctx.plugin(ContextWindowServicePlugin);
    await ctx.plugin(CompactionServicePlugin);
    await ctx.plugin(AgentLoopServicePlugin);

    // modes registry + embedded backend created from headless ctx
    const modes = new AgentModeRegistry();
    modes.register({ id: EMBEDDED_MODE, displayName: 'E', description: '', createBackend: ({ ctx: c, sessionId }) => new EmbeddedBackend(c, { sessionId }) });
    ctx.provide('modes', modes);

    const session = createSession(ctx, 's1', EMBEDDED_MODE, modes);
    const events: string[] = [];
    for await (const ev of session.backend.streamChat({ sessionId: 's1', messages: [{ role: 'user', content: 'read hello', timestamp: 1 }] })) {
      events.push(ev.type);
    }
    expect(events).toContain('agent:start');
    expect(events).toContain('tool:start');
    expect(events).toContain('tool:end');
    expect(events).toContain('turn:end');
    await session.dispose();
  }, 20000);
});
