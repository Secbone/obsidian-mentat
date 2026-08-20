import type { PluginObject, Context } from '../core/cordis';
import type { ToolDefinition, ToolContext } from './contract';

/**
 * Tool registry (L2.4). Tools register here; the agent loop enumerates and
 * executes them. A registration is a reversible effect — unloading a tool
 * component unregisters its tools.
 *
 * `documents`/`knowledge`/`search`/`graph` are injected into ToolContext at
 * execution time (only those provided by the platform are present, so a tool
 * relying on an optional capability stays inert on minimal platforms).
 */
export class ToolsRegistry {
  private tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): () => void {
    if (this.tools.has(tool.name)) {
      throw new Error(`tool "${tool.name}" is already registered`);
    }
    this.tools.set(tool.name, tool);
    return () => this.tools.delete(tool.name);
  }

  unregister(name: string): void {
    this.tools.delete(name);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  async execute(name: string, input: unknown, ctx: ToolContext): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`tool "${name}" is not registered`);
    return tool.execute(input, ctx);
  }
}

export const ToolsService: PluginObject = {
  apply(ctx: Context) {
    const registry = new ToolsRegistry();
    return ctx.provide('tools', registry);
  },
};
