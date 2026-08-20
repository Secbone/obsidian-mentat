import type { PluginObject, Context } from '../../core/cordis';
import type { ToolDefinition } from '../contract';
import type { ToolsRegistry } from '../tools.service';

/**
 * Vault document tools (L2.5): read/write/list/search over the host-agnostic
 * `documents`/`search` contracts. These are the capability components that
 * the legacy built-in skills ultimately delegate to — kept independent so any
 * agent or external MCP client can call them.
 */

const readTool: ToolDefinition<{ path: string }> = {
  name: 'vault_read',
  description: 'Read a document\'s full content from the workspace.',
  permissions: ['documents:read'],
  async execute(input, ctx) {
    const doc = ctx.documents?.getDocument(input.path);
    if (!doc) return { success: false, error: `document not found: ${input.path}` };
    const content = await ctx.documents!.readDocument(doc);
    return { success: true, data: { path: input.path, content } };
  },
};

const writeTool: ToolDefinition<{ path: string; content: string }> = {
  name: 'vault_write',
  description: 'Write full content to a document (create or overwrite).',
  permissions: ['documents:write'],
  async execute(input, ctx) {
    if (!ctx.documents) return { success: false, error: 'document store unavailable' };
    await ctx.documents.writeDocument(input.path, input.content);
    return { success: true, data: { path: input.path } };
  },
};

const listTool: ToolDefinition<{ dir?: string }> = {
  name: 'vault_list',
  description: 'List documents in the workspace, optionally scoped to a directory.',
  permissions: ['documents:read'],
  async execute(input, ctx) {
    const docs = ctx.documents?.listDocuments(input.dir) ?? [];
    return { success: true, data: docs.map((d) => ({ path: d.path, name: d.name, extension: d.extension })) };
  },
};

const searchTool: ToolDefinition<{ query: string }> = {
  name: 'vault_search',
  description: 'Full-text search across documents.',
  permissions: ['documents:read'],
  async execute(input, ctx) {
    if (!ctx.search) return { success: false, error: 'search unavailable' };
    const results = await ctx.search.search(input.query);
    return { success: true, data: results };
  },
};

const TOOLS = [readTool, writeTool, listTool, searchTool];

export const VaultToolsPlugin: PluginObject = {
  inject: ['tools'],
  apply(ctx: Context) {
    const registry = ctx.get<ToolsRegistry>('tools')!;
    const disposers = TOOLS.map((tool) => registry.register(tool));
    return () => disposers.forEach((d) => d());
  },
};

// Re-exported for discovery and tests.
export const VAULT_TOOLS = TOOLS;
