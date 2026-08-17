import type { PluginObject, Context } from '../core/cordis';
import type MentatPlugin from '../main';
import { ObsidianAdapter } from '../utils/obsidian-adapter';

/**
 * Host service: provides the Obsidian platform adapter.
 *
 * Keeps the plugin field reference (`plugin.platform`) so existing code
 * (commands, chat view) continues to work untouched.
 */
export const PlatformService: PluginObject = {
  inject: ['mentatPlugin'],
  apply(ctx: Context) {
    // Non-strict read: `mentatPlugin` is an assembly-time reference provided
    // by the root component while it is still LOADING.
    const plugin = ctx.get<MentatPlugin>('mentatPlugin', false)!;
    const platform = new ObsidianAdapter(plugin);
    plugin.platform = platform;
    return ctx.provide('platform', platform);
  },
};
