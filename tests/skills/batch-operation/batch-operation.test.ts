import { describe, expect, it, vi } from 'vitest';
import { parseYaml, TFile } from 'obsidian';
import { execute, schema } from '../../../skills/batch-operation/scripts';
import type { SkillContext } from '../../../src/skills/skill-types';

function fixture(initial: Record<string, string>) {
  const contents = new Map(Object.entries(initial));
  const files = [...contents.keys()].map(path => Object.assign(new TFile(), { path }));
  const modify = vi.fn(async (file: TFile, content: string) => { contents.set(file.path, content); });
  const context = {
    vault: {
      getMarkdownFiles: () => files,
      getAbstractFileByPath: (path: string) => files.find(file => file.path === path),
      read: async (file: TFile) => contents.get(file.path)!,
      modify,
    },
    metadataCache: { getFileCache: () => ({}) },
  } as unknown as SkillContext;
  const run = (input: Record<string, unknown>) => execute(schema.parse(input), context);
  return { contents, modify, run };
}
const tagsInput = { operation: 'add-tags', filter: {}, params: { tags: ['new'] } };
const frontmatter = (content: string) => parseYaml(content.split('---')[1]);

describe('batch_operation write integrity', () => {
  it('retains nested metadata, inline tags, scalar types and the complete body', async () => {
    const f = fixture({ 'Notes/a.md': '---\ntitle: "A: title"\ntags: [old, research]\nconfig:\n  enabled: true\n  count: 3\n---\nBody\n\n# Keep this\n' });
    const result = await f.run(tagsInput);
    expect(result.success).toBe(true);
    expect(frontmatter(f.contents.get('Notes/a.md')!)).toEqual({ title: 'A: title', tags: ['old', 'research', 'new'], config: { enabled: true, count: 3 } });
    expect(f.contents.get('Notes/a.md')).toMatch(/---\nBody\n\n# Keep this\n$/);
  });
  it('preserves unrelated YAML when removing tags or updating frontmatter', async () => {
    const f = fixture({ 'a.md': '---\ntags: [old, keep]\nconfig: {nested: [1, 2]}\n---\nBody' });
    await f.run({ operation: 'remove-tags', filter: {}, params: { tags: ['old'] } });
    await f.run({ operation: 'update-frontmatter', filter: {}, params: { updates: { title: 'Updated' } } });
    expect(frontmatter(f.contents.get('a.md')!)).toEqual({ tags: ['keep'], config: { nested: [1, 2] }, title: 'Updated' });
  });
  it('supports CRLF and existing scalar tags without discarding old tags', async () => {
    const f = fixture({ 'a.md': '---\r\ntags: old, research\r\n---\r\nBody\r\n' });
    await f.run(tagsInput);
    expect(frontmatter(f.contents.get('a.md')!).tags).toEqual(['old', 'research', 'new']);
    expect(f.contents.get('a.md')).toMatch(/Body\r\n$/);
  });
  it('matches complete folder boundaries, including a trailing slash', async () => {
    const f = fixture({ 'Notes/a.md': 'body', 'Notes/sub/b.md': 'body', 'Notes-backup/a.md': 'body' });
    const result = await f.run({ ...tagsInput, filter: { folders: ['Notes/'] } });
    expect(result.data?.filesModified).toEqual(['Notes/a.md', 'Notes/sub/b.md']);
    expect(f.contents.get('Notes-backup/a.md')).toBe('body');
  });
  it('reports failure when all writes fail, preserving per-file evidence', async () => {
    const f = fixture({ 'a.md': 'body' });
    f.modify.mockRejectedValue(new Error('disk unavailable'));
    const result = await f.run(tagsInput);
    expect(result.success).toBe(false);
    expect(result.outcome).toBe('failure');
    expect(result.data?.filesModified).toEqual([]);
    expect(result.data?.errors).toEqual([{ path: 'a.md', error: 'disk unavailable' }]);
  });
  it('does not call a partially failed batch a success', async () => {
    const f = fixture({ 'a.md': 'body', 'b.md': 'body' });
    f.modify.mockRejectedValueOnce(new Error('first failed'));
    const result = await f.run(tagsInput);
    expect(result.success).toBe(false);
    expect(result.data?.filesModified).toEqual(['b.md']);
    expect(result.error).toContain('1 changed');
  });
  it.each(['---\nconfig: [broken\n---\nBody', '---\n- sequence\n---\nBody', '---\ntags: [old]\nBody'])('refuses malformed or non-mapping frontmatter without writing', async content => {
    const f = fixture({ 'a.md': content });
    const result = await f.run(tagsInput);
    expect(result.success).toBe(false);
    expect(f.modify).not.toHaveBeenCalled();
    expect(f.contents.get('a.md')).toBe(content);
  });
  it('keeps dry run free of writes', async () => {
    const f = fixture({ 'a.md': 'body' });
    const result = await f.run({ ...tagsInput, dryRun: true });
    expect(result.success).toBe(true);
    expect(f.modify).not.toHaveBeenCalled();
    expect(result.metadata?.filesModified).toEqual([]);
  });
});
