import { errorDetails } from '../utils/execution';
import { redactDiagnostics } from './redaction';
import type { EventInput, ObservationEvent } from './types';
import { LogStore } from './log-store';

/** Normalize before either persistence or live delivery; never copy model/tool bodies. */
function bounded(value: unknown, depth = 0, seen = new WeakSet<object>(), truncate = true): unknown {
  if (depth > 6) return '[DEPTH LIMIT]';
  if (typeof value === 'string') return truncate && value.length > 4000 ? value.slice(0, 4000) + ' [TRUNCATED]' : value;
  if (!value || typeof value !== 'object') return typeof value === 'bigint' ? String(value) : value;
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  const result = Array.isArray(value) ? value.slice(0, 20).map(v => bounded(v, depth + 1, seen, truncate))
    : Object.fromEntries(Object.entries(value).slice(0, 40).map(([k, v]) => [k,
      /^(content|prompt|messages|originalArgs|repairedArgs|arguments|reasoning_content|providerState|partialContent|body|data|answer|result)$/i.test(k)
        ? '[PAYLOAD OMITTED]' : bounded(v, depth + 1, seen, truncate)]));
  seen.delete(value);
  return result;
}
export class Observer {
  private sequence = 0;
  private listeners = new Set<(event: ObservationEvent) => void>();
  private recent: ObservationEvent[] = [];
  readonly processInstanceId = `process-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  constructor(readonly store: LogStore, private secrets: () => string[] = () => []) {}
  event(name: string, input: EventInput = {}): void {
    try {
      const sequence = ++this.sequence;
      // Redact before truncation, so cutting a secret never exposes its prefix.
      const safe = bounded(redactDiagnostics(bounded(input, 0, new WeakSet(), false), this.secrets())) as EventInput;
      const event: ObservationEvent = { ...safe, schemaVersion: 1, eventId: safe.eventId || `${this.processInstanceId}:${sequence}`,
        timestamp: safe.timestamp ?? Date.now(), processInstanceId: this.processInstanceId, sequence,
        name, component: safe.component || 'runtime', level: safe.level || (/(failed|error|incident)/.test(name) ? 'error' : /interrupted|unknown/.test(name) ? 'warn' : 'info') };
      if (JSON.stringify(event).length > 24000) event.attributes = { truncated: true, preview: JSON.stringify(event.attributes).slice(0, 16000) };
      this.recent.push(event);
      if (this.recent.length > 500) this.recent.shift();
      this.store.enqueue(event);
      for (const listener of this.listeners) { try { listener(event); } catch { /* A broken viewer cannot break execution. */ } }
    } catch { this.store.health.dropped++; console.error('[Mentat Observer] Unable to normalize event'); }
  }
  error(name: string, error: unknown, input: EventInput = {}): void {
    this.event(name, { ...input, level: 'error', attributes: { ...input.attributes, error: errorDetails(error) } });
  }
  async task<T>(name: string, action: () => Promise<T>, input: EventInput = {}): Promise<T> {
    const started = performance.now();
    this.event(`${name}:started`, input);
    try {
      const result = await action();
      this.event(`${name}:completed`, { ...input, durationMs: performance.now() - started });
      return result;
    } catch (error) {
      this.error(`${name}:failed`, error, { ...input, durationMs: performance.now() - started });
      throw error;
    }
  }
  sanitize(event: ObservationEvent): ObservationEvent {
    return bounded(redactDiagnostics(bounded(event, 0, new WeakSet(), false), this.secrets())) as ObservationEvent;
  }
  snapshot(): ObservationEvent[] { return [...this.recent]; }
  subscribe(listener: (event: ObservationEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async query(): Promise<ObservationEvent[]> {
    const persisted = await this.store.read();
    return [...new Map([...persisted, ...this.recent].map(e => [e.eventId, e])).values()].sort((a,b) => a.timestamp - b.timestamp || a.sequence - b.sequence);
  }
}
