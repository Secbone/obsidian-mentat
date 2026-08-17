import type { PluginObject, Context } from '../core/cordis';
import { ReadTracker } from './read-tracker';

/**
 * Host service: provides the shared read-tracking registry so components
 * (skills, chat) can declare `inject: ['readTracker']` instead of each
 * constructing their own.
 */
export const ReadTrackerService: PluginObject = {
  apply(ctx: Context) {
    return ctx.provide('readTracker', new ReadTracker());
  },
};
