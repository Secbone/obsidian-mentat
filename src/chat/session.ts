import type { Context } from '../core/cordis';
import { AgentModeRegistry, EMBEDDED_MODE } from '../agents/agent-mode';
import type { AgentBackend } from '../agents/agent-backend';

/** A live session handle: the scope context plus its resolved backend. */
export interface SessionHandle {
  sessionId: string;
  ctx: Context;
  backend: AgentBackend;
  dispose(): Promise<void>;
}

/**
 * Create one agent session on the given root context. Each session gets its
 * own isolated scope context (realm) and resolves its backend from the mode
 * registry, so multiple sessions run in parallel without interfering
 * (RFC §3.3 / docs M6).
 */
export function createSession(
  rootCtx: Context,
  sessionId: string,
  modeId: string = EMBEDDED_MODE,
  registry: AgentModeRegistry,
): SessionHandle {
  const sessionCtx = rootCtx.isolate('agent');
  const descriptor = registry.get(modeId) ?? registry.get(EMBEDDED_MODE);
  if (!descriptor) {
    throw new Error(`no agent mode registered for "${modeId}" (and no embedded fallback)`);
  }
  const backend = descriptor.createBackend({ ctx: sessionCtx, sessionId });
  void backend.onSessionStart?.(sessionId);
  return {
    sessionId,
    ctx: sessionCtx,
    backend,
    dispose: async () => {
      await backend.onSessionEnd?.(sessionId);
      await backend.dispose();
    },
  };
}
