// ChatOrchestrator - Orchestrates chat conversations with agent and skill support

import { TFile } from 'obsidian';
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
import { AgentConfig, AgentContext, AgentEvent, AgentResponse } from '../agents/agent-types';
import { DraftReviewPipeline } from './draft-review-pipeline';

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
    this.skillInvocationContext = new SkillInvocationContext(
      invocationMode,
      plugin.app,
      plugin.settings.skillInvocationConfig?.directCallSkills
    );

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

    const isWritingTask = /起草|写作|撰写|写笔记|新建笔记|研究报告|文章|draft|write|note|report|article/i.test(userQuery);
    const useDraftReview = this.plugin.settings.draftReviewModeEnabled || (this.plugin.settings.draftReviewModeEnabled !== false && isWritingTask);

    let response: AgentResponse;
    if (useDraftReview) {
      const provider = await this.plugin.aiRouter.getProvider(TaskType.CHAT);
      const baseSystemPrompt = await this.buildSystemPrompt();
      const dependencies: AgentDependencies = {
        skillRegistry: this.skillRegistry,
        skillExecutor: this.skillExecutor,
        skillInvocationContext: this.skillInvocationContext
      };

      const pipeline = new DraftReviewPipeline(provider, dependencies, baseSystemPrompt);
      const generator = pipeline.execute(userQuery, context);

      let result = await generator.next();
      while (!result.done) {
        yield result.value as AgentEvent;
        result = await generator.next();
      }
      response = result.value as AgentResponse;
    } else {
      response = yield* this.agentManager.executeWithCurrentAgent(
        userQuery,
        context
      );
    }

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

    // Get folder list (deduplicated, sorted) - kept for backwards compatibility
    const folders = new Set<string>();
    allFiles.forEach(file => {
      if (file.parent && file.parent.path !== '/') {
        folders.add(file.parent.path);
      }
    });
    const topFolders = Array.from(folders).slice(0, 5).join(', ');

    // Get common tags (from metadata cache) - kept for backwards compatibility
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

    // Generate Stage 4 dynamic semantic structures
    const vaultHierarchy = this.buildSemanticDirectoryTree(allFiles);
    const vaultMap = await this.getVaultMap();

    // Use skill invocation strategy to prepare system prompt content
    const skillContent = this.skillInvocationContext.prepareSystemPrompt(this.skillRegistry);

    // Try to load system prompt from file, fall back to embedded version
    try {
      const userPreferences = await this.getUserPreferences();
      return await this.promptLoader.loadPrompt(PROMPT_PATHS.SYSTEM_PROMPT, {
        [TEMPLATE_VARS.TOTAL_FILES]: totalFiles.toString(),
        [TEMPLATE_VARS.TOP_FOLDERS]: topFolders || 'None',
        [TEMPLATE_VARS.TOP_TAGS]: topTags || 'None',
        [TEMPLATE_VARS.SKILL_CONTENT]: skillContent,
        [TEMPLATE_VARS.USER_PREFERENCES]: userPreferences,
        [(TEMPLATE_VARS as any).VAULT_HIERARCHY || 'vaultHierarchy']: vaultHierarchy,
        [(TEMPLATE_VARS as any).VAULT_MAP || 'vaultMap']: vaultMap
      });
    } catch (error) {
      console.error('[ChatOrchestrator] Error building system prompt, using inline fallback:', error);

      const userPreferences = await this.getUserPreferences();
      // Inline fallback
      return `You are a helpful AI assistant for an Obsidian vault.

${skillContent}

RULES:
- Use available skills to help the user manage their knowledge base
- Be concise but thorough
- When creating or editing Obsidian files, use proper Obsidian-Flavored Markdown syntax

OBSIDIAN SYNTAX CHEAT SHEET:
- Internal Links: ALWAYS use Wikilinks \`[[Note Name]]\` or \`[[Note Name|Display Text]]\` instead of standard markdown links.
- Embeds: Use \`![[Note Name]]\` or \`![[Note Name#Heading]]\` to embed other notes, headings, or media inline.
- Callouts: Use callouts like \`> [!note]\`, \`> [!tip]\`, \`> [!warning]\`, \`> [!important]\` (use \`> [!note]-\` to fold by default).
- Frontmatter: ALWAYS place a YAML metadata block at the very top of new notes enclosed by \`---\`.
- Tags: Use \`#nested/tag\` or \`#tag-name\` for hierarchical categorization.
- Block References: Reference paragraphs by appending \`^block-id\` to the block and linking via \`![[Note#^block-id]]\`.

USER-SPECIFIC CUSTOM PREFERENCES & STYLE (CRITICAL):
${userPreferences}

Use your skills proactively to help the user manage their knowledge base.

VAULT OVERVIEW & STRUCTURE:
- Total documents: ${totalFiles}

SEMANTIC DIRECTORY HIERARCHY:
${vaultHierarchy}

USER-DEFINED KNOWLEDGE MAP:
${vaultMap}`;
    }
  }

  /**
   * Safe reader for the user-customizable vault-map.md configuration file.
   */
  async getVaultMap(): Promise<string> {
    try {
      const configFolder = this.plugin.settings.userConfigFolder || 'Personal Agent/Config';
      const mapPath = `${configFolder}/vault-map.md`;
      const vault = this.plugin.app.vault;

      if (await vault.adapter.exists(mapPath)) {
        return await vault.adapter.read(mapPath);
      }
      return '*(None defined. Click "Open Vault Knowledge Map" in Settings to outline your vault structure.)*';
    } catch (error) {
      console.error('[ChatOrchestrator] Error reading vault-map.md:', error);
      return '*(None defined. Click "Open Vault Knowledge Map" in Settings to outline your vault structure.)*';
    }
  }

  /**
   * Helper to extract tags safely from metadata cache of a single file
   */
  private getFileTags(file: TFile): string[] {
    const cache = this.plugin.app.metadataCache.getFileCache(file);
    const fileTags = cache?.tags?.map((t: any) => t.tag.replace('#', '')) || [];
    const frontmatterTagsRaw = cache?.frontmatter?.tags;
    let frontmatterTags: string[] = [];
    if (Array.isArray(frontmatterTagsRaw)) {
      frontmatterTags = frontmatterTagsRaw.map(t => typeof t === 'string' ? t : String(t));
    } else if (typeof frontmatterTagsRaw === 'string') {
      frontmatterTags = frontmatterTagsRaw.split(',').map(t => t.trim());
    }
    const normalizedTags: string[] = [];
    [...fileTags, ...frontmatterTags].forEach(tag => {
      if (!tag) return;
      const tagStr = typeof tag === 'string' ? tag : String(tag);
      const cleanTag = tagStr.replace('#', '').trim();
      if (cleanTag) {
        normalizedTags.push(cleanTag);
      }
    });
    return Array.from(new Set(normalizedTags));
  }

  /**
   * Build a dynamic, nested, semantic directory outline up to depth 3
   */
  private buildSemanticDirectoryTree(allFiles: TFile[]): string {
    interface FolderNode {
      name: string;
      path: string;
      depth: number;
      directFiles: TFile[];
      recursiveCount: number;
      tagCounts: Map<string, number>;
      children: Map<string, FolderNode>;
    }

    const rootNode: FolderNode = {
      name: 'root',
      path: '',
      depth: 0,
      directFiles: [],
      recursiveCount: 0,
      tagCounts: new Map(),
      children: new Map()
    };

    allFiles.forEach(file => {
      const parentPath = file.parent ? file.parent.path : '';
      const fileTags = this.getFileTags(file);

      // Increment root stats
      rootNode.recursiveCount++;
      fileTags.forEach(tag => {
        rootNode.tagCounts.set(tag, (rootNode.tagCounts.get(tag) || 0) + 1);
      });

      if (!parentPath || parentPath === '/' || parentPath === '.') {
        rootNode.directFiles.push(file);
        return;
      }

      const segments = parentPath.split('/').filter(Boolean);
      let currentNode = rootNode;
      let currentPath = '';

      for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];
        currentPath = currentPath ? `${currentPath}/${segment}` : segment;

        if (!currentNode.children.has(segment)) {
          currentNode.children.set(segment, {
            name: segment,
            path: currentPath,
            depth: i + 1,
            directFiles: [],
            recursiveCount: 0,
            tagCounts: new Map(),
            children: new Map()
          });
        }

        currentNode = currentNode.children.get(segment)!;
        currentNode.recursiveCount++;
        fileTags.forEach(tag => {
          currentNode.tagCounts.set(tag, (currentNode.tagCounts.get(tag) || 0) + 1);
        });

        if (i === segments.length - 1) {
          currentNode.directFiles.push(file);
        }
      }
    });

    const lines: string[] = [];

    const serialize = (node: FolderNode) => {
      if (node.depth > 3) return;
      if (node.depth > 0) {
        const topTags = Array.from(node.tagCounts.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([tag]) => `#${tag}`)
          .join(', ');

        const indent = '  '.repeat(node.depth - 1);
        const tagSuffix = topTags ? ` | Tags: ${topTags}` : '';
        lines.push(`${indent}- \`${node.path}/\` (${node.recursiveCount} doc${node.recursiveCount !== 1 ? 's' : ''})${tagSuffix}`);
      }

      // Sort subdirectories by recursive document count descending (most active folders first)
      const sortedChildren = Array.from(node.children.values())
        .sort((a, b) => b.recursiveCount - a.recursiveCount);

      sortedChildren.forEach(child => serialize(child));
    };

    const topLevelFolders = Array.from(rootNode.children.values())
      .sort((a, b) => b.recursiveCount - a.recursiveCount);

    topLevelFolders.forEach(child => serialize(child));

    return lines.join('\n') || '- *(No folders containing documents)*';
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

  /**
   * Safe helper to load, initialize, or fallback prompt preferences from the vault configuration folder
   */
  async getUserPreferences(): Promise<string> {
    try {
      const configFolder = this.plugin.settings.userConfigFolder || 'Personal Agent/Config';
      const preferencesPath = `${configFolder}/user-preferences.md`;
      const vault = this.plugin.app.vault;

      // 1. If preferences file exists, read and return it
      if (await vault.adapter.exists(preferencesPath)) {
        return await vault.adapter.read(preferencesPath);
      }

      // 2. If config folder doesn't exist, create it recursively
      if (!(await vault.adapter.exists(configFolder))) {
        const folders = configFolder.split('/');
        let currentFolder = '';
        for (const folder of folders) {
          if (!folder) continue;
          currentFolder = currentFolder ? `${currentFolder}/${folder}` : folder;
          if (!(await vault.adapter.exists(currentFolder))) {
            await vault.createFolder(currentFolder);
          }
        }
      }

      // 3. Create the template file
      const defaultTemplate = `# User Prompt Preferences

Write your custom style instructions and preferences here. This file is dynamically read by Personal Agent and injected directly into the AI system prompt to guide its behavior and output style.

## Instructions
- These settings apply to all chat and research sessions.
- You can modify this file at any time. Changes are loaded dynamically when a new session starts.
- Because this note is parsed safely as raw text, you can write anything here without worrying about crashing the plugin.

## Your Custom Preferences
(Write your rules below, for example: "Do not use emojis in headings", "Use high-density bullet points", "Compare outputs with my personal notes style")

- 
`;
      await vault.create(preferencesPath, defaultTemplate);
      return defaultTemplate;
    } catch (e) {
      console.error('[ChatOrchestrator] Error loading/initializing user prompt preferences:', e);
      // Absolute safety isolation: fall back to setting or 'None' rather than throwing/crashing
      return this.plugin.settings.userSystemPromptPreferences || 'None';
    }
  }
}
