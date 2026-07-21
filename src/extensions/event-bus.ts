// EventBus - Simple typed pub/sub event system for extensions

export type EventHandler<T = unknown> = (data: T) => void;

export interface ExtensionEvents {
  'agent_start': {};
  'agent_end': { messages: unknown[] };
  'turn_start': { turnIndex: number };
  'turn_end': { turnIndex: number; messages: unknown[] };
  'before_tool': { toolCallId: string; toolName: string; args: unknown };
  'after_tool': { toolCallId: string; toolName: string; result: unknown; isError: boolean };
  'settings_changed': { settings: Record<string, unknown> };
}

export class EventBus {
  private handlers = new Map<string, Set<EventHandler>>();

  on<K extends keyof ExtensionEvents>(event: K, handler: EventHandler<ExtensionEvents[K]>): () => void {
    if (!this.handlers.has(event as string)) {
      this.handlers.set(event as string, new Set());
    }
    this.handlers.get(event as string)!.add(handler as EventHandler);
    return () => this.off(event, handler);
  }

  off<K extends keyof ExtensionEvents>(event: K, handler: EventHandler<ExtensionEvents[K]>): void {
    this.handlers.get(event as string)?.delete(handler as EventHandler);
  }

  emit<K extends keyof ExtensionEvents>(event: K, data: ExtensionEvents[K]): void {
    this.handlers.get(event as string)?.forEach(handler => {
      try {
        handler(data);
      } catch (error) {
        console.error(`[EventBus] Handler error for event "${event as string}":`, error);
      }
    });
  }

  removeAll(): void {
    this.handlers.clear();
  }
}
