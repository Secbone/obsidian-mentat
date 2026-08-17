/**
 * Internal symbol keys, shared with Cordis via `Symbol.for` so that a later
 * migration to `@deepseek-ai/cordis` can reuse the same brand keys.
 *
 * This is a simplified, API-compatible subset of the Cordis 4 kernel.
 */
export const symbols = {
  /** Context-level isolation map (realm table ρ). */
  isolate: Symbol.for('cordis.isolate'),
  /** Context-level interception map (metadata table ι). */
  intercept: Symbol.for('cordis.intercept'),
  /** Event listener filter carried on a listener. */
  filter: Symbol.for('cordis.filter'),
  /** Effect meta tree attached to a disposer. */
  effect: Symbol.for('cordis.effect'),
  /** Availability predicate for a provided service. */
  check: Symbol.for('cordis.check'),
  /** Method run after construction (class plugins). */
  init: Symbol.for('cordis.init'),
  /** Call body making a service callable (e.g. `ctx.logger()`). */
  invoke: Symbol.for('cordis.invoke'),
  /** Derive an extended service instance. */
  extend: Symbol.for('cordis.extend'),
  /** Intercept-config resolution helper. */
  resolveConfig: Symbol.for('cordis.resolveConfig'),
  /** Proxy receiver pass-through. */
  receiver: Symbol.for('cordis.receiver'),
  /** Extended-context shadow marker. */
  shadow: Symbol.for('cordis.shadow'),
  /** Static plugin metadata (inject declarations etc.). */
  metadata: Symbol.for('cordis.metadata'),
} as const;

export type SymbolKeys = typeof symbols;
