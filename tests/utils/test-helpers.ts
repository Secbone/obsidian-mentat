import { SkillContext } from '@/skills/skill-types';
import { Plugin } from 'obsidian';

export function createMockSkillContext(overrides?: Partial<SkillContext>): SkillContext {
  const defaultSettings = {
    browserlessApiKey: '',
    ...(overrides?.plugin as any)?.settings
  };

  return {
    plugin: {
      settings: defaultSettings,
      app: {} as any,
      manifest: {} as any,
      loadData: async () => ({}),
      saveData: async () => {},
      ...(overrides?.plugin || {})
    } as Plugin
  } as SkillContext;
}

export function createMockResponse(status: number, text: string, headers: Record<string, string> = {}) {
  return {
    status,
    text,
    headers,
    arrayBuffer: new ArrayBuffer(0),
    json: {}
  };
}
