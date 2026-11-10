import { DiagnosticsLogger } from '../agents/agent-types';
import { Notice } from 'obsidian';

import { redactDiagnostics } from '../observability/redaction';
export { redactDiagnostics } from '../observability/redaction';
import type { Observer } from '../observability/observer';


/**
 * VaultDiagnosticsLogger - Writes tool execution and parsing incident reports
 * directly into the Obsidian vault adapter under `.mentat/diagnostics.jsonl`.
 */
export class VaultDiagnosticsLogger implements DiagnosticsLogger {
  private vault: { adapter: { exists: (path: string) => Promise<boolean>; mkdir: (path: string) => Promise<void>; append: (path: string, data: string) => Promise<void> } } | null;

  private pending: Promise<void> = Promise.resolve();
  private warned = false;

  constructor(vault: { adapter: { exists: (path: string) => Promise<boolean>; mkdir: (path: string) => Promise<void>; append: (path: string, data: string) => Promise<void> } } | null, private secrets: () => string[] = () => [], private observer?: Observer) {
    this.vault = vault;
  }

  async logIncident(incident: Parameters<DiagnosticsLogger['logIncident']>[0]): Promise<void> {
    if (this.observer) {
      this.observer.event('diagnostic:incident', { component: 'skills', sessionId: incident.sessionId, runId: incident.runId, level: incident.success ? 'info' : 'error', attributes: incident });
      return;
    }
    const safe = redactDiagnostics({ timestamp: Date.now(), time: new Date().toISOString(), ...incident }, this.secrets());
    const write = this.pending.catch(() => undefined).then(async () => {
    try {
      if (!this.vault) return;

      const logDir = '.mentat';
      const logPath = `${logDir}/diagnostics.jsonl`;

      // Check if folder exists, if not, create it
      if (!(await this.vault.adapter.exists(logDir))) {
        await this.vault.adapter.mkdir(logDir);
      }

      await this.vault.adapter.append(logPath, JSON.stringify(safe) + '\n');
    } catch (err) {
      console.error('[VaultDiagnosticsLogger] Failed to write diagnostic log:', err);
      if (!this.warned) { this.warned = true; new Notice('诊断日志写入失败，请检查存储权限；本次错误可能未落盘。'); }
    }
    });
    this.pending = write;
    await write;
  }
}
