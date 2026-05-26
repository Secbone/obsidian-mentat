// ChatOrchestrator - Orchestrates chat conversations with agent and skill support

import PersonalAgentPlugin from '../main';
import { TaskType, ChatMessage } from '../types';
import { SkillRegistry } from '../skills/core/skill-registry';
import { SkillExecutor } from '../skills/core/skill-executor';
import { SkillContext, SkillCall } from '../skills/skill-types';
import { MCPManager } from '../skills/mcp';
import { SkillLoader, isExecutableSkill, isDocumentationSkill } from '../skills/core/skill-loader';
import { SkillInvocationContext } from '../skills/strategies/skill-invocation-strategy';
import { SkillLoadCache } from '../skills/core/skill-cache';
import { PromptLoader } from '../prompts/prompt-loader';
import { PROMPT_PATHS, FALLBACK_PROMPTS, TEMPLATE_VARS } from '../prompts/prompt-templates';
import { BaseAgent, AgentDependencies } from '../agents/base-agent';
import { AgentManager } from '../agents/agent-manager';
import { AgentConfig, AgentContext, AgentEvent } from '../agents/agent-types';

export interface ChatQueryOptions {
  enableSkills?: boolean;
  maxTurns?: number;
  contextMessages?: ChatMessage[];
}

export interface ChatQueryResult {
  response: string;
  messages: ChatMessage[];
  skillCalls?: SkillCall[];
}

/**
 * ChatOrchestrator - Manages chat conversations with agent and skill support
 */
export class ChatOrchestrator {
  private agentManager: AgentManager;
  private defaultAgent: BaseAgent | null = null;
  private plugin: PersonalAgentPlugin;

  // Skill system components
  private skillRegistry: SkillRegistry;
  private skillExecutor: SkillExecutor;
  private skillInvocationContext: SkillInvocationContext;
  private skillLoader: SkillLoader;
  private mcpManager: MCPManager;
  private skillCache: SkillLoadCache;
  private promptLoader: PromptLoader;

  constructor(plugin: PersonalAgentPlugin) {
    this.plugin = plugin;
    this.agentManager = new AgentManager();

    // Initialize Skill system
    this.skillRegistry = new SkillRegistry();
    this.mcpManager = new MCPManager(this.skillRegistry);
    this.skillLoader = new SkillLoader(plugin.app, 'personal-agent');

    // Initialize skill invocation strategy
    const invocationMode = plugin.settings.skillInvocationMode || 'progressive';
    this.skillInvocationContext = new SkillInvocationContext(invocationMode, plugin.app);

    // Initialize skill cache
    const cacheConfig = plugin.settings.skillInvocationConfig?.cacheConfig || {};
    this.skillCache = new SkillLoadCache(
      cacheConfig.ttl || 3600000,  // Default 1 hour
      cacheConfig.maxSize || 100    // Default 100 entries
    );

    // Initialize prompt loader
    this.promptLoader = new PromptLoader(plugin.app, FALLBACK_PROMPTS);

    // Create skill context
    const skillContext: SkillContext = {
      vault: plugin.app.vault,
      metadataCache: plugin.app.metadataCache,
      workspace: plugin.app.workspace,
      indexManager: plugin.indexManager,
      plugin: plugin
    };

    this.skillExecutor = new SkillExecutor(this.skillRegistry, skillContext);
  }

  /**
   * Initialize the orchestrator (load skills and create default agent)
   */
  async initialize(): Promise<void> {
    // Create skill context
    const skillContext: SkillContext = {
      vault: this.plugin.app.vault,
      metadataCache: this.plugin.app.metadataCache,
      workspace: this.plugin.app.workspace,
      indexManager: this.plugin.indexManager,
      plugin: this.plugin
    };

    // Load all skills from skills directory
    await this.loadAllSkills(skillContext);

    // Initialize MCP servers
    await this.initializeMCP();

    // Create default agent
    await this.createDefaultAgent();
  }

  /**
   * Create default chat agent
   */
  private async createDefaultAgent(): Promise<void> {
    const provider = await this.plugin.aiRouter.getProvider(TaskType.CHAT);

    // Build system prompt with vault overview and skill information
    const systemPrompt = await this.buildSystemPrompt();

    const agentConfig: AgentConfig = {
      id: 'default-chat-agent',
      name: 'Chat Agent',
      description: 'Default chat agent with skill support',
      enableSkills: true,
      maxTurns: 20,
      temperature: 0.7,
      systemPrompt
    };

    const dependencies: AgentDependencies = {
      skillRegistry: this.skillRegistry,
      skillExecutor: this.skillExecutor,
      skillInvocationContext: this.skillInvocationContext
    };

    this.defaultAgent = new BaseAgent(agentConfig, provider, dependencies);
    this.agentManager.registerAgent(this.defaultAgent);
    this.agentManager.setCurrentAgent(this.defaultAgent.getId());
  }

  /**
   * Main query method - chat interface
   */
  async *query(
    userQuery: string,
    options: ChatQueryOptions = {}
  ): AsyncGenerator<AgentEvent, ChatQueryResult, any> {
    if (!this.defaultAgent) {
      throw new Error('ChatOrchestrator not initialized');
    }

    const context: AgentContext = {
      messages: options.contextMessages || [],
      sessionId: Date.now().toString(),
      metadata: {
        maxTurns: options.maxTurns  // Pass maxTurns through context
      }
    };

    const response = yield* this.agentManager.executeWithCurrentAgent(
      userQuery,
      context
    );

    return {
      response: response.content,
      messages: response.messages,
      skillCalls: response.skillCalls
    };
  }

  /**
   * Get AgentManager (for advanced usage)
   */
  getAgentManager(): AgentManager {
    return this.agentManager;
  }

  /**
   * Get default agent
   */
  getDefaultAgent(): BaseAgent | null {
    return this.defaultAgent;
  }

  /**
   * Load all skills from skills directory
   */
  private async loadAllSkills(context: SkillContext): Promise<void> {
    try {
      const allSkills = await this.skillLoader.loadAllSkills(context);

      // Separate executable and documentation skills
      const executableSkills = allSkills.filter(isExecutableSkill);
      const docSkills = allSkills.filter(isDocumentationSkill);

      // Register executable skills
      this.skillRegistry.registerBulk(executableSkills);

      // Register documentation skills
      this.skillRegistry.registerDocumentationBulk(docSkills);

      console.log(`[ChatOrchestrator] Loaded ${allSkills.length} skills from skills directory (${executableSkills.length} executable, ${docSkills.length} documentation)`);
    } catch (error) {
      console.error('[ChatOrchestrator] Failed to load skills:', error);
    }
  }

  /**
   * Reload all skills (useful for development/debugging)
   */
  async reloadSkills(): Promise<void> {
    const skillContext: SkillContext = {
      vault: this.plugin.app.vault,
      metadataCache: this.plugin.app.metadataCache,
      workspace: this.plugin.app.workspace,
      indexManager: this.plugin.indexManager,
      plugin: this.plugin
    };

    // Clear existing skills
    this.skillRegistry = new SkillRegistry();
    this.skillExecutor = new SkillExecutor(this.skillRegistry, skillContext);

    // Reload all skills
    await this.loadAllSkills(skillContext);

    // Recreate default agent with new skill registry
    await this.createDefaultAgent();
  }

  /**
   * Initialize MCP servers
   */
  private async initializeMCP(): Promise<void> {
    const mcpServers = this.plugin.settings.mcpServers || [];

    for (const serverConfig of mcpServers) {
      this.mcpManager.addServer(serverConfig);
    }

    // Connect to enabled servers
    await this.mcpManager.connectAll();

    const stats = this.mcpManager.getStats();
    console.log(`[ChatOrchestrator] MCP initialized: ${stats.connectedServers}/${stats.totalServers} servers, ${stats.totalTools} tools`);
  }

  /**
   * Build system prompt with vault overview and skill information
   */
  private async buildSystemPrompt(): Promise<string> {
    // Collect vault statistics
    const allFiles = this.plugin.app.vault.getMarkdownFiles();
    const totalFiles = allFiles.length;

    // Get folder list (deduplicated, sorted)
    const folders = new Set<string>();
    allFiles.forEach(file => {
      if (file.parent && file.parent.path !== '/') {
        folders.add(file.parent.path);
      }
    });
    const topFolders = Array.from(folders).slice(0, 5).join(', ');

    // Get common tags (from metadata cache)
    const tagCounts = new Map<string, number>();
    allFiles.forEach(file => {
      const cache = this.plugin.app.metadataCache.getFileCache(file);
      const fileTags = cache?.tags?.map((t: any) => t.tag.replace('#', '')) || [];
      const frontmatterTags = cache?.frontmatter?.tags || [];
      [...fileTags, ...frontmatterTags].forEach(tag => {
        const tagStr = typeof tag === 'string' ? tag : String(tag);
        tagCounts.set(tagStr, (tagCounts.get(tagStr) || 0) + 1);
      });
    });
    const topTags = Array.from(tagCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([tag]) => tag)
      .join(', ');

    // Use skill invocation strategy to prepare system prompt content
    const skillContent = this.skillInvocationContext.prepareSystemPrompt(this.skillRegistry);

    // Try to load system prompt from file, fall back to embedded version
    try {
      return await this.promptLoader.loadPrompt(PROMPT_PATHS.SYSTEM_PROMPT, {
        [TEMPLATE_VARS.TOTAL_FILES]: totalFiles.toString(),
        [TEMPLATE_VARS.TOP_FOLDERS]: topFolders || 'None',
        [TEMPLATE_VARS.TOP_TAGS]: topTags || 'None',
        [TEMPLATE_VARS.SKILL_CONTENT]: skillContent
      });
    } catch (error) {
      console.error('[ChatOrchestrator] Error building system prompt, using inline fallback:', error);

      // Inline fallback
      return `You are a helpful AI assistant for an Obsidian vault.

${skillContent}

RULES:
- Use available skills to help the user manage their knowledge base
- Be concise but thorough
- When creating or editing Obsidian files, use proper Markdown syntax

Use your skills proactively to help the user manage their knowledge base.

VAULT OVERVIEW (DYNAMIC):
- Total documents: ${totalFiles}
- Main folders: ${topFolders || 'None'}
- Common tags: ${topTags || 'None'}`;
    }
  }

  /**
   * Get skill registry (for external access)
   */
  getSkillRegistry(): SkillRegistry {
    return this.skillRegistry;
  }

  /**
   * Get skill executor (for external access)
   */
  getSkillExecutor(): SkillExecutor {
    return this.skillExecutor;
  }

  /**
   * Get MCP manager (for external access)
   */
  getMCPManager(): MCPManager {
    return this.mcpManager;
  }

  /**
   * Get skill invocation context (for external access)
   */
  getSkillInvocationContext(): SkillInvocationContext {
    return this.skillInvocationContext;
  }

  /**
   * Get skill cache (for external access)
   */
  getSkillCache(): SkillLoadCache {
    return this.skillCache;
  }
}
