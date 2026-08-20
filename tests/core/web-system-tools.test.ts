import { describe, it, expect, vi } from 'vitest';
import { Context } from '../../src/core/cordis';
import { ToolsService, ToolsRegistry } from '../../src/tools/tools.service';
import { WebToolsPlugin } from '../../src/tools/web/web-tools';
import { SystemToolsPlugin } from '../../src/tools/system/system-tools';

describe('Web & System tools (L2.6)', () => {
  it('registers web_fetch and web_search', async () => {
    const ctx = new Context();
    await ctx.plugin(ToolsService);
    await ctx.plugin(WebToolsPlugin);
    const registry = ctx.get<ToolsRegistry>('tools', false)!;
    expect(registry.get('web_fetch')).toBeTruthy();
    expect(registry.get('web_search')).toBeTruthy();
  });

  it('web_fetch executes and returns text', async () => {
    const ctx = new Context();
    await ctx.plugin(ToolsService);
    await ctx.plugin(WebToolsPlugin);
    const registry = ctx.get<ToolsRegistry>('tools', false)!;
    const stub = vi.fn(async () => new Response('hello world', { status: 200 }));
    // @ts-expect-error replace global fetch
    global.fetch = stub;
    const res = await registry.execute('web_fetch', { url: 'https://example.com' }, {});
    expect(res).toMatchObject({ success: true });
    expect((res as { data: string }).data).toBe('hello world');
    // @ts-expect-error restore
    delete global.fetch;
  });

  it('system tools activate with ui capability and provide ask_user', async () => {
    const ctx = new Context();
    const confirm = vi.fn(async () => true);
    ctx.provide('ui', { notify: () => {}, confirm });
    await ctx.plugin(ToolsService);
    await ctx.plugin(SystemToolsPlugin);
    const registry = ctx.get<ToolsRegistry>('tools', false)!;
    expect(registry.get('ask_user')).toBeTruthy();

    const res = await registry.execute('ask_user', { question: 'proceed?' }, {});
    expect(res).toMatchObject({ success: true });
    expect(confirm).toHaveBeenCalled();
  });

  it('system tools stay pending without the ui capability', async () => {
    const ctx = new Context();
    await ctx.plugin(ToolsService);
    const fiber = ctx.plugin(SystemToolsPlugin);
    await new Promise((r) => setTimeout(r, 10));
    const registry = ctx.get<ToolsRegistry>('tools', false)!;
    expect(registry.get('ask_user')).toBeUndefined();
    void fiber;
  });
});
