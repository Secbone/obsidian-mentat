import { describe, it, expect } from 'vitest';
import { buildStreamMessages } from '../../src/agents/chat-messages';
import type { ChatMessage } from '../../src/types';

describe('buildStreamMessages (user prompt → agent-loop input)', () => {
  it('always includes the new user message — even with no history (regression: 400 Empty input messages)', () => {
    const out = buildStreamMessages(undefined, 'hello');
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe('user');
    expect(out[0].content).toBe('hello');
    expect(typeof out[0].timestamp).toBe('number');
  });

  it('appends the user message after existing history, preserving order', () => {
    const history: ChatMessage[] = [
      { role: 'user', content: 'first', timestamp: 1 },
      { role: 'assistant', content: 'reply', timestamp: 2 },
    ];
    const out = buildStreamMessages(history, 'second');
    expect(out).toHaveLength(3);
    expect(out[0].content).toBe('first');
    expect(out[1].content).toBe('reply');
    expect(out[2]).toMatchObject({ role: 'user', content: 'second' });
  });

  it('does not mutate the input history array', () => {
    const history: ChatMessage[] = [{ role: 'user', content: 'x', timestamp: 1 }];
    const copy = [...history];
    buildStreamMessages(history, 'y');
    expect(history).toEqual(copy);
  });
});
