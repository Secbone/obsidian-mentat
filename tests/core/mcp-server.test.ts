import { describe, it, expect } from 'vitest';
import { Context } from '../../src/core/cordis';
import { ToolsService, ToolsRegistry } from '../../src/tools/tools.service';
import { McpServerService, McpServerServicePlugin } from '../../src/external/mcp-server/mcp-server.service';
import type { ToolDefinition } from '../../src/tools/contract';

describe('McpServerService (L4.3)', () => {
  async function setup() {
    const ctx = new Context();
    await ctx.plugin(ToolsService);
    const registry = ctx.get<ToolsRegistry>('tools', false)!;
    registry.register({
      name: 'vault_read', description: 'read a doc', permissions: ['documents:read'],
      execute: async (input: { path: string }) => ({ success: true, data: { content: `content of ${input.path}` } }),
    } as ToolDefinition);
    await ctx.plugin(McpServerServicePlugin);
    return { ctx, registry, server: ctx.get<McpServerService>('mcp-server', false)! };
  }

  it('listTools maps registered tools to MCP tool definitions', async () => {
    const { server } = await setup();
    const resp = server.listTools();
    expect(resp.method).toBe('tools/list');
    expect(resp.result.tools.map((t) => t.name)).toContain('vault_read');
    expect(resp.result.tools[0].inputSchema.type).toBe('object');
  });

  it('callTool executes a tool and returns a text response', async () => {
    const { server } = await setup();
    const resp = await server.callTool('vault_read', { path: 'a.md' });
    expect(resp.method).toBe('tools/call');
    expect(resp.result.isError).toBe(false);
    expect(JSON.parse(resp.result.content[0].text!)).toMatchObject({ content: 'content of a.md' });
  });

  it('callTool returns isError true for unknown/externally-failing tools', async () => {
    const { server } = await setup();
    const resp = await server.callTool('does_not_exist', {});
    expect(resp.result.isError).toBe(true);
    expect(resp.result.content[0].text).toContain('not registered');
  });

  it('McpServerServicePlugin provides and unload recovers', async () => {
    const ctx = new Context();
    await ctx.plugin(ToolsService);
    ctx.get<ToolsRegistry>('tools', false)!.register({ name: 'x', description: '', permissions: [], execute: async () => ({ success: true }) } as ToolDefinition);
    await ctx.plugin(McpServerServicePlugin);
    expect(ctx.get<McpServerService>('mcp-server', false)).toBeInstanceOf(McpServerService);
    await ctx.fiber.dispose();
    expect(ctx.get('mcp-server', false)).toBeUndefined();
  });
});
