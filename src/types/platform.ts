import type { MentatSettings } from '../settings/settings';
import { App, Vault, Workspace, MetadataCache } from 'obsidian';

export interface IPlatformFile {
  path: string;
  name: string;
  extension: string;
  stat: {
    mtime: number;
    size: number;
    ctime: number;
  };
  parent?: {
    path: string;
  } | null;
}

export interface IFileCache {
  tags?: Array<{ tag: string }>;
  frontmatter?: Record<string, unknown>;
}

export interface IPlatformAdapter {
  /**
   * Get all markdown files in the vault
   */
  getMarkdownFiles(): IPlatformFile[];

  /**
   * Find a file by its path in the vault
   */
  getFileByPath(path: string): IPlatformFile | null;

  /**
   * Read file content as text
   */
  readFile(file: IPlatformFile): Promise<string>;

  /**
   * Get caching metadata (tags, frontmatter, etc)
   */
  getFileCache(file: IPlatformFile): IFileCache | null;

  /**
   * Get currently active open file in workspace
   */
  getActiveFile(): IPlatformFile | null;

  /**
   * Get local plugin configuration directory configDir (e.g. '.obsidian')
   */
  getConfigDir(): string;

  // DataAdapter filesystem APIs
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
  delete(path: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  list(path: string): Promise<{ files: string[]; folders: string[] }>;

  // Plugin data storage APIs
  loadPluginData(): Promise<MentatSettings>;
  savePluginData(data: MentatSettings): Promise<void>;

  // Safe typed wrappers for underlying host instances
  getApp(): App;
  getVault(): Vault;
  getWorkspace(): Workspace;
  getMetadataCache(): MetadataCache;
  getPlugin(): import('../main').default;
}
