import type { PluginObject, Context } from '../core/cordis';
import { OpenCodeIntegration } from './opencode-integration';
import type MentatPlugin from '../main';

/**
 * Host service: provides the OpenCode integration.
 */
export const OpenCodeService: PluginObject = {
  inject: ['mentatPlugin'],
  apply(ctx: Context) {
    const plugin = ctx.get<MentatPlugin>('mentatPlugin', false)!;
    const integration = new OpenCodeIntegration(plugin);
    plugin.openCodeIntegration = integration;
    return ctx.provide('openCode', integration);
  },
};
