import { describe, it, expect, beforeEach } from 'vitest';
import { execute, schema } from '../../../skills/run-command/scripts/index';
import { SkillContext } from '../../../src/skills/skill-types';

describe('Run-Command Skill', () => {
  let mockContext: SkillContext;

  beforeEach(() => {
    mockContext = {
      vault: {
        adapter: {
          getBasePath: () => '/mock/vault/root'
        }
      } as any,
      metadataCache: {} as any,
      workspace: {} as any,
      indexManager: {} as any,
      plugin: {} as any
    };
  });

  it('should reject blacklisted commands like rm', async () => {
    const input = schema.parse({
      command: 'rm -rf /some/file'
    });

    const result = await execute(input, mockContext);

    expect(result.success).toBe(false);
    expect(result.error).toContain('blocked high-risk keyword \'rm\'');
  });

  it('should reject command combinations containing sudo', async () => {
    const input = schema.parse({
      command: 'sudo apt-get install git'
    });

    const result = await execute(input, mockContext);

    expect(result.success).toBe(false);
    expect(result.error).toContain('blocked high-risk keyword \'sudo\'');
  });

  it('should reject vault sandbox escape attempts', async () => {
    const input = schema.parse({
      command: 'ls -la',
      cwd: '../../outside-vault'
    });

    const result = await execute(input, mockContext);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Sandbox Violation');
  });
});
