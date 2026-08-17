import { Notice } from 'obsidian';
import type { PluginObject, Context } from '../core/cordis';
import { ChatOrchestrator } from './chat-orchestrator';
import type { MentatSettings } from '../settings/settings';
import type { AIRouter } from '../providers/ai-router';
import type { IndexManager } from '../indexing/index-manager';
import type { ObsidianAdapter } from '../utils/obsidian-adapter';
import type { EventBus } from '../extensions';
import type MentatPlugin from '../main';

/**
 * Host service: provides the chat orchestration (agent sessions, skills,
 * MCP) as a context service. Keeps the current ChatOrchestrator internals
 * unchanged; only the assembly moves to dependency injection.
 *
 * The service's unload inverse disposes the orchestrator, and its `provide`
 * inverses unregister `chat`/`agents`, so unloading the context recovers
 * everything in LIFO order.
 */
export const ChatService: PluginObject = {
  inject: ['platform', 'settings', 'aiRouter', 'indexing', 'eventBus'],
  apply: async (ctx: Context) => {
    const platform = ctx.get<ObsidianAdapter>('platform')!;
    const settings = ctx.get<MentatSettings>('settings')!;
    const aiRouter = ctx.get<AIRouter>('aiRouter')!;
    const indexManager = ctx.get<IndexManager>('indexing')!;
    const eventBus = ctx.get<EventBus>('eventBus')!;

    const chatOrchestrator = new ChatOrchestrator(platform, settings, aiRouter, indexManager, eventBus);
    try {
      await chatOrchestrator.initialize();
    } catch (error: unknown) {
      console.warn(
        'Mentat: ChatOrchestrator initialization failed (will retry after provider config):',
        error instanceof Error ? error.message : String(error),
      );
      new Notice('Mentat: 未检测到 AI 服务商配置。请在设置中配置 API Key。No AI provider configured — add one in Mentat settings.');
    }

    const plugin = ctx.get<MentatPlugin>('mentatPlugin', false);
    if (plugin) {
      plugin.chatOrchestrator = chatOrchestrator;
      plugin.agentManager = chatOrchestrator.getAgentManager();
    }
    ctx.provide('chat', chatOrchestrator);
    ctx.provide('agents', chatOrchestrator.getAgentManager());
    // Unload inverse: keep the current orchestrator cleanup semantics.
    return () => chatOrchestrator.dispose();
  },
};
