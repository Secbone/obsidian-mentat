import type { PluginObject, Context } from '../core/cordis';
import type { AgentEvent } from '../agents/agent-types';

export type EventHandler = (event: AgentEvent) => void;

/**
 * Event bridge (L4.1): a drop-in replacement for the legacy EventBus with the
 * SAME single-argument API (`on(name|'*', (event) => ...)`, `emit(event)`),
 * so UI consumers migrate without signature churn — but its underlying
 * mechanism is the kernel EventsService, giving lifecycle-managed listeners
 * (auto-disposed with the owning fiber) and realm isolation.
 *
 * New orchestration (agent-loop / backends) publishes via `emit(event)`; the
 * old UI's `eventBus.on('*', handler)` keeps working, now over the kernel bus.
 */
export class EventBridgeService {
  private ctx: Context;

  constructor(ctx: Context) {
    this.ctx = ctx;
  }

  /** Subscribe to an event name or wildcard; returns an unsubscriber. */
  on(event: string, handler: EventHandler): () => void {
    // Kernel ctx.on uses (subject, ...args); adapt to a single event object.
    const listener = (_subject: unknown, ...args: unknown[]) => {
      const ev = args[0] as AgentEvent;
      if (ev && typeof ev === 'object' && 'type' in ev) handler(ev);
    };
    return this.ctx.on(event, listener);
  }

  off(_event: string, _handler: EventHandler): void {
    // Kernel off is handled via the returned unsubscriber; off() kept for API
    // parity is a best-effort no-op (listeners are lifecycle-managed).
  }

  once(event: string, handler: EventHandler): () => void {
    const unsub = this.on(event, (ev) => { unsub(); handler(ev); });
    return unsub;
  }

  /** Publish an agent event to the kernel bus (bridge for new orchestration). */
  emit(event: AgentEvent): void {
    // Namespaced by event type so kernel exact + wildcard matching works, and
    // also always reachable via the '*' global wildcard.
    this.ctx.emit(event.type, event);
  }
}

export const EventBridgeServicePlugin: PluginObject = {
  inject: [],
  apply(ctx: Context) {
    return ctx.provide('event-bridge', new EventBridgeService(ctx));
  },
};

// Re-export for tests/consumers.
export type { AgentEvent };
