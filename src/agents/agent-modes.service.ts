import type { PluginObject, Context } from '../core/cordis';
import { AgentModeRegistry, EMBEDDED_MODE } from './agent-mode';
import { EmbeddedBackend } from './backends/embedded.backend';

/**
 * Host service: provides the agent-mode registry and registers the built-in
 * `embedded` mode. Sessions resolve their backend through this service; UI
 * and settings can enumerate available modes via `ctx.get('agentModes')`.
 */
export const AgentModesService: PluginObject = {
  apply(ctx: Context) {
    const registry = new AgentModeRegistry();
    registry.register({
      id: EMBEDDED_MODE,
      displayName: '内置 Agent',
      description: '进程内 RAGP agent（现有能力）',
      createBackend: ({ ctx: sessionCtx, sessionId }) => new EmbeddedBackend(sessionCtx, { sessionId }),
    });
    ctx.provide('agentModes', registry);
    ctx.provide('modes', registry);   // canonical L3 name used by the session service
  },
};
