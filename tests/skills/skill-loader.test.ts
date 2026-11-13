import { describe, expect, it } from 'vitest';
import { SkillLoader } from '../../src/skills/core/skill-loader';
import { isDocumentationSkill, isExecutableSkill } from '../../src/skills/skill-types';
import type { SkillContext } from '../../src/skills/skill-types';
import type { App } from 'obsidian';

async function load(manifest: string) {
  const root = '.obsidian/plugins/mentat/skills';
  const files = new Map([
    [`${root}/example/SKILL.md`, manifest],
    [`${root}/example/implementation.js`, 'function execute(input) { return { success: true, data: input }; }'],
  ]);
  const app = { vault: { configDir: '.obsidian', adapter: {
    exists: async (path: string) => path === root || files.has(path),
    list: async () => ({ folders: [`${root}/example`], files: [] }),
    read: async (path: string) => files.get(path)!,
  } } } as unknown as App;
  return new SkillLoader(app).loadAllSkills({ vault: app.vault } as SkillContext);
}
const manifest = (metadata: string) => `---\nname: custom_example\ndescription: "Example: custom"\n${metadata}\n---\n# Instructions\n`;

describe('SkillLoader manifest contract', () => {
  it('retains nested YAML metadata and a custom skill approval requirement', async () => {
    const skills = await load(manifest('metadata:\n  executable: true\n  requiresConfirmation: true\n  tags: [local, test]\n  version: "2.0"'));
    expect(skills).toHaveLength(1);
    expect(skills[0].metadata).toMatchObject({ requiresConfirmation: true, tags: ['local', 'test'], version: '2.0' });
    expect(skills[0].description).toBe('Example: custom');
    expect(isExecutableSkill(skills[0])).toBe(true);
  });
  it('defaults custom executable skills to confirmation while retaining explicit false', async () => {
    const [defaultSkill] = await load(manifest(''));
    const [explicitSkill] = await load(manifest('metadata:\n  requiresConfirmation: false'));
    expect(defaultSkill.metadata).toMatchObject({ requiresConfirmation: true });
    expect(explicitSkill.metadata).toMatchObject({ requiresConfirmation: false });
  });
  it('honors documentation-only manifests instead of loading implementation.js', async () => {
    const [skill] = await load(manifest('metadata:\n  executable: false\n  tags:\n    - guide'));
    expect(isDocumentationSkill(skill)).toBe(true);
    expect(skill.metadata?.tags).toEqual(['guide']);
    expect('execute' in skill).toBe(false);
  });
  it.each([
    'metadata:\n  requiresConfirmation: "false"',
    'metadata:\n  executable: "false"',
    'metadata:\n  requiresConfirmation: [true]',
    'metadata: [invalid]',
    'metadata:\n  tags: [unclosed',
  ])('rejects invalid policy metadata without loading executable code', async metadata => {
    expect(await load(manifest(metadata))).toEqual([]);
  });
  it('accepts CRLF manifests and preserves block descriptions', async () => {
    const [skill] = await load('---\r\nname: custom_example\r\ndescription: >-\r\n  A multiline\r\n  description\r\nmetadata:\r\n  requiresConfirmation: true\r\n---\r\nInstructions');
    expect(skill.description).toBe('A multiline description');
    expect(skill.metadata).toMatchObject({ requiresConfirmation: true });
  });
});
