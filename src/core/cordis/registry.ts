import { symbols } from './symbols';
import { Fiber, ACTIVE } from './fiber';
import { isObject, isConstructor } from './utils';
import { isolationOf } from './context';
import type { Context } from './context';
import type { Disposable } from './utils';

/** A provided service implementation record. */
export interface ServiceImpl {
  name: string;
  value: unknown;
  fiber: Fiber;
  check?: (value: unknown) => boolean | undefined;
}

/** The normalized plugin callback. */
export type PluginCallback = (ctx: Context, config: unknown) => unknown;

/** The object plugin shape `{ name?, inject?, Config?, apply() }`. */
export interface PluginObject {
  name?: string;
  inject?: string[] | Record<string, unknown>;
  Config?: unknown;
  apply(ctx: Context, config: unknown): unknown;
}

export type PluginInput = PluginCallback | PluginObject | (new (ctx: Context, config: unknown) => unknown);

/** Per-plugin runtime: one record, possibly many fibers (instantiations). */
export interface PluginRuntime {
  name?: string;
  callback: PluginCallback;
  fibers: FiberList;
  Config?: unknown;
}

/** A set of fibers with add/remove/iterate semantics. */
export class FiberList implements Iterable<Fiber> {
  private fibers = new Set<Fiber>();

  add(fiber: Fiber): () => void {
    this.fibers.add(fiber);
    return () => this.fibers.delete(fiber);
  }

  delete(fiber: Fiber): boolean {
    return this.fibers.delete(fiber);
  }

  get size(): number {
    return this.fibers.size;
  }

  [Symbol.iterator](): Iterator<Fiber> {
    return this.fibers[Symbol.iterator]();
  }
}

/** Resolve an `inject` declaration (array or map) into a record. */
export function resolveInject(inject?: string[] | Record<string, unknown>): Record<string, unknown> {
  if (!inject) return Object.create(null);
  if (Array.isArray(inject)) {
    const map: Record<string, unknown> = Object.create(null);
    for (const name of inject) map[name] = undefined;
    return map;
  }
  return { ...inject };
}

/** Normalize any supported plugin shape to its callback. */
export function resolvePlugin(plugin: PluginInput): PluginCallback | undefined {
  if (typeof plugin === 'function') {
    if (isConstructor(plugin)) {
      // Class plugin: constructible with (ctx, config).
      return plugin as unknown as PluginCallback;
    }
    return plugin as PluginCallback;
  }
  if (isObject(plugin) && typeof (plugin as PluginObject).apply === 'function') {
    return (plugin as PluginObject).apply as PluginCallback;
  }
  return undefined;
}

/**
 * Service registry: service provisioning and plugin instantiation.
 *
 * Every method takes the *calling context* as its first argument — this is
 * the simplified equivalent of Cordis's context-tracking (`getTraceable`)
 * service methods. The public `ctx.*` surface injects the caller, so
 * `childCtx.provide(...)` registers under the child's isolation realm on the
 * child's own fiber, exactly as in Cordis.
 */
export class RegistryService {
  /** Monotonic fiber uid counter (root fiber is 0). */
  private _counter = 1;
  private store = new Map<symbol, ServiceImpl>();
  private _internal = new Map<PluginCallback, PluginRuntime>();

  constructor(private ctx: Context) {}

  get counter(): number {
    return this._counter++;
  }

  /** Service store keyed by isolation realm symbol. */
  get implStore(): Map<symbol, ServiceImpl> {
    return this.store;
  }

  // ── services ──────────────────────────────────────────────────────────

  _getImpl(ctx: Context, name: string, strict = true): ServiceImpl | undefined {
    const key = isolationOf(ctx)[name];
    const impl = key && this.store.get(key);
    if (!impl) return undefined;
    if (strict && impl.fiber.state !== ACTIVE) return undefined;
    return impl;
  }

  /** Read a service from the store without the inject requirement. */
  get<T = unknown>(ctx: Context, name: string, strict = true): T | undefined {
    return this._getImpl(ctx, name, strict)?.value as T | undefined;
  }

  /** Overwrite a provided service's value (same fiber only). */
  set<T = unknown>(ctx: Context, name: string, value: T): boolean {
    const key = isolationOf(ctx)[name];
    const impl = this.store.get(key);
    if (!impl) throw new Error(`cannot set property "${name}" without provide`);
    if (impl.fiber !== ctx.fiber) throw new Error(`cannot set property "${name}" in multiple fibers`);
    impl.value = value;
    return true;
  }

  /**
   * Register a service implementation owned by the calling fiber. The
   * registration is a revertible effect: the returned disposer removes the
   * binding, notifies dependents and waits for them to settle.
   */
  provide<T = unknown>(ctx: Context, name: string, value: T, check?: (value: unknown) => boolean | undefined): Disposable {
    return ctx.fiber.effect(() => {
      const rootIsolation = (ctx.root as unknown as { [symbols.isolate]: Record<string, symbol> })[symbols.isolate];
      rootIsolation[name] ??= Symbol(name);
      const key = isolationOf(ctx)[name];
      const impl: ServiceImpl = { name, value, fiber: ctx.fiber, check };
      if (this.store.has(key)) {
        throw new Error(`service "${name}" has been registered at <${this.store.get(key)!.fiber.name}>`);
      }
      this.store.set(key, impl);
      (ctx.fiber.store as Record<string, ServiceImpl>)[name] = impl;
      if (ctx.fiber.state === ACTIVE) this.notify(ctx, [name]);
      return async () => {
        this.store.delete(key);
        const fibers = this.notify(ctx, [name]);
        await Promise.allSettled(fibers.map((f) => f.await()));
        delete (ctx.fiber.store as Record<string, ServiceImpl>)[name];
      };
    }, `ctx.provide(${JSON.stringify(name)})`);
  }

  /**
   * Re-evaluate every fiber that requires one of the given services.
   * @returns the fibers whose dependency state was refreshed.
   */
  notify(
    ctx: Context,
    names: string[],
    filter: (fiberCtx: Context, name: string) => boolean = (fiberCtx, name) =>
      isolationOf(fiberCtx)[name] === isolationOf(ctx)[name],
  ): Fiber[] {
    const fibers: Fiber[] = [];
    for (const runtime of this._internal.values()) {
      for (const fiber of runtime.fibers) {
        let hasUpdate = false;
        for (const name of names) {
          if (!(name in fiber.inject)) continue;
          if (!filter(fiber.ctx, name)) continue;
          hasUpdate = true;
        }
        if (!hasUpdate) continue;
        fiber._refresh();
        fibers.push(fiber);
      }
    }
    for (const name of names) {
      const self = Object.create(ctx);
      self[symbols.filter] = (target: unknown) => filter(target as Context, name);
      ctx.events.emit(self, 'internal/service', name, this._getImpl(ctx, name, false)?.value);
    }
    return fibers;
  }

  // ── plugins ───────────────────────────────────────────────────────────

  has(plugin: PluginInput): boolean {
    const callback = resolvePlugin(plugin);
    return !!callback && this._internal.has(callback);
  }

  delete(plugin: PluginInput): PluginRuntime | undefined {
    const callback = resolvePlugin(plugin);
    const runtime = callback && this._internal.get(callback);
    if (!runtime) return undefined;
    this._internal.delete(callback);
    for (const fiber of [...runtime.fibers]) void fiber.dispose();
    return runtime;
  }

  keys(): IterableIterator<PluginCallback> {
    return this._internal.keys();
  }

  values(): IterableIterator<PluginRuntime> {
    return this._internal.values();
  }

  entries(): IterableIterator<[PluginCallback, PluginRuntime]> {
    return this._internal.entries();
  }

  forEach(callback: (runtime: PluginRuntime, plugin: PluginCallback) => void): void {
    this._internal.forEach(callback);
  }

  /**
   * Start a plugin in the calling context and return its fiber.
   * The returned fiber is promise-like: awaiting it settles once loading finishes.
   */
  plugin(ctx: Context, plugin: PluginInput, config?: unknown): Fiber & PromiseLike<void> {
    const callback = resolvePlugin(plugin);
    if (!callback) {
      throw new Error('invalid plugin, expect function or object with an "apply" method, received ' + typeof plugin);
    }
    ctx.fiber.assertActive();
    let runtime = this._internal.get(callback);
    if (!runtime) {
      let name = typeof plugin === 'function' ? (plugin as { name?: string }).name : (plugin as PluginObject).name;
      if (name === 'apply') name = undefined;
      runtime = {
        name,
        callback,
        fibers: new FiberList(),
        Config: typeof plugin === 'function' ? (plugin as { Config?: unknown }).Config : (plugin as PluginObject).Config,
      };
      this._internal.set(callback, runtime);
    }
    const inject = resolveInject(
      typeof plugin === 'function' ? (plugin as { inject?: string[] | Record<string, unknown> }).inject : (plugin as PluginObject).inject,
    );
    const fiber = new Fiber(ctx, config, inject, runtime);
    const wrapped = Object.create(fiber) as Fiber & PromiseLike<void>;
    wrapped.then = (onFulfilled, onRejected) => fiber.await().then(onFulfilled, onRejected);
    return wrapped;
  }

  /** Alias of `plugin`, matching the Koishi-style `ctx.use()` spelling. */
  use(ctx: Context, plugin: PluginInput, config?: unknown): Fiber & PromiseLike<void> {
    return this.plugin(ctx, plugin, config);
  }

  /** Start a callback once the requested dependencies are available. */
  inject(ctx: Context, inject: string[] | Record<string, unknown>, callback: PluginCallback): Fiber & PromiseLike<void> {
    return this.plugin(ctx, { inject, apply: callback, name: callback.name });
  }
}
