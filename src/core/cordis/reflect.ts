import type { Context } from './context';
import type { Disposable } from './utils';

export interface PropMeta {
  type: 'service' | 'accessor' | 'mixin';
  config?: unknown;
}

export interface AccessorOptions<T = unknown> {
  get(this: Context): T;
  set?(this: Context, value: T): void;
}

/**
 * Reflection and service-resolution layer installed as `ctx.reflect`.
 *
 * It owns the property metadata table (`props`) that drives the context
 * Proxy: reading `ctx.foo` resolves against the declaring fiber's `inject`
 * (throwing on undeclared access), and writing `ctx.foo` requires the
 * current fiber to have provided `foo` (mirroring the paper's rule that a
 * component may only write keys it declares in its provision).
 */
export class ReflectService {
  readonly props: Record<string, PropMeta | undefined> = Object.create(null);

  constructor(private ctx: Context) {}

  /** Mark a name as a service property (called by `provide`). */
  declareService(name: string): void {
    const existing = this.props[name];
    if (!existing) {
      this.props[name] = { type: 'service' };
    } else if (existing.type !== 'service') {
      throw new Error(`property "${name}" is already declared as ${existing.type}`);
    }
  }

  /** Mark a name as a mixin-forwarded property. */
  declareMixin(name: string): void {
    const existing = this.props[name];
    if (existing && existing.type !== 'mixin') {
      throw new Error(`property "${name}" is already declared as ${existing.type}`);
    }
    this.props[name] = { type: 'mixin' };
  }

  /** Register a service (same contract as `registry.provide`, with metadata). */
  provide<T = unknown>(ctx: Context, name: string, value: T, check?: (value: unknown) => boolean | undefined): Disposable {
    this.declareService(name);
    return this.ctx.registry.provide(ctx, name, value, check);
  }

  /** Define a computed context property backed by get/set hooks. */
  accessor<T = unknown>(ctx: Context, name: string, options: AccessorOptions<T>): Disposable {
    return ctx.fiber.effect(() => {
      const existing = this.props[name];
      if (existing && existing.type !== 'accessor') {
        throw new Error(`property "${name}" is already declared as ${existing.type}`);
      }
      this.props[name] = { type: 'accessor', config: options };
      return () => {
        if (this.props[name]?.type === 'accessor') delete this.props[name];
      };
    }, `ctx.accessor(${JSON.stringify(name)})`);
  }

  /**
   * Resolve a property read. `ctx.get(name)` reads the service store freely
   * (no inject requirement — that enforcement belongs to proxy property
   * access, matching Cordis semantics).
   */
  get(ctx: Context, prop: string, strict = true): unknown {
    const meta = this.props[prop];
    if (meta?.type === 'accessor') {
      return (meta.config as AccessorOptions).get.call(ctx);
    }
    return this.ctx.registry.get(ctx, prop, strict);
  }

  /** Resolve a property write; requires the current fiber to provide it. */
  set(ctx: Context, prop: string, value: unknown): boolean {
    const meta = this.props[prop];
    if (meta?.type === 'accessor') {
      const options = meta.config as AccessorOptions;
      if (!options.set) throw new Error(`property "${prop}" is read-only`);
      options.set.call(ctx, value);
      return true;
    }
    if (meta?.type !== 'service') {
      throw new Error(`cannot set property "${prop}" without provide`);
    }
    const fiber = ctx.fiber;
    if (!fiber.runtime || !(prop in fiber.store)) {
      throw new Error(`cannot set property "${prop}" without provide`);
    }
    return this.ctx.registry.set(ctx, prop, value);
  }

  /** Whether the property is declared at all. */
  has(prop: string): boolean {
    return !!this.props[prop];
  }
}

/**
 * Proxy handler for the context: string property access resolves services
 * (via ReflectService), symbol keys and declared own properties pass through.
 */
export const contextHandler: ProxyHandler<Context> = {
  get(target, prop, receiver) {
    if (typeof prop === 'symbol') return Reflect.get(target, prop, receiver);
    const stringProp = prop as string;
    if (stringProp in target) return Reflect.get(target, prop, receiver);
    if (target.reflect.has(stringProp)) {
      // Property access inside a fiber requires the name to be declared in
      // `inject` (or provided by the fiber itself) — the paper's rule that a
      // component may only read what it declares. `ctx.get(name)` bypasses
      // this; `ctx.foo` enforces it.
      const accessor = (receiver && typeof receiver === 'object' ? receiver : target) as Context;
      const fiber = accessor.fiber;
      if (fiber.runtime && !(stringProp in fiber.inject) && !(stringProp in (fiber.store as object))) {
        throw new Error(`cannot get property "${stringProp}" without inject`);
      }
      return target.reflect.get(target, stringProp, false);
    }
    return undefined;
  },

  set(target, prop, value, receiver) {
    if (typeof prop === 'symbol') return Reflect.set(target, prop, value, receiver);
    const stringProp = prop as string;
    if (stringProp in target) return Reflect.set(target, prop, value, receiver);
    if (target.reflect.has(stringProp)) {
      return target.reflect.set(target, stringProp, value);
    }
    return Reflect.set(target, prop, value, receiver);
  },

  has(target, prop) {
    if (typeof prop === 'symbol') return Reflect.has(target, prop);
    const stringProp = prop as string;
    return stringProp in target || target.reflect.has(stringProp);
  },

  getPrototypeOf(target) {
    return Reflect.getPrototypeOf(target);
  },

  getOwnPropertyDescriptor(target, prop) {
    if (typeof prop === 'symbol') return Reflect.getOwnPropertyDescriptor(target, prop);
    if (target.reflect.has(prop as string)) {
      return {
        configurable: true,
        enumerable: true,
        writable: true,
        value: (target as unknown as Record<string, unknown>)[prop as string],
      };
    }
    return Reflect.getOwnPropertyDescriptor(target, prop);
  },
};
