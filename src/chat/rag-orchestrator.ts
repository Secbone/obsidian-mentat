// RAG Orchestrator - Orchestrates the complete RAG pipeline with Skills support

import { TFile } from 'obsidian';
import PersonalAgentPlugin from '../main';
import { IndexManager } from '../indexing/index-manager';
import { FileChunk } from '../indexing/chunk-processor';
import { SourceTracker } from './source-tracker';
import { TaskType, ChatMessage, ToolCall, GenerateResponse } from '../types';
import { SkillRegistry } from '../skills/core/skill-registry';
import { SkillExecutor, ExecutionOptions } from '../skills/core/skill-executor';
import { SkillContext, SkillCall } from '../skills/skill-types';
import { MCPManager } from '../skills/mcp';
import { SkillLoader, isExecutableSkill, isDocumentationSkill } from '../skills/core/skill-loader';
import { SkillInvocationContext } from '../skills/strategies/skill-invocation-strategy';
import { SkillLoadCache } from '../skills/core/skill-cache';
import { SpecParams, InvokeParams } from '../skills/meta-tools';
import { PromptLoader } from '../prompts/prompt-loader';
import { PROMPT_PATHS, FALLBACK_PROMPTS, TEMPLATE_VARS } from '../prompts/prompt-templates';

export interface RAGContext {
  selectedFiles: TFile[];
  relevantChunks: FileChunk[];
  sources: Map<string, string>; // chunkId -> sourceInfo
  skillCalls?: SkillCall[]; // Track skill executions
}

export interface RAGQueryOptions {
  enableSkills?: boolean;
  maxTurns?: number; // Maximum number of agent turns
  onSkillCall?: (skillCall: SkillCall) => void;
}

export class RAGOrchestrator {
  private indexManager: IndexManager;
  private sourceTracker: SourceTracker;
  private skillRegistry: SkillRegistry;
  private skillExecutor: SkillExecutor;
  private mcpManager: MCPManager;
  private skillLoader: SkillLoader;
  private skillInvocationContext: SkillInvocationContext;
  private skillCache: SkillLoadCache;
  private promptLoader: PromptLoader;

  constructor(private plugin: PersonalAgentPlugin) {
    this.indexManager = plugin.indexManager;
    this.sourceTracker = new SourceTracker();

    // Initialize Skill system
    this.skillRegistry = new SkillRegistry();
    this.mcpManager = new MCPManager(this.skillRegistry);
    this.skillLoader = new SkillLoader(plugin.app, 'personal-agent');

    // Initialize skill invocation strategy (pass app instance for prompt loading)
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
      indexManager: this.indexManager,
      plugin: plugin
    };

    this.skillExecutor = new SkillExecutor(this.skillRegistry, skillContext);

    // Note: Skills will be loaded asynchronously via initialize()
  }

  /**
   * Initialize the orchestrator (load skills and MCP)
   * Must be called after construction
   */
  async initialize(): Promise<void> {
    // Create skill context
    const skillContext: SkillContext = {
      vault: this.plugin.app.vault,
      metadataCache: this.plugin.app.metadataCache,
      workspace: this.plugin.app.workspace,
      indexManager: this.indexManager,
      plugin: this.plugin
    };

    // Load all skills from skills directory
    await this.loadAllSkills(skillContext);

    // Initialize MCP servers
    await this.initializeMCP();
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

      console.log(`[RAGOrchestrator] Loaded ${allSkills.length} skills from skills directory (${executableSkills.length} executable, ${docSkills.length} documentation)`);
    } catch (error) {
      console.error('[RAGOrchestrator] Failed to load skills:', error);
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
      indexManager: this.indexManager,
      plugin: this.plugin
    };

    // Clear existing skills
    this.skillRegistry = new SkillRegistry();
    this.skillExecutor = new SkillExecutor(this.skillRegistry, skillContext);

    // Reload all skills
    await this.loadAllSkills(skillContext);
  }

  /**
   * Initialize MCP servers
   */
  async initializeMCP(): Promise<void> {
    const mcpServers = this.plugin.settings.mcpServers || [];

    for (const serverConfig of mcpServers) {
      this.mcpManager.addServer(serverConfig);
    }

    // Connect to enabled servers
    await this.mcpManager.connectAll();

    const stats = this.mcpManager.getStats();
    console.log(`[RAGOrchestrator] MCP initialized: ${stats.connectedServers}/${stats.totalServers} servers, ${stats.totalTools} tools`);
  }

  /**
   * Execute RAG query with streaming support and Skills
   */
  async query(
    userQuery: string,
    selectedFiles: TFile[],
    contextMessages: ChatMessage[] = [],
    onStream?: (chunk: string) => void,
    options: RAGQueryOptions = {}
  ): Promise<{ response: string; context: RAGContext; messages: ChatMessage[] }> {
    const enableSkills = options.enableSkills ?? this.plugin.settings.skillsEnabled ?? true;
    const maxTurns = options.maxTurns ?? this.plugin.settings.maxTurns ?? 5;

    // 1. Retrieve relevant chunks (only if files are selected)
    let relevantChunks: FileChunk[] = [];
    if (selectedFiles.length > 0) {
      relevantChunks = await this.retrieve(userQuery, selectedFiles);

      // Handle empty retrieval results when files are selected
      if (relevantChunks.length === 0) {
        console.warn('[RAG] No relevant chunks found');
        const errorMessage = this.buildNoResultsMessage();

        if (onStream) {
          for (const char of errorMessage) {
            onStream(char);
            await new Promise(resolve => setTimeout(resolve, 10));
          }
        }

        return {
          response: errorMessage,
          context: {
            selectedFiles,
            relevantChunks: [],
            sources: new Map(),
            skillCalls: []
          },
          messages: contextMessages
        };
      }
    }

    // 2. Build enhanced prompt with RAG context in system prompt
    const { prompt, systemPrompt } = this.buildPrompt(userQuery, relevantChunks);

    // 3. Generate response with Skills support
    let response: string;
    let messages: ChatMessage[] = [];
    const skillCalls: SkillCall[] = [];

    if (enableSkills) {
      const result = await this.generateWithSkills(
        prompt,
        systemPrompt,
        contextMessages,
        onStream,
        maxTurns,
        (skillCall) => {
          skillCalls.push(skillCall);
          if (options.onSkillCall) {
            options.onSkillCall(skillCall);
          }
        }
      );
      response = result.response;
      messages = result.messages;
    } else {
      const result = await this.generate(prompt, systemPrompt, onStream);
      response = result.response;
      // Combine context messages with new messages
      messages = [...contextMessages, ...result.messages];
    }

    // 4. Extract and format sources (only if we have chunks)
    let responseWithSources = response;
    if (relevantChunks.length > 0) {
      const citationSources = this.sourceTracker.extractSources(relevantChunks);
      const sourcesMarkdown = this.sourceTracker.formatSourcesAsMarkdown(citationSources);
      responseWithSources = response + sourcesMarkdown;
    }

    // 5. Build source map
    const sources = this.buildSourceMap(relevantChunks);

    return {
      response: responseWithSources,
      context: {
        selectedFiles,
        relevantChunks,
        sources,
        skillCalls
      },
      messages: messages
    };
  }

  /**
   * Generate response with Skills support (multi-turn agent loop)
   */
  private async generateWithSkills(
    initialPrompt: string,
    systemPrompt: string,
    contextMessages: ChatMessage[],
    onStream?: (chunk: string) => void,
    maxTurns: number = 5,
    onSkillCall?: (skillCall: SkillCall) => void
  ): Promise<{ response: string; messages: ChatMessage[] }> {
    const provider = await this.plugin.aiRouter.getProvider(TaskType.CHAT);

    // Check if provider supports skills
    if (!provider.supportsSkills || !provider.supportsSkills()) {
      console.warn('[RAG] Provider does not support skills, falling back to standard generation');
      return this.generate(initialPrompt, systemPrompt, onStream);
    }

    // Build message history (system prompt passed via options)
    const messages: ChatMessage[] = [
      ...contextMessages,
      {
        role: 'user',
        content: initialPrompt,
        timestamp: Date.now()
      }
    ];

    // Get skills in provider format using invocation strategy
    const skills = this.skillInvocationContext.getToolDefinitions(
      this.skillRegistry,
      provider.type === 'openai' ? 'openai' : 'anthropic'
    );

    let fullResponse = '';
    let turnCount = 0;

    // Agent loop
    while (turnCount < maxTurns) {
      turnCount++;

      // Generate with skills
      // Note: systemPrompt is passed via options.systemPrompt for all providers
      const result: GenerateResponse = await provider.generateStreamWithSkills!(
        messages,
        (chunk: string) => {
          fullResponse += chunk;
          if (onStream) {
            onStream(chunk);
          }
        },
        undefined, // onToolCall handled below
        {
          temperature: 0.7,
          maxTokens: 2048,
          systemPrompt, // Passed to all providers via options
          skills,
          toolChoice: 'auto'
        }
      );

      // Add assistant message to history
      const assistantMessage: ChatMessage = {
        role: 'assistant',
        content: result.content,
        timestamp: Date.now(),
        tool_calls: result.toolCalls
      };
      messages.push(assistantMessage);

      // Check if there are tool calls
      if (!result.toolCalls || result.toolCalls.length === 0) {
        // No more tool calls, we're done
        break;
      }

      // Execute tool calls
      for (const toolCall of result.toolCalls) {
        // Check if this is a meta-tool call (spec or invoke)
        if (this.skillInvocationContext.isMetaToolCall(toolCall.name)) {
          const metaResult = await this.handleMetaToolCall(toolCall, onStream);

          // Add meta-tool result to messages
          const toolResultMessage: ChatMessage = {
            role: 'tool',
            content: metaResult.content,
            timestamp: Date.now(),
            tool_call_id: toolCall.id,
            name: toolCall.name
          };
          messages.push(toolResultMessage);

          continue;
        }

        // Regular skill execution (for native mode or after invoke)
        const skillCall: SkillCall = {
          id: toolCall.id,
          skillName: toolCall.name,
          namespace: toolCall.name.startsWith('mcp:') ? 'mcp' : 'obsidian',
          parameters: typeof toolCall.arguments === 'string'
            ? JSON.parse(toolCall.arguments)
            : toolCall.arguments,
          status: 'executing',
          timestamp: Date.now()
        };

        // Special handling for ask_user skill
        const isAskUser = toolCall.name === 'obsidian:ask_user';

        // Check if skill requires confirmation
        const skill = this.skillRegistry.get(toolCall.name);
        const requiresConfirmation = skill?.metadata?.requiresConfirmation;

        // Notify about skill call
        if (onStream) {
          // Get skill name without namespace prefix
          const shortName = toolCall.name.split(':').pop() || toolCall.name;
          const displayParam = this.getSkillDisplayParam(toolCall.name, skillCall.parameters);

          if (isAskUser) {
            onStream(`\n\n${shortName}()\n`);
          } else if (requiresConfirmation) {
            const paramStr = displayParam ? `(${displayParam})` : '()';
            onStream(`\n\n⚠️ ${shortName}${paramStr}\n`);
          } else {
            const paramStr = displayParam ? `(${displayParam})` : '()';
            onStream(`\n\n${shortName}${paramStr}\n`);
          }
        }

        // Execute the skill
        const result = await this.skillExecutor.executeFromToolCall(toolCall);

        skillCall.status = result.success ? 'success' : 'error';
        skillCall.result = result;
        skillCall.executionTime = Date.now() - skillCall.timestamp;

        // Notify about completion
        if (onSkillCall) {
          onSkillCall(skillCall);
        }

        // Add tool result to messages
        const toolResultMessage: ChatMessage = {
          role: 'tool',
          content: result.success
            ? JSON.stringify(result.data, null, 2)
            : `Error: ${result.error}`,
          timestamp: Date.now(),
          tool_call_id: toolCall.id,
          name: toolCall.name
        };
        messages.push(toolResultMessage);

        if (onStream) {
          if (result.success) {
            onStream(`✓ success\n\n`);
          } else if (result.error && result.error.includes('cancelled')) {
            onStream(`✗ cancelled\n\n`);
          } else {
            onStream(`✗ failed\n\n`);
          }
        }
      }

      // Continue the loop to let the model process tool results
    }

    if (turnCount >= maxTurns) {
      console.warn('[RAG] Reached maximum turns limit');
    }

    return {
      response: fullResponse,
      messages: messages
    };
  }

  /**
   * Extract the most relevant parameter for display in skill execution messages
   */
  private getSkillDisplayParam(skillName: string, parameters: Record<string, any>): string {
    // File operations - show filename only (not full path)
    if (parameters.path) {
      const filename = parameters.path.split('/').pop() || parameters.path;
      return filename;
    }

    // Query operations - show query or pattern
    if (parameters.query) {
      return `"${parameters.query.substring(0, 30)}"`;
    }

    if (parameters.pattern) {
      return parameters.pattern;
    }

    if (parameters.tags && Array.isArray(parameters.tags)) {
      return `tags: [${parameters.tags.slice(0, 2).join(', ')}]`;
    }

    // Fallback - no params shown
    return '';
  }

  /**
   * Retrieve relevant chunks from selected files
   */
  private async retrieve(
    query: string,
    selectedFiles: TFile[]
  ): Promise<FileChunk[]> {
    const results = await this.indexManager.search(query, {
      topK: 5,
      minScore: 0.3,
      filterFiles: selectedFiles.map(f => f.path)
    });

    return results.map(r => r.chunk);
  }

  /**
   * Build system prompt with vault overview and optional RAG context
   */
  private buildSystemPrompt(chunks: FileChunk[] = []): string {
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

    // Build RAG context if chunks are provided
    let ragContext = '';
    if (chunks.length > 0) {
      const contextParts = chunks.map((chunk, idx) => {
        const fileName = chunk.filePath.split('/').pop() || chunk.filePath;
        return `[Document ${idx + 1}: ${fileName}]\n${chunk.content}`;
      });

      ragContext = `\n\nRELEVANT DOCUMENTS:\n${contextParts.join('\n---\n')}`;
    }

    // Try to load system prompt from file, fall back to embedded version
    try {
      // Use synchronous variable replacement for now
      // In the future, this could be enhanced to load asynchronously during initialization
      const template = FALLBACK_PROMPTS.get(PROMPT_PATHS.SYSTEM_PROMPT) || '';
      return this.promptLoader.replaceVariables(template, {
        [TEMPLATE_VARS.TOTAL_FILES]: totalFiles.toString(),
        [TEMPLATE_VARS.TOP_FOLDERS]: topFolders || 'None',
        [TEMPLATE_VARS.TOP_TAGS]: topTags || 'None',
        [TEMPLATE_VARS.SKILL_CONTENT]: skillContent
      }) + ragContext;
    } catch (error) {
      console.error('[RAGOrchestrator] Error building system prompt, using inline fallback:', error);

      // Inline fallback
      return `You are a helpful AI assistant for an Obsidian vault.

VAULT OVERVIEW:
- Total documents: ${totalFiles}
- Main folders: ${topFolders || 'None'}
- Common tags: ${topTags || 'None'}

${skillContent}

RULES:
- Base answers on provided context documents
- When context is insufficient, use available skills to find more information
- Always mention which document information comes from
- Be concise but thorough
- When creating or editing Obsidian files, use proper Markdown syntax

Use your skills proactively to help the user manage their knowledge base.${ragContext}`;
    }
  }

  /**
   * Build prompt - returns original query with RAG context in system prompt
   */
  private buildPrompt(
    query: string,
    chunks: FileChunk[]
  ): { prompt: string; systemPrompt: string } {
    // Build system prompt with RAG context
    const systemPrompt = this.buildSystemPrompt(chunks);

    // User message is just the original query
    const prompt = query;

    return { prompt, systemPrompt };
  }

  /**
   * Generate response with streaming (without skills)
   */
  private async generate(
    prompt: string,
    systemPrompt: string,
    onStream?: (chunk: string) => void
  ): Promise<{ response: string; messages: ChatMessage[] }> {
    const provider = await this.plugin.aiRouter.getProvider(TaskType.CHAT);

    // Build messages array
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: prompt,
        timestamp: Date.now()
      }
    ];

    let fullResponse = '';

    await provider.generateStream(
      prompt,
      (chunk: string) => {
        fullResponse += chunk;
        onStream?.(chunk);
      },
      {
        temperature: 0.7,
        maxTokens: 2048,
        systemPrompt
      }
    );

    // Add assistant response to messages
    messages.push({
      role: 'assistant',
      content: fullResponse,
      timestamp: Date.now()
    });

    return {
      response: fullResponse,
      messages: messages
    };
  }

  /**
   * Build source map for citations
   */
  private buildSourceMap(chunks: FileChunk[]): Map<string, string> {
    const sources = new Map<string, string>();

    chunks.forEach((chunk, idx) => {
      const fileName = chunk.filePath.split('/').pop() || chunk.filePath;
      const sourceInfo = `${fileName} (lines ${chunk.metadata.startLine}-${chunk.metadata.endLine})`;
      sources.set(`chunk-${idx}`, sourceInfo);
    });

    return sources;
  }

  /**
   * Build error message for no results
   */
  private buildNoResultsMessage(): string {
    try {
      // Try to load error message from file
      const template = FALLBACK_PROMPTS.get(PROMPT_PATHS.NO_RESULTS_ERROR) || '';
      return this.promptLoader.replaceVariables(template, {});
    } catch (error) {
      console.error('[RAGOrchestrator] Error loading no results message, using inline fallback:', error);

      // Inline fallback
      return `⚠️ **无法检索到文档内容**

可能的原因：
1. 📚 **文档尚未索引** - 请先执行 Ctrl/Cmd+P → "Index all documents for RAG"
2. 🔍 **文档内容与问题相关性较低** - 尝试更换文档或调整问题
3. ⚙️ **Embedding Provider 未配置** - 检查设置中的 AI Provider 配置

**下一步操作**：
1. 按 Ctrl/Cmd+P 打开命令面板
2. 搜索 "Index all documents"
3. 等待索引完成后重试`;
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
   * Handle meta-tool calls (spec and invoke)
   */
  private async handleMetaToolCall(
    toolCall: ToolCall,
    onStream?: (chunk: string) => void
  ): Promise<{ content: string; success: boolean }> {
    const params = typeof toolCall.arguments === 'string'
      ? JSON.parse(toolCall.arguments)
      : toolCall.arguments;

    if (toolCall.name === 'spec') {
      return this.handleSpec(params as SpecParams, onStream);
    } else if (toolCall.name === 'invoke') {
      return this.handleInvoke(params as InvokeParams, onStream);
    }

    return {
      content: `Error: Unknown meta-tool: ${toolCall.name}`,
      success: false
    };
  }

  /**
   * Handle spec meta-tool call
   */
  private async handleSpec(
    params: SpecParams,
    onStream?: (chunk: string) => void
  ): Promise<{ content: string; success: boolean }> {
    const { skill_name } = params;

    if (onStream) {
      onStream(`\n\n📖 Getting spec: ${skill_name}\n`);
    }

    // Check cache first
    const cached = this.skillCache.get(skill_name);
    if (cached) {
      if (onStream) {
        onStream(`✓ (from cache)\n\n`);
      }
      return { content: cached, success: true };
    }

    // Get skill from registry
    let skill = this.skillRegistry.get(skill_name);

    // If not found, try dynamic discovery
    if (!skill) {
      if (onStream) {
        onStream(`🔍 Discovering new skills...\n`);
      }

      const discovered = await this.skillRegistry.discoverSkills(skill_name);
      if (discovered.length > 0) {
        skill = this.skillRegistry.get(skill_name);
      }
    }

    // Get detailed information
    const format = this.plugin.settings.skillInvocationConfig?.detailFormat || 'markdown';
    const details = this.skillRegistry.getSkillDetails(skill_name, format);

    // Cache the result
    if (!details.startsWith('Error:')) {
      this.skillCache.set(skill_name, details);
    }

    if (onStream) {
      if (details.startsWith('Error:')) {
        onStream(`✗ not found\n\n`);
      } else {
        onStream(`✓ loaded\n\n`);
      }
    }

    return {
      content: details,
      success: !details.startsWith('Error:')
    };
  }

  /**
   * Handle invoke meta-tool call
   */
  private async handleInvoke(
    params: InvokeParams,
    onStream?: (chunk: string) => void
  ): Promise<{ content: string; success: boolean }> {
    const { skill_name, params: skillParams } = params;

    // Create a tool call object for the skill executor
    const toolCall: ToolCall = {
      id: `invoke_${Date.now()}`,
      name: skill_name,
      arguments: skillParams
    };

    // Get skill for display purposes
    const skill = this.skillRegistry.get(skill_name);
    const shortName = skill_name.split(':').pop() || skill_name;
    const displayParam = this.getSkillDisplayParam(skill_name, skillParams);
    const isAskUser = skill_name === 'obsidian:ask_user';
    const requiresConfirmation = skill?.metadata?.requiresConfirmation;

    // Notify about skill call
    if (onStream) {
      if (isAskUser) {
        onStream(`\n\n${shortName}()\n`);
      } else if (requiresConfirmation) {
        const paramStr = displayParam ? `(${displayParam})` : '()';
        onStream(`\n\n⚠️ ${shortName}${paramStr}\n`);
      } else {
        const paramStr = displayParam ? `(${displayParam})` : '()';
        onStream(`\n\n${shortName}${paramStr}\n`);
      }
    }

    // Execute the skill
    const result = await this.skillExecutor.executeFromToolCall(toolCall);

    // Notify about completion
    if (onStream) {
      if (result.success) {
        onStream(`✓ success\n\n`);
      } else if (result.error && result.error.includes('cancelled')) {
        onStream(`✗ cancelled\n\n`);
      } else {
        onStream(`✗ failed\n\n`);
      }
    }

    return {
      content: result.success
        ? JSON.stringify(result.data, null, 2)
        : `Error: ${result.error}`,
      success: result.success
    };
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
