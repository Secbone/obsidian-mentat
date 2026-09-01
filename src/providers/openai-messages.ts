import type { ChatMessage } from '../types';

/**
 * OpenAI-style message param shape (structural — avoids importing the OpenAI
 * SDK just for the type, keeping this module testable in isolation).
 */
export interface OpenAIMessageParam {
  role: 'user' | 'assistant' | 'tool' | 'system' | 'function';
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
}

/**
 * Convert ChatMessage[] to OpenAI format.
 *
 * Filters out system messages (defensive — the system prompt is passed via
 * options, not the message array). Ensures tool_calls / tool response pairing
 * integrity required by OpenAI-compatible APIs (DeepSeek rejects broken pairs
 * with 400). Handles two kinds of orphans caused by message truncation:
 *   1. orphan tool messages (tool response with no preceding assistant that
 *      declared the tool_call) -> folded into a user message to preserve
 *      context without rejecting the API call.
 *   2. orphan assistant tool_calls (declared but responses missing) -> sent as
 *      a plain assistant message.
 *
 * Extracted as a pure function so pairing/truncation edge cases are unit
 * tested without a live provider.
 */
export function convertToOpenAIMessages(messages: ChatMessage[]): OpenAIMessageParam[] {
  const filtered = messages.filter((msg) => msg.role !== 'system');

  // Pre-scan: collect all tool_call_ids that have tool responses.
  const respondedToolCallIds = new Set<string>();
  for (const msg of filtered) {
    if (msg.role === 'tool' && msg.tool_call_id) {
      respondedToolCallIds.add(msg.tool_call_id);
    }
  }

  const seenToolCallIds = new Set<string>();
  const result: OpenAIMessageParam[] = [];

  for (const msg of filtered) {
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        seenToolCallIds.add(tc.id);
      }
      const validToolCalls = msg.tool_calls.filter((tc) => respondedToolCallIds.has(tc.id));
      if (validToolCalls.length > 0) {
        result.push({
          role: 'assistant',
          content: msg.content || null,
          tool_calls: validToolCalls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: {
              name: tc.name,
              arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments),
            },
          })),
        });
      } else {
        result.push({ role: 'assistant', content: msg.content || '' });
      }
    } else if (msg.role === 'tool') {
      if (!msg.tool_call_id || !seenToolCallIds.has(msg.tool_call_id)) {
        // Orphan tool message — fold into a user message to keep context.
        result.push({
          role: 'user',
          content: `[Tool Result${msg.name ? ` (${msg.name})` : ''}]: ${msg.content}`,
        });
      } else {
        result.push({ role: 'tool', content: msg.content, tool_call_id: msg.tool_call_id });
      }
    } else {
      result.push({ role: msg.role, content: msg.content });
    }
  }

  return result;
}
