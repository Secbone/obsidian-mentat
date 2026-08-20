import { describe, it, expect } from 'vitest';
import { Context } from '../../src/core/cordis';
import { ToolsRegistry, ToolsService } from '../../src/tools/tools.service';
import type { ToolDefinition } from '../../src/tools/contract';

function makeTool(name: string, fn: () => unknown): ToolDefinition {
  return { name, description: name, permissions: ['documents:read'], execute: async () => ({ success: true, data: fn() }) };
}

describe('ToolsRegistry (L2.4)', () => {
  it('registers, lists, gets and reversibly unregisters tools', () => {
    const r = new ToolsRegistry();
    const t = makeTool('test', () => 42);
    const unregister = r.register(t);
    expect(r.get('test')).toBe(t);
    expect(r.list().map((x) => x.name)).toEqual(['test']);
    unregister();
    expect(r.get('test')).toBeUndefined();
  });

  it('rejects duplicate tool names', () => {
    const r = new ToolsRegistry();
    r.register(makeTool('dup', () => {}));
    expect(() => r.register(makeTool('dup', () => {}))).toThrow(/already registered/);
  });

  it('execute dispatches and throws for unknown tools', async () => {
    const r = new ToolsRegistry();
    r.register(makeTool('hello', () => 'world'));
    const result = await r.execute('hello', {}, {} as never);
    expect(result).toEqual({ success: true, data: 'world' });
    await expect(r.execute('nope', {}, {} as never)).rejects.toThrow(/not registered/);
  });

  it('ToolsService provides the registry and unload recovers it', async () => {
    const ctx = new Context();
    await ctx.plugin(ToolsService);
    expect(ctx.get<ToolsRegistry>('tools', false)).toBeInstanceOf(ToolsRegistry);
    await ctx.fiber.dispose();
    expect(ctx.get('tools', false)).toBeUndefined();
  });
});
