import { describe, it, expect } from 'vitest';
import { VAULT_TOOLS } from '../../src/tools/vault/vault-tools';
import { WEB_TOOLS } from '../../src/tools/web/web-tools';

describe('capability tools — input schemas advertised to the model', () => {
  const all = [...VAULT_TOOLS, ...WEB_TOOLS];

  it('every tool declares a zod schema so the model knows its required parameters', () => {
    for (const tool of all) {
      expect(tool.schema, `tool "${tool.name}" must declare a zod schema`).toBeDefined();
    }
  });

  it('vault_read requires a path; vault_search requires a query', async () => {
    const read = VAULT_TOOLS.find((t) => t.name === 'vault_read')!;
    const search = VAULT_TOOLS.find((t) => t.name === 'vault_search')!;
    expect(read.schema!.safeParse({ path: 'a.md' }).success).toBe(true);
    expect(read.schema!.safeParse({}).success).toBe(false); // path required
    expect(search.schema!.safeParse({ query: 'hello' }).success).toBe(true);
    expect(search.schema!.safeParse({}).success).toBe(false); // query required
  });

  it('vault_list accepts an optional dir', async () => {
    const list = VAULT_TOOLS.find((t) => t.name === 'vault_list')!;
    expect(list.schema!.safeParse({}).success).toBe(true);
    expect(list.schema!.safeParse({ dir: 'notes' }).success).toBe(true);
  });
});

describe('assembly-level: real tools advertised to the provider', () => {
  it('the full vault tool set reaches the provider with non-empty parameter schemas', async () => {
    const { AgentLoopService } = await import('../../src/agents/loop.service');
    const { ToolsRegistry } = await import('../../src/tools/tools.service');
    const { ContextWindowService } = await import('../../src/session/context.service');
    const { CompactionService, SummarizeCompactionStrategy } = await import('../../src/session/compaction.service');
    const { LLMRegistry } = await import('../../src/llm/llm.service');
    const { z } = await import('zod');
    const type = (await import('../../src/types')) as { ChatMessage: unknown };

    // Register the REAL production tools.
    const tools = new ToolsRegistry();
    for (const t of [...VAULT_TOOLS, ...WEB_TOOLS]) tools.register(t as never);

    let received: { name: string; parameters?: Record<string, unknown> }[] | undefined;
    const provider = {
      id: 'p', name: 'P', capabilities: { chat: true, streaming: true, embeddings: false, tools: true },
      generate: async () => '',
      generateStream: async () => {},
      generateWithTools: async (_m: unknown, _c: unknown, options: { tools?: unknown }) => {
        received = options?.tools as { name: string; parameters?: Record<string, unknown> }[];
        return { content: 'ok', toolCalls: undefined };
      },
      getContextWindow: () => 8000, getCompactionThreshold: () => 6000, isAvailable: async () => true,
    };
    const llm = new LLMRegistry();
    llm.register(provider as never);
    const window = new ContextWindowService();
    const loop = new AgentLoopService(llm, tools, window, new CompactionService(window));
    loop['compaction'].register(new SummarizeCompactionStrategy());
    const msg = { role: 'user' as const, content: 'list docs', timestamp: Date.now() };

    for await (const _e of loop.run([msg], {}, new AbortController().signal)) { /* drain */ }

    const byName = new Map((received ?? []).map((t) => [t.name, t]));
    // The model MUST see a required `query` on vault_search / web_search, and
    // a required `path` on vault_read / vault_write.
    for (const name of ['vault_search', 'web_search']) {
      const params = byName.get(name)?.parameters as { required?: string[]; properties?: Record<string, unknown> } | undefined;
      expect(params, `tool ${name} should carry parameters`).toBeDefined();
      expect(params!.required).toContain('query');
      expect(params!.properties).toHaveProperty('query');
    }
    for (const name of ['vault_read', 'vault_write']) {
      const params = byName.get(name)?.parameters as { required?: string[]; properties?: Record<string, unknown> } | undefined;
      expect(params, `tool ${name} should carry parameters`).toBeDefined();
      expect(params!.required).toContain('path');
    }
  });
});
