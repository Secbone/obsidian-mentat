import { describe, it, expect } from 'vitest';
import { convertToOpenAIMessages } from '../../src/providers/openai-messages';
import type { ChatMessage, ToolCall } from '../../src/types';

function u(content: string): ChatMessage { return { role: 'user', content, timestamp: 1 }; }
function a(content: string, tool_calls?: ToolCall[]): ChatMessage { return { role: 'assistant', content, timestamp: 1, tool_calls }; }
function t(content: string, name: string, tool_call_id: string): ChatMessage {
  return { role: 'tool', content, name, tool_call_id, timestamp: 1 };
}

describe('convertToOpenAIMessages — message pairing for OpenAI-compatible APIs', () => {
  it('passes plain user/assistant messages through unchanged', () => {
    const out = convertToOpenAIMessages([u('hi'), a('hello')]);
    expect(out).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]);
  });

  it('drops system messages (they are passed via options, not the array)', () => {
    const out = convertToOpenAIMessages([
      { role: 'system', content: 'sys', timestamp: 1 },
      u('hi'),
    ]);
    expect(out.map((m) => m.role)).toEqual(['user']);
  });

  it('keeps a properly paired assistant tool_calls + tool response', () => {
    const tc: ToolCall = { id: 'call_1', name: 'vault_read', arguments: { path: 'a.md' } };
    const out = convertToOpenAIMessages([u('read'), a('', [tc]), t('{"content":"file"}', 'vault_read', 'call_1')]);
    expect(out).toEqual([
      { role: 'user', content: 'read' },
      {
        role: 'assistant', content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'vault_read', arguments: '{"path":"a.md"}' } }],
      },
      { role: 'tool', content: '{"content":"file"}', tool_call_id: 'call_1' },
    ]);
  });

  it('folds an ORPHAN tool message into a user message to avoid a 400 rejection', () => {
    // Tool response with no preceding assistant that declared the call.
    const out = convertToOpenAIMessages([u('read'), t('{"content":"file"}', 'vault_read', 'call_missing')]);
    expect(out).toEqual([
      { role: 'user', content: 'read' },
      { role: 'user', content: '[Tool Result (vault_read)]: {"content":"file"}' },
    ]);
  });

  it('sends orphan assistant tool_calls as a plain assistant message when responses are missing', () => {
    const tc: ToolCall = { id: 'call_orphan', name: 'vault_read', arguments: {} };
    const out = convertToOpenAIMessages([u('read'), a('thinking', [tc])]);
    expect(out).toEqual([
      { role: 'user', content: 'read' },
      { role: 'assistant', content: 'thinking' }, // no tool_calls wrapper
    ]);
  });

  it('only keeps the tool_calls that actually have matching responses', () => {
    const ok: ToolCall = { id: 'call_ok', name: 'a', arguments: {} };
    const missing: ToolCall = { id: 'call_missing', name: 'b', arguments: {} };
    const out = convertToOpenAIMessages([
      u('go'),
      a('', [ok, missing]),
      t('res', 'a', 'call_ok'),
    ]);
    const assistant = out.find((m) => m.role === 'assistant');
    expect(assistant?.tool_calls?.map((tc) => tc.id)).toEqual(['call_ok']);
  });

  it('stringifies object-form tool arguments', () => {
    const tc: ToolCall = { id: 'c', name: 'x', arguments: { nested: { a: 1 } } };
    const out = convertToOpenAIMessages([a('', [tc]), t('res', 'x', 'c')]);
    expect(out[0].tool_calls![0].function.arguments).toBe('{"nested":{"a":1}}');
  });

  it('keeps string-form tool arguments as-is', () => {
    const tc: ToolCall = { id: 'c', name: 'x', arguments: '{"raw":"str"}' };
    const out = convertToOpenAIMessages([a('', [tc]), t('res', 'x', 'c')]);
    expect(out[0].tool_calls![0].function.arguments).toBe('{"raw":"str"}');
  });
});
