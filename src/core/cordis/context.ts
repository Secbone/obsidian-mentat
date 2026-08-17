import { symbols } from './symbols';
import { Fiber } from './fiber';
import { RegistryService, PluginInput, PluginCallback } from './registry';
import { EventsService, EventHandler, EventOptions } from './events';
import { ReflectService, contextHandler, AccessorOptions } from './reflect';
import type { Disposable } from './utils';
import type { PluginRuntime } from './registry';

/**
 * The unified context — the Γ∞ of the paper: the single entity through which
 * every interaction between a component and its environment passes. It
 * carries the dependency (coeffect) table, the effect accumulator (per fiber)
 * and the isolation/interception tables.
 *
 * API-compatible with the Cordis 4 `Context` subset:
 * - `ctx.provide(name, value, check?)` / `ctx.get(name, strict?)` / `ctx.set(name, value)`
 * - `ctx.inject(names, callback)` / `ctx.plugin(plugin, config?)` / `ctx.use(...)`
 * - `ctx.effect(callback, label?)` — revertible effect on the current fiber
 * - `ctx.on/once/off/emit` — events (listeners are revertible effects)
 * - `ctx.extend(meta)` / `ctx.isolate(name, label)` / `ctx.intercept(name, config)`
 * - `ctx.fiber` — the current fiber; `ctx.registry` / `ctx.events` / `ctx.reflect`
 */
/** The isolation realm table ρ (key → realm symbol). */
export interface IsolationMap {
  [name: string]: symbol;
}

/** The interception metadata table ι (key → metadata). */
export interface InterceptionMap {
  [name: string]: unknown;
}

export class Context {
  static effect = symbols.effect;
  static filter = symbols.filter;
  static isolate = symbols.isolate;
  static intercept = symbols.intercept;

  root: Context;
  baseUrl?: string;
  fiber: Fiber;
  reflect: ReflectService;
  registry: RegistryService;
  events: EventsService;

  /** Create the root context and install the built-in services. */
  constructor() {
    (this as unknown as { [symbols.isolate]: IsolationMap })[symbols.isolate] = Object.create(null);
    (this as unknown as { [symbols.intercept]: InterceptionMap })[symbols.intercept] = Object.create(null);
    const self = new Proxy(this, contextHandler) as unknown as Context;
    this.root = self;
    this.baseUrl = undefined;
    this.reflect = new ReflectService(self);
    this.registry = new RegistryService(self);
    this.events = new EventsService(self);
    this.fiber = new Fiber(self, undefined, Object.create(null), null);
    this.mixin('reflect', ['get', 'set', 'provide', 'accessor']);
    this.mixinFiber();
    this.mixin('registry', ['inject', 'plugin', 'use']);
    this.mixin('events', ['on', 'once', 'off']);
    this.mixinEmit();
    // Return the proxied instance so property access resolves services.
    return self;
  }

  /** The fiber this context currently runs under (mixin-backed). */
  runtime: PluginRuntime | null = null;
  /* eslint-disable @typescript-eslint/no-unused-vars --
   * The following stubs declare the public API shape only; their real
   * implementations are installed by `mixin()`/`mixinFiber()`/`mixinEmit()`.
   */
  /** Read a service (mixin-forwarded to the registry). */
  get<T = unknown>(_name: string, _strict?: boolean): T | undefined { return undefined; }
  /** Register a service (mixin-forwarded). */
  provide<T = unknown>(_name: string, _value: T, _check?: (value: T) => boolean): Disposable { return () => {}; }
  /** Overwrite a provided service value (mixin-forwarded). */
  set<T = unknown>(_name: string, _value: T): boolean { return false; }
  /** Register a revertible effect (mixin-forwarded to the current fiber). */
  effect(_execute: () => unknown, _label?: string): Disposable { return () => {}; }
  /** Start a plugin (mixin-forwarded). */
  plugin(_plugin: PluginInput, _config?: unknown): Fiber & PromiseLike<void> { throw new Error('unreachable'); }
  /** Alias of plugin (mixin-forwarded). */
  use(_plugin: PluginInput, _config?: unknown): Fiber & PromiseLike<void> { throw new Error('unreachable'); }
  /** Dependency-injected plugin (mixin-forwarded). */
  inject(_names: string[] | Record<string, unknown>, _callback: PluginCallback): Fiber & PromiseLike<void> { throw new Error('unreachable'); }
  /** Register an event listener (mixin-forwarded). */
  on(_name: string, _handler: EventHandler, _options?: EventOptions): Disposable { return () => {}; }
  /** Register a one-shot event listener (mixin-forwarded). */
  once(_name: string, _handler: EventHandler): Disposable { return () => {}; }
  /** Remove an event listener (mixin-forwarded). */
  off(_name: string, _handler: EventHandler): void { }
  /** Emit an event (mixin-forwarded). */
  emit(_subject: unknown, _name: string, ..._args: unknown[]): boolean { return false; }
  /** Define a computed property (mixin-forwarded). */
  accessor<T = unknown>(_name: string, _options: AccessorOptions<T>): Disposable { return () => {}; }
  /* eslint-enable @typescript-eslint/no-unused-vars */

  /**
   * Forward methods of a built-in service onto the context. The generated
   * context method injects the *calling context* as the first argument of the
   * underlying service method — the simplified equivalent of Cordis's
   * context-tracking (`getTraceable`) services. Thus `childCtx.provide(...)`
   * registers under the child's isolation realm on the child's own fiber.
   */
  mixin(source: string, mixins: string[] | Record<string, string>): void {
    const entries = Array.isArray(mixins) ? mixins.map((key) => [key, key] as const) : Object.entries(mixins);
    for (const [sourceKey, ctxKey] of entries) {
      Object.defineProperty(this, ctxKey, {
        configurable: true,
        enumerable: false,
        get(this: Context) {
          // eslint-disable-next-line @typescript-eslint/no-this-alias
          const ctx = this;
          const service = (ctx as unknown as Record<string, unknown>)[source] as unknown as Record<string, unknown>;
          const method = service[sourceKey];
          if (typeof method !== 'function') return method;
          return (...args: unknown[]) => (method as (...a: unknown[]) => unknown).call(service, ctx, ...args);
        },
      });
      this.reflect.declareMixin(ctxKey);
    }
  }

  /**
   * Forward `ctx.effect`/`ctx.runtime` onto the *current fiber* of the calling
   * context (each context carries its own fiber, so `ctx.effect` inside a
   * plugin registers on that plugin's fiber).
   */
  private mixinFiber(): void {
    Object.defineProperty(this, 'effect', {
      configurable: true,
      enumerable: false,
      get(this: Context) {
        return this.fiber.effect.bind(this.fiber);
      },
    });
    Object.defineProperty(this, 'runtime', {
      configurable: true,
      enumerable: false,
      get(this: Context) {
        return this.fiber.runtime;
      },
    });
    this.reflect.declareMixin('effect');
    this.reflect.declareMixin('runtime');
  }

  /**
   * Forward `ctx.emit` onto the events service with the Cordis signature:
   * `ctx.emit(name, ...args)` or `ctx.emit(subject, name, ...args)`.
   */
  private mixinEmit(): void {
    Object.defineProperty(this, 'emit', {
      configurable: true,
      enumerable: false,
      get(this: Context) {
        return this.events.emit.bind(this.events);
      },
    });
    this.reflect.declareMixin('emit');
  }

  /**
   * Create a child context that prototypally inherits this one; own
   * properties of `meta` shadow the inherited ones. The parent is not mutated.
   */
  extend(meta: Record<PropertyKey, unknown> = {}): Context {
    const self = Object.create(this);
    for (const prop of Reflect.ownKeys(meta)) {
      const descriptor = Reflect.getOwnPropertyDescriptor(meta, prop);
      if (descriptor) Object.defineProperty(self, prop, descriptor);
    }
    return self as Context;
  }

  /**
   * Create a child context with an independent service scope for `name`
   * (the coeffect isolation realm ρ of the paper): below the returned
   * context, reads/writes of `name` resolve against the new label.
   */
  isolate(name: string, label?: symbol): Context {
    const shadow = Object.create(isolationOf(this));
    shadow[name] = label ?? Symbol(name);
    return this.extend({ [symbols.isolate]: shadow });
  }

  /** Create a child context merging interception metadata for `name`. */
  intercept(name: string, config: unknown): Context {
    const intercept = Object.create(interceptionOf(this));
    intercept[name] = config;
    return this.extend({ [symbols.intercept]: intercept });
  }
}

/** Read the isolation realm table ρ of a context. */
export function isolationOf(ctx: Context): IsolationMap {
  return (ctx as unknown as { [symbols.isolate]: IsolationMap })[symbols.isolate];
}

/** Read the interception metadata table ι of a context. */
export function interceptionOf(ctx: Context): InterceptionMap {
  return (ctx as unknown as { [symbols.intercept]: InterceptionMap })[symbols.intercept];
}

/** Read the isolation realm table of a context (alias kept for readability). */
export function getIsolation(ctx: Context): IsolationMap {
  return isolationOf(ctx);
}

export type { Disposable };
