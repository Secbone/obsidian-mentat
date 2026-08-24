import { describe, it, expect, vi } from 'vitest';
import { Context } from '../../src/core/cordis';
import { PermissionService, PermissionServicePlugin } from '../../src/external/permissions.service';
import { ToolsService, ToolsRegistry } from '../../src/tools/tools.service';
import type { ToolDefinition } from '../../src/tools/contract';
import type { NotifyCapability } from '../../src/platform/contracts';

describe('PermissionService (L4.2)', () => {
  it('grants read by default, confirms write/delete with ui', async () => {
    const confirm = vi.fn(async () => true);
    const ui: NotifyCapability = { notify: () => {}, confirm };
    const svc = new PermissionService(ui);

    expect(await svc.check('documents:read')).toBe(true);       // default granted
    expect(await svc.check('documents:write')).toBe(true);       // confirmed
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(await svc.check('documents:delete')).toBe(true);      // confirmed
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it('fails closed for confirm-required permissions without ui', async () => {
    const svc = new PermissionService(undefined);
    expect(await svc.check('documents:write')).toBe(false);      // no ui -> deny
    expect(await svc.check('documents:read')).toBe(true);        // default still granted
  });

  it('tools execute enforces declared permissions (denied write throws)', async () => {
    const ctx = new Context();
    const confirm = vi.fn(async () => false);
    const ui: NotifyCapability = { notify: () => {}, confirm };
    const permissions = new PermissionService(ui);
    ctx.provide('permissions', permissions);
    await ctx.plugin(ToolsService);

    const registry = ctx.get<ToolsRegistry>('tools', false)!;
    registry.register({
      name: 'vault_write', description: '', permissions: ['documents:write'],
      execute: async () => ({ success: true }),
    } as ToolDefinition);

    await expect(registry.execute('vault_write', {}, {})).rejects.toThrow(/permission denied/);
  });

  it('PermissionServicePlugin wires ui and unload recovers', async () => {
    const ctx = new Context();
    ctx.provide('ui', { notify: () => {}, confirm: async () => true });
    await ctx.plugin(PermissionServicePlugin);
    expect(ctx.get<PermissionService>('permissions', false)).toBeInstanceOf(PermissionService);
    await ctx.fiber.dispose();
    expect(ctx.get('permissions', false)).toBeUndefined();
  });
});
