/** Minimal shared utilities for the Cordis-compatible kernel. */

export type Disposable = () => void | Promise<void>;

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isConstructor(value: unknown): value is new (...args: never[]) => unknown {
  return typeof value === 'function'
    && !!value.prototype
    && (value as { prototype?: { constructor?: unknown } }).prototype?.constructor === value;
}

export function isNullable(value: unknown): value is null | undefined {
  return value === null || value === undefined;
}

/** Run one disposer, tolerating both sync and async results. */
export function runDisposable(dispose: Disposable): void | Promise<void> {
  return dispose();
}

/**
 * A list of disposers that supports LIFO disposal (the accumulator 𝜑 of the
 * revertible-effects model) and removal of individual entries.
 */
export class DisposableList {
  private disposers = new Set<Disposable>();

  add(dispose: Disposable): void {
    this.disposers.add(dispose);
  }

  /** Add and return a function that removes this entry. */
  push(dispose: Disposable): () => void {
    this.disposers.add(dispose);
    return () => this.disposers.delete(dispose);
  }

  delete(dispose: Disposable): boolean {
    return this.disposers.delete(dispose);
  }

  get size(): number {
    return this.disposers.size;
  }

  /** Run all disposers in LIFO order; safe to call multiple times (no-ops after the first). */
  async dispose(): Promise<void> {
    if (this.disposers.size === 0) return;
    const list = [...this.disposers].reverse();
    this.disposers.clear();
    let task: Promise<void> = Promise.resolve();
    for (const dispose of list) {
      task = task.then(() => runDisposable(dispose));
    }
    await task;
  }

  [Symbol.iterator](): Iterator<Disposable> {
    return this.disposers[Symbol.iterator]();
  }
}
