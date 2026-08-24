import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { HeadlessPlatform } from '../../src/platform/headless/headless-platform';
import type { DocumentStore, SearchCapability } from '../../src/platform/contracts';

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'mentat-headless-'));
  mkdirSync(join(root, 'Research'));
  writeFileSync(join(root, 'Research/AI.md'), '# AI\nsemantic retrieval notes');
  writeFileSync(join(root, 'Inbox.md'), 'a todo note');
  return root;
}

describe('HeadlessPlatform (L5.2)', () => {
  it('provides documents over the filesystem', () => {
    const root = makeRoot();
    const platform = new HeadlessPlatform(root, root);
    const docs = platform.documents.listDocuments();
    expect(docs.length).toBeGreaterThanOrEqual(2);
    expect(docs.map((d) => d.path)).toContain(join('Research', 'AI.md').replace(/\\/g, '/'));
  });

  it('reads a document, search finds content', async () => {
    const root = makeRoot();
    const platform = new HeadlessPlatform(root, root);
    const doc = platform.documents.getDocument('Research/AI.md')!;
    expect((await platform.documents.readDocument(doc)).startsWith('# AI')).toBe(true);

    const res = await platform.search.search('semantic');
    expect(res.length).toBeGreaterThan(0);
  });

  it('does NOT provide optional capabilities (graph/workspace/ui absent)', () => {
    const root = makeRoot();
    const platform = new HeadlessPlatform(root, root);
    expect(platform.graph).toBeUndefined();
    expect(platform.workspace).toBeUndefined();
    expect(platform.ui).toBeUndefined();
  });
});
