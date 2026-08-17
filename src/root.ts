import { Notice } from 'obsidian';
import type { PluginObject } from './core/cordis';
import type MentatPlugin from './main';
import { ObsidianAdapter } from './utils/obsidian-adapter';
import { AIRouter } from './providers/ai-router';
import { IndexManager } from './indexing/index-manager';
import { EventBus, ExtensionManager } from './extensions';
import { ChatOrchestrator } from './chat/chat-orchestrator';
import { OpenCodeIntegration } from './providers/opencode-integration';
import { TaskType } from './types';

/** Config passed to the MentatRoot component. */
export interface MentatRootConfig {
  plugin: MentatPlugin;
}

/**
 * Host-plane assembly component (M1 skeleton, behavior-preserving).
 *
 * Moves the hand-wired initialization from `main.ts onload()` into a Cordis
 * plugin so that every subsystem is registered as a *service* on the unified
 * context, and unloading the context fiber (in `onunload`) recovers the
 * registrations in LIFO order. Nothing else changes yet: the plugin instance
 * keeps its public field references (`plugin.aiRouter`, ...) so existing UI,
 * commands and settings code keeps working untouched.
 *
 * Follow-up steps (per docs/mentat-cordis-refactor.md) will replace each
 * subsystem in turn with a proper `Service` component declaring `inject`.
 */
export const MentatRoot: PluginObject = {
  inject: [],
  apply: async (ctx, config: MentatRootConfig) => {
    const plugin = config.plugin;

    // ── identity / settings ───────────────────────────────────────────────
    ctx.provide('mentatPlugin', plugin);
    ctx.provide('settings', plugin.settings);

    // ── platform ──────────────────────────────────────────────────────────
    const platform = new ObsidianAdapter(plugin);
    ctx.provide('platform', platform);
    plugin.platform = platform;

    // ── AI router ─────────────────────────────────────────────────────────
    const aiRouter = new AIRouter(plugin.settings);
    ctx.provide('aiRouter', aiRouter);
    plugin.aiRouter = aiRouter;

    // ── indexing ──────────────────────────────────────────────────────────
    const indexManager = new IndexManager(platform, () => aiRouter.getProvider(TaskType.EMBEDDING));
    await indexManager.initialize();
    ctx.provide('indexing', indexManager);
    plugin.indexManager = indexManager;

    // ── event bus (before the orchestrator, for agent event streaming) ────
    const eventBus = new EventBus();
    ctx.provide('eventBus', eventBus);
    plugin.eventBus = eventBus;

    // ── chat orchestration (may fail gracefully without a provider) ───────
    const chatOrchestrator = new ChatOrchestrator(
      platform,
      plugin.settings,
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

    // ── extension system (shares the global event bus) ────────────────────
    const extensionManager = new ExtensionManager(
      plugin.app,
      chatOrchestrator.getSkillRegistry(),
      chatOrchestrator.getSkillExecutor(),
      plugin.settings,
      eventBus,
    );
    extensionManager.loadAll();
    ctx.provide('extensions', extensionManager);
    plugin.extensionManager = extensionManager;

    // ── integrations ──────────────────────────────────────────────────────
    const openCodeIntegration = new OpenCodeIntegration(plugin);
    ctx.provide('openCode', openCodeIntegration);
    plugin.openCodeIntegration = openCodeIntegration;

    // Unload inverse: keep the current onunload cleanup semantics exactly
    // (M5 will widen this to full LIFO recovery of every registration).
    return async () => {
      chatOrchestrator.dispose();
      openCodeIntegration.dispose();
    };
  },
};
