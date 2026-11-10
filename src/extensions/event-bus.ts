// EventBus - Simple typed pub/sub event system

import { AgentEvent } from '../agents/agent-types';

export type EventHandler = (event: AgentEvent) => void;

export class EventBus {
  constructor(private onError?: (error: unknown, eventType: string) => void) {}
  private invoke(handler: EventHandler, event: AgentEvent): void {
    try {
      const result = handler(event) as unknown;
      if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
        void Promise.resolve(result).catch(error => this.report(error, event.type));
      }
    } catch (error) { this.report(error, event.type); }
  }
  private report(error: unknown, type: string): void {
    try { this.onError?.(error, type); } catch { /* Observability must not break dispatch. */ }
    if (!this.onError) console.error(`[EventBus] Handler error for ${type}:`, error);
  }
  private handlers = new Map<string, Set<EventHandler>>();

  on(event: string, handler: EventHandler): () => void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler);
    return () => this.off(event, handler);
  }

  off(event: string, handler: EventHandler): void {
    this.handlers.get(event)?.delete(handler);
  }

  emit(event: AgentEvent): void {
    const type = event.type;
    const parts = type.split(':');

    // 1. Exact match: 'tool:end'
    this.handlers.get(type)?.forEach(handler => {
      this.invoke(handler, event);
    });

    // 2. Namespace wildcard: 'tool:*', 'context:compact:*', ...
    for (let i = 1; i < parts.length; i++) {
      const pattern = parts.slice(0, i).join(':') + ':*';
      this.handlers.get(pattern)?.forEach(handler => {
        this.invoke(handler, event);
      });
    }

    // 3. Global wildcard: '*'
    this.handlers.get('*')?.forEach(handler => {
      this.invoke(handler, event);
    });
  }

  removeAll(): void {
    this.handlers.clear();
  }
}
