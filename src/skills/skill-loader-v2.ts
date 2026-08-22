import type { DocumentStore } from '../platform/contracts';
import type { SkillDefinition } from './skill-types';

/** Parsed frontmatter from a SKILL.md file. */
interface SkillMeta {
  name?: string;
  description?: string;
  [key: string]: unknown;
}

function parseFrontmatter(text: string): { meta: SkillMeta; body: string } {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { meta: {}, body: text };
  const meta: SkillMeta = {};
  for (const line of m[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx > 0) meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return { meta, body: text.slice(m[0].length) };
}

/**
 * Host-agnostic skill loader (L2.7): loads skills from a directory over the
 * platform-agnostic `documents` contract — no Obsidian adapter. Skills are
 * discovered as `<dir>/SKILL.md`; the directory name becomes the skill name
 * when the meta has none. This complements the legacy SkillLoader (which
 * stays for the current chat pipeline) and feeds the new tools/skills layer.
 */
export class SkillLoaderV2 {
  constructor(private documents: DocumentStore) {}

  async loadFromDirectory(dir: string): Promise<SkillDefinition[]> {
    const paths = await this.listSkillFiles(dir);
    const skills: SkillDefinition[] = [];
    for (const rel of paths) {
      try {
        const text = await this.readSkill(rel);
        const { meta } = parseFrontmatter(text);
        const name = meta.name ?? stripSkillSuffix(rel);
        skills.push({
          name,
          namespace: 'custom',
          description: meta.description ?? '',
          schema: undefined as never,
          execute: async () => ({ success: true, data: { content: text } }),
        } as never);
      } catch (error) {
        console.error(`[SkillLoaderV2] failed to load ${rel}:`, error);
      }
    }
    return skills;
  }

  private async listSkillFiles(dir: string): Promise<string[]> {
    const list = await this.documents.list(dir);
    const out: string[] = [];
    for (const folder of list.folders) {
      const full = folder.startsWith(dir) ? folder : `${dir}/${folder}`;
      const skillPath = `${full}/SKILL.md`.replace(/\/+/g, '/');
      if (await this.documents.exists(skillPath)) out.push(skillPath);
    }
    return out;
  }

  private async readSkill(rel: string): Promise<string> {
    const file = await this.documents.getDocument(rel);
    if (!file) throw new Error(`skill not found: ${rel}`);
    return this.documents.readDocument(file);
  }
}

function stripSkillSuffix(path: string): string {
  // The skill name is the directory containing SKILL.md, e.g.
  // 'skills/query-notes/SKILL.md' -> 'query-notes'.
  const dir = path.replace(/SKILL\.md$/i, '').replace(/\/$/, '');
  const base = dir.split('/').pop() ?? 'skill';
  return base.replace(/_/g, '-');
}
