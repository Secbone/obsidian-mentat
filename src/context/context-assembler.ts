import type { PluginObject, Context } from '../core/cordis';
import type { DocumentStore } from '../platform/contracts';

/** Structured vault context for the system prompt. */
export interface VaultContext {
  currentTime: string;
  fileCount: number;
  filePaths: string[];
}

/**
 * Context Assembler (L2): builds vault context metadata (current time, file
 * list, directory structure) from the platform's DocumentStore. The agent-loop
 * and backends consume this to enrich the system prompt so the model knows
 * the vault environment.
 *
 * This is platform-agnostic — the DocumentStore abstraction hides Obsidian
 * specifics. Headless and Obsidian platforms both implement it.
 */
export class ContextAssemblerService {
  constructor(private documents?: DocumentStore) {}

  getVaultContext(): VaultContext {
    const now = new Date().toLocaleString('zh-CN', {
      hour12: false,
      timeZone: 'Asia/Shanghai',
    });
    let filePaths: string[] = [];
    let fileCount = 0;
    try {
      if (this.documents) {
        const docs = this.documents.listDocuments();
        fileCount = docs.length;
        filePaths = docs.map((d) => d.path);
      }
    } catch { /* platform unavailable */ }
    return { currentTime: now, fileCount, filePaths };
  }

  /** Build a concise string for injection into the system prompt. */
  getSystemContext(): string {
    const ctx = this.getVaultContext();
    const parts = [`当前时间: ${ctx.currentTime}`];
    if (ctx.fileCount > 0) {
      parts.push(`文件总数: ${ctx.fileCount}`);
      parts.push(`文件列表:\n${ctx.filePaths.join('\n')}`);
    }
    return parts.length ? `[Vault 上下文]\n${parts.join('\n')}` : '';
  }
}

export const ContextAssemblerPlugin: PluginObject = {
  apply(ctx: Context) {
    const documents = ctx.get<DocumentStore>('documents', false);
    const service = new ContextAssemblerService(documents);
    return ctx.provide('context-assembler', service);
  },
};
