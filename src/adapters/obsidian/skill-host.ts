import { TFile, type App } from 'obsidian';
import type { IPlatformAdapter } from '../../types/platform';
import type { IndexManager } from '../../indexing/index-manager';
import type { SkillContext } from '../../skills/skill-types';
import { MutationService } from '../../skills/mutations/mutation-service';
import { FileMutationPlanStore } from '../../skills/mutations/plan-store';
import { NodeCommandExecutor } from '../node/command-executor';
import { UserInputModal } from '../../ui/user-input-modal';

/** All native capabilities are assembled here; portable skills never receive Plugin or App. */
export function createObsidianSkillHost(app: App, platform: IPlatformAdapter, index: IndexManager): SkillContext {
  const file = (path: string) => { const value = app.vault.getAbstractFileByPath(path); return value instanceof TFile ? value : null; };
  const ensureParent = async (path: string) => {
    let parent = '';
    for (const part of path.split('/').slice(0, -1)) {
      parent += (parent ? '/' : '') + part;
      if (!app.vault.getAbstractFileByPath(parent)) await app.vault.createFolder(parent);
    }
  };
  const mutations = new MutationService({
    read: async path => { const current = file(path); return current ? app.vault.read(current) : null; },
    exists: async path => !!app.vault.getAbstractFileByPath(path),
    listMarkdown: async () => app.vault.getMarkdownFiles().map(current => current.path),
    write: async (path, text) => { await ensureParent(path); const current = file(path); if (current) await app.vault.modify(current, text); else await app.vault.create(path, text); },
    move: async (from, to) => { await ensureParent(to); const current = file(from); if (!current) throw new Error(`File not found: ${from}`); await app.vault.rename(current, to); },
    resolveLink: (link, source) => app.metadataCache.getFirstLinkpathDest(link, source)?.path || null,
  }, new FileMutationPlanStore(platform, `${platform.getConfigDir()}/plugins/mentat/mutation-plans`));
  const adapter = app.vault.adapter as typeof app.vault.adapter & { getBasePath?: () => string };
  return {
    files: { getAbstractFileByPath: path => app.vault.getAbstractFileByPath(path), getMarkdownFiles: () => app.vault.getMarkdownFiles(), read: current => {
      const native = file(current.path); if (!native) throw new Error(`File not found: ${current.path}`); return app.vault.read(native);
    } },
    metadataCache: { getFileCache: current => { const native = file(current.path); return native ? app.metadataCache.getFileCache(native) : null; } },
    mutations,
    indexManager: {
      canSearch: () => index.canSearch(), search: (query, options) => index.search(query, { ...options, topK: options?.topK ?? 8, minScore: options?.minScore ?? 0.3 }),
      indexFile: current => index.indexFile(current), removeFromIndex: path => index.removeFromIndex(path),
    },
    commands: adapter.getBasePath ? new NodeCommandExecutor(adapter.getBasePath()) : undefined,
    askUser: input => new Promise(resolve => new UserInputModal(app, input.question, input.context, input.options, undefined, input.requiresInput ?? true,
      result => resolve(result.cancelled ? { kind: 'cancelled' } : { kind: 'answered', answer: result.answer })).open()),
  };
}
