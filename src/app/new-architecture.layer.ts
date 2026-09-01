import type { PluginObject, Context } from '../core/cordis';
import { LlmService } from '../llm/llm.service';
import { LlmProvidersService } from '../llm/providers.service';
import { ToolsService } from '../tools/tools.service';
import { VaultToolsPlugin } from '../tools/vault/vault-tools';
import { WebToolsPlugin } from '../tools/web/web-tools';
import { SystemToolsPlugin } from '../tools/system/system-tools';
import { ContextAssemblerPlugin } from '../context/context-assembler';
import { KnowledgeServicePlugin } from '../knowledge/knowledge.service';
import { ContextWindowServicePlugin } from '../session/context.service';
import { CompactionServicePlugin } from '../session/compaction.service';
import { AgentLoopServicePlugin } from '../agents/loop.service';
import { SessionServicePlugin } from '../session/session.service';
import { EventBridgeServicePlugin } from '../events/event-bridge.service';
import { PermissionServicePlugin } from '../external/permissions.service';
import { McpClientServicePlugin } from '../external/mcp-client/mcp-client.service';
import { McpServerServicePlugin } from '../external/mcp-server/mcp-server.service';
import { DelegatedServicePlugin } from '../external/delegated/delegated.service';
import { ExtensionHostV2Plugin } from '../extensions/extension-api-v2';

/**
 * New-architecture layer (L5): mounts the full L2-L4 service stack on the
 * context. Kept alongside the legacy services so the plugin runs in both
 * modes; a future switch retires the legacy ChatService path. Mount order is
 * a convenience — the kernel's reactive dependency resolution makes it
 * non-essential (a service stays pending until its injects are satisfied).
 */
export const NewArchitectureLayer: PluginObject = {
  inject: ['settings'],
  apply: async (ctx: Context) => {
    // ── L2 capability ─────────────────────────────────────────────────────
    await ctx.plugin(LlmService);                  // llm registry
    await ctx.plugin(LlmProvidersService);         // providers -> llm (settings-driven)
    await ctx.plugin(ToolsService);                // tools registry
    await ctx.plugin(VaultToolsPlugin);            // vault_read/write/list/search
    await ctx.plugin(WebToolsPlugin);              // web_fetch/search
    await ctx.plugin(SystemToolsPlugin);           // ask_user (needs ui)
    await ctx.plugin(KnowledgeServicePlugin);      // knowledge (documents + llm)
    await ctx.plugin(McpClientServicePlugin);      // external MCP tools -> tools
    await ctx.plugin(ContextAssemblerPlugin);       // vault context for system prompt

    // ── L3 orchestration ──────────────────────────────────────────────────
    await ctx.plugin(ContextWindowServicePlugin);  // context-window
    await ctx.plugin(CompactionServicePlugin);      // compaction
    await ctx.plugin(AgentLoopServicePlugin);       // agent-loop
    await ctx.plugin(SessionServicePlugin);         // session (modes from root AgentModesService)

    // ── L4 interaction / external ─────────────────────────────────────────
    await ctx.plugin(EventBridgeServicePlugin);     // event-bridge (kernel bus)
    await ctx.plugin(PermissionServicePlugin);      // permissions (needs ui)
    await ctx.plugin(McpServerServicePlugin);       // tools -> MCP
    await ctx.plugin(DelegatedServicePlugin);       // external agents -> modes
    await ctx.plugin(ExtensionHostV2Plugin());      // extensions v2
  },
};
