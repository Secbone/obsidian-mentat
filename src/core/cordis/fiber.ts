import { symbols } from './symbols';
import { DisposableList, Disposable, isConstructor, isNullable, isObject, runDisposable } from './utils';
import type { Context, IsolationMap } from './context';
import { isolationOf } from './context';
import type { PluginRuntime, RegistryService } from './registry';

/** Fiber lifecycle states (numbers align with Cordis 4 observable semantics). */
export const INACTIVE = 0;
export const LOADING = 1;
export const ACTIVE = 2;
export const UNLOADING = 3;
export const DISPOSED = 5;

export interface FiberRunner {
  epoch: number;
  execute(): unknown;
  collect(dispose: Disposable): void;
}

/**
 * A fiber is one instantiation of a plugin (component) carrying a lifecycle
 * state of its own — a simplified, API-compatible port of the Cordis 4
 * `Fiber`. Hierarchy semantics match Cordis: `parent` is the *context* the
 * fiber was instantiated under, so `parent.fiber` is the parent fiber.
 *
 * - `fiber.effect()` implements the *revertible effect* accumulator: the body
 *   runs immediately, whatever disposer(s) it returns are collected, and the
 *   returned `dispose` runs them in LIFO order (Theorem 7 of the paper).
 * - The lifecycle state machine (INACTIVE → LOADING → ACTIVE → UNLOADING)
 *   reacts to dependency changes: `provide()`/disposal notify dependent
 *   fibers, which re-check their `inject` declarations and reload/unload.
 * - Disposing a fiber is itself an effect registered on the *parent* fiber,
 *   so unloading a parent cascades to its children (Definition 47 of the
 *   paper: the inverse of instantiating a component retires it).
 */
export class Fiber {
  uid: number | null = null;
  /** The context this fiber was instantiated under (self for the root). */
  parent: Context;
  inject: Record<string, unknown>;
  ctx: Context;
  /** Services this fiber provided, keyed by service name. */
  store: Record<string, unknown> = Object.create(null);
  runtime: PluginRuntime | null;
  state = INACTIVE;

  private _disposables = new DisposableList();
  private _inertia: Promise<void> | null = null;
  private _loadError: unknown = null;
  private _epoch = 0;
  private _runner: FiberRunner | null = null;
  private _config: unknown;

  /** Unloading this fiber (also an effect on the parent fiber). */
  dispose: Disposable;

  constructor(
    parent: Context,
    config: unknown,
    inject: Record<string, unknown>,
    runtime: PluginRuntime | null,
  ) {
    this.parent = parent;
    this.inject = inject;
    this.runtime = runtime;
    this._config = config;

    if (runtime) {
      this.uid = parent.registry.counter;
      this.ctx = parent.extend({ fiber: this });
      const inheritedIntercept = (parent as unknown as { [symbols.intercept]: unknown })[symbols.intercept];
      (this.ctx as unknown as { [symbols.intercept]: unknown })[symbols.intercept] = Object.create(
        isObject(inheritedIntercept) ? inheritedIntercept : Object.create(null),
      );
      for (const [name, cfg] of Object.entries(inject)) {
        if (isNullable(cfg)) continue;
        (this.ctx as unknown as { [symbols.intercept]: Record<string, unknown> })[symbols.intercept][name] = cfg;
      }
      this._runner = {
        epoch: 0,
        execute: () => {
          if (isConstructor(runtime.callback)) {
            const Ctor = runtime.callback as unknown as new (ctx: Context, config: unknown) => { [symbols.init]?: unknown };
            const instance = new Ctor(this.ctx, config);
            const init = instance[symbols.init];
            if (typeof init === 'function') return (init as () => unknown).call(instance);
            return instance;
          }
          return (runtime.callback as (ctx: Context, config: unknown) => unknown)(this.ctx, config);
        },
        collect: (dispose: Disposable) => {
          this._disposables.add(dispose);
        },
      };
      this.dispose = parent.fiber.effect(() => {
        const remove = runtime.fibers.add(this);
        return async () => {
          this.uid = null;
          if (this.ctx.registry.has(runtime.callback)) {
            remove();
            if (runtime.fibers.size === 0) this.ctx.registry.delete(runtime.callback);
          }
          this.state = DISPOSED;
          if (!this._inertia) this._setInertia(this._unload());
          while (this._inertia) await this._inertia;
        };
      }, 'ctx.plugin()');

      if (this.uid !== null && parent.fiber.state !== DISPOSED) {
        for (const name of Object.keys(this.inject)) this._checkImpl(name);
        this._refresh();
      }
    } else {
      // Root fiber: always active, owns the context itself. Disposing it
      // recovers every effect registered directly on the root (Cordis
      // semantics: `ctx.fiber.dispose()` unwinds the whole assembly).
      this.uid = 0;
      this.ctx = parent;
      this.state = ACTIVE;
      this.dispose = async () => {
        await this._disposables.dispose();
        this._inertia = null;
      };
    }
  }

  /** The plugin's display name, inherited from the nearest named ancestor. */
  get name(): string {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    let fiber: Fiber = this;
    for (;;) {
      if (fiber.runtime?.name) return fiber.runtime.name;
      const next = fiber.parent.fiber;
      if (next === fiber || !next) return 'root';
      fiber = next;
    }
  }

  /** The validated config this fiber was created with. */
  get config(): unknown {
    return this._config;
  }

  /** Convenience: the registry of the owning context. */
  get registry(): RegistryService {
    return this.ctx.registry;
  }

  /** The isolation realm table visible to this fiber. */
  get isolation(): IsolationMap {
    return isolationOf(this.ctx);
  }

  assertActive(): void {
    if (this.uid === null) {
      throw new Error('INACTIVE_EFFECT: cannot register an effect on a disposed fiber');
    }
  }

  /**
   * Register a revertible effect. `execute` runs immediately and may return:
   * - a disposer function,
   * - a promise of a disposer,
   * - a (sync or async) generator yielding disposers.
   * The returned function disposes them all in LIFO order, at most once.
   */
  effect(execute: () => unknown, _label = 'anonymous'): Disposable {
    this.assertActive();
    if (this.state === DISPOSED) throw new Error('INACTIVE_EFFECT');

    const disposables: Disposable[] = [];
    const pending: Promise<void>[] = [];
    let disposing = false;
    let disposalTask: Promise<void> | undefined;

    const dispose = (): Promise<void> | void => {
      if (disposing) return disposalTask;
      disposing = true;
      // Synchronous disposers run synchronously (so `off()` / a disposer takes
      // effect immediately, matching Cordis); async disposers chain in order.
      const runList = (): Promise<void> | void => {
        let task: Promise<void> | undefined;
        for (const d of disposables.splice(0).reverse()) {
          const r = runDisposable(d);
          if (isObject(r) && 'then' in r) {
            const next = Promise.resolve(r as Promise<void>);
            task = task ? task.then(() => next) : next;
          } else if (task) {
            task = task.then(() => {});
          }
        }
        return task;
      };
      if (pending.length > 0) {
        const task = (async () => {
          await Promise.allSettled(pending);
          await runList();
        })();
        return disposalTask = task;
      }
      return disposalTask = runList() ?? Promise.resolve();
    };

    const runner: FiberRunner = {
      epoch: this._epoch,
      execute,
      collect: (d: Disposable) => {
        disposables.push(d);
        this._disposables.delete(d);
      },
    };

    const task = this._execute(runner);
    if (task) pending.push(task);
    // Register the effect's own disposer into the fiber accumulator so that
    // unloading the fiber releases every effect LIFO (Cordis: _disposables.push(wrapper)).
    this._disposables.add(dispose);
    return dispose;
  }

  /** Run one effect body and collect whatever disposer(s) it yields. */
  private _execute(runner: FiberRunner): void | Promise<void> {
    const effect = runner.execute();
    if (typeof effect === 'function') {
      runner.collect(effect as Disposable);
    } else if (isNullable(effect)) {
      // nothing to collect
    } else if (isObject(effect) && 'then' in effect) {
      return Promise.resolve(effect as unknown as Promise<unknown>).then((d) => {
        if (typeof d === 'function') runner.collect(d as Disposable);
      });
    } else if (isObject(effect) && Symbol.iterator in effect) {
      for (const d of effect as Iterable<unknown>) {
        if (typeof d === 'function') runner.collect(d as Disposable);
      }
    } else if (isObject(effect) && Symbol.asyncIterator in effect) {
      return (async () => {
        for await (const d of effect as AsyncIterable<unknown>) {
          if (runner.epoch !== this._epoch) return;
          if (typeof d === 'function') runner.collect(d as Disposable);
        }
      })();
    } else {
      throw new TypeError('Invalid effect: expected a disposer, promise, or (async) generator');
    }
    return undefined;
  }

  /** Whether the declared dependency `name` is currently satisfied. */
  _checkImpl(name: string): boolean {
    return this.ctx.get(name, false) !== undefined;
  }

  private _dependenciesSatisfied(): boolean {
    for (const name of Object.keys(this.inject)) {
      if (!this._checkImpl(name)) return false;
    }
    return true;
  }

  /** Re-evaluate the lifecycle against the current dependency state. */
  _refresh(): void {
    if (this.state === DISPOSED) return;
    const satisfied = this._dependenciesSatisfied();
    if (satisfied && this.state === INACTIVE) this._start();
    else if (!satisfied && this.state === ACTIVE) this._stop();
  }

  private _start(): void {
    if (this.state !== INACTIVE || !this._runner) return;
    this.state = LOADING;
    this._setInertia((async () => {
      try {
        const task = this._execute(this._runner!);
        if (task) await task;
        if (this._dependenciesSatisfied()) {
          this.state = ACTIVE;
          // This fiber now provides; refresh dependents.
          this.ctx.registry.notify(this.ctx, Object.keys(this.store));
        } else {
          await this._unload();
        }
      } catch (error) {
        this._loadError = error;
        console.error(`[Fiber] ${this.name} failed to activate:`, error);
        await this._unload();
      }
    })());
  }

  private _stop(): void {
    if (this.state !== ACTIVE) return;
    this.state = UNLOADING;
    this._setInertia((async () => {
      await this._unload();
    })());
  }

  /** Apply the accumulator (LIFO) and return to INACTIVE. */
  private async _unload(): Promise<void> {
    await this._disposables.dispose();
    this.state = INACTIVE;
    this._loadError = null;
    // Inertial chaining: if dependencies became satisfied again while this
    // fiber was unloading (e.g. a provider was re-registered), reload it.
    if (this.uid !== null && this._dependenciesSatisfied()) {
      this._refresh();
    }
  }

  /**
   * Track an in-flight transition and clear it once the task settles. Using a
   * chained microtask (rather than clearing inside the task body) keeps the
   * ordering correct even when the task completes synchronously.
   */
  private _setInertia(task: Promise<void>): void {
    this._inertia = task;
    void task.then(() => {
      if (this._inertia === task) this._inertia = null;
    });
  }

  /** Await any in-flight transition. */
  await(): Promise<void> {
    return this._inertia ?? Promise.resolve();
  }

}
