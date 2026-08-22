import { describe, it, expect, vi } from 'vitest';
import { Context } from '../../src/core/cordis';
import { ToolsService, ToolsRegistry } from '../../src/tools/tools.service';
import { McpClientService, McpClientServicePlugin, type McpServerConfig } from '../../src/external/mcp-client/mcp-client.service';

function makeClient(listTools: string[]) {
  const call = vi.fn(async (name: string, args: unknown) => ({ echoed: { name, args } }));
  const disconnect = vi.fn(async () => {});
  return {
    listTools: async () => listTools.map((name) => ({ name, description: `mcp tool ${name}` })),
    call,
    disconnect,
  };
}

describe('McpClientService (L2.8)', () => {
  it('bridges MCP tools into the tools registry', async () => {
    const ctx = new Context();
    await ctx.plugin(ToolsService);
    const connectFn = vi.fn(async () => makeClient(['mcp_alpha', 'mcp_beta']));
    const service = new McpClientService(ctx.get<ToolsRegistry>('tools', false)!, connectFn);

    await service.connect({ name: 't', transport: 'http', url: 'http://x' });

    const registry = ctx.get<ToolsRegistry>('tools', false)!;
    expect(registry.get('mcp_alpha')).toBeTruthy();
    expect(registry.get('mcp_beta')).toBeTruthy();

    const res = await registry.execute('mcp_alpha', { q: 1 }, {});
    expect(res).toMatchObject({ success: true });
    expect(connectFn).toHaveBeenCalled();
  });

  it('disconnect removes the bridged tools and disconnects the client', async () => {
    const ctx = new Context();
    await ctx.plugin(ToolsService);
    const client = makeClient(['mcp_x']);
    const service = new McpClientService(ctx.get<ToolsRegistry>('tools', false)!, async () => client);

    await service.connect({ name: 't', transport: 'stdio', command: 'echo' });
    const registry = ctx.get<ToolsRegistry>('tools', false)!;
    expect(registry.get('mcp_x')).toBeTruthy();

    await service.disconnect('t');
    expect(client.disconnect).toHaveBeenCalled();
    expect(registry.get('mcp_x')).toBeUndefined();
  });

  it('McpClientServicePlugin provides the service and unload recovers it', async () => {
    const ctx = new Context();
    await ctx.plugin(ToolsService);
    await ctx.plugin(McpClientServicePlugin);
    expect(ctx.get<McpClientService>('mcp-client', false)).toBeInstanceOf(McpClientService);
    await ctx.fiber.dispose();
    expect(ctx.get('mcp-client', false)).toBeUndefined();
  });
});
