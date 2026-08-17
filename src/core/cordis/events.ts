import type { Context } from './context';
import type { Disposable } from './utils';

export type EventFilter = (ctx: unknown) => boolean;

export interface EventHandler {
  (subject: unknown, ...args: unknown[]): unknown;
}

/** Listener filters are stored out-of-band so plain functions stay assignable. */
const filters = new WeakMap<EventHandler, EventFilter>();

export function setListenerFilter(handler: EventHandler, filter: EventFilter): void {
  filters.set(handler, filter);
}

export function getListenerFilter(handler: EventHandler): EventFilter | undefined {
  return filters.get(handler);
}

export interface EventOptions {
  /** Register once, then self-dispose on first emission. */
  once?: boolean;
}

/**
 * Typed-ish pub/sub event service, API-compatible with the Cordis 4
 * `EventsService` subset. Registering a listener is a *revertible effect* on
 * the owning fiber: the returned disposer unregisters it, and unloading the
 * fiber disposes every listener it registered.
 *
 * As a superset of Cordis (which uses exact names and the `internal/` prefix
 * convention), exact names, `name:*` namespace wildcards and the global `*`
 * wildcard are all matched, mirroring the existing Mentat EventBus.
 */
export class EventsService {
  private listeners = new Map<string, Set<EventHandler>>();

  constructor(private ctx: Context) {}

  private attach(name: string, handler: EventHandler): void {
    let set = this.listeners.get(name);
    if (!set) {
      set = new Set();
      this.listeners.set(name, set);
    }
    set.add(handler);
  }

  /**
   * Register a listener as an effect on the calling fiber (Cordis: listeners
   * are revertible effects, disposed automatically when the fiber unloads).
   * @returns a disposer that unregisters the listener.
   */
  on(ctx: Context, name: string, handler: EventHandler, options: EventOptions = {}): Disposable {
    return ctx.fiber.effect(() => {
      if (options.once) {
        const self = handler;
        const wrapper: EventHandler = (subject, ...args) => {
          this.off(this.ctx, name, wrapper);
          return self.call(subject, subject, ...args);
        };
        const inherited = getListenerFilter(self);
        if (inherited) setListenerFilter(wrapper, inherited);
        this.attach(name, wrapper);
        return () => this.off(this.ctx, name, wrapper);
      }
      this.attach(name, handler);
      return () => this.off(this.ctx, name, handler);
    }, `events.on(${JSON.stringify(name)})`);
  }

  /** Register a listener that disposes itself after the first call. */
  once(ctx: Context, name: string, handler: EventHandler): Disposable {
    return this.on(ctx, name, handler, { once: true });
  }

  /** Remove a listener. */
  off(_ctx: Context, name: string, handler: EventHandler): void {
    const set = this.listeners.get(name);
    if (!set) return;
    set.delete(handler);
    if (set.size === 0) this.listeners.delete(name);
  }

  /**
   * Emit an event with the Cordis dispatch signature: an optional leading
   * object/function argument is treated as the subject (`ctx.events.emit(subject,
   * name, ...)`), otherwise the current context is used (`ctx.emit(name, ...)`).
   * The subject is passed as the first argument to every listener.
   */
  emit(...args: unknown[]): boolean {
    const rest = [...args];
    const hasSubject = (typeof rest[0] === 'object' && rest[0] !== null) || typeof rest[0] === 'function';
    const subject: unknown = hasSubject ? rest.shift() : this.ctx;
    const name = rest.shift() as string;
    if (typeof name !== 'string') {
      throw new TypeError(`[EventsService] emit requires an event name, received ${String(name)}`);
    }
    const fired = new Set<EventHandler>();
    const fire = (handler: EventHandler): void => {
      if (fired.has(handler)) return;
      const filter = getListenerFilter(handler);
      if (filter && !filter(subject)) return;
      fired.add(handler);
      try {
        handler.call(subject, subject, ...rest);
      } catch (error) {
        console.error(`[EventsService] Listener error for "${name}":`, error);
      }
    };

    // 1. Exact match.
    const exact = this.listeners.get(name);
    if (exact) for (const handler of [...exact]) fire(handler);

    // 2. Namespace wildcard: 'tool:*', 'context:compact:*', ...
    const parts = name.split(':');
    for (let i = 1; i < parts.length; i++) {
      const pattern = parts.slice(0, i).join(':') + ':*';
      const wild = this.listeners.get(pattern);
      if (wild) for (const handler of [...wild]) fire(handler);
    }

    // 3. Global wildcard.
    const global = this.listeners.get('*');
    if (global) for (const handler of [...global]) fire(handler);

    return fired.size > 0;
  }
}
