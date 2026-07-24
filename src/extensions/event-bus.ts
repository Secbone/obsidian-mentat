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
    this.handlers.get(event.type)?.forEach(handler => {
      try { handler(event); } catch (error) {
        console.error(`[EventBus] Handler error for event "${event.type}":`, error);
      }
    });
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
