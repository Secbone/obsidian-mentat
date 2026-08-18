import type { PluginObject, Context } from '../core/cordis';
import { ObsidianPlatform } from './obsidian/obsidian-platform';
import type MentatPlugin from '../main';

/**
 * Platform plugin (L1): provides the host-agnostic knowledge-workspace
 * services. `documents`/`search`/`storage` are core (always provided);
 * `graph`/`workspace`/`ui` are optional capabilities — the Obsidian host
 * provides all six.
 *
 * Note: the legacy `platform` service name (ObsidianAdapter) is kept for the
 * current codebase; this plugin intentionally does not provide it yet.
 * The switch happens when L2/L3 are rebuilt on the new contracts.
 */
export const ObsidianPlatformPlugin: PluginObject = {
  inject: ['mentatPlugin'],
  apply(ctx: Context) {
    const plugin = ctx.get<MentatPlugin>('mentatPlugin', false)!;
    const platform = new ObsidianPlatform(plugin);

    // Core services (all platforms).
    ctx.provide('documents', platform.documents);
    ctx.provide('search', platform.search);
    ctx.provide('storage', platform.storage);

    // Optional capabilities (Obsidian has all of them).
    ctx.provide('graph', platform.graph);
    ctx.provide('workspace', platform.workspace);
    ctx.provide('ui', platform.ui);

    // Platform root (id/displayName) for inspection and shell use.
    ctx.provide('platform-info', {
      id: platform.id,
      displayName: platform.displayName,
    });
  },
};
