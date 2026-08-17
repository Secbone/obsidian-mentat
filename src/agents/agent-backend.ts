import type { ChatMessage } from '../types';
import type { AgentEvent } from './agent-types';

/** One chat interaction (session-incremental). */
export interface AgentChatInput {
  sessionId: string;
  messages: ChatMessage[];
  signal?: AbortSignal;
  config?: Record<string, unknown>;
}

/** Backend capability description, probed by UI and configuration layers. */
export interface AgentBackendCapabilities {
  supportsStreaming: boolean;
  supportsCancellation: boolean;
  /** Whether the backend manages its own tools/skills. */
  supportsSkills: boolean;
  maxContextTokens?: number;
}

/**
 * The unified contract for "one chat backend" (RFC §3.1). Both the embedded
 * in-process agent and (later) delegated external agents implement this, so
 * the UI and session layer depend only on the interface.
 */
export interface AgentBackend {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: AgentBackendCapabilities;

  /** Stream a chat interaction; yields AgentEvent, returns the final response. */
  streamChat(input: AgentChatInput): AsyncGenerator<AgentEvent>;

  onSessionStart?(sessionId: string): void | Promise<void>;
  onSessionEnd?(sessionId: string): void | Promise<void>;

  /** Release backend-held resources (external process handles, subscriptions). */
  dispose(): void | Promise<void>;
}
