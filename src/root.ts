import type { PluginObject } from './core/cordis';
import type MentatPlugin from './main';
import {
  SettingsService,
  PlatformService,
  EventBusService,
  ReadTrackerService,
} from './services';
import { AIRouterService } from './providers/ai-router.service';
import { IndexingService } from './indexing/indexing.service';
import { ChatService } from './chat/chat.service';
import { ExtensionsService } from './extensions/extensions.service';
import { OpenCodeService } from './providers/opencode.service';

/** Config passed to the MentatRoot component. */
export interface MentatRootConfig {
  plugin: MentatPlugin;
}

/**
 * Host-plane assembly component (M4: all host services componentized).
 *
 * Assembles the plugin as a Cordis component tree. Every subsystem is a
 * component declaring its dependencies via `inject` and providing itself on
 * the context; the root only mounts them in a convenient order — the kernel's
 * reactive dependency resolution makes the order non-essential (a service
 * stays pending until its injects are satisfied).
 *
 * Unloading the context fiber (in `onunload`) recovers every registration
 * in LIFO order, including the chat orchestrator's cleanup via its own
 * unload inverse.
 */
export const MentatRoot: PluginObject = {
  inject: [],
  apply: async (ctx, config: MentatRootConfig) => {
    const plugin = config.plugin;

    // ── identity ──────────────────────────────────────────────────────────
    ctx.provide('mentatPlugin', plugin);

    // ── base services ─────────────────────────────────────────────────────
    await ctx.plugin(SettingsService);
    await ctx.plugin(PlatformService);
    await ctx.plugin(EventBusService);
    await ctx.plugin(ReadTrackerService);

    // ── capability services (M3) ──────────────────────────────────────────
    await ctx.plugin(AIRouterService);
    await ctx.plugin(IndexingService);

    // ── business services (M4) ────────────────────────────────────────────
    await ctx.plugin(ChatService);
    await ctx.plugin(ExtensionsService);
    await ctx.plugin(OpenCodeService);
  },
};
