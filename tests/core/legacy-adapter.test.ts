import { describe, it, expect, vi } from 'vitest';
import { adaptLegacyProvider } from '../../src/llm/legacy-adapter';
import type { LLMToolDefinition } from '../../src/llm/contract';
import type { ChatMessage } from '../../src/types';

const msg: ChatMessage = { role: 'user', content: 'hi', timestamp: 1 };

describe('adaptLegacyProvider — tools passthrough', () => {
  it('forwards options.tools to the legacy source as skills (regression: tools never sent)', async () => {
    const generateStreamWithSkills = vi.fn(async (_m: unknown, _cb: unknown, _ot: unknown, options: { skills?: unknown[] }) => ({
      content: 'ok', toolCalls: [],
    }));
    const source = {
      id: 'x', name: 'X',
      supportsSkills: () => true,
      generateStreamWithSkills,
      generate: async () => '',
      generateStream: async () => {},
      isAvailable: async () => true,
      getContextWindow: () => 8000,
      getCompactionThreshold: () => 6000,
    };
    const adapted = adaptLegacyProvider(source);
    const tool: LLMToolDefinition = { name: 'vault_read', description: 'd', parameters: { type: 'object', properties: {} } };

    const result = await adapted.generateWithTools([msg], () => {}, { tools: [tool] });

    expect(generateStreamWithSkills).toHaveBeenCalledTimes(1);
    const optionsArg = generateStreamWithSkills.mock.calls[0][3] as { skills?: unknown[] };
    expect(optionsArg.skills).toEqual([
      { name: 'vault_read', description: 'd', parameters: { type: 'object', properties: {} } },
    ]);
    expect(result.content).toBe('ok');
  });

  it('sends no skills when options.tools is empty', async () => {
    const generateStreamWithSkills = vi.fn(async () => ({ content: '', toolCalls: [] }));
    const source = {
      id: 'x', name: 'X', supportsSkills: () => true, generateStreamWithSkills,
      generate: async () => '', generateStream: async () => {},
      isAvailable: async () => true, getContextWindow: () => 8000, getCompactionThreshold: () => 6000,
    };
    const adapted = adaptLegacyProvider(source);
    await adapted.generateWithTools([msg], () => {}, { tools: [] });
    const optionsArg = generateStreamWithSkills.mock.calls[0][3] as { skills?: unknown[] };
    expect(optionsArg.skills).toEqual([]);
  });
});
