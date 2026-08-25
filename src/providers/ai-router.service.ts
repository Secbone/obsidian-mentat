import type { PluginObject, Context } from '../core/cordis';
import type { MentatSettings } from '../settings/settings';
import { AIRouter } from './ai-router';
import type { LoggerService, Logger } from '../logger/logger.service';
import type MentatPlugin from '../main';

/**
 * Host service: provides the AI task router.
 *
 * Dependents declare `inject: ['aiRouter']`; because provisioning is a
 * revertible effect and dependents reload on `notify`, re-providing a fresh
 * router (e.g. after provider configuration changes) will reactively reload
 * every consumer — the Cordis pattern for provider hot-swap.
 */
export const AIRouterService: PluginObject = {
  inject: ['settings', 'logger'],
  apply(ctx: Context) {
    const settings = ctx.get<MentatSettings>('settings')!;
    const logger = ctx.get<LoggerService>('logger', false);
    const loggerFactory = (providerId: string) => (error: unknown, stage: string) => {
      if (logger) {
        const named = logger.get(`provider:${providerId}`, { providerId }) as Logger;
        named.error(`[${stage}] ${error instanceof Error ? error.message : String(error)}`);
        named.error(error);
      } else {
        console.error(`[provider:${providerId}] ${stage}:`, error);
      }
    };
    const router = new AIRouter(settings, loggerFactory);
    // Keep the plugin field reference for existing command code.
    const plugin = ctx.get<MentatPlugin>('mentatPlugin', false);
    if (plugin) plugin.aiRouter = router;
    return ctx.provide('aiRouter', router);
  },
};
