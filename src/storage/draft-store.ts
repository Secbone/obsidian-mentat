/** Session drafts are separate from plugin settings and never write data.json. */
export interface DraftStore {
  load(sessionId: string): Promise<string | null>;
  save(sessionId: string, html: string): Promise<void>;
  clear(sessionId: string): Promise<void>;
  flush(): Promise<void>;
}

export interface DraftFileIO {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
  mkdir(path: string): Promise<void>;
}

interface DraftFile {
  version: 1;
  legacyMigrated: boolean;
  drafts: Record<string, string>;
}

function legacyDrafts(legacy: unknown): Record<string, string> {
  return legacy && typeof legacy === 'object' && !Array.isArray(legacy)
    ? Object.fromEntries(Object.entries(legacy).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : {};
}

/** Keep editing usable during storage failure without claiming that a draft was saved. */
class UnavailableDraftStore implements DraftStore {
  private drafts: Record<string, string>;
  constructor(legacy: unknown) { this.drafts = legacyDrafts(legacy); }
  async load(sessionId: string): Promise<string | null> {
    return Object.prototype.hasOwnProperty.call(this.drafts, sessionId) ? this.drafts[sessionId] : null;
  }
  async save(sessionId: string, html: string): Promise<void> {
    this.drafts = { ...this.drafts, [sessionId]: html };
    throw new Error('草稿存储不可用，本次草稿仅保留在内存，重启后可能丢失。');
  }
  async clear(sessionId: string): Promise<void> {
    delete this.drafts[sessionId];
    throw new Error('草稿存储不可用，持久草稿未清除。');
  }
  async flush(): Promise<void> { /* No persistent writes were accepted. */ }
}

export async function initializeDraftStore(io: DraftFileIO, path: string, legacy: unknown,
  onFailure: (error: unknown) => void): Promise<{ store: DraftStore; migrated: boolean }> {
  const store = new FileDraftStore(io, path);
  try {
    await store.migrateLegacy(legacy);
    return { store, migrated: true };
  } catch (error) {
    onFailure(error);
    return { store: new UnavailableDraftStore(legacy), migrated: false };
  }
}

export class FileDraftStore implements DraftStore {
  private pending: Promise<void> = Promise.resolve();
  private state?: DraftFile;
  constructor(private io: DraftFileIO, readonly path: string) {}

  private serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.pending.then(action);
    this.pending = result.then(() => undefined, () => undefined);
    return result;
  }
  private parse(text: string): DraftFile {
    const data = JSON.parse(text);
    if (data?.version !== 1 || typeof data.legacyMigrated !== 'boolean' || !data.drafts || typeof data.drafts !== 'object'
      || Array.isArray(data.drafts) || Object.values(data.drafts).some(value => typeof value !== 'string')) throw new Error('草稿文件格式无效');
    return data as DraftFile;
  }
  private async read(): Promise<DraftFile> {
    if (this.state) return this.state;
    try {
      this.state = await this.io.exists(this.path) ? this.parse(await this.io.read(this.path))
        : await this.io.exists(`${this.path}.bak`) ? this.parse(await this.io.read(`${this.path}.bak`))
          : { version: 1, legacyMigrated: false, drafts: {} };
    } catch (error) {
      if (!await this.io.exists(`${this.path}.bak`)) throw error;
      this.state = this.parse(await this.io.read(`${this.path}.bak`));
    }
    return this.state;
  }
  private async write(next: DraftFile): Promise<void> {
    const segments = this.path.split('/').slice(0, -1);
    for (let i = 1; i <= segments.length; i++) {
      const folder = segments.slice(0, i).join('/');
      if (!await this.io.exists(folder)) await this.io.mkdir(folder);
    }
    if (this.state) await this.io.write(`${this.path}.bak`, JSON.stringify(this.state));
    const encoded = JSON.stringify(next);
    await this.io.write(this.path, encoded);
    if (await this.io.read(this.path) !== encoded) throw new Error('草稿写入校验失败');
    this.state = next;
  }
  /** Keep legacy data untouched until a verified, repeatable import has completed. */
  migrateLegacy(legacy: unknown): Promise<void> {
    return this.serial(async () => {
      const current = await this.read();
      if (current.legacyMigrated) return;
      const drafts = legacyDrafts(legacy);
      await this.write({ version: 1, legacyMigrated: true, drafts: { ...drafts, ...current.drafts } });
    });
  }
  load(sessionId: string): Promise<string | null> {
    return this.serial(async () => {
      const { drafts } = await this.read();
      return Object.prototype.hasOwnProperty.call(drafts, sessionId) ? drafts[sessionId] : null;
    });
  }
  save(sessionId: string, html: string): Promise<void> {
    return this.serial(async () => {
      const current = await this.read();
      await this.write({ ...current, drafts: { ...current.drafts, [sessionId]: html } });
    });
  }
  clear(sessionId: string): Promise<void> {
    return this.serial(async () => {
      const current = await this.read();
      if (!Object.prototype.hasOwnProperty.call(current.drafts, sessionId)) return;
      const drafts = { ...current.drafts }; delete drafts[sessionId];
      await this.write({ ...current, drafts });
    });
  }
  async flush(): Promise<void> { await this.pending; }
}
