import type { PluginObject, Context } from '../core/cordis';
import type MentatPlugin from '../main';

/**
 * Host service: provides the plugin settings object on the context.
 *
 * The data itself is loaded by the plugin's `loadSettings()` (kept in
 * main.ts, since `loadData` is an Obsidian `Plugin` primitive); this
 * component only makes it available as a context service so dependents
 * declare `inject: ['settings']` instead of reaching for the plugin.
 */
export const SettingsService: PluginObject = {
  inject: ['mentatPlugin'],
  apply(ctx: Context) {
    // Non-strict read: `mentatPlugin` is an assembly-time reference provided
    // by the root component while it is still LOADING.
    const plugin = ctx.get<MentatPlugin>('mentatPlugin', false)!;
    return ctx.provide('settings', plugin.settings);
  },
};
