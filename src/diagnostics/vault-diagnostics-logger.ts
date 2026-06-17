import { DiagnosticsLogger } from '../agents/agent-types';

/**
 * VaultDiagnosticsLogger - Writes tool execution and parsing incident reports
 * directly into the Obsidian vault adapter under `.mentat/diagnostics.jsonl`.
 */
export class VaultDiagnosticsLogger implements DiagnosticsLogger {
  private vault: { adapter: { exists: (path: string) => Promise<boolean>; mkdir: (path: string) => Promise<void>; append: (path: string, data: string) => Promise<void> } } | null;

  constructor(vault: { adapter: { exists: (path: string) => Promise<boolean>; mkdir: (path: string) => Promise<void>; append: (path: string, data: string) => Promise<void> } } | null) {
    this.vault = vault;
  }

  async logIncident(incident: {
    agentId: string;
    agentName: string;
    toolName: string;
    originalArgs: string;
    errorMessage: string;
    strategy: string;
    repairedArgs?: string;
    success: boolean;
  }): Promise<void> {
    try {
      if (!this.vault) return;

      const logDir = '.mentat';
      const logPath = `${logDir}/diagnostics.jsonl`;

      // Check if folder exists, if not, create it
      if (!(await this.vault.adapter.exists(logDir))) {
        await this.vault.adapter.mkdir(logDir);
      }

      const logEntry = {
        timestamp: Date.now(),
        time: new Date().toISOString(),
        ...incident
      };

      await this.vault.adapter.append(logPath, JSON.stringify(logEntry) + '\n');
    } catch (err) {
      console.error('[VaultDiagnosticsLogger] Failed to write diagnostic log:', err);
    }
  }
}
