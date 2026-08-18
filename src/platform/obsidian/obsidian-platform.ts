import { Notice, TFile, Modal, App } from 'obsidian';
import type { Plugin } from 'obsidian';
import type {
  Doc,
  DocumentStore,
  SearchCapability,
  SearchResult,
  StorageCapability,
  GraphCapability,
  WorkspaceCapability,
  NotifyCapability,
  Platform,
  Backlink,
  ConfirmRequest,
} from '../contracts';

/**
 * Obsidian implementation of the platform contracts.
 *
 * All Obsidian-specific types stay inside this file — nothing crosses the
 * platform boundary (docs/mentat-architecture-clean.md §3.6). The Obsidian
 * `Plugin` instance is the only host dependency, obtained via the L5 shell's
 * `mentatPlugin` service.
 */
export class ObsidianPlatform implements Platform {
  readonly id = 'obsidian';
  readonly displayName = 'Obsidian';

  readonly documents: DocumentStore;
  readonly search: SearchCapability;
  readonly storage: StorageCapability;
  readonly graph: GraphCapability;
  readonly workspace: WorkspaceCapability;
  readonly ui: NotifyCapability;

  constructor(private plugin: Plugin) {
    this.documents = new ObsidianDocuments(plugin);
    this.search = new ObsidianSearch(plugin);
    this.storage = new ObsidianStorage(plugin);
    this.graph = new ObsidianGraph(plugin);
    this.workspace = new ObsidianWorkspace(plugin);
    this.ui = new ObsidianNotify(plugin);
  }
}

function toDoc(file: TFile): Doc {
  return {
    path: file.path,
    name: file.basename,
    extension: file.extension,
    stat: {
      mtime: file.stat.mtime,
      size: file.stat.size,
      ctime: file.stat.ctime,
    },
    parent: file.parent ? { path: file.parent.path } : null,
  };
}

class ObsidianDocuments implements DocumentStore {
  constructor(private plugin: Plugin) {}

  listDocuments(dir?: string): Doc[] {
    const files = this.plugin.app.vault.getMarkdownFiles();
    if (!dir || dir === '/') return files.map(toDoc);
    const prefix = dir.endsWith('/') ? dir : `${dir}/`;
    return files.filter((f) => f.path.startsWith(prefix)).map(toDoc);
  }

  getDocument(path: string): Doc | null {
    const file = this.plugin.app.vault.getAbstractFileByPath(path);
    return file instanceof TFile ? toDoc(file) : null;
  }

  async readDocument(doc: Doc): Promise<string> {
    const file = this.plugin.app.vault.getAbstractFileByPath(doc.path);
    if (!(file instanceof TFile)) throw new Error(`Document not found: ${doc.path}`);
    return this.plugin.app.vault.read(file);
  }

  async writeDocument(path: string, content: string): Promise<void> {
    const vault = this.plugin.app.vault;
    const existing = vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      await vault.modify(existing, content);
    } else {
      await vault.create(path, content);
    }
  }

  async moveDocument(from: string, to: string): Promise<void> {
    const file = this.plugin.app.vault.getAbstractFileByPath(from);
    if (!(file instanceof TFile)) throw new Error(`Document not found: ${from}`);
    await this.plugin.app.vault.rename(file, to);
  }

  async deleteDocument(path: string): Promise<void> {
    const file = this.plugin.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error(`Document not found: ${path}`);
    await this.plugin.app.vault.delete(file);
  }

  async exists(path: string): Promise<boolean> {
    return this.plugin.app.vault.adapter.exists(path);
  }

  async mkdir(path: string): Promise<void> {
    await this.plugin.app.vault.adapter.mkdir(path);
  }

  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    return this.plugin.app.vault.adapter.list(path);
  }

  watch(path: string, callback: (changed: string) => void): () => void {
    const ref = this.plugin.app.vault.on('modify', (file) => {
      if (file.path === path || file.path.startsWith(path)) callback(file.path);
    });
    return () => this.plugin.app.vault.offref(ref);
  }
}

class ObsidianSearch implements SearchCapability {
  constructor(private plugin: Plugin) {}

  async search(query: string): Promise<SearchResult[]> {
    const vault = this.plugin.app.vault as unknown as {
      search(q: string): Promise<Array<{ file: TFile; match?: { context: string }; score: number }>>;
    };
    if (typeof vault.search !== 'function') return [];
    const results = await vault.search(query);
    return results.map((r) => ({
      path: r.file.path,
      snippet: r.match?.context,
      score: r.score,
    }));
  }
}

class ObsidianStorage implements StorageCapability {
  constructor(private plugin: Plugin) {}

  async loadData(): Promise<Record<string, unknown>> {
    return (await this.plugin.loadData()) ?? {};
  }

  async saveData(data: Record<string, unknown>): Promise<void> {
    await this.plugin.saveData(data);
  }

  getConfigDir(): string {
    return this.plugin.app.vault.configDir;
  }
}

class ObsidianGraph implements GraphCapability {
  constructor(private plugin: Plugin) {}

  getBacklinks(path: string): Backlink[] {
    const file = this.plugin.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return [];
    const cache = this.plugin.app.metadataCache as unknown as {
      getBacklinksForFile(f: TFile): Record<string, { link: { path: string }; context?: { text: string } }>;
    };
    const backlinks = cache.getBacklinksForFile(file);
    return Object.values(backlinks).map((entry) => ({
      source: entry.link.path,
      excerpt: entry.context?.text,
    }));
  }

  getLinks(path: string): string[] {
    const file = this.plugin.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return [];
    const resolved = this.plugin.app.metadataCache.resolvedLinks[file.path] ?? {};
    return Object.keys(resolved);
  }

  getTags(path: string): string[] {
    const cache = this.getCache(path);
    return (cache?.tags ?? []).map((t) => t.tag.replace(/^#/, ''));
  }

  getFrontmatter(path: string): Record<string, unknown> | null {
    const cache = this.getCache(path);
    return cache?.frontmatter ?? null;
  }

  private getCache(path: string) {
    const file = this.plugin.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return null;
    return this.plugin.app.metadataCache.getFileCache(file);
  }
}

class ObsidianWorkspace implements WorkspaceCapability {
  constructor(private plugin: Plugin) {}

  getActiveDocument(): Doc | null {
    const file = this.plugin.app.workspace.getActiveFile();
    return file instanceof TFile ? toDoc(file) : null;
  }

  onActiveChange(callback: (doc: Doc | null) => void): () => void {
    const ref = this.plugin.app.workspace.on('file-open', (file) => {
      callback(file instanceof TFile ? toDoc(file) : null);
    });
    return () => this.plugin.app.workspace.offref(ref);
  }
}

class ObsidianNotify implements NotifyCapability {
  constructor(private plugin: Plugin) {}

  notify(message: string, timeout = 4000): void {
    new Notice(message, timeout);
  }

  confirm(request: ConfirmRequest): Promise<boolean> {
    return new Promise((resolve) => {
      const modal = new ConfirmModal(this.plugin.app, request, (confirmed) => {
        resolve(confirmed);
      });
      modal.open();
    });
  }
}

/** Minimal confirm modal over the Obsidian Modal API (host-owned UI primitive). */
class ConfirmModal extends Modal {
  constructor(
    app: App,
    private request: ConfirmRequest,
    private onSubmit: (confirmed: boolean) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: 'Mentat 请求授权' });
    contentEl.createEl('p', { text: this.request.message });
    if (this.request.detail) contentEl.createEl('p', { text: this.request.detail });
    const actions = contentEl.createDiv({ cls: 'mentat-confirm-actions' });
    actions.createEl('button', { text: '拒绝' }).addEventListener('click', () => {
      this.onSubmit(false);
      this.close();
    });
    actions.createEl('button', { text: '允许' }).addEventListener('click', () => {
      this.onSubmit(true);
      this.close();
    });
  }
}
