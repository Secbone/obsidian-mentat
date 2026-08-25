import type { LoggerExporter, LogMessage } from './logger.service';

/** An append primitive provided by the platform (Obsidian adapter or fs). */
export type AppendFn = (path: string, data: string) => Promise<void>;

export interface FileLogSinkOptions {
  /** Base directory for logs (e.g. `<configDir>/.mentat/logs`). */
  dir: string;
  append: AppendFn;
  /** Per-name level overrides. */
  levels?: Record<string, number>;
  /** Preserve < N days; older files removed on init. */
  keepDays?: number;
  /** Extra static context merged into every message. */
  staticContext?: Record<string, unknown>;
}

/**
 * FileLogSink: a LoggerService exporter that appends structured messages as
 * JSONL, one file per day. This is the durable, grep-able diagnostics surface
 * for troubleshooting (e.g. the real cause behind a "Connection error.").
 *
 * It is purely a sink — all formatting/filtering is done by LoggerService —
 * so it integrates as just another exporter (console + ring + file coexist).
 */
export class FileLogSink implements LoggerExporter {
  readonly name = 'file';
  levels?: Record<string, number>;
  private dir: string;
  private append: AppendFn;
  private staticContext: Record<string, unknown>;

  constructor(options: FileLogSinkOptions) {
    this.dir = options.dir;
    this.append = options.append;
    this.levels = options.levels;
    this.staticContext = options.staticContext ?? {};
  }

  async export(message: LogMessage): Promise<void> {
    const file = this.fileFor(message.ts);
    const entry = {
      ts: message.iso,
      sn: message.sn,
      level: message.level,
      name: message.name,
      fiber: message.fiber,
      context: { ...this.staticContext, ...message.context },
      message: stringifyArgs(message.args),
      errorChain: message.errorChain,
    };
    await this.append(file, JSON.stringify(entry) + '\n');
  }

  /** The per-day JSONL path. */
  private fileFor(ts: number): string {
    const d = new Date(ts);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${this.dir}/mentat-${y}-${m}-${day}.jsonl`;
  }
}

/** Stringify args into one line (mirrors Logger format, returns a string). */
function stringifyArgs(args: unknown[]): string {
  return args.map((a) => {
    if (a instanceof Error) return a.stack || a.message;
    if (typeof a === 'object' && a !== null) return safeJson(a);
    return String(a);
  }).join(' ');
}

function safeJson(a: unknown): string {
  try { return JSON.stringify(a); } catch { return String(a); }
}
