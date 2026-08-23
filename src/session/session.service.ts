import type { PluginObject, Context } from '../core/cordis';
import type { AgentBackend } from '../agents/agent-backend';
import type { AgentEvent } from '../agents/agent-types';
import type { ChatMessage } from '../types';
import type { AgentModeRegistry } from '../agents/agent-mode';
import { EMBEDDED_MODE } from '../agents/agent-mode';
import { createSession, type SessionHandle } from '../chat/session';

export interface SessionSendInput {
  messages: ChatMessage[];
  signal?: AbortSignal;
}

/**
 * Session service (L3.5): manages chat sessions — creation with an isolated
 * scope context, backend resolution from the mode registry, history, streaming
 * send, abort and dispose. Backed by the existing createSession primitive
 * (M6), wrapped as a context service so the UI and external consumers depend
 * on one stable interface.
 */
export class SessionService {
  private sessions = new Map<string, SessionHandle>();

  constructor(
    private rootCtx: Context,
    private modes: AgentModeRegistry,
  ) {}

  create(sessionId: string, modeId = EMBEDDED_MODE): SessionHandle {
    const handle = createSession(this.rootCtx, sessionId, modeId, this.modes);
    this.sessions.set(sessionId, handle);
    return handle;
  }

  get(sessionId: string): SessionHandle | undefined {
    return this.sessions.get(sessionId);
  }

  list(): string[] {
    return [...this.sessions.keys()];
  }

  /** Stream a chat over a session's backend. */
  async *send(sessionId: string, input: SessionSendInput): AsyncGenerator<AgentEvent> {
    const handle = this.get(sessionId);
    if (!handle) throw new Error(`session "${sessionId}" not found`);
    yield* handle.backend.streamChat({ sessionId, messages: input.messages, signal: input.signal });
  }

  async dispose(sessionId: string): Promise<void> {
    const handle = this.sessions.get(sessionId);
    if (!handle) return;
    await handle.dispose();
    this.sessions.delete(sessionId);
  }

  async disposeAll(): Promise<void> {
    for (const id of [...this.sessions.keys()]) await this.dispose(id);
  }
}

export const SessionServicePlugin: PluginObject = {
  inject: ['modes'],
  apply(ctx: Context) {
    const modes = ctx.get<AgentModeRegistry>('modes')!;
    const service = new SessionService(ctx, modes);
    return ctx.provide('session', service);
  },
};
