// Meta-tools - spec and invoke definitions

import { OpenAIFunction, AnthropicTool } from './skill-types';

/**
 * Get the spec tool definition
 */
export function getSpecTool(format: 'openai' | 'anthropic'): OpenAIFunction | AnthropicTool {
  const description =
    'Get detailed parameter specification for a skill, including parameters, examples, and usage notes. ' +
    'Call this before using a skill for the first time to understand its parameters and behavior.';

  const schema = {
    type: 'object' as const,
    properties: {
      skill_name: {
        type: 'string',
        description: 'Full skill name in format "namespace:skill_name" (e.g., "obsidian:query_notes")'
      }
    },
    required: ['skill_name']
  };

  if (format === 'openai') {
    return {
      name: 'spec',
      description,
      parameters: schema
    };
  } else {
    return {
      name: 'spec',
      description,
      input_schema: schema
    };
  }
}

/**
 * Get the invoke tool definition
 */
export function getInvokeTool(format: 'openai' | 'anthropic'): OpenAIFunction | AnthropicTool {
  const description =
    'Execute a skill with the given parameters. ' +
    'You must get the skill spec first using spec to understand its parameters, ' +
    'unless you have already loaded it in this conversation.';

  const schema = {
    type: 'object' as const,
    properties: {
      skill_name: {
        type: 'string',
        description: 'Full skill name in format "namespace:skill_name" (e.g., "obsidian:query_notes")'
      },
      params: {
        type: 'object',
        description: 'Skill-specific parameters as defined in the skill specification. ' +
                    'The structure depends on the skill - use spec first to see what parameters are required.',
        additionalProperties: true
      }
    },
    required: ['skill_name', 'params']
  };

  if (format === 'openai') {
    return {
      name: 'invoke',
      description,
      parameters: schema
    };
  } else {
    return {
      name: 'invoke',
      description,
      input_schema: schema
    };
  }
}

/**
 * Parameters for spec
 */
export interface SpecParams {
  skill_name: string;
}

/**
 * Parameters for invoke
 */
export interface InvokeParams {
  skill_name: string;
  params: Record<string, unknown>;
}

/**
 * Check if a tool call is spec
 */
export function isSpecCall(toolName: string): boolean {
  return toolName === 'spec';
}

/**
 * Check if a tool call is invoke
 */
export function isInvokeCall(toolName: string): boolean {
  return toolName === 'invoke';
}
