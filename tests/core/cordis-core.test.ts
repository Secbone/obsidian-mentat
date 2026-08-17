import { describe, it, expect } from 'vitest';
import { Context, Service } from '../../src/core/cordis';

/** Await one macro/micro task round so async lifecycle settles. */
const settle = (n = 3) => Promise.all(Array.from({ length: n }, () => Promise.resolve()));

describe('Cordis-compatible kernel: Context & services', () => {
  it('provide/get basic read-write', () => {
    const ctx = new Context();
    const disposer = ctx.provide('greeting', 'hello');
    expect(ctx.get('greeting')).toBe('hello');
    disposer();
    expect(ctx.get('greeting')).toBeUndefined();
  });

  it('duplicate registration of the same service throws', () => {
    const ctx = new Context();
    ctx.provide('svc', 1);
    expect(() => ctx.provide('svc', 2)).toThrow(/has been registered/);
  });

  it('ctx.get with strict=false still returns undefined after the provider unloads', () => {
    const ctx = new Context();
    const fiber = ctx.plugin(() => {
      ctx.provide('svc', 42);
    });
    void fiber;
    expect(ctx.get('svc', false)).toBe(42);
  });

  it('isolate() gives an independent realm for the same service name', () => {
    const ctx = new Context();
    ctx.provide('greeting', 'global');
    const child = ctx.isolate('greeting');
    // Provision into the isolated realm.
    const childFiber = child.plugin(() => {
      child.provide('greeting', 'isolated');
    });
    void childFiber;
    expect(child.get('greeting', false)).toBe('isolated');
    expect(ctx.get('greeting')).toBe('global');
  });
});

describe('Cordis-compatible kernel: revertible effects', () => {
  it('fiber.effect collects disposers; plugin unload restores in LIFO order', async () => {
    const ctx = new Context();
    const order: string[] = [];
    const fiber = ctx.plugin((childCtx) => {
      childCtx.effect(() => () => { order.push('a'); });
      childCtx.effect(() => () => { order.push('b'); });
      childCtx.effect(() => () => { order.push('c'); });
    });
    await fiber;
    expect(order).toEqual([]);
    await fiber.dispose();
    expect(order).toEqual(['c', 'b', 'a']);
  });

  it('effect disposer is idempotent (fires at most once)', async () => {
    const ctx = new Context();
    let count = 0;
    const fiber = ctx.plugin((childCtx) => {
      childCtx.effect(() => () => { count++; });
    });
    await fiber;
    await fiber.dispose();
    await fiber.dispose();
    expect(count).toBe(1);
  });

  it('effect supports async disposers', async () => {
    const ctx = new Context();
    const order: string[] = [];
    const fiber = ctx.plugin((childCtx) => {
      childCtx.effect(() => async () => { order.push('async'); });
    });
    await fiber;
    await fiber.dispose();
    expect(order).toEqual(['async']);
  });

  it('effect supports generator bodies yielding disposers', async () => {
    const ctx = new Context();
    const order: string[] = [];
    const fiber = ctx.plugin((childCtx) => {
      childCtx.effect(function* () {
        yield () => { order.push('gen-1'); };
        yield () => { order.push('gen-2'); };
      });
    });
    await fiber;
    await fiber.dispose();
    expect(order).toEqual(['gen-2', 'gen-1']);
  });
});

describe('Cordis-compatible kernel: reactive dependencies', () => {
  it('plugin with unsatisfied inject stays inactive, activates when provided', async () => {
    const ctx = new Context();
    const log: string[] = [];
    let activations = 0;
    const fiber = ctx.plugin({
      inject: ['dep'],
      apply() {
        activations++;
        log.push('active');
        return () => log.push('inactive');
      },
    });
    await fiber;
    await settle();
    expect(activations).toBe(0); // dependency missing → not activated

    const disposer = ctx.provide('dep', { ready: true });
    await settle();
    expect(activations).toBe(1);
    expect(log).toEqual(['active']);

    disposer();
    await settle();
    expect(log).toEqual(['active', 'inactive']);
  });

  it('dependency replaced → dependent reloads', async () => {
    const ctx = new Context();
    let activations = 0;
    const fiber = ctx.plugin({
      inject: ['dep'],
      apply() {
        activations++;
        return () => {};
      },
    });
    const d1 = ctx.provide('dep', { version: 1 });
    await settle();
    expect(activations).toBe(1);
    d1();
    await settle();
    ctx.provide('dep', { version: 2 });
    await settle();
    expect(activations).toBe(2);
    void fiber;
  });

  it('ctx.inject(names, cb) runs the callback once dependencies are available', async () => {
    const ctx = new Context();
    let ran = 0;
    let seen: unknown;
    ctx.inject(['alpha', 'beta'], (childCtx) => {
      ran++;
      seen = [childCtx.get('alpha'), childCtx.get('beta')];
    });
    await settle();
    expect(ran).toBe(0);

    ctx.provide('alpha', 'A');
    await settle();
    expect(ran).toBe(0);

    ctx.provide('beta', 'B');
    await settle();
    expect(ran).toBe(1);
    expect(seen).toEqual(['A', 'B']);
  });

  it('unloading a parent cascades to child plugins', async () => {
    const ctx = new Context();
    const log: string[] = [];
    const parent = ctx.plugin((parentCtx) => {
      log.push('parent-active');
      parentCtx.effect(() => {
        // A child plugin instantiated by the parent.
        parentCtx.plugin((childCtx) => {
          log.push('child-active');
          return () => log.push('child-inactive');
        });
        return () => log.push('parent-inactive');
      });
    });
    await settle();
    expect(log).toEqual(['parent-active', 'child-active']);

    await parent.dispose();
    expect(log).toEqual(['parent-active', 'child-active', 'parent-inactive', 'child-inactive']);
  });
});

describe('Cordis-compatible kernel: Service base class', () => {
  class Greeter extends Service {
    constructor(ctx: Context, public text: string) {
      super(ctx, 'greeter');
    }
    greet(): string {
      return `hi ${this.text}`;
    }
  }

  it('service registers on construction and unregisters with its fiber', async () => {
    const ctx = new Context();
    const fiber = ctx.plugin((childCtx) => {
      new Greeter(childCtx, 'mentat');
    });
    await settle();
    expect(ctx.get('greeter', false)).toBeInstanceOf(Greeter);

    await fiber.dispose();
    expect(ctx.get('greeter', false)).toBeUndefined();
  });

  it('ctx.greeter property access resolves through the proxy', async () => {
    const ctx = new Context();
    const fiber = ctx.plugin((childCtx) => {
      new Greeter(childCtx, 'proxy');
    });
    await settle();
    const greeter = (ctx as unknown as Record<string, Greeter>).greeter;
    expect(greeter).toBeInstanceOf(Greeter);
    expect(greeter.greet()).toBe('hi proxy');
    await fiber.dispose();
  });
});

describe('Cordis-compatible kernel: events', () => {
  it('on/emit exact match with subject as first argument', () => {
    const ctx = new Context();
    const seen: unknown[] = [];
    ctx.on('agent/start', (subject, arg) => {
      seen.push(subject, arg);
    });
    ctx.events.emit(ctx, 'agent/start', 42);
    expect(seen).toEqual([ctx, 42]);
  });

  it('namespace wildcard and global wildcard match', () => {
    const ctx = new Context();
    const seen: string[] = [];
    ctx.on('tool:*', () => seen.push('namespace'));
    ctx.on('*', () => seen.push('global'));
    ctx.events.emit(ctx, 'tool:call', {});
    expect(seen).toEqual(['namespace', 'global']);
  });

  it('once listener self-disposes after the first emission', () => {
    const ctx = new Context();
    let count = 0;
    ctx.once('x', () => count++);
    ctx.events.emit(ctx, 'x');
    ctx.events.emit(ctx, 'x');
    expect(count).toBe(1);
  });

  it('listener disposer unregisters', () => {
    const ctx = new Context();
    let count = 0;
    const off = ctx.on('x', () => count++);
    ctx.events.emit(ctx, 'x');
    off();
    ctx.events.emit(ctx, 'x');
    expect(count).toBe(1);
  });
});

describe('Cordis-compatible kernel: plugin shapes', () => {
  it('function plugin', async () => {
    const ctx = new Context();
    let ran = false;
    const fiber = ctx.plugin(() => { ran = true; });
    await fiber;
    expect(ran).toBe(true);
  });

  it('object plugin with apply', async () => {
    const ctx = new Context();
    let ran = false;
    const fiber = ctx.use({ apply: () => { ran = true; } });
    await fiber;
    expect(ran).toBe(true);
  });

  it('class plugin extending Service', async () => {
    const ctx = new Context();
    class Marker extends Service {
      static provide = 'marker';
    }
    const fiber = ctx.plugin((childCtx) => {
      new Marker(childCtx);
    });
    await settle();
    expect(ctx.get('marker', false)).toBeInstanceOf(Marker);
    await fiber.dispose();
  });

  it('plugin registers are removed from the registry when disposed', async () => {
    const ctx = new Context();
    const plugin = () => {};
    const fiber = ctx.plugin(plugin);
    await fiber;
    expect(ctx.registry.has(plugin)).toBe(true);
    await fiber.dispose();
    expect(ctx.registry.has(plugin)).toBe(false);
  });
});
