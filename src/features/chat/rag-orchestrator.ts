// RAG Orchestrator - Orchestrates the complete RAG pipeline with Skills support

import { TFile } from 'obsidian';
import PersonalAgentPlugin from '../../main';
import { IndexManager } from '../../indexing/index-manager';
import { FileChunk } from '../../indexing/chunk-processor';
import { SourceTracker } from './source-tracker';
import { TaskType, ChatMessage, ToolCall, GenerateResponse } from '../../types';
import { SkillRegistry } from '../../skills/skill-registry';
import { SkillExecutor, ExecutionOptions } from '../../skills/skill-executor';
import { SkillContext, SkillCall } from '../../skills/skill-types';
import { MCPManager } from '../../skills/mcp';
import { SkillLoader, isExecutableSkill, isDocumentationSkill } from '../../skills/skill-loader';

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

  constructor(private plugin: PersonalAgentPlugin) {
    this.indexManager = plugin.indexManager;
    this.sourceTracker = new SourceTracker();

    // Initialize Skill system
    this.skillRegistry = new SkillRegistry();
    this.mcpManager = new MCPManager(this.skillRegistry);
    this.skillLoader = new SkillLoader(plugin.app, 'personal-agent');

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
  ): Promise<{ response: string; context: RAGContext }> {
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
          }
        };
      }
    }

    // 2. Build enhanced prompt with conversation history
    const { prompt, systemPrompt } = this.buildPrompt(userQuery, relevantChunks, contextMessages);

    // 3. Generate response with Skills support
    let response: string;
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
      response = result;
    } else {
      response = await this.generate(prompt, systemPrompt, onStream);
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
      }
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
  ): Promise<string> {
    const provider = await this.plugin.aiRouter.getProvider(TaskType.CHAT);

    // Check if provider supports skills
    if (!provider.supportsSkills || !provider.supportsSkills()) {
      console.warn('[RAG] Provider does not support skills, falling back to standard generation');
      return this.generate(initialPrompt, systemPrompt, onStream);
    }

    // Build message history
    const messages: ChatMessage[] = [
      ...contextMessages,
      {
        role: 'user',
        content: initialPrompt,
        timestamp: Date.now()
      }
    ];

    // Get skills in provider format
    const skills = provider.type === 'openai'
      ? this.skillRegistry.toOpenAIFunctions()
      : this.skillRegistry.toAnthropicTools();

    let fullResponse = '';
    let turnCount = 0;

    // Agent loop
    while (turnCount < maxTurns) {
      turnCount++;

      // Generate with skills
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
          systemPrompt,
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

    return fullResponse;
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
   * Build system prompt with vault overview
   */
  private buildSystemPrompt(): string {
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

    // Get documentation skills content
    const docContent = this.skillRegistry.getDocumentationContent();

    return `You are a helpful AI assistant for an Obsidian vault.

VAULT OVERVIEW:
- Total documents: ${totalFiles}
- Main folders: ${topFolders || 'None'}
- Common tags: ${topTags || 'None'}

IMPORTANT: You have access to tools to manage documents. Follow this workflow:

1. DISCOVER FILES FIRST
   - Use query_notes to find files before reading them
   - Don't guess file paths - always query first

2. ASK FOR GUIDANCE WHEN UNCERTAIN
   - If you encounter ambiguity or multiple valid options, use ask_user
   - Examples: Multiple files match, unclear user intent, need confirmation
   - Provide clear context and specific options when asking
   - Don't make assumptions - ask the user instead

3. QUERY EXAMPLES
   - Browse all files: query_notes({limit: 50})
   - Find by tag: query_notes({tags: ['project']})
   - Search content: query_notes({query: 'machine learning'})
   - Filter by folder: query_notes({folders: ['Projects']})
   - Match pattern: query_notes({pattern: 'Daily/2025-*.md'})
   - Match any subfolder: query_notes({pattern: '**/meetings/*.md'})

4. READ FILES
   - After query_notes returns results, use read_note with the exact path
   - Example: read_note({path: 'Projects/My Project.md'})

5. GET DETAILED VAULT INFO
   - Use list_vault_structure to see complete folder/tag structure

GLOB PATTERNS:
- * matches any characters except /
- ** matches any characters including /
- ? matches single character
- Examples: "Daily/2025-*.md", "**/2025-01-*.md", "Projects/**/README.md"
${docContent}
RULES:
- Base answers on provided context documents
- When context is insufficient, use tools to find more information
- Always mention which document information comes from
- Be concise but thorough
- When creating or editing Obsidian files, follow the documentation above for proper syntax

Use your tools proactively to help the user manage their knowledge base.`;
  }

  /**
   * Build enhanced prompt with context
   */
  private buildPrompt(
    query: string,
    chunks: FileChunk[],
    contextMessages: ChatMessage[] = []
  ): { prompt: string; systemPrompt: string } {
    const systemPrompt = this.buildSystemPrompt();

    // Build conversation history
    let conversationHistory = '';
    if (contextMessages.length > 0) {
      conversationHistory = '\nConversation History:\n';
      for (const msg of contextMessages) {
        conversationHistory += `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}\n\n`;
      }
    }

    // Build prompt based on whether we have document context
    let prompt: string;
    if (chunks.length > 0) {
      // RAG mode with document context
      const contextParts = chunks.map((chunk, idx) => {
        const fileName = chunk.filePath.split('/').pop() || chunk.filePath;
        return `[Document ${idx + 1}: ${fileName}]
${chunk.content}
`;
      });

      prompt = `Context from selected documents:

${contextParts.join('\n---\n')}
${conversationHistory}
Current Question: ${query}

Please answer the question based on the context provided above.`;
    } else {
      // Normal chat mode without document context
      prompt = `${conversationHistory}
Current Question: ${query}

Please answer the question.`;
    }

    return { prompt, systemPrompt };
  }

  /**
   * Generate response with streaming (without skills)
   */
  private async generate(
    prompt: string,
    systemPrompt: string,
    onStream?: (chunk: string) => void
  ): Promise<string> {
    const provider = await this.plugin.aiRouter.getProvider(TaskType.CHAT);

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

    return fullResponse;
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
}
