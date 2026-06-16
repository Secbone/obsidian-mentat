// ChatOrchestrator - Orchestrates chat conversations with agent and skill support

import { TaskType, ChatMessage } from '../types';
import { Notice } from 'obsidian';
import { SkillRegistry } from '../skills/core/skill-registry';
import { SkillExecutor } from '../skills/core/skill-executor';
import { SkillContext, SkillCall, isExecutableSkill, isDocumentationSkill, SkillDefinition } from '../skills/skill-types';
import { MCPManager } from '../skills/mcp';
import { SkillLoader } from '../skills/core/skill-loader';
import { SkillInvocationContext } from '../skills/strategies/skill-invocation-strategy';
import { SkillLoadCache } from '../skills/core/skill-cache';
import { PromptLoader } from '../prompts/prompt-loader';
import { PROMPT_PATHS, FALLBACK_PROMPTS, TEMPLATE_VARS } from '../prompts/prompt-templates';
import { BaseAgent, AgentDependencies } from '../agents/base-agent';
import { AgentManager } from '../agents/agent-manager';
import { AgentConfig, AgentContext, AgentEvent, AgentResponse } from '../agents/agent-types';
import { VaultDiagnosticsLogger } from '../diagnostics/vault-diagnostics-logger';
import { IPlatformAdapter, IPlatformFile } from '../types/platform';
import { ConfirmationModal } from '../ui/confirmation-modal';
import { z } from 'zod';

export interface ChatQueryOptions {
  enableSkills?: boolean;
  maxTurns?: number;
  contextMessages?: ChatMessage[];
  context?: AgentContext;
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
  private diagnosticsLogger: VaultDiagnosticsLogger;
  
  // Decoupled host & engine references
  private platform: IPlatformAdapter;
  private settings: any;
  private aiRouter: any;
  private indexManager: any;

  // Skill system components
  private skillRegistry: SkillRegistry;
  private skillExecutor: SkillExecutor;
  private skillInvocationContext: SkillInvocationContext;
  private skillLoader: SkillLoader;
  private mcpManager: MCPManager;
  private skillCache: SkillLoadCache;
  private promptLoader: PromptLoader;

  constructor(
    platform: IPlatformAdapter,
    settings: any,
    aiRouter: any,
    indexManager: any
  ) {
    this.platform = platform;
    this.settings = settings;
    this.aiRouter = aiRouter;
    this.indexManager = indexManager;
    this.agentManager = new AgentManager();

    const app = (platform as any).app;

    // Initialize Skill system
    this.skillRegistry = new SkillRegistry();
    this.mcpManager = new MCPManager(this.skillRegistry);
    this.skillLoader = new SkillLoader(app, 'mentat');

    // Initialize skill invocation strategy
    const invocationMode = settings.skillInvocationMode || 'progressive';
    this.skillInvocationContext = new SkillInvocationContext(
      invocationMode,
      platform,
      settings.skillInvocationConfig?.directCallSkills
    );

    // Initialize skill cache
    const cacheConfig = settings.skillInvocationConfig?.cacheConfig || {};
    this.skillCache = new SkillLoadCache(
      cacheConfig.ttl || 3600000,  // Default 1 hour
      cacheConfig.maxSize || 100    // Default 100 entries
    );

    // Initialize prompt loader
    this.promptLoader = new PromptLoader(platform, FALLBACK_PROMPTS);

    // Create skill context
    const skillContext: SkillContext = {
      vault: app?.vault,
      metadataCache: app?.metadataCache,
      workspace: app?.workspace,
      indexManager: indexManager,
      plugin: (platform as any).plugin
    };

    this.skillExecutor = new SkillExecutor(this.skillRegistry, skillContext);
    this.diagnosticsLogger = new VaultDiagnosticsLogger(platform.getVault());
  }

  dispose(): void {
    this.mcpManager?.disconnectAll();
  }

  /**
   * Initialize the orchestrator (load skills and create default agent)
   */
  async initialize(): Promise<void> {
    const app = (this.platform as any).app;
    
    // Create skill context
    const skillContext: SkillContext = {
      vault: app?.vault,
      metadataCache: app?.metadataCache,
      workspace: app?.workspace,
      indexManager: this.indexManager,
      plugin: (this.platform as any).plugin
    };

    // Load all skills from skills directory
    await this.loadAllSkills(skillContext);

    // Initialize MCP servers
    await this.initializeMCP();

    // Create default agent
    await this.createDefaultAgent();

    // Initialize subagents
    await this.initializeSubagents();

    // Ensure vault-map.md exists (Cold-Start Engine)
    await this.ensureVaultMapExists();
  }

  /**
   * Create default chat agent
   */
  private async createDefaultAgent(): Promise<void> {
    const provider = await this.aiRouter.getProvider(TaskType.CHAT);

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
      skillInvocationContext: this.skillInvocationContext,
      diagnosticsLogger: this.diagnosticsLogger
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

    const messages = options.contextMessages || [];
    
    // Find if we already have a session context in the history
    const firstUserMsg = messages.find(m => m.role === 'user');
    let sessionContextPayload = firstUserMsg?.metadata?.sessionContextPayload;

    if (!sessionContextPayload) {
      // Generate it once for the session
      sessionContextPayload = await this.buildVaultSessionContextPayload();
    }

    const app = (this.platform as any).app;
    const context: AgentContext = options.context || {
      messages: messages,
      sessionId: Date.now().toString(),
      metadata: {
        maxTurns: options.maxTurns,  // Pass maxTurns through context
        sessionContextPayload
      },
      confirmHandler: async (skillName, params, message) => {
        return new Promise((resolve) => {
          new ConfirmationModal(
            app,
            {
              skillName,
              description: message || '',
              parameters: params || {},
              operationType: 'write'
            },
            (confirmed) => resolve({ approved: confirmed })
          ).open();
        });
      }
    };

    const response = yield* this.agentManager.execute(
      this.defaultAgent.getId(),
      userQuery,
      context
    );

    return {
      response: response.content,
      messages: response.messages,
      skillCalls: response.skillCalls
    };
  }

  private async buildVaultSessionContextPayload(): Promise<string> {
    const allFiles = this.platform.getMarkdownFiles();
    const totalFiles = allFiles.length;

    const vaultHierarchy = this.buildSemanticDirectoryTree(allFiles);
    const dynamicVaultMap = await this.generateSemanticVaultMap(allFiles);
    const userVaultMap = await this.getVaultMap();
    const formattedTime = new Date().toLocaleString('zh-CN', { hour12: false });

    // Determine if the user-defined map is customized or is just the default placeholder
    const hasCustomMap = userVaultMap && 
                         !userVaultMap.includes('*(None defined') && 
                         userVaultMap.trim() !== dynamicVaultMap.trim();

    return `[Vault Session Context]
- Current Time: ${formattedTime}
- Total documents: ${totalFiles}

Semantic Directory Hierarchy:
${vaultHierarchy}

Vault Knowledge Map (Folders, Tags & Note Summaries):
${dynamicVaultMap}${hasCustomMap ? `\n\nUser-Defined Custom Guidelines (vault-map.md):\n${userVaultMap}` : ''}`;
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
    const app = (this.platform as any).app;
    
    const skillContext: SkillContext = {
      vault: app?.vault,
      metadataCache: app?.metadataCache,
      workspace: app?.workspace,
      indexManager: this.indexManager,
      plugin: (this.platform as any).plugin
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
    const mcpServers = this.settings.mcpServers || [];

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
    // Use skill invocation strategy to prepare system prompt content
    const skillContent = this.skillInvocationContext.prepareSystemPrompt(this.skillRegistry);

    // Try to load system prompt from file, fall back to embedded version
    try {
      const userPreferences = await this.getUserPreferences();
      return await this.promptLoader.loadPrompt(PROMPT_PATHS.SYSTEM_PROMPT, {
        [TEMPLATE_VARS.TOTAL_FILES]: "(Refer to the Vault Session Context in the message history)",
        [TEMPLATE_VARS.TOP_FOLDERS]: "(Refer to the Vault Session Context in the message history)",
        [TEMPLATE_VARS.TOP_TAGS]: "(Refer to the Vault Session Context in the message history)",
        [TEMPLATE_VARS.SKILL_CONTENT]: skillContent,
        [TEMPLATE_VARS.USER_PREFERENCES]: userPreferences,
        [(TEMPLATE_VARS as any).VAULT_HIERARCHY || 'vaultHierarchy']: "(Refer to the Vault Session Context in the message history)",
        [(TEMPLATE_VARS as any).VAULT_MAP || 'vaultMap']: "(Refer to the Vault Session Context in the message history)"
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
- **MANDATORY STREAMING FINAL ANSWER WRAPPING (CRITICAL)**: When you have finished all necessary tool calls and reasoning, and are ready to provide your final answer to the user, you MUST strictly wrap your final user-facing response inside \`<final_answer>\` and \`</final_answer>\` tags. Anything outside these tags (such as your intermediate explanations, thoughts, or plans) will be treated as internal reasoning chain and hidden from the user's primary chat bubble. Keep your final answer comprehensive and completely self-contained.

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
    - Total documents: (Refer to the Vault Session Context in the message history)
    
    SEMANTIC DIRECTORY HIERARCHY:
    (Refer to the Vault Session Context in the message history)
    
    USER-DEFINED KNOWLEDGE MAP:
    (Refer to the Vault Session Context in the message history)`;
    }
  }

  /**
   * Safe reader for the user-customizable vault-map.md configuration file.
   */
  async getVaultMap(): Promise<string> {
    try {
      const configFolder = this.settings.userConfigFolder || 'Mentat/Config';
      const mapPath = `${configFolder}/vault-map.md`;

      if (await this.platform.exists(mapPath)) {
        return await this.platform.read(mapPath);
      }
      return '*(None defined. Click "Open Vault Knowledge Map" in Settings to outline your vault structure.)*';
    } catch (error) {
      console.error('[ChatOrchestrator] Error reading vault-map.md:', error);
      return '*(None defined. Click "Open Vault Knowledge Map" in Settings to outline your vault structure.)*';
    }
  }

  /**
   * Automatically creates the vault-map.md with default templates and scanned vault directories if it does not exist.
   */
  /**
   * Generates a high-density Knowledge Structure Map from the vault files locally.
   */
  private async generateSemanticVaultMap(allFiles: any[]): Promise<string> {
    const folderDataMap = new Map<string, {
      files: any[];
      tags: Map<string, number>;
      directCount: number;
    }>();

    // Group files by folder
    for (const file of allFiles) {
      if (!file.parent) continue;
      const folderPath = file.parent.path === '/' || file.parent.path === '.' || !file.parent.path ? 'Root' : file.parent.path;
      
      if (!folderDataMap.has(folderPath)) {
        folderDataMap.set(folderPath, {
          files: [],
          tags: new Map<string, number>(),
          directCount: 0
        });
      }
      
      const folderData = folderDataMap.get(folderPath)!;
      folderData.files.push(file);
      folderData.directCount++;

      // Count tags in this file
      const fileTags = this.getFileTags(file);
      for (const tag of fileTags) {
        if (tag) {
          folderData.tags.set(tag, (folderData.tags.get(tag) || 0) + 1);
        }
      }
    }

    let mapContent = `# 🗺️ Vault Knowledge Structure Map\n\n`;
    mapContent += `This document maps the directory roles, core tags, and primary notes of this Obsidian vault. Mentat reads this structure to contextualize its actions.\n\n`;
    mapContent += `> [!note]\n`;
    mapContent += `> This map is automatically generated. You can customize the folder descriptions below to guide Mentat's filing system.\n\n`;
    mapContent += `## 📁 Core Folder Guidelines\n\n`;

    // Sort folders alphabetically
    const sortedFolders = Array.from(folderDataMap.keys()).sort((a, b) => {
      if (a === 'Root') return -1;
      if (b === 'Root') return 1;
      return a.localeCompare(b);
    });

    for (const folder of sortedFolders) {
      const data = folderDataMap.get(folder)!;
      
      // Get top 5 tags
      const topTags = Array.from(data.tags.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([tag]) => `#${tag}`)
        .join(', ');

      // Sort files by modification time or size (we can use stat.mtime to list newest first)
      const sortedFiles = [...data.files].sort((a, b) => (b.stat?.mtime || 0) - (a.stat?.mtime || 0));
      const keyNotes = sortedFiles
        .slice(0, 5)
        .map(f => {
          const cleanPath = f.path.replace(/\.md$/, '');
          const cleanName = f.name.replace(/\.md$/, '');
          return `[[${cleanPath}|${cleanName}]]`;
        })
        .join(', ');

      const displayName = folder === 'Root' ? 'Root Directory' : `${folder}/`;
      mapContent += `### 📂 \`[[${displayName}]]\`\n`;
      mapContent += `- **Role/Theme**: Filing notes and documents relating to ${folder === 'Root' ? 'general vault home' : folder.split('/').pop()}.\n`;
      if (keyNotes) {
        mapContent += `- **Sample Notes**: ${keyNotes}\n`;
      }
      if (topTags) {
        mapContent += `- **Frequent Tags**: ${topTags}\n`;
      }
      mapContent += `- **Stats**: ${data.directCount} documents\n\n`;
    }

    return mapContent;
  }

  /**
   * Automatically creates the vault-map.md with default templates and scanned vault directories if it does not exist.
   */
  async ensureVaultMapExists(): Promise<void> {
    try {
      const configFolder = this.settings.userConfigFolder || 'Mentat/Config';
      const mapPath = `${configFolder}/vault-map.md`;

      // Auto-create folder paths recursively if they do not exist
      if (!(await this.platform.exists(configFolder))) {
        await this.platform.mkdir(configFolder);
      }

      // Create default template if file does not exist
      if (!(await this.platform.exists(mapPath))) {
        const allFiles = this.platform.getMarkdownFiles();
        const defaultTemplate = await this.generateSemanticVaultMap(allFiles);
        await this.platform.write(mapPath, defaultTemplate);
        console.log('[ChatOrchestrator] Generated rich semantic vault-map.md successfully');
      }
    } catch (error) {
      console.error('[ChatOrchestrator] Error initializing vault-map.md:', error);
    }
  }

  /**
   * Premium AI-Assisted Vault-Map Generation
   * Scans vault directories, collects note counts, popular tags, and recent file names,
   * then feeds this structural context to the active LLM to generate highly personalized guidelines.
   */
  async aiRebuildVaultMap(onProgress?: (stage: string, percent: number) => void): Promise<void> {
    const configFolder = this.settings.userConfigFolder || 'Mentat/Config';
    const mapPath = `${configFolder}/vault-map.md`;

    // 1. Gather all files in the vault to analyze folder structures, file names, and tag frequencies
    onProgress?.('正在扫描库中的文件夹与笔记结构...', 15);
    const allFiles = this.platform.getMarkdownFiles();
    const folderStats = new Map<string, { noteCount: number; files: { name: string; mtime: number }[]; tags: Map<string, number> }>();

    allFiles.forEach(file => {
      if (file.parent && file.parent.path !== '/' && file.parent.path !== '.') {
        const folder = file.parent.path;
        if (!folderStats.has(folder)) {
          folderStats.set(folder, {
            noteCount: 0,
            files: [],
            tags: new Map<string, number>()
          });
        }

        const stat = folderStats.get(folder)!;
        stat.noteCount += 1;
        stat.files.push({ name: file.name, mtime: file.stat.mtime });

        // Extract tags for tag frequency mapping
        const tags = this.getFileTags(file);
        tags.forEach(tag => {
          stat.tags.set(tag, (stat.tags.get(tag) || 0) + 1);
        });
      }
    });

    // Process the stats to compile structured metadata for the LLM
    onProgress?.('正在整理并分析热门标签与最新笔记样本...', 35);
    const analyzedFolders: any[] = [];
    folderStats.forEach((stat, folder) => {
      // Sort files by modification time descending and pick top 5
      const recentFiles = stat.files
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, 5)
        .map(f => f.name);

      // Sort tags by frequency descending and pick top 3
      const topTags = Array.from(stat.tags.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([tag]) => tag);

      analyzedFolders.push({
        folder: `${folder}/`,
        totalNoteCount: stat.noteCount,
        recentSampleFiles: recentFiles,
        topFrequentTags: topTags
      });
    });

    // 2. Fetch the active AI provider
    const provider = await this.aiRouter.getProvider(TaskType.CHAT);
    if (!provider) {
      throw new Error('未配置或未启用任何 AI 服务商，请先在设置中配置 API Key。 (No active AI provider configured)');
    }

    // 3. Format prompting with actual vault statistics
    const vaultDataStr = JSON.stringify(analyzedFolders, null, 2);
    const prompt = `You are a professional knowledge management expert specializing in Obsidian vaults.
Analyze the following folder structure, sample filenames, and tag distributions in the user's vault to draft a customized, highly comprehensive vault-map guidelines file.

Vault Structure Data:
${vaultDataStr}

Guidelines for generating the "vault-map.md" file:
1. Provide a beautiful title: "# 🗺️ Vault Knowledge Structure Map".
2. Create a "## 📁 Core Folder Guidelines" section. For EACH folder listed in the data, write a detailed, highly accurate description (in Chinese) of what kind of notes belong there based on the sample files and popular tags found. Format the folder names as double-bracket wiki-links (e.g. "- \`[[Research/ML/]]\`: 用于存放机器学习、最优化损失函数及研究计划 of 笔记与推导。").
3. Create a "## 🏷️ Category Workflows & Wiki-Linking" section. Under it:
   - Identify naming conventions (e.g., prefixing, suffixing, or case formats) you detect from note titles in each directory.
   - Outline suggested workflows and relationships between these folders (e.g., rough notes and captured inputs in Inbox should be polished and moved to Research or Projects).
4. Strictly return ONLY the raw Markdown content. Do not include any HTML script tags, dynamic canvas elements, markdown block wrappers (\`\`\`), or conversational preamble.

Return the finalized markdown content:`;

    // 4. Call LLM to generate the content
    onProgress?.('正在调用 AI 智能服务商规划知识库结构指南 (大约需要 5-10 秒)...', 65);
    const response = await provider.generate(prompt);
    if (!response || !response.trim()) {
      throw new Error('AI 生成了空内容，请重试。 (AI returned empty response)');
    }

    const cleanMarkdown = response.replace(/^```markdown\n/i, '').replace(/```$/i, '').trim();

    // 5. Ensure config folder exists
    onProgress?.('正在保存并写入本地地图配置文件...', 90);
    if (!(await this.platform.exists(configFolder))) {
      await this.platform.mkdir(configFolder);
    }

    // 6. Overwrite or create file
    await this.platform.write(mapPath, cleanMarkdown);
  }

  /**
   * Helper to extract tags safely from metadata cache of a single file
   */
  private getFileTags(file: IPlatformFile): string[] {
    const cache = this.platform.getFileCache(file);
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
  private buildSemanticDirectoryTree(allFiles: IPlatformFile[]): string {
    interface FolderNode {
      name: string;
      path: string;
      depth: number;
      directFiles: IPlatformFile[];
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
      const configFolder = this.settings.userConfigFolder || 'Mentat/Config';
      const preferencesPath = `${configFolder}/user-preferences.md`;

      // 1. If preferences file exists, read and return it
      if (await this.platform.exists(preferencesPath)) {
        return await this.platform.read(preferencesPath);
      }

      // 2. If config folder doesn't exist, create it recursively
      if (!(await this.platform.exists(configFolder))) {
        await this.platform.mkdir(configFolder);
      }

      // 3. Create the template file
      const defaultTemplate = `# User Prompt Preferences

Write your custom style instructions and preferences here. This file is dynamically read by Mentat and injected directly into the AI system prompt to guide its behavior and output style.

## Instructions
- These settings apply to all chat and research sessions.
- You can modify this file at any time. Changes are loaded dynamically when a new session starts.
- Because this note is parsed safely as raw text, you can write anything here without worrying about crashing the plugin.

## Your Custom Preferences
(Write your rules below, for example: "Do not use emojis in headings", "Use high-density bullet points", "Compare outputs with my personal notes style")

- 
`;
      await this.platform.write(preferencesPath, defaultTemplate);
      return defaultTemplate;
    } catch (e) {
      console.error('[ChatOrchestrator] Error loading/initializing user prompt preferences:', e);
      // Absolute safety isolation: fall back to setting or 'None' rather than throwing/crashing
      return this.settings.userSystemPromptPreferences || 'None';
    }
  }

  /**
   * Scan and register system + custom user-defined subagents
   */
  private async initializeSubagents(): Promise<void> {
    const provider = await this.aiRouter.getProvider(TaskType.CHAT);
    const dependencies: AgentDependencies = {
      skillRegistry: this.skillRegistry,
      skillExecutor: this.skillExecutor,
      skillInvocationContext: this.skillInvocationContext,
      diagnosticsLogger: this.diagnosticsLogger
    };

    // 1. Register Default Writer Agent
    const writerSystemPrompt = `${await this.buildSystemPrompt()}

=======================================================
WRITER ROLE INSTRUCTIONS (CRITICAL):
You are an expert technical note writer. Your goal is to draft comprehensive, accurate, and high-density technical notes.
- Use available skills/tools to gather information.
- Structure your output elegantly using headers and bulleted lists.
- Avoid generic filler text and boilerplate headers.
- Always review your own outputs for LaTeX math and wikilink syntax.
=======================================================`;

    const writerConfig: AgentConfig = {
      id: 'writer-agent',
      name: 'Writer Agent',
      description: 'Specialized technical content draft agent with skill capabilities',
      enableSkills: true,
      maxTurns: 20,
      temperature: 0.7,
      systemPrompt: writerSystemPrompt
    };
    const writerAgent = new BaseAgent(writerConfig, provider, dependencies);
    this.agentManager.registerAgent(writerAgent);

    // 2. Register Default Reviewer Agent
    const reviewerSystemPrompt = `You are a strict, detail-oriented Obsidian note auditor.
Your job is to critically review technical drafts for quality, syntax correctness, and structural integrity.

CRITICAL INSTRUCTIONS:
- Verify that all LaTeX block formulas '$$' and inline formulas '$' are balanced and closed.
- Verify that code blocks are balanced and closed with triple backticks.
- Verify that wikilinks '[[Note]]' are balanced.
- Verify that there are no decorative emojis in headings.
- Check if the technical content is deep enough and has concrete examples.

IF the draft is of stellar quality and has NO structural or formatting errors:
- Respond with exactly: APPROVED

OTHERWISE:
- Respond with a clear, concise bulleted list of specific criticisms and actions that the Writer MUST fix.
- Do NOT include any other text besides the bulleted list.
`;

    const reviewerConfig: AgentConfig = {
      id: 'reviewer-agent',
      name: 'Reviewer Agent',
      description: 'Obsidian note formatting and quality auditor',
      enableSkills: false,
      maxTurns: 5,
      temperature: 0.2,
      systemPrompt: reviewerSystemPrompt
    };
    const reviewerAgent = new BaseAgent(reviewerConfig, provider, dependencies);
    this.agentManager.registerAgent(reviewerAgent);

    // 3. Scan and Load Custom User Agents from Vault
    try {
      const configFolder = this.settings.userConfigFolder || 'Mentat/Config';
      const agentsFolder = `${configFolder}/agents`;
      if (await this.platform.exists(agentsFolder)) {
        const listResult = await this.platform.list(agentsFolder);
        for (const filePath of listResult.files) {
          if (filePath.endsWith('.json')) {
            try {
              const fileContent = await this.platform.read(filePath);
              const customConfig: AgentConfig = JSON.parse(fileContent);
              if (customConfig.id && customConfig.name) {
                const customAgent = new BaseAgent(customConfig, provider, dependencies);
                this.agentManager.registerAgent(customAgent);
                console.log(`[ChatOrchestrator] Successfully loaded custom agent: ${customConfig.id}`);
              }
            } catch (err) {
              console.error(`[ChatOrchestrator] Failed to load custom agent config ${filePath}:`, err);
            }
          }
        }
      }
    } catch (e) {
      console.error('[ChatOrchestrator] Error loading custom user agents:', e);
    }

    // 4. Register delegate_task skill
    const delegateTaskSkill: SkillDefinition = {
      name: 'delegate_task',
      namespace: 'obsidian',
      description: 'Delegate a specific task or prompt to a specialized subagent (e.g. writer-agent, reviewer-agent) and get its output.',
      schema: z.object({
        agentId: z.string().describe('The ID of the agent to delegate to (e.g. "writer-agent", "reviewer-agent")'),
        prompt: z.string().describe('The detailed instructions or content for the agent to process')
      }),
      execute: async (input: { agentId: string; prompt: string }) => {
        try {
          const agent = this.agentManager.getAgent(input.agentId);
          if (!agent) {
            return { success: false, error: `Agent not found: ${input.agentId}` };
          }
          
          new Notice(`🤖 正在委派任务给 ${agent.getName()}...`);
          
          // Execute agent to completion
          const stream = agent.execute(input.prompt, {
            messages: [], // Isolated context
            sessionId: `subagent-${Date.now()}`
          });
          
          let result = await stream.next();
          while (!result.done) {
            result = await stream.next();
          }
          
          const response = result.value as AgentResponse;
          return {
            success: true,
            data: response.content,
            metadata: {
              subagentMessages: response.messages,
              agentId: input.agentId
            }
          };
        } catch (err: any) {
          return { success: false, error: `Delegation error: ${err.message}` };
        }
      }
    };
    this.skillRegistry.register(delegateTaskSkill);

    // 5. Register spawn_subagent skill
    const spawnSubagentSkill: SkillDefinition = {
      name: 'spawn_subagent',
      namespace: 'obsidian',
      description: 'Dynamically spawn a temporary subagent with custom roles and prompts to assist with a sub-task.',
      schema: z.object({
        name: z.string().describe('The name of the temporary subagent (e.g. "Translator", "Summarizer")'),
        systemPrompt: z.string().describe('The system instructions defining the behavior and constraints of the subagent'),
        prompt: z.string().describe('The instructions or prompt to execute')
      }),
      execute: async (input: { name: string; systemPrompt: string; prompt: string }) => {
        const tempAgentId = `temp-${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
        try {
          const tempConfig: AgentConfig = {
            id: tempAgentId,
            name: input.name,
            description: 'Dynamically spawned subagent',
            enableSkills: false, // Keep subagents simple by default
            maxTurns: 5,
            temperature: 0.5,
            systemPrompt: input.systemPrompt
          };
          
          const tempAgent = new BaseAgent(tempConfig, provider, dependencies);
          this.agentManager.registerAgent(tempAgent);
          
          new Notice(`🤖 正在生成子智能体: ${input.name}...`);
          
          const stream = tempAgent.execute(input.prompt, {
            messages: [],
            sessionId: `subagent-${Date.now()}`
          });
          
          let result = await stream.next();
          while (!result.done) {
            result = await stream.next();
          }
          
          const response = result.value as AgentResponse;
          
          return {
            success: true,
            data: response.content,
            metadata: {
              subagentMessages: response.messages,
              agentId: tempAgentId
            }
          };
        } catch (err: any) {
          return { success: false, error: `Spawning error: ${err.message}` };
        } finally {
          this.agentManager.unregisterAgent(tempAgentId);
        }
      }
    };
    this.skillRegistry.register(spawnSubagentSkill);
  }
}
