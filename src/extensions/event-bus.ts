// EventBus - Simple typed pub/sub event system

import { AgentEvent } from '../agents/agent-types';

export type EventHandler = (event: AgentEvent) => void;

export class EventBus {
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
      try { handler(event); } catch (error) {
        console.error(`[EventBus] Handler error for event "${type}":`, error);
      }
    });

    // 2. Namespace wildcard: 'tool:*', 'context:compact:*', ...
    for (let i = 1; i < parts.length; i++) {
      const pattern = parts.slice(0, i).join(':') + ':*';
      this.handlers.get(pattern)?.forEach(handler => {
        try { handler(event); } catch (error) {
          console.error(`[EventBus] Handler error for pattern "${pattern}":`, error);
        }
      });
    }

    // 3. Global wildcard: '*'
    this.handlers.get('*')?.forEach(handler => {
      try { handler(event); } catch (error) {
        console.error(`[EventBus] Handler error for wildcard:`, error);
      }
    });
  }

  removeAll(): void {
    this.handlers.clear();
  }
}
