import { describe, it, expect, vi } from 'vitest';
import { Context } from '../../src/core/cordis';
import { ToolsService, ToolsRegistry } from '../../src/tools/tools.service';
import { EventBridgeService, EventBridgeServicePlugin } from '../../src/events/event-bridge.service';
import { ExtensionHostV2, ExtensionHostV2Plugin, type ExtensionRegistrationV2 } from '../../src/extensions/extension-api-v2';
import type { AgentEvent } from '../../src/agents/agent-types';

async function setup() {
  const ctx = new Context();
  await ctx.plugin(ToolsService);
  await ctx.plugin(EventBridgeServicePlugin);
  await ctx.plugin(ExtensionHostV2Plugin() as never);
  return { ctx, tools: ctx.get<ToolsRegistry>('tools', false)!, host: ctx.get<ExtensionHostV2>('extensions-v2', false)! };
}

describe('ExtensionHostV2 (L4.5)', () => {
  it('registers an extension; registerTool is reversible via the unsubscriber', async () => {
    const { ctx, tools, host } = await setup();
    let unregisterTool: (() => void) | undefined;
    const reg: ExtensionRegistrationV2 = {
      id: 'ext1', name: 'E1', description: '',
      factory: (api) => {
        unregisterTool = api.registerTool({ name: 'ext_tool', description: '', permissions: [], execute: async () => ({ success: true }) });
      },
    };
    const unregister = await host.register(reg);
    expect(host.has('ext1')).toBe(true);
    expect(tools.get('ext_tool')).toBeTruthy();

    unregisterTool!();
    expect(tools.get('ext_tool')).toBeUndefined();
    unregister();
    expect(host.has('ext1')).toBe(false);
  });

  it('allows event subscription through the kernel-backed bridge', async () => {
    const { ctx, host } = await setup();
    const handler = vi.fn();
    const reg: ExtensionRegistrationV2 = {
      id: 'ext-evt', name: 'Evt', description: '',
      factory: (api) => { api.on('*', handler); },
    };
    await host.register(reg);
    // Emit via kernel bridge
    ctx.get<EventBridgeService>('event-bridge', false)!.emit({ type: 'agent:start' } as AgentEvent);
    expect(handler).toHaveBeenCalled();
  });

  it('blocks non-allowlisted services via get()', async () => {
    const { host } = await setup();
    let error: string | undefined;
    const reg: ExtensionRegistrationV2 = {
      id: 'ext-get', name: 'Get', description: '',
      factory: (api) => { try { api.get('chat'); } catch (e) { error = (e as Error).message; } },
    };
    await host.register(reg);
    expect(error).toContain('not in the extension allowlist');
  });

  it('ExtensionHostV2 can be built directly and recovers on dispose', async () => {
    const { ctx, tools } = await setup();
    const events = ctx.get<EventBridgeService>('event-bridge', false)!;
    const host = new ExtensionHostV2(tools, events, ctx);
    const cleanup = vi.fn();
    await host.register({ id: 'x', name: 'X', description: '', factory: () => cleanup });
    host.unregister('x');
    expect(cleanup).toHaveBeenCalled();
    expect(host.has('x')).toBe(false);
  });
});
