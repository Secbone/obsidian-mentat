import { Notice } from 'obsidian';
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
import { ExtensionManager } from './extensions';
import { ChatOrchestrator } from './chat/chat-orchestrator';
import { OpenCodeIntegration } from './providers/opencode-integration';
import type { MentatSettings } from './settings/settings';
import type { EventBus } from './extensions';
import type { AIRouter } from './providers/ai-router';
import type { IndexManager } from './indexing/index-manager';
import type { ObsidianAdapter } from './utils/obsidian-adapter';

/** Config passed to the MentatRoot component. */
export interface MentatRootConfig {
  plugin: MentatPlugin;
}

/**
 * Host-plane assembly component (M2: base services componentized).
 *
 * Assembles the plugin as a Cordis component tree:
 * - base services (settings / platform / eventBus / readTracker) are
 *   dedicated components declaring their dependencies via `inject`;
 * - heavier business services (router / indexing / chat / extensions /
 *   integrations) are still initialized inline for now and will be
 *   componentized in M3/M4, reading base services through the registry.
 *
 * Unloading the context fiber (in `onunload`) recovers every registration
 * in LIFO order.
 */
export const MentatRoot: PluginObject = {
  inject: [],
  apply: async (ctx, config: MentatRootConfig) => {
    const plugin = config.plugin;
    const registry = ctx.registry;

    // ── identity ──────────────────────────────────────────────────────────
    ctx.provide('mentatPlugin', plugin);

    // ── base services (await activation so providers are installed) ───────
    await ctx.plugin(SettingsService);
    await ctx.plugin(PlatformService);
    await ctx.plugin(EventBusService);
    await ctx.plugin(ReadTrackerService);

    // ── capability services (M3) ──────────────────────────────────────────
    await ctx.plugin(AIRouterService);
    await ctx.plugin(IndexingService);

    // ── remaining business services (M4: replace with components) ─────────
    const settings = registry.get<MentatSettings>(ctx, 'settings', false)!;
    const platform = registry.get<ObsidianAdapter>(ctx, 'platform', false)!;
    const eventBus = registry.get<EventBus>(ctx, 'eventBus', false)!;
    const aiRouter = registry.get<AIRouter>(ctx, 'aiRouter', false)!;
    const indexManager = registry.get<IndexManager>(ctx, 'indexing', false)!;

    // Chat orchestration (may fail gracefully without a provider)
    const chatOrchestrator = new ChatOrchestrator(
      platform,
      settings,
      aiRouter,
      indexManager,
      eventBus,
    );
    try {
      await chatOrchestrator.initialize();
    } catch (error: unknown) {
      console.warn(
        'Mentat: ChatOrchestrator initialization failed (will retry after provider config):',
        error instanceof Error ? error.message : String(error),
      );
      new Notice('Mentat: 未检测到 AI 服务商配置。请在设置中配置 API Key。No AI provider configured — add one in Mentat settings.');
    }
    ctx.provide('chat', chatOrchestrator);
    plugin.chatOrchestrator = chatOrchestrator;
    plugin.agentManager = chatOrchestrator.getAgentManager();
    ctx.provide('agents', plugin.agentManager);

    // Extension system
    const extensionManager = new ExtensionManager(
      plugin.app,
      chatOrchestrator.getSkillRegistry(),
      chatOrchestrator.getSkillExecutor(),
      settings,
      eventBus,
    );
    extensionManager.loadAll();
    ctx.provide('extensions', extensionManager);
    plugin.extensionManager = extensionManager;

    // Integrations
    const openCodeIntegration = new OpenCodeIntegration(plugin);
    ctx.provide('openCode', openCodeIntegration);
    plugin.openCodeIntegration = openCodeIntegration;

    // Unload inverse: keep the current cleanup semantics (M5 widens this).
    return async () => {
      chatOrchestrator.dispose();
      openCodeIntegration.dispose();
    };
  },
};
