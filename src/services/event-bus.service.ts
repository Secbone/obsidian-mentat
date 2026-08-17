import type { PluginObject, Context } from '../core/cordis';
import type MentatPlugin from '../main';
import { EventBus } from '../extensions';

/**
 * Host service: provides the (legacy-compatible) agent event bus.
 *
 * The existing `EventBus` remains for UI compatibility; the kernel's own
 * `EventsService` (ctx.on/emit) is the underlying mechanism for new code.
 */
export const EventBusService: PluginObject = {
  inject: ['mentatPlugin'],
  apply(ctx: Context) {
    // Non-strict read: `mentatPlugin` is an assembly-time reference provided
    // by the root component while it is still LOADING.
    const plugin = ctx.get<MentatPlugin>('mentatPlugin', false)!;
    const eventBus = new EventBus();
    plugin.eventBus = eventBus;
    return ctx.provide('eventBus', eventBus);
  },
};
