import type { PluginObject, Context } from '../core/cordis';
import type { Permission } from '../tools/contract';
import type { NotifyCapability } from '../platform/contracts';

export interface PermissionRequest {
  permission: Permission;
  /** Who is asking (tool name / scope). */
  scope: string;
  detail?: string;
}

/** Policy over which permissions need explicit confirmation. */
const DEFAULT_CONFIRM_REQUIRED: Permission[] = [
  'documents:write',
  'documents:delete',
  'execute:command',
  'network:fetch',
  'extension:mount',
];
const DEFAULT_GRANTED: Permission[] = ['documents:read'];

/**
 * Permissions service (L4.2): enforces tool/action permissions via the
 * optional `ui` capability. Read-only permissions are granted by default;
 * write/delete/execute/network require confirmation, cached per session id
 * (so the second use in a session is auto-approved, matching the legacy
 * confirm workflow). On platforms without `ui`, confirm-capable permissions
 * simply fail closed.
 */
export class PermissionService {
  constructor(
    private ui?: NotifyCapability,
    private confirmRequired: Permission[] = DEFAULT_CONFIRM_REQUIRED,
    private granted: Permission[] = DEFAULT_GRANTED,
  ) {}

  /** Permissions granted by default (no confirmation). */
  isDefaultGranted(permission: Permission): boolean {
    return this.granted.includes(permission);
  }

  /**
   * Check a permission for a scope. Returns true if granted/confirmed.
   * Confirmation results are cached per session scope within this instance.
   */
  async check(permission: Permission, scope = 'agent'): Promise<boolean> {
    if (this.isDefaultGranted(permission)) return true;
    if (!this.confirmRequired.includes(permission)) return true; // unknown -> allow
    if (!this.ui) return false; // fail closed on platforms without ui
    const requested = await this.ui.confirm({
      message: `Mentat 请求授权：${permission}`,
      detail: `${permission} · ${scope}`,
      scope,
    });
    return requested;
  }
}

export const PermissionServicePlugin: PluginObject = {
  inject: ['ui'],
  apply(ctx: Context) {
    const ui = ctx.get<NotifyCapability>('ui', false);
    const service = new PermissionService(ui);
    return ctx.provide('permissions', service);
  },
};
