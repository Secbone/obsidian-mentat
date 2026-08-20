import { describe, it, expect, vi } from 'vitest';
import { Context } from '../../src/core/cordis';
import { KnowledgeService, KnowledgeServicePlugin } from '../../src/knowledge/knowledge.service';
import { LLMRegistry } from '../../src/llm/llm.service';
import type { DocumentStore, Doc } from '../../src/platform/contracts';
import type { LLMProvider } from '../../src/llm/contract';

function makeDoc(path: string): Doc {
  return { path, name: path.split('/').pop()!, extension: 'md', stat: { mtime: 1, size: 1, ctime: 1 }, parent: null };
}

function mockDocuments(contents: Record<string, string>): DocumentStore {
  return {
    listDocuments: () => Object.keys(contents).map(makeDoc),
    getDocument: (p) => (p in contents ? makeDoc(p) : null),
    readDocument: async (d) => contents[d.path] ?? '',
    writeDocument: async () => {}, moveDocument: async () => {}, deleteDocument: async () => {},
    exists: async () => false, mkdir: async () => {}, list: async () => ({ files: [], folders: [] }),
  };
}

/** Deterministic TF-ish embedding so relevance is testable. */
function tfEmbed(text: string): number[] {
  const vocab = ['ai', 'retrieval', 'notes', 'research', 'coding'];
  return text.toLowerCase().split(/\W+/).map((w) => (vocab.indexOf(w) >= 0 ? 1 : 0));
}

describe('KnowledgeService (L2.3)', () => {
  it('indexes documents and retrieves relevant chunks by semantic query', async () => {
    const docs = mockDocuments({
      'Research/AI.md': 'AI retrieval notes\nsemantic search for AI',
      'Dev/Other.md': 'some coding unrelated text',
    });
    const ctx = new Context();
    ctx.provide('documents', docs);
    const registry = new LLMRegistry();
    const embedProvider: LLMProvider = {
      id: 'mock-embed', name: 'Mock', capabilities: { chat: false, streaming: false, embeddings: true, tools: false },
      generate: async () => '', generateStream: async () => {},
      embed: async (texts) => texts.map(tfEmbed),
      getContextWindow: () => 8000, getCompactionThreshold: () => 6000, isAvailable: async () => true,
    };
    registry.register(embedProvider);
    ctx.provide('llm', registry);

    await ctx.plugin(KnowledgeServicePlugin);
    const knowledge = ctx.get<KnowledgeService>('knowledge', false)!;
    await knowledge.indexDocuments();

    expect(knowledge.getStats().indexedDocuments).toBe(2);

    const results = await knowledge.search('AI retrieval', 3, 0);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].path).toBe('Research/AI.md');
  });

  it('KnowledgeServicePlugin unload recovers the service', async () => {
    const ctx = new Context();
    ctx.provide('documents', mockDocuments({ 'a.md': 'x' }));
    ctx.provide('llm', new LLMRegistry());
    await ctx.plugin(KnowledgeServicePlugin);
    expect(ctx.get('knowledge', false)).toBeTruthy();
    await ctx.fiber.dispose();
    expect(ctx.get('knowledge', false)).toBeUndefined();
  });
});
