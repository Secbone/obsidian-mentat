import { throwIfAborted } from '../../../src/utils/execution';
// Run Terminal Command Skill Implementation
// Core logic for executing system terminal commands in a explicitly authorized host context

import { z } from 'zod';
import { SkillContext, SkillResult } from '../../../src/skills/skill-types';
import { fromToolOutcome } from '../../../src/skills/results';

/**
 * Skill metadata
 */
export const metadata = {
  name: 'run_command',
  description: 'Execute authorized host shell commands with the vault as the working directory',
  version: '1.0.0',
  tags: ['terminal', 'execution', 'automation'],
  performance: 'medium',
  requiresConfirmation: true,
  executionCategory: 'external',
  permissions: ['external'],
  category: 'system-operations'
};

/**
 * Input schema
 */
export const schema = z.object({
  command: z.string().describe('The system shell command to execute (e.g. git status, python script.py, grep -rn "text")'),
  cwd: z.string().optional().describe('Optional subdirectory path inside the vault to run the command in'),
  timeout: z.number().default(30000).describe('Execution timeout in milliseconds (default: 30000)')
});

export type Input = z.infer<typeof schema>;

/** Execute only through the explicitly injected host command driver. */
export async function execute(input:Input,context:SkillContext):Promise<SkillResult>{
  throwIfAborted(context.abortSignal);
  if(!context.commands)return {success:false,outcome:'denied',error:'宿主未启用命令执行能力'};
  return fromToolOutcome(await context.commands.execute(input,context.abortSignal));
}
