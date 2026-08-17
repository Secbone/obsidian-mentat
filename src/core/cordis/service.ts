import { symbols } from './symbols';
import { isolationOf } from './context';
import type { Context } from './context';

/**
 * Base class for services that expose a named API on `ctx`.
 *
 * Subclasses call `super(ctx, name)` from their constructor; the service is
 * registered immediately as a *revertible effect* on the owning fiber and is
 * automatically removed when that fiber unloads (API-compatible with the
 * Cordis 4 `Service` base class subset).
 */
export class Service<C extends Context = Context> {
  ctx: C;
  /** The service name this instance is registered under. */
  name: string;

  constructor(ctx: C, name?: string) {
    this.ctx = ctx;
    name ??= (this.constructor as unknown as { provide?: string }).provide;
    this.name = name as string;
    ctx.reflect.provide(ctx, name as string, this, (this as unknown as Record<symbol, unknown>)[symbols.check] as ((v: unknown) => boolean) | undefined);
  }

  /** Isolation-scope match for dependents of this service. */
  [symbols.filter](ctx: Context): boolean {
    return isolationOf(ctx)[this.name] === isolationOf(this.ctx)[this.name];
  }

  /** Derive an extended service instance overriding the given props. */
  [symbols.extend]<T extends Service>(this: T, props: Record<string, unknown>): T {
    return Object.assign(Object.create(this), props);
  }
}

// Static symbol-keyed members (kept for shape compatibility with Cordis 4).
export const ServiceCheck = symbols.check;
export const ServiceInit = symbols.init;
export const ServiceInvoke = symbols.invoke;
export const ServiceExtend = symbols.extend;
export const ServiceResolveConfig = symbols.resolveConfig;
