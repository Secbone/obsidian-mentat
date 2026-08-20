import type { PluginObject, Context } from '../../core/cordis';
import type { ToolDefinition } from '../contract';
import type { ToolsRegistry } from '../tools.service';

/**
 * Web tools (L2.6): fetch a URL and (optionally) search the web.
 * Permissions: network:fetch (subject to the permissions service in L4).
 * Kept host-agnostic — no Obsidian types.
 */
const fetchTool: ToolDefinition<{ url: string }> = {
  name: 'web_fetch',
  description: 'Fetch a URL and return its text content.',
  permissions: ['network:fetch'],
  async execute(input) {
    try {
      const res = await fetch(input.url);
      if (!res.ok) return { success: false, error: `HTTP ${res.status}` };
      const text = await res.text();
      return { success: true, data: text.slice(0, 4000) };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const searchTool: ToolDefinition<{ query: string }> = {
  name: 'web_search',
  description: 'Search the web for a query and return top results.',
  permissions: ['network:fetch'],
  async execute(input) {
    try {
      // A pluggable search provider can be injected later; for now a
      // best-effort informational response. The full implementation is
      // delegated to the legacy web-search skill / a provider service.
      return {
        success: true,
        data: `web_search is a stub; full provider wiring lands with the skills/L4 integration. query=${input.query}`,
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const TOOLS = [fetchTool, searchTool];

export const WebToolsPlugin: PluginObject = {
  inject: ['tools'],
  apply(ctx: Context) {
    const registry = ctx.get<ToolsRegistry>('tools')!;
    const disposers = TOOLS.map((t) => registry.register(t));
    return () => disposers.forEach((d) => d());
  },
};

export const WEB_TOOLS = TOOLS;
