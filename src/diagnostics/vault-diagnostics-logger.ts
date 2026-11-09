import { DiagnosticsLogger } from '../agents/agent-types';
import { Notice } from 'obsidian';

export function redactDiagnostics(value: unknown, secrets: string[] = []): unknown {
  if (Array.isArray(value)) return value.map(item => redactDiagnostics(item, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /api.?key|authorization|password|secret|^(access|refresh|auth)[_-]?token$|^token$/i.test(key) ? '[REDACTED]' : redactDiagnostics(item, secrets)]));
  if (typeof value !== 'string') return value;
  if (/^(?:\{|\[)/.test(value.trim())) { try { return JSON.stringify(redactDiagnostics(JSON.parse(value), secrets)); } catch { /* plain text */ } }
  let text = value.replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, 'Bearer [REDACTED]').replace(/sk-[A-Za-z0-9_-]{12,}/g, '[REDACTED]').replace(/([?&](?:api_key|access_token|token|key)=)[^&\s]+/gi, '$1[REDACTED]');
  for (const secret of secrets.filter(Boolean)) text = text.split(secret).join('[REDACTED]');
  return text;
}


/**
 * VaultDiagnosticsLogger - Writes tool execution and parsing incident reports
 * directly into the Obsidian vault adapter under `.mentat/diagnostics.jsonl`.
 */
export class VaultDiagnosticsLogger implements DiagnosticsLogger {
  private vault: { adapter: { exists: (path: string) => Promise<boolean>; mkdir: (path: string) => Promise<void>; append: (path: string, data: string) => Promise<void> } } | null;

  private pending: Promise<void> = Promise.resolve();
  private warned = false;

  constructor(vault: { adapter: { exists: (path: string) => Promise<boolean>; mkdir: (path: string) => Promise<void>; append: (path: string, data: string) => Promise<void> } } | null, private secrets: () => string[] = () => []) {
    this.vault = vault;
  }

  async logIncident(incident: Parameters<DiagnosticsLogger['logIncident']>[0]): Promise<void> {
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
