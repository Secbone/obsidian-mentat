import { describe, it, expect } from 'vitest';
import { Context } from '../../src/core/cordis';
import { ToolsService, ToolsRegistry } from '../../src/tools/tools.service';
import { VaultToolsPlugin } from '../../src/tools/vault/vault-tools';
import type { DocumentStore, Doc, SearchCapability } from '../../src/platform/contracts';

function makeDoc(path: string): Doc {
  return { path, name: path.split('/').pop()!, extension: 'md', stat: { mtime: 1, size: 1, ctime: 1 }, parent: null };
}

const contents: Record<string, string> = {
  'Research/AI.md': '# AI retrieval\nnotes about semantic search',
  'Dev/Code.md': 'plain code text',
};

const documents: DocumentStore = {
  listDocuments: () => Object.keys(contents).map(makeDoc),
  getDocument: (p) => (p in contents ? makeDoc(p) : null),
  readDocument: async (d) => contents[d.path] ?? '',
  writeDocument: async (path, content) => { contents[path] = content; },
  moveDocument: async () => {}, deleteDocument: async () => {},
  exists: async (p) => p in contents, mkdir: async () => {}, list: async () => ({ files: [], folders: [] }),
};

const search: SearchCapability = {
  search: async (q) => Object.keys(contents).filter((p) => p.includes(q)).map((p) => ({ path: p })),
};

describe('VaultTools (L2.5)', () => {
  async function setup() {
    const ctx = new Context();
    ctx.provide('documents', documents);
    ctx.provide('search', search);
    await ctx.plugin(ToolsService);
    await ctx.plugin(VaultToolsPlugin);
    return { ctx, registry: ctx.get<ToolsRegistry>('tools', false)! };
  }

  it('registers the four vault tools', async () => {
    const { registry } = await setup();
    for (const n of ['vault_read', 'vault_write', 'vault_list', 'vault_search']) {
      expect(registry.get(n)).toBeTruthy();
    }
  });

  it('executes vault_read and vault_write against documents', async () => {
    const { registry } = await setup();
    const read = await registry.execute('vault_read', { path: 'Research/AI.md' }, { documents });
    expect(read).toMatchObject({ success: true });
    expect((read as { data: { content: string } }).data.content).toContain('semantic search');

    await registry.execute('vault_write', { path: 'New/Note.md', content: 'hello' }, { documents });
    expect(contents['New/Note.md']).toBe('hello');
  });

  it('executes vault_search via the search capability', async () => {
    const { registry } = await setup();
    const res = await registry.execute('vault_search', { query: 'Research' }, { search });
    expect(res).toMatchObject({ success: true });
    expect((res as { data: Array<{ path: string }> }).data).toContainEqual({ path: 'Research/AI.md' });
  });

  it('unloading the plugin unregisters all vault tools', async () => {
    const ctx = new Context();
    const registry = new ToolsRegistry();
    ctx.provide('tools', registry);
    const fiber = ctx.plugin(VaultToolsPlugin);
    await fiber;
    expect(registry.get('vault_read')).toBeTruthy();
    await fiber.dispose();
    for (const n of ['vault_read', 'vault_write', 'vault_list', 'vault_search']) {
      expect(registry.get(n)).toBeUndefined();
    }
  });
});
