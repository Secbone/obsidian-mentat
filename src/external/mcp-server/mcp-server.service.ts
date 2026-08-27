import type { PluginObject, Context } from '../../core/cordis';
import type { ToolsRegistry } from '../../tools/tools.service';
import type { MCPToolDefinition, MCPToolsListResponse, MCPToolCallResponse } from '../../skills/mcp/mcp-types';
import type { ZodTypeAny } from 'zod';
import type { Logger, LoggerService } from '../../logger/logger.service';

/**
 * MCP server (L4.3): exposes the tools registry over the MCP protocol so
 * external agents (delegated mode) can call Mentat's vault/document abilities.
 *
 * `listTools()` maps registered ToolDefinitions to MCPToolDefinitions (zod
 * schema -> inputSchema); `callTool()` executes a tool through the registry
 * (which enforces permissions) and wraps the result as an MCP response.
 * Transport (stdio/http) is the caller's concern; this service is the
 * protocol-neutral tool surface.
 */
export class McpServerService {
  constructor(private tools: ToolsRegistry, private logger?: Logger) {}

  listTools(): MCPToolsListResponse {
    const list: MCPToolDefinition[] = this.tools.list().map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: schemaToInputSchema(t.schema as ZodTypeAny | undefined),
    }));
    return { jsonrpc: '2.0', method: 'tools/list', result: { tools: list } } as unknown as MCPToolsListResponse;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<MCPToolCallResponse> {
    try {
      const result = (await this.tools.execute(name, args, {})) as { success?: boolean; data?: unknown; error?: string };
      const ok = result?.success !== false;
      return { jsonrpc: '2.0', method: 'tools/call', result: { content: [{ type: 'text', text: JSON.stringify(result?.data ?? result) }], isError: !ok } } as unknown as MCPToolCallResponse;
    } catch (err) {
      this.logger?.error(`mcp callTool ${name} failed`, { tool: name, error: err instanceof Error ? err.message : String(err) });
      return { jsonrpc: '2.0', method: 'tools/call', result: { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true } } as unknown as MCPToolCallResponse;
    }
  }
}

/** Convert a zod schema to the an MCP inputSchema JSON shape (best-effort). */
function schemaToInputSchema(schema: ZodTypeAny | undefined): MCPToolDefinition['inputSchema'] {
  if (!schema) return { type: 'object', properties: {} };
  // Fall back to a generic object shape; a zod-to-json-schema adapter can
  // refine this without changing the service contract.
  return { type: 'object', properties: {} };
}

export const McpServerServicePlugin: PluginObject = {
  inject: ['tools'],
  apply(ctx: Context) {
    const tools = ctx.get<ToolsRegistry>('tools')!;
    const logger = ctx.get<LoggerService>('logger', false);
    return ctx.provide('mcp-server', new McpServerService(tools, logger?.get('mcp-server')));
  },
};
