// Ask User Skill Implementation
// Allows the AI to ask the user questions when uncertain

import { z } from 'zod';
import { SkillContext, SkillResult } from '../../../src/skills/skill-types';
import { RunSuspended, RunBlocked } from '../../../src/runtime/types';
import { throwIfAborted } from '../../../src/utils/execution';

/**
 * Skill metadata
 */
export const metadata = {
  name: 'ask_user',
  description: 'Ask user a question to get clarification or guidance',
  version: '1.0.0',
  tags: ['interaction', 'guidance', 'clarification'],
  performance: 'fast',
  executionCategory: 'interaction',
  permissions: ['read'],
  category: 'user-interaction'
};

/**
 * Input schema for ask_user
 */
export const schema = z.object({
  question: z.string().describe('The question to ask the user'),
  context: z.string().optional().describe('Optional context about why asking'),
  options: z.array(z.string()).optional().describe('Optional predefined choices'),
  defaultValue: z.string().optional().describe('Optional default answer'),
  requiresInput: z.boolean().default(true).describe('Whether empty response is allowed')
});

export type Input = z.infer<typeof schema>;

/**
 * Execute ask_user skill
 */
export async function execute(
  input: Input,
  context: SkillContext
): Promise<SkillResult> {
  try {
    throwIfAborted(context.abortSignal);
    if (context.runtime && context.operationId) {
      const outcome = await context.runtime.interact({ id: `${context.operationId}:question`, operationId: context.operationId, kind: 'question', ...input });
      if (outcome.kind !== 'answered') return { success: false, outcome: outcome.kind === 'expired' ? 'expired' : 'cancelled', error: '人工问答已结束' };
      return { success: true, outcome: 'success', data: { answer: outcome.answer, timestamp: Date.now() } };
    }
    if(!context.askUser)return {success:false,outcome:'denied',error:'宿主未提供人工交互能力'};
    const response=await context.askUser(input);
    if(response.kind!=='answered')return {success:false,outcome:response.kind==='expired'?'expired':'cancelled',error:'人工问答已结束'};
    const answer=response.answer||'';

    return {
      success: true,
      data: {
        answer,
        timestamp: Date.now(),
        selectedOption: input.options?.find(opt => opt === answer)
      }
    };
  } catch (error) {
    if (error instanceof RunSuspended || error instanceof RunBlocked) throw error;
    console.error('[AskUser] Error:', error);
    return {
      success: false,
      error: (error as Error).message || 'User cancelled or error occurred'
    };
  }
}

/**
 * Factory function for backward compatibility
 */
export function createSkill(context: SkillContext) {
  return {
    schema,
    execute: (input: Input) => execute(input, context)
  };
}
