import { describe, it, expect } from 'vitest';
import { SkillLoaderV2 } from '../../src/skills/skill-loader-v2';
import type { DocumentStore, Doc } from '../../src/platform/contracts';

const SKILLS: Record<string, string> = {
  'skills/query-notes/SKILL.md': '---\nname: query-notes\ndescription: Search notes\n---\n# Query Notes\n',
  'skills/markdown/SKILL.md': '---\ndescription: Markdown docs\n---\n# Markdown\n',
};

function makeDoc(path: string): Doc {
  return { path, name: path.split('/').pop()!, extension: 'md', stat: { mtime: 1, size: 1, ctime: 1 }, parent: null };
}

const documents: DocumentStore = {
  listDocuments: () => Object.keys(SKILLS).map(makeDoc),
  getDocument: (p) => (p in SKILLS ? makeDoc(p) : null),
  readDocument: async (d) => SKILLS[d.path] ?? '',
  writeDocument: async () => {}, moveDocument: async () => {}, deleteDocument: async () => {},
  exists: async (p) => p in SKILLS,
  mkdir: async () => {},
  list: async (dir) => ({
    folders: ['skills/query-notes', 'skills/markdown'].filter((f) => f.startsWith(dir)),
    files: [],
  }),
};

describe('SkillLoaderV2 (L2.7)', () => {
  it('loads skills from SKILL.md over the documents contract', async () => {
    const loader = new SkillLoaderV2(documents);
    const skills = await loader.loadFromDirectory('skills');
    expect(skills.length).toBe(2);
    const names = skills.map((s) => s.name);
    expect(names).toContain('query-notes');
    // directory-name fallback when meta.name absent
    expect(names).toContain('markdown');
  });
});
