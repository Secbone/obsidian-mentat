import type { PluginObject, Context } from '../../core/cordis';
import type { ToolsRegistry } from '../../tools/tools.service';
import type { ToolDefinition } from '../../tools/contract';

/** Minimal MCP server config (host-agnostic, by URL/command). */
export interface McpServerConfig {
  name: string;
  /** Connect via URL transport (http/sse) or local command. */
  transport: 'stdio' | 'http';
  url?: string;
  command?: string;
  args?: string[];
}

/**
 * MCP client bridge (L2.8): connects external MCP servers and exposes their
 * tools on the `tools` registry. Each MCP tool becomes a `ToolDefinition`
 * (with explicit permission declaration), so the agent loop and MCP-powered
 * delegated agents share one tool surface. Connections are reversible effects
 * (disconnected on unload).
 */
export class McpClientService {
  private connections = new Map<string, { disconnect: () => Promise<void> }>();

  constructor(private tools: ToolsRegistry, private connectFn?: (cfg: McpServerConfig) => Promise<{ listTools(): Promise<Array<{ name: string; description: string }>>; call(name: string, args: unknown): Promise<unknown>; disconnect(): Promise<void> }>) {}

  async connect(cfg: McpServerConfig): Promise<void> {
    if (this.connections.has(cfg.name)) return;
    const client = await this.connectFn?.(cfg);
    if (!client) throw new Error(`mcp-client: no transport for ${cfg.name}`);
    const tools = await client.listTools();
    const disposers = tools.map((t) => this.tools.register({
      name: t.name,
      description: t.description,
      permissions: ['documents:read'], // external tools default to read; narrowed by L4 permissions
      execute: async (input) => {
        try {
          const data = await client.call(t.name, input);
          return { success: true, data };
        } catch (err) {
          return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
    } as ToolDefinition));
    this.connections.set(cfg.name, {
      disconnect: async () => {
        disposers.forEach((d) => d());
        await client.disconnect();
      },
    });
  }

  async disconnect(name: string): Promise<void> {
    const conn = this.connections.get(name);
    if (!conn) return;
    await conn.disconnect();
    this.connections.delete(name);
  }

  async disconnectAll(): Promise<void> {
    for (const name of [...this.connections.keys()]) await this.disconnect(name);
  }
}

export const McpClientServicePlugin: PluginObject = {
  inject: ['tools'],
  apply(ctx: Context) {
    const tools = ctx.get<ToolsRegistry>('tools')!;
    const service = new McpClientService(tools);
    return ctx.provide('mcp-client', service);
  },
};
