import type { Doc, DocumentStore, SearchCapability, StorageCapability, Platform } from '../contracts';

/**
 * Headless platform (L5.2): a minimal host-agnostic implementation over the
 * local filesystem — proves the platform contracts are truly host-independent.
 * No graph/workspace/ui (optional capabilities absent), so components that
 * inject those stay pending automatically.
 */
export class HeadlessPlatform implements Platform {
  readonly id = 'headless';
  readonly displayName = 'Headless';
  readonly documents: DocumentStore;
  readonly search: SearchCapability;
  readonly storage: StorageCapability;

  constructor(private rootDir: string, private configDir: string) {
    this.documents = new HeadlessDocuments(rootDir);
    this.search = new HeadlessSearch(rootDir);
    this.storage = new HeadlessStorage(configDir);
  }
}

class HeadlessDocuments implements DocumentStore {
  constructor(private root: string) {}

  listDocuments(dir?: string): Doc[] {
    const base = dir ? this.resolve(dir) : this.root;
    return walkMarkdown(base).map((p) => this.toDoc(p));
  }

  getDocument(path: string): Doc | null {
    const full = this.resolve(path);
    return existsSync(full) && full.endsWith('.md') ? this.toDoc(full) : null;
  }

  async readDocument(doc: Doc): Promise<string> { return readFileSync(this.resolve(doc.path), 'utf-8'); }
  async writeDocument(path: string, content: string): Promise<void> { writeFileSync(this.resolve(path), content, 'utf-8'); }
  async moveDocument(from: string, to: string): Promise<void> { renameSync(this.resolve(from), this.resolve(to)); }
  async deleteDocument(path: string): Promise<void> { unlinkSync(this.resolve(path)); }
  async exists(path: string): Promise<boolean> { return existsSync(this.resolve(path)); }
  async mkdir(path: string): Promise<void> { mkdirSync(this.resolve(path), { recursive: true }); }
  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    const full = this.resolve(path);
    const entries = fs.readdirSync(full, { withFileTypes: true });
    return {
      files: entries.filter((e) => e.isFile()).map((e) => e.name),
      folders: entries.filter((e) => e.isDirectory()).map((e) => e.name),
    };
  }
  watch(_path: string, _cb: (changed: string) => void): () => void { return () => {}; }

  private resolve(p: string): string { return path.resolve(this.root, p); }
  private toDoc(p: string): Doc {
    const st = fs.statSync(p);
    return { path: path.relative(this.root, p), name: path.parse(p).name, extension: path.extname(p).slice(1), stat: { mtime: st.mtimeMs, size: st.size, ctime: st.ctimeMs }, parent: { path: path.dirname(p) } };
  }
}

class HeadlessSearch implements SearchCapability {
  constructor(private root: string) {}
  async search(query: string): Promise<Array<{ path: string; snippet?: string; score?: number }>> {
    const out: Array<{ path: string; snippet?: string; score?: number }> = [];
    for (const f of walkMarkdown(this.root)) {
      const text = fs.readFileSync(f, 'utf-8');
      if (text.toLowerCase().includes(query.toLowerCase())) {
        out.push({ path: f, snippet: text.slice(0, 120) });
      }
    }
    return out;
  }
}

class HeadlessStorage implements StorageCapability {
  constructor(private configDir: string) {}
  async loadData(): Promise<Record<string, unknown>> {
    try { return JSON.parse(fs.readFileSync(path.join(this.configDir, 'mentat-data.json'), 'utf-8')); } catch { return {}; }
  }
  async saveData(data: Record<string, unknown>): Promise<void> {
    fs.mkdirSync(this.configDir, { recursive: true });
    fs.writeFileSync(path.join(this.configDir, 'mentat-data.json'), JSON.stringify(data, null, 2));
  }
  getConfigDir(): string { return this.configDir; }
}

// Node fs helpers (proves headless can run outside Obsidian).
import { existsSync, writeFileSync, readFileSync, renameSync, unlinkSync, mkdirSync } from 'fs';
import path from 'path';
import * as fs from 'fs';

function walkMarkdown(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (!full.includes('node_modules')) out.push(...walkMarkdown(full)); }
    else if (full.endsWith('.md')) out.push(full);
  }
  return out;
}
