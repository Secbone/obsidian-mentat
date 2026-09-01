import type { PluginObject, Context } from '../../core/cordis';
import type { ToolDefinition } from '../contract';
import type { ToolsRegistry } from '../tools.service';
import { z } from 'zod';

/**
 * Vault document tools (L2.5): read/write/list/search over the host-agnostic
 * `documents`/`search` contracts. These are the capability components that
 * the legacy built-in skills ultimately delegate to — kept independent so any
 * agent or external MCP client can call them.
 *
 * Each tool declares a zod `schema` so the model is told the exact input
 * shape (required params, types). Without it the provider falls back to an
 * empty parameter schema and the model guesses arguments, producing wrong
 * tool results.
 */

const readTool: ToolDefinition<{ path: string }> = {
  name: 'vault_read',
  description: 'Read a document\'s full content from the workspace. Pass the relative path of the file, e.g. "notes/ideas.md".',
  schema: z.object({ path: z.string().describe('Relative file path of the document to read') }),
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
  schema: z.object({
    path: z.string().describe('Relative file path of the document to write'),
    content: z.string().describe('Full content to write to the file'),
  }),
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
  schema: z.object({ dir: z.string().optional().describe('Optional directory to scope the listing to') }),
  permissions: ['documents:read'],
  async execute(input, ctx) {
    const docs = ctx.documents?.listDocuments(input.dir) ?? [];
    return { success: true, data: docs.map((d) => ({ path: d.path, name: d.name, extension: d.extension })) };
  },
};

const searchTool: ToolDefinition<{ query: string }> = {
  name: 'vault_search',
  description: 'Full-text search across documents.',
  schema: z.object({ query: z.string().describe('The search query text') }),
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
