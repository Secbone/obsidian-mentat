import type { PluginObject, Context } from '../core/cordis';
import { ExtensionManager } from './index';
import type { ChatOrchestrator } from '../chat/chat-orchestrator';
import type { MentatSettings } from '../settings/settings';
import type { EventBus } from './index';
import type MentatPlugin from '../main';

/**
 * Host service: provides the extension system (shares the global event bus
 * and the chat service's skill registry/executor).
 */
export const ExtensionsService: PluginObject = {
  inject: ['chat', 'settings', 'eventBus'],
  apply(ctx: Context) {
    const chat = ctx.get<ChatOrchestrator>('chat')!;
    const settings = ctx.get<MentatSettings>('settings')!;
    const eventBus = ctx.get<EventBus>('eventBus')!;
    const plugin = ctx.get<MentatPlugin>('mentatPlugin', false)!;

    const extensionManager = new ExtensionManager(
      plugin.app,
      chat.getSkillRegistry(),
      chat.getSkillExecutor(),
      settings,
      eventBus,
    );
    extensionManager.loadAll();
    plugin.extensionManager = extensionManager;
    return ctx.provide('extensions', extensionManager);
  },
};
