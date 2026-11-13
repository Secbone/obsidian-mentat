import { SkillContext } from '@/skills/skill-types';

export function createMockSkillContext(overrides?: Partial<SkillContext> & {plugin?:any}): SkillContext {
  return {files:{} as any,metadataCache:{} as any,...overrides,settings:{browserlessApiKey:'',...overrides?.plugin?.settings,...overrides?.settings}} as SkillContext;
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
