import type { PluginObject, Context } from '../core/cordis';
import { DiagnosticsExporter } from './diagnostics-exporter';
import type { ChatManager } from '../chat/chat-manager';
import type MentatPlugin from '../main';

/**
 * Crosscutting service: unified diagnostics surface.
 *
 * Provides a stable `diagnostics` service (log + session export + open log)
 * so components can emit structured diagnostics without knowing the host,
 * while keeping the existing export implementation.
 */
export interface DiagnosticsApi {
  log(level: 'info' | 'warn' | 'error', message: string, data?: unknown): void;
  exportSession(chatManager: ChatManager): Promise<string | null>;
  openLog(): Promise<void>;
}

export const DiagnosticsService: PluginObject = {
  inject: ['mentatPlugin'],
  apply(ctx: Context) {
    const plugin = ctx.get<MentatPlugin>('mentatPlugin', false)!;
    const api: DiagnosticsApi = {
      log(level, message, data) {
        if (level === 'error') console.error(`[Mentat] ${message}`, data ?? '');
        else if (level === 'warn') console.warn(`[Mentat] ${message}`, data ?? '');
        else console.log(`[Mentat] ${message}`, data ?? '');
      },
      async exportSession(chatManager) {
        return DiagnosticsExporter.exportSession(plugin, chatManager);
      },
      async openLog() {
        await DiagnosticsExporter.generateAndOpenDiagnosticsLog(plugin);
      },
    };
    return ctx.provide('diagnostics', api);
  },
};
