import { App, Plugin, Vault, Workspace, MetadataCache, TFile } from 'obsidian';
import { IPlatformAdapter, IPlatformFile, IFileCache } from '../types/platform';
import type { MentatSettings } from '../settings/settings';

export class ObsidianAdapter implements IPlatformAdapter {
  readonly app: App;
  readonly plugin: Plugin;

  constructor(plugin: Plugin) {
    this.plugin = plugin;
    this.app = plugin.app;
  }

  getMarkdownFiles(): IPlatformFile[] {
    return this.app.vault.getMarkdownFiles();
  }

  getFileByPath(path: string): IPlatformFile | null {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file && file instanceof TFile) {
      return file;
    }
    return null;
  }

  async readFile(file: IPlatformFile): Promise<string> {
    const tfile = this.app.vault.getAbstractFileByPath(file.path);
    if (tfile && tfile instanceof TFile) {
      return await this.app.vault.read(tfile);
    }
    throw new Error(`File not found: ${file.path}`);
  }

  getFileCache(file: IPlatformFile): IFileCache | null {
    const tfile = this.app.vault.getAbstractFileByPath(file.path);
    if (tfile && tfile instanceof TFile) {
      const cache = this.app.metadataCache.getFileCache(tfile);
      if (!cache) return null;
      return {
        tags: cache.tags,
        frontmatter: cache.frontmatter
      };
    }
    return null;
  }

  getActiveFile(): IPlatformFile | null {
    return this.app.workspace.getActiveFile();
  }

  getConfigDir(): string {
    return this.app.vault.configDir;
  }

  async exists(path: string): Promise<boolean> {
    return await this.app.vault.adapter.exists(path);
  }

  async read(path: string): Promise<string> {
    return await this.app.vault.adapter.read(path);
  }

  async write(path: string, data: string): Promise<void> {
    await this.app.vault.adapter.write(path, data);
  }

  async delete(path: string): Promise<void> {
    await this.app.vault.adapter.remove(path);
  }

  async mkdir(path: string): Promise<void> {
    await this.app.vault.adapter.mkdir(path);
  }

  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    return await this.app.vault.adapter.list(path);
  }

  async loadPluginData(): Promise<MentatSettings> {
    return (await this.plugin.loadData()) as MentatSettings;
  }

  async savePluginData(data: MentatSettings): Promise<void> {
    await this.plugin.saveData(data);
  }

  getApp(): App {
    return this.app;
  }

  getVault(): Vault {
    return this.app.vault;
  }

  getWorkspace(): Workspace {
    return this.app.workspace;
  }

  getMetadataCache(): MetadataCache {
    return this.app.metadataCache;
  }

  getPlugin(): import('../main').default {
    return this.plugin as import('../main').default;
  }
}
