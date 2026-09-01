import type { PluginObject, Context } from '../../core/cordis';
import type { ToolDefinition } from '../contract';
import type { ToolsRegistry } from '../tools.service';
import type { NotifyCapability } from '../../platform/contracts';
import { z } from 'zod';

/**
 * System/interaction tools (L2.6): ask the user for confirmation/input.
 * Requires the optional `ui` platform capability; on headless platforms this
 * component stays pending (ui absent) and is not registered.
 */
function askUserTool(ui?: NotifyCapability): ToolDefinition<{ question: string }> {
  return {
    name: 'ask_user',
    description: 'Ask the user a concise question and get their answer.',
    schema: z.object({ question: z.string().describe('The concise question to ask the user') }),
    permissions: ['documents:read'],
    async execute(input) {
      if (!ui) return { success: false, error: 'ui capability unavailable' };
      const ok = await ui.confirm({ message: input.question, scope: 'ask_user' });
      return { success: true, data: { confirmed: ok } };
    },
  };
}

export const SystemToolsPlugin: PluginObject = {
  inject: ['tools', 'ui'], // ui is optional; stayed pending when absent
  apply(ctx: Context) {
    const registry = ctx.get<ToolsRegistry>('tools')!;
    const ui = ctx.get<NotifyCapability>('ui', false);
    const disposers = [askUserTool(ui)].map((t) => registry.register(t));
    return () => disposers.forEach((d) => d());
  },
};
