import { describe, it, expect } from 'vitest';
import { TFile } from 'obsidian';
import { Context } from '../../src/core/cordis';
import { ObsidianPlatformPlugin } from '../../src/platform/platform.service';
import type { DocumentStore, GraphCapability, SearchCapability } from '../../src/platform/contracts';

/** In-memory vault mock with the Obsidian API surface the platform uses. */
function createMockPlugin() {
  const files = new Map<string, { content: string; mtime: number; ctime: number; size: number }>();

  const mkFile = (path: string, content = '') => {
    const now = Date.now();
    files.set(path, { content, mtime: now, ctime: now, size: content.length });
  };
  mkFile('Research/Paper.md', '# Paper\n[[Other]]\n#tag');
  mkFile('Research/Other.md', 'other note');
  mkFile('Inbox/Todo.md', '- [ ] task');

  const vault = {
    configDir: 'vault/.obsidian',
    getMarkdownFiles: () => [...files.keys()].filter((p) => p.endsWith('.md')).map((path) => {
      const [name, extension] = [path.split('/').pop()!.replace(/\.md$/, ''), 'md'];
      const f = files.get(path)!;
      const t = new TFile();
      Object.assign(t, { path, basename: name, extension, stat: { mtime: f.mtime, ctime: f.ctime, size: f.size }, parent: path.includes('/') ? { path: path.split('/').slice(0, -1).join('/') } : null });
      return t;
    }),
    getAbstractFileByPath: (path: string) => {
      if (!files.has(path)) return null;
      const [name, extension] = [path.split('/').pop()!.replace(/\.md$/, ''), 'md'];
      const f = files.get(path)!;
      const t = new TFile();
      Object.assign(t, { path, basename: name, extension, stat: { mtime: f.mtime, ctime: f.ctime, size: f.size }, parent: null });
      return t;
    },
    read: async (file: { path: string }) => files.get(file.path)?.content ?? '',
    create: async (path: string, content: string) => { mkFile(path, content); },
    modify: async (file: { path: string }, content: string) => { files.set(file.path, { ...files.get(file.path)!, content, size: content.length, mtime: Date.now() }); },
    delete: async (file: { path: string }) => { files.delete(file.path); },
    rename: async (file: { path: string }, to: string) => { const f = files.get(file.path); if (f) { files.delete(file.path); files.set(to, f); } },
    adapter: {
      exists: async (p: string) => files.has(p) || [...files.keys()].some((k) => k.startsWith(p)),
      read: async (p: string) => files.get(p)?.content ?? '',
      write: async (p: string, c: string) => mkFile(p, c),
      remove: async (p: string) => { files.delete(p); },
      mkdir: async () => {},
      list: async (p: string) => ({ files: [...files.keys()].filter((k) => k.startsWith(p)), folders: [] }),
    },
    search: async (q: string) => [...files.keys()].filter((p) => p.toLowerCase().includes(q.toLowerCase())).map((p) => ({ file: { path: p }, match: { context: files.get(p)!.content.slice(0, 20) }, score: 1 })),
    on: () => ({ ref: 1 }),
    offref: () => {},
  };

  const metadataCache = {
    getFileCache: (file: { path: string }) => {
      if (file.path === 'Research/Paper.md') return { tags: [{ tag: '#tag' }], frontmatter: { title: 'Paper' } };
      return null;
    },
    getBacklinksForFile: () => ({ 'Research/Other.md': { link: { path: 'Research/Other.md' }, context: { text: 'refers' } } }),
    resolvedLinks: { 'Research/Paper.md': { 'Research/Other.md': 1 } },
  };

  const workspace = {
    getActiveFile: () => {
      const t = new TFile();
      Object.assign(t, { path: 'Research/Paper.md', basename: 'Paper', extension: 'md', stat: { mtime: 1, ctime: 1, size: 1 }, parent: null });
      return t;
    },
    on: () => ({ ref: 1 }),
    offref: () => {},
  };

  const plugin = {
    app: { vault, metadataCache, workspace },
    manifest: { id: 'mentat' },
    loadData: async () => ({ key: 'value' }),
    saveData: async () => {},
  };
  return plugin;
}

describe('Platform layer (L1): obsidian implementation', () => {
  it('provides all six service names when mounted', async () => {
    const ctx = new Context();
    ctx.provide('mentatPlugin', createMockPlugin() as never);
    await ctx.plugin(ObsidianPlatformPlugin);

    for (const name of ['documents', 'search', 'storage', 'graph', 'workspace', 'ui']) {
      expect(ctx.get(name, false)).toBeTruthy();
    }
  });

  it('documents: list/read/write/exists roundtrip', async () => {
    const ctx = new Context();
    ctx.provide('mentatPlugin', createMockPlugin() as never);
    await ctx.plugin(ObsidianPlatformPlugin);

    const documents = ctx.get<DocumentStore>('documents', false)!;
    const docs = documents.listDocuments();
    expect(docs.length).toBe(3);
    expect(docs.map((d) => d.path)).toContain('Research/Paper.md');

    const paper = documents.getDocument('Research/Paper.md')!;
    expect((await documents.readDocument(paper)).startsWith('# Paper')).toBe(true);

    await documents.writeDocument('New/Note.md', 'hello');
    expect(await documents.exists('New/Note.md')).toBe(true);
    expect(documents.getDocument('New/Note.md')).toBeTruthy();
  });

  it('search delegates to the host full-text search', async () => {
    const ctx = new Context();
    ctx.provide('mentatPlugin', createMockPlugin() as never);
    await ctx.plugin(ObsidianPlatformPlugin);

    const search = ctx.get<SearchCapability>('search', false)!;
    const results = await search.search('todo');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].path.toLowerCase()).toContain('todo');
  });

  it('graph exposes tags/backlinks/frontmatter', async () => {
    const ctx = new Context();
    ctx.provide('mentatPlugin', createMockPlugin() as never);
    await ctx.plugin(ObsidianPlatformPlugin);

    const graph = ctx.get<GraphCapability>('graph', false)!;
    expect(graph.getTags('Research/Paper.md')).toEqual(['tag']);
    expect(graph.getFrontmatter('Research/Paper.md')).toEqual({ title: 'Paper' });
    expect(graph.getBacklinks('Research/Paper.md').length).toBe(1);
    expect(graph.getLinks('Research/Paper.md')).toContain('Research/Other.md');
  });

  it('unloading the context recovers all platform services', async () => {
    const ctx = new Context();
    ctx.provide('mentatPlugin', createMockPlugin() as never);
    await ctx.plugin(ObsidianPlatformPlugin);
    expect(ctx.get('documents', false)).toBeTruthy();

    await ctx.fiber.dispose();
    for (const name of ['documents', 'search', 'storage', 'graph', 'workspace', 'ui']) {
      expect(ctx.get(name, false)).toBeUndefined();
    }
  });
});
