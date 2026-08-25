import type { PluginObject, Context } from '../core/cordis';

export type LogLevel = 'error' | 'info' | 'warn' | 'debug';
const LEVELS: Record<LogLevel, number> = { error: 0, info: 1, warn: 2, debug: 3 };

export interface LogContext {
  sessionId?: string;
  agentId?: string;
  providerId?: string;
  toolName?: string;
  [key: string]: unknown;
}

/** A structured log message emitted to every exporter. */
export interface LogMessage {
  sn: number;
  ts: number;
  iso: string;
  level: LogLevel;
  /** The named logger (e.g. 'provider:deepseek'). */
  name: string;
  /** Owning fiber name (auto-derived; optional fallback). */
  fiber?: string;
  context?: LogContext;
  args: unknown[];
  /** Unwrapped error chain, when the message came from an Error. */
  errorChain?: string;
}

export interface LoggerExporter {
  name: string;
  export(message: LogMessage): void;
  /** Per-name level override: `{ 'provider:x': 3 }` or `{ default: 2 }`. */
  levels?: Record<string, number>;
}

/** Unwrap the cause chain of an error into a single readable string. */
export function errorChain(error: unknown): string {
  const parts: string[] = [];
  let cur: unknown = error;
  const seen = new Set<unknown>();
  while (cur instanceof Error && !seen.has(cur)) {
    seen.add(cur);
    parts.push(cur.message);
    cur = (cur as { cause?: unknown }).cause;
  }
  return parts.join(' ← ');
}

/**
 * Logger facade for one named subsystem (Cordis `Logger`).
 * Auto-derives its name from the owning fiber when not given explicitly.
 */
export class Logger {
  constructor(private service: LoggerService, private options: { name?: string; level?: LogLevel; context?: LogContext } = {}) {}

  private get name(): string {
    return this.options.name ?? this.service.defaultName();
  }
  private get level(): number {
    return LEVELS[this.options.level ?? 'info'];
  }

  private _method(type: LogLevel): (...args: unknown[]) => void {
    const level = LEVELS[type];
    return (...args: unknown[]) => {
      const sn = ++this.service.sn;
      const ts = Date.now();
      const msg: LogMessage = {
        sn, ts, iso: new Date(ts).toISOString(),
        level: type, name: this.name, fiber: this.service.currentFiber(),
        context: this.options.context,
        args,
        errorChain: args[0] instanceof Error ? errorChain(args[0]) : undefined,
      };
      this.service.emit(msg, level);
    };
  }

  error(...args: unknown[]): void { this._method('error')(...args); }
  warn(...args: unknown[]): void { this._method('warn')(...args); }
  info(...args: unknown[]): void { this._method('info')(...args); }
  debug(...args: unknown[]): void { this._method('debug')(...args); }
}

/**
 * LoggerService (Cordis-style): a registry of exporters + named loggers.
 * Uses the kernel context so exporter registration is a reversible effect
 * (auto-disposed with the owning fiber), and a default in-memory ring buffer
 * exporter so recent messages are always available for diagnostics.
 */
export class LoggerService {
  sn = 0;
  private exporters = new Map<number, LoggerExporter>();
  bufferSize = 1000;
  private buffer: LogMessage[] = [];
  private ctx: Context;

  constructor(ctx: Context) {
    this.ctx = ctx;
    // Default ring-buffer exporter (diagnostics, always on).
    this.addExporter({
      name: 'ring',
      export: (m) => {
        this.buffer.push(m);
        if (this.buffer.length > this.bufferSize) this.buffer = this.buffer.slice(-this.bufferSize);
      },
    });
  }

  /** Register an exporter as a reversible effect on the current fiber. */
  addExporter(exporter: LoggerExporter): () => void {
    if (this.ctx.fiber) {
      const dispose = this.ctx.fiber.effect(() => {
        const id = ++this.sn;
        this.exporters.set(id, exporter);
        return () => this.exporters.delete(id);
      }, 'logger.exporter()');
      return dispose as unknown as () => void;
    }
    const id = ++this.sn;
    this.exporters.set(id, exporter);
    return () => this.exporters.delete(id);
  }

  /** Named logger; name derived from fiber when omitted. */
  get(name?: string, context?: LogContext): Logger {
    return new Logger(this, { name, context });
  }

  /** Derive a default name from the current fiber. */
  defaultName(): string {
    return this.currentFiber() || 'app';
  }

  /** The owning fiber's name (from the kernel context). */
  currentFiber(): string {
    const fiber = (this.ctx as { fiber?: { name?: string } }).fiber;
    return fiber?.name ?? 'root';
  }

  emit(msg: LogMessage, level: number): void {
    for (const exporter of this.exporters.values()) {
      const allowed = exporter.levels?.[msg.name] ?? exporter.levels?.default ?? level;
      if (allowed < level) continue;
      try {
        exporter.export({ ...msg, args: [...msg.args] });
      } catch (err) {
        // Never let a sink break logging.
        console.error('[logger] exporter failed:', err);
      }
    }
  }

  /** Recent messages from the ring buffer (for diagnostics/export). */
  recent(filter?: { name?: string; level?: LogLevel; since?: number }): LogMessage[] {
    let out = this.buffer;
    if (filter?.name) out = out.filter((m) => m.name === filter.name);
    if (filter?.level) { const lv = LEVELS[filter.level]; out = out.filter((m) => LEVELS[m.level] >= lv); }
    if (filter?.since) out = out.filter((m) => m.ts >= filter.since!);
    return out;
  }

  /** Clear the ring buffer. */
  clear(): void { this.buffer = []; }
}

export const LoggerServicePlugin: PluginObject = {
  apply(ctx: Context) {
    const logger = new LoggerService(ctx);
    return ctx.provide('logger', logger);
  },
};
