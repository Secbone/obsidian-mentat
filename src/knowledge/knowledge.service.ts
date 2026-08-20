import type { PluginObject, Context } from '../core/cordis';
import type { DocumentStore } from '../platform/contracts';
import type { LLMRegistry } from '../llm/llm.service';
import type { Doc } from '../platform/contracts';

export interface RetrievalResult {
  path: string;
  snippet: string;
  score: number;
}

export interface KnowledgeStats {
  indexedDocuments: number;
  totalChunks: number;
}

interface Chunk { path: string; text: string; embedding: number[]; }

/**
 * Knowledge service (L2.3): document indexing + semantic retrieval, built
 * purely on the host-agnostic `documents` platform contract and the `llm`
 * registry (embedding provider). No host types; no dependency on the legacy
 * indexing subsystem.
 *
 * This is a v1 in-memory embedding index; a persistent vector store can
 * replace `index`/`search` later without changing the contract.
 */
export class KnowledgeService {
  private chunks: Chunk[] = [];
  private indexedPaths = new Set<string>();

  constructor(
    private documents: DocumentStore,
    private llm: LLMRegistry,
  ) {}

  async indexDocuments(paths?: string[]): Promise<void> {
    const docs = paths
      ? paths.map((p) => this.documents.getDocument(p)!).filter(Boolean)
      : this.documents.listDocuments();
    for (const doc of docs) {
      await this.indexDocument(doc);
    }
  }

  async indexDocument(doc: Doc): Promise<void> {
    if (this.indexedPaths.has(doc.path)) return;
    const text = await this.documents.readDocument(doc);
    // Simple chunking: split on blank lines, cap length.
    const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    const inline = await this.embedAll(paragraphs.length ? paragraphs : [text]);
    this.chunks = this.chunks.filter((c) => c.path !== doc.path);
    paragraphs.forEach((p, i) => {
      this.chunks.push({ path: doc.path, text: p, embedding: inline[i] ?? [] });
    });
    this.indexedPaths.add(doc.path);
  }

  async search(query: string, topK = 5, minScore = 0.3): Promise<RetrievalResult[]> {
    const provider = this.llm.resolve('embedding');
    if (!provider?.embed) return [];
    const queryVec = (await provider.embed([query]))[0] ?? [];
    const scored = this.chunks
      .map((c) => ({ ...c, score: cosine(queryVec, c.embedding) }))
      .filter((c) => c.score >= minScore && c.embedding.length > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
    return scored.map((c) => ({ path: c.path, snippet: c.text.slice(0, 200), score: c.score }));
  }

  getStats(): KnowledgeStats {
    return { indexedDocuments: this.indexedPaths.size, totalChunks: this.chunks.length };
  }

  private async embedAll(texts: string[]): Promise<number[][]> {
    const provider = this.llm.resolve('embedding');
    if (!provider?.embed) return texts.map(() => []);
    return provider.embed(texts);
  }
}

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export const KnowledgeServicePlugin: PluginObject = {
  inject: ['documents', 'llm'],
  apply(ctx: Context) {
    const documents = ctx.get<DocumentStore>('documents')!;
    const llm = ctx.get<LLMRegistry>('llm')!;
    const knowledge = new KnowledgeService(documents, llm);
    return ctx.provide('knowledge', knowledge);
  },
};
