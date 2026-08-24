import type { PluginObject, Context } from '../../core/cordis';
import type { AgentModeDescriptor } from '../../agents/agent-mode';
import type { AgentModeRegistry } from '../../agents/agent-mode';
import type { AgentBackend } from '../../agents/agent-backend';
import type { McpServerService } from '../mcp-server/mcp-server.service';

/**
 * A delegated-external-agent adapter: implements an AgentBackend that forwards
 * the conversation to an external agent (Claude Code / OpenCode / DSH), and
 * (optionally) points that agent at Mentat's mcp-server for vault access.
 */
export interface DelegatedAdapter {
  readonly id: string;              // e.g. 'delegated:claude-code'
  readonly displayName: string;
  readonly description: string;
  /** Create the external-agent backend for a session. */
  createBackend(ctx: Context, options: { sessionId?: string }): Promise<AgentBackend>;
}

/**
 * Delegated framework (L4.4): registers external-agent modes into the modes
 * registry. Each adapter contributes an AgentModeDescriptor whose createBackend
 * is an external backend (delegated). The mcp-server is available so external
 * agents can call Mentat's vault tools.
 *
 * This is the extensibility seam: a new external agent = one DelegatedAdapter
 * registration.
 */
export class DelegatedService {
  private adapters = new Map<string, DelegatedAdapter>();

  constructor(private modes: AgentModeRegistry) {}

  /** Register an external-agent adapter, exposing it as a mode. Returns unregister. */
  register(adapter: DelegatedAdapter): () => void {
    if (this.adapters.has(adapter.id)) throw new Error(`delegated adapter "${adapter.id}" already registered`);
    this.adapters.set(adapter.id, adapter);
    const descriptor: AgentModeDescriptor = {
      id: adapter.id,
      displayName: adapter.displayName,
      description: adapter.description,
      requiresVaultServer: true,
      createBackend: (modeCtx) => new LazyBackend(adapter, modeCtx.ctx, { sessionId: modeCtx.sessionId }),
    };
    const unregisterMode = this.modes.register(descriptor);
    return () => { unregisterMode(); this.adapters.delete(adapter.id); };
  }

  list(): DelegatedAdapter[] { return [...this.adapters.values()]; }
  get(id: string): DelegatedAdapter | undefined { return this.adapters.get(id); }
}

/**
 * Lazy delegated backend: defers connecting the external agent until the
 * first streamChat (since the modes contract expects a synchronous backend,
 * but external-agent connection is async).
 */
class LazyBackend implements AgentBackend {
  private inner?: AgentBackend;

  constructor(
    private adapter: DelegatedAdapter,
    private ctx: Context,
    private options: { sessionId?: string },
  ) {}

  get id(): string { return this.adapter.id; }
  get displayName(): string { return this.adapter.displayName; }
  get capabilities(): AgentBackend['capabilities'] {
    return { supportsStreaming: true, supportsCancellation: true, supportsSkills: true };
  }

  private async ensureInner(): Promise<AgentBackend> {
    if (!this.inner) this.inner = await this.adapter.createBackend(this.ctx, this.options);
    return this.inner;
  }

  async *streamChat(input: Parameters<AgentBackend['streamChat']>[0]) {
    const inner = await this.ensureInner();
    yield* inner.streamChat(input);
  }

  async onSessionStart(sessionId: string) { return (await this.ensureInner()).onSessionStart?.(sessionId); }
  async onSessionEnd(sessionId: string) { return (await this.ensureInner()).onSessionEnd?.(sessionId); }
  async dispose() { return (await this.ensureInner()).dispose(); }
}

export const DelegatedServicePlugin: PluginObject = {
  inject: ['modes'],
  apply(ctx: Context) {
    const modes = ctx.get<AgentModeRegistry>('modes')!;
    const service = new DelegatedService(modes);
    return ctx.provide('delegated', service);
  },
};
