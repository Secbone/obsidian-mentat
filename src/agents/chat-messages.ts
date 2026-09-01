import type { ChatMessage } from '../types';

/**
 * Build the message list sent to the agent-loop for a new user prompt.
 *
 * The agent-loop runs on the exact list it is given — it does NOT append the
 * new user message itself. Callers MUST include it here, otherwise the model
 * is invoked with an empty (or stale) history, which DeepSeek rejects with
 * "400 Empty input messages".
 *
 * Extracted as a pure helper so the UI's send path is unit-testable.
 */
export function buildStreamMessages(history: ChatMessage[] | undefined, userMessage: string): ChatMessage[] {
  return [
    ...(history ?? []),
    { role: 'user', content: userMessage, timestamp: Date.now() },
  ];
}
