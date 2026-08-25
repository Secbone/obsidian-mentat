import type { PluginObject } from './core/cordis';
import type MentatPlugin from './main';
import {
  SettingsService,
  PlatformService,
  EventBusService,
  ReadTrackerService,
} from './services';
import { DiagnosticsService } from './diagnostics/diagnostics.service';
import { LoggerServicePlugin } from './logger/logger.service';
import { FileLogSink } from './logger/file-sink';
import { ObsidianPlatformPlugin } from './platform/platform.service';
import { AIRouterService } from './providers/ai-router.service';
import { IndexingService } from './indexing/indexing.service';
import { ChatService } from './chat/chat.service';
import { ExtensionsService } from './extensions/extensions.service';
import { OpenCodeService } from './providers/opencode.service';
import { AgentModesService } from './agents/agent-modes.service';
import { NewArchitectureLayer } from './app/new-architecture.layer';

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

    // ── logging (crosscutting; must precede any service that logs) ────────
    await ctx.plugin(LoggerServicePlugin);
    const logger = ctx.get<import('./logger/logger.service').LoggerService>('logger', false);
    const rawAdapter = plugin?.app?.vault?.adapter as { append?: (p: string, d: string) => Promise<void> } | undefined;
    if (logger && rawAdapter?.append) {
      const adapter = rawAdapter;
      const appDir = String(plugin.app.vault.configDir ?? '');
      const logDir = `${appDir}/plugins/mentat/logs`.replace(/\\/g, '/');
      const fileSink = new FileLogSink({
        dir: logDir,
        append: (path, data) => adapter.append!(path, data),
        mkdir: (path) => plugin.app.vault.adapter.mkdir(path.replace(/\\/g, '/')),
      });
      logger.addExporter(fileSink);
    }

    // ── L1 platform + crosscutting ────────────────────────────────────────
    // Host-agnostic platform services (documents/search/storage/graph/workspace/ui).
    // Kept alongside the legacy `platform` service until L2/L3 switch over.
    await ctx.plugin(ObsidianPlatformPlugin);
    await ctx.plugin(DiagnosticsService);

    // ── base services (legacy, retired at switch points) ──────────────────
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

    // ── session plane (M6) ────────────────────────────────────────────────
    await ctx.plugin(AgentModesService);

    // ── L2-L4 new-architecture service stack (parallel with legacy) ───────
    await ctx.plugin(NewArchitectureLayer);
  },
};
