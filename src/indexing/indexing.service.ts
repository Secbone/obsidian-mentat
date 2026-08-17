import type { PluginObject, Context } from '../core/cordis';
import { IndexManager } from './index-manager';
import { TaskType } from '../types';
import type { AIRouter } from '../providers/ai-router';
import type { ObsidianAdapter } from '../utils/obsidian-adapter';
import type MentatPlugin from '../main';

/**
 * Host service: provides the vault indexing (RAG) manager.
 *
 * Reactively depends on `aiRouter` for the embedding provider: if the router
 * is unavailable the service stays pending and activates once it appears.
 */
export const IndexingService: PluginObject = {
  inject: ['platform', 'aiRouter'],
  apply: async (ctx: Context) => {
    const platform = ctx.get<ObsidianAdapter>('platform')!;
    const aiRouter = ctx.get<AIRouter>('aiRouter')!;
    const indexManager = new IndexManager(platform, () => aiRouter.getProvider(TaskType.EMBEDDING));
    await indexManager.initialize();
    const plugin = ctx.get<MentatPlugin>('mentatPlugin', false);
    if (plugin) plugin.indexManager = indexManager;
    return ctx.provide('indexing', indexManager);
  },
};
