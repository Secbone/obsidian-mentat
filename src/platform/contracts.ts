/**
 * Platform layer contracts — host-agnostic "knowledge workspace" abstraction.
 *
 * Discipline (docs/mentat-architecture-clean.md §3.6): NO host types
 * (Obsidian App/Vault/Workspace/MetadataCache/TFile) ever appear in these
 * interfaces. The replacement unit is the whole host (Obsidian -> headless);
 * optional capabilities are optional service names (a component injecting a
 * missing capability stays pending via Cordis reactive dependencies).
 */

/** A document in the workspace (platform-neutral file metadata). */
export interface Doc {
  path: string;
  name: string;
  extension: string;
  stat: { mtime: number; size: number; ctime: number };
  parent?: { path: string } | null;
}

/** Core: document store — every platform must implement. */
export interface DocumentStore {
  /** List documents, optionally scoped to a directory. */
  listDocuments(dir?: string): Doc[];
  /** Find a document by path, or null. */
  getDocument(path: string): Doc | null;
  readDocument(doc: Doc): Promise<string>;
  writeDocument(path: string, content: string): Promise<void>;
  moveDocument(from: string, to: string): Promise<void>;
  deleteDocument(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
  /** Optional: notify on file changes under a path. */
  watch?(path: string, callback: (changed: string) => void): () => void;
}

export interface SearchResult {
  path: string;
  snippet?: string;
  score?: number;
}

/** Core: full-text search — every platform must implement. */
export interface SearchCapability {
  search(query: string, scope?: string): Promise<SearchResult[]>;
}

/** Core: persistent key-value storage + config directory. */
export interface StorageCapability {
  loadData(): Promise<Record<string, unknown>>;
  saveData(data: Record<string, unknown>): Promise<void>;
  getConfigDir(): string;
}

export interface Backlink {
  source: string;
  excerpt?: string;
}

/** Optional capability: document graph (wikilinks/backlinks/tags/frontmatter). */
export interface GraphCapability {
  getBacklinks(path: string): Backlink[];
  getLinks(path: string): string[];
  getTags(path: string): string[];
  getFrontmatter(path: string): Record<string, unknown> | null;
}

/** Optional capability: current workspace context. */
export interface WorkspaceCapability {
  getActiveDocument(): Doc | null;
  onActiveChange?(callback: (doc: Doc | null) => void): () => void;
}

export interface ConfirmRequest {
  message: string;
  detail?: string;
  /** Who is asking (e.g. a tool name or a permission scope). */
  scope: string;
}

/** Optional capability: user notifications and confirmations (headless: none). */
export interface NotifyCapability {
  notify(message: string, timeout?: number): void;
  confirm(request: ConfirmRequest): Promise<boolean>;
}

/**
 * The platform root: one host plugin providing fine-grained service names.
 * `documents`/`search`/`storage` are always provided; `graph`/`workspace`/
 * `ui` are optional and may be absent on minimal platforms.
 */
export interface Platform {
  readonly id: string; // 'obsidian' | 'headless' | 'server' | ...
  readonly displayName: string;
  documents: DocumentStore;
  search: SearchCapability;
  storage: StorageCapability;
  graph?: GraphCapability;
  workspace?: WorkspaceCapability;
  ui?: NotifyCapability;
}

/** Service names provided by a platform plugin (fine-grained dependency slots). */
export const PLATFORM_SERVICES = [
  'documents',
  'search',
  'storage',
  'graph',
  'workspace',
  'ui',
] as const;
