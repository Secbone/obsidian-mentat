import { IPlatformAdapter, IPlatformFile, IFileCache } from '../../src/types/platform';

export class MemoryPlatformAdapter implements IPlatformAdapter {
  files: Map<string, { content: string; file: IPlatformFile; cache?: IFileCache }> = new Map();
  pluginData: any = {};
  configDir: string = '.obsidian';
  activeFile: IPlatformFile | null = null;

  // Helpers to prepopulate memory filesystem
  addFile(
    path: string,
    content: string,
    stat: { mtime: number; size: number } = { mtime: Date.now(), size: content.length },
    cache?: IFileCache
  ): IPlatformFile {
    const name = path.split('/').pop() || path;
    const extension = name.split('.').pop() || '';
    
    const segments = path.split('/');
    let parent = null;
    if (segments.length > 1) {
      parent = {
        path: segments.slice(0, -1).join('/')
      };
    }

    const file: IPlatformFile = {
      path,
      name,
      extension,
      stat: {
        mtime: stat.mtime,
        size: stat.size,
        ctime: Date.now()
      },
      parent
    };
    this.files.set(path, { content, file, cache });
    return file;
  }

  getMarkdownFiles(): IPlatformFile[] {
    return Array.from(this.files.values())
      .filter(item => item.file.extension === 'md')
      .map(item => item.file);
  }

  getFileByPath(path: string): IPlatformFile | null {
    const item = this.files.get(path);
    return item ? item.file : null;
  }

  async readFile(file: IPlatformFile): Promise<string> {
    const item = this.files.get(file.path);
    if (item) {
      return item.content;
    }
    throw new Error(`File not found: ${file.path}`);
  }

  getFileCache(file: IPlatformFile): IFileCache | null {
    const item = this.files.get(file.path);
    return item && item.cache ? item.cache : null;
  }

  getActiveFile(): IPlatformFile | null {
    return this.activeFile;
  }

  getConfigDir(): string {
    return this.configDir;
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }

  async read(path: string): Promise<string> {
    const item = this.files.get(path);
    if (item) {
      return item.content;
    }
    throw new Error(`File not found: ${path}`);
  }

  async write(path: string, data: string): Promise<void> {
    const item = this.files.get(path);
    if (item) {
      item.content = data;
      item.file.stat.size = data.length;
      item.file.stat.mtime = Date.now();
    } else {
      this.addFile(path, data);
    }
  }

  async delete(path: string): Promise<void> {
    this.files.delete(path);
  }

  async mkdir(path: string): Promise<void> {
    // Memory simulation doesn't strictly need directory structure, but we can support folder creation implicitly
  }

  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    const files: string[] = [];
    const folders: string[] = [];
    const normalizedPath = path.endsWith('/') ? path : path + '/';
    
    for (const key of this.files.keys()) {
      if (key.startsWith(normalizedPath)) {
        const relative = key.slice(normalizedPath.length);
        if (relative.includes('/')) {
          const folder = relative.split('/')[0];
          if (!folders.includes(folder)) {
            folders.push(folder);
          }
        } else if (relative) {
          files.push(relative);
        }
      }
    }
    return { files, folders };
  }

  async loadPluginData(): Promise<any> {
    return this.pluginData;
  }

  async savePluginData(data: any): Promise<void> {
    this.pluginData = data;
  }
}
