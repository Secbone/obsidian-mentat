// Ask User Skill Implementation
// Allows the AI to ask the user questions when uncertain

import { z } from 'zod';
import { SkillContext, SkillResult } from '../../../src/skills/skill-types';
import { UserInputModal } from '../../../src/ui/user-input-modal';

/**
 * Skill metadata
 */
export const metadata = {
  name: 'ask_user',
  description: 'Ask user a question to get clarification or guidance',
  version: '1.0.0',
  tags: ['interaction', 'guidance', 'clarification'],
  performance: 'fast',
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
    // Create and show modal - this returns a Promise that blocks until user responds
    const answer = await new Promise<string>((resolve, reject) => {
      const modal = new UserInputModal(
        context.plugin.app,
        input.question,
        input.context,
        input.options,
        input.defaultValue,
        input.requiresInput,
        (result) => {
          if (result.cancelled) {
            reject(new Error('User cancelled the request'));
          } else {
            resolve(result.answer);
          }
        }
      );
      modal.open();
    });

    return {
      success: true,
      data: {
        answer,
        timestamp: Date.now(),
        selectedOption: input.options?.find(opt => opt === answer)
      }
    };
  } catch (error) {
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
