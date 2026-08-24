import type { Context } from '../core/cordis';
import type { ToolDefinition } from '../tools/contract';
import type { ToolsRegistry } from '../tools/tools.service';
import type { EventBridgeService } from '../events/event-bridge.service';
import type { PermissionService } from '../external/permissions.service';
import type { AgentEvent } from '../agents/agent-types';

export interface ExtensionContext {
  id: string;
  name: string;
  description: string;
}

/**
 * Host-agnostic extension API (L4.5): the surface a third-party extension
 * sees. No Obsidian types; services are accessed via a whitelist (get),
 * tools register reversibly, events flow through the kernel-backed bridge.
 */
export interface ExtensionAPIV2 {
  readonly context: ExtensionContext;
  registerTool(tool: ToolDefinition): () => void;
  on(event: string, handler: (event: AgentEvent) => void): () => void;
  get<T = unknown>(service: string): T | undefined;
  getSettings(): Record<string, unknown>;
}

export type ExtensionFactoryV2 = (
  api: ExtensionAPIV2,
  ctx: Context,
) => void | Promise<void> | (() => void | Promise<void>);

export interface ExtensionRegistrationV2 {
  id: string;
  name: string;
  description: string;
  factory: ExtensionFactoryV2;
}

/** Whitelist of service names an extension may read via get(). */
const ALLOWED_SERVICES = ['tools', 'permissions', 'context-window'] as const;

/**
 * Extension host (L4.5): loads extension factories and hands each a
 * host-agnostic API. Tool registration and event subscription are reversible
 * and lifecycle-managed (disposed with the extension's fiber). Loading is an
 * effect, so unloading the host recovers every extension.
 */
export class ExtensionHostV2 {
  private extensions = new Map<string, { api: ExtensionAPIV2; dispose: () => void }>();
  private ctx: Context;

  constructor(
    private tools: ToolsRegistry,
    private events: EventBridgeService,
    ctx: Context,
  ) {
    this.ctx = ctx;
  }

  async register(reg: ExtensionRegistrationV2): Promise<() => void> {
    if (this.extensions.has(reg.id)) throw new Error(`extension "${reg.id}" already registered`);
    const api: ExtensionAPIV2 = {
      context: { id: reg.id, name: reg.name, description: reg.description },
      registerTool: (tool) => this.tools.register(tool),
      on: (event, handler) => this.events.on(event, handler),
      get: <T,>(service: string) => {
        if (!ALLOWED_SERVICES.includes(service as never)) {
          throw new Error(`service "${service}" is not in the extension allowlist`);
        }
        return this.ctx.get<T>(service, false);
      },
      getSettings: () => (this.ctx.get('settings', false) ?? {}) as Record<string, unknown>,
    };
    const disposal = await reg.factory(api, this.ctx);
    const dispose = typeof disposal === 'function' ? disposal : () => {};
    this.extensions.set(reg.id, { api, dispose });
    return () => { dispose(); this.extensions.delete(reg.id); };
  }

  unregister(id: string): void {
    const ext = this.extensions.get(id);
    if (ext) { ext.dispose(); this.extensions.delete(id); }
  }

  list(): string[] { return [...this.extensions.keys()]; }
  has(id: string): boolean { return this.extensions.has(id); }
}

export const ExtensionHostV2Plugin = (): ((ctx: Context) => () => void) => {
  return (ctx: Context) => {
    const tools = ctx.get<ToolsRegistry>('tools', false)!;
    const events = ctx.get<EventBridgeService>('event-bridge')!;
    const host = new ExtensionHostV2(tools, events, ctx);
    ctx.provide('extensions-v2', host);
    return () => {
      for (const id of [...host.list()]) host.unregister(id);
    };
  };
};

export { ALLOWED_SERVICES };
