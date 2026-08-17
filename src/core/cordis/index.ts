/**
 * A simplified, API-compatible subset of the Cordis 4 kernel.
 *
 * Core mechanisms (per the paper "A Programming Paradigm for Spatiotemporal
 * Composability"):
 * - `Context` — the unified context type Γ∞ (state + accumulator + coeffects).
 * - `ctx.effect` / `fiber.effect` — revertible effects: every registered
 *   disposer is tracked and recovered LIFO on unload (Theorem 7).
 * - `ctx.provide` / `ctx.get` / `ctx.inject` — reactive coeffects: dependency
 *   changes notify dependent fibers, which reload/unload automatically.
 * - `ctx.plugin` / `ctx.use` — dynamic composition: instantiating a plugin is
 *   itself a revertible effect on the parent, so unloading a parent cascades.
 * - `ctx.isolate` / `ctx.intercept` — coeffect isolation and interception.
 *
 * The API shapes mirror `@deepseek-ai/cordis` 4.x so that application code
 * written against this kernel can migrate to the full framework later.
 */
export { Context, getIsolation } from './context';
export type { Context as ContextType } from './context';
export { Fiber, INACTIVE, LOADING, ACTIVE, UNLOADING, DISPOSED } from './fiber';
export type { FiberRunner } from './fiber';
export { RegistryService, FiberList, resolveInject, resolvePlugin } from './registry';
export type { ServiceImpl, PluginRuntime, PluginCallback, PluginObject, PluginInput } from './registry';
export { EventsService } from './events';
export type { EventHandler, EventOptions } from './events';
export { ReflectService, contextHandler } from './reflect';
export type { PropMeta, AccessorOptions } from './reflect';
export { Service } from './service';
export { symbols } from './symbols';
export { DisposableList, isObject, isConstructor, isNullable } from './utils';
export type { Disposable } from './utils';
