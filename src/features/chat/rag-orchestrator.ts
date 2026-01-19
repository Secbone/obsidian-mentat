// RAG Orchestrator - Orchestrates the complete RAG pipeline

import { TFile } from 'obsidian';
import PersonalAgentPlugin from '../../main';
import { IndexManager } from '../../indexing/index-manager';
import { FileChunk } from '../../indexing/chunk-processor';
import { SourceTracker } from './source-tracker';
import { TaskType, ChatMessage } from '../../types';

export interface RAGContext {
  selectedFiles: TFile[];
  relevantChunks: FileChunk[];
  sources: Map<string, string>; // chunkId -> sourceInfo
}

export class RAGOrchestrator {
  private indexManager: IndexManager;
  private sourceTracker: SourceTracker;

  constructor(private plugin: PersonalAgentPlugin) {
    this.indexManager = plugin.indexManager;
    this.sourceTracker = new SourceTracker();
  }

  /**
   * Execute RAG query with streaming support
   */
  async query(
    userQuery: string,
    selectedFiles: TFile[],
    contextMessages: ChatMessage[] = [],
    onStream?: (chunk: string) => void
  ): Promise<{ response: string; context: RAGContext }> {
    // 1. Retrieve relevant chunks
    const relevantChunks = await this.retrieve(userQuery, selectedFiles);

    // Handle empty retrieval results
    if (relevantChunks.length === 0) {
      console.warn('[RAG] No relevant chunks found');
      console.warn('[RAG] Selected files:', selectedFiles.map(f => f.path));
      console.warn('[RAG] Index stats:', this.indexManager.getStats());

      const errorMessage = `⚠️ **无法检索到文档内容**

可能的原因：
1. 📚 **文档尚未索引** - 请先执行 Ctrl/Cmd+P → "Index all documents for RAG"
2. 🔍 **文档内容与问题相关性较低** - 尝试更换文档或调整问题
3. ⚙️ **Embedding Provider 未配置** - 检查设置中的 AI Provider 配置

**下一步操作**：
1. 按 Ctrl/Cmd+P 打开命令面板
2. 搜索 "Index all documents"
3. 等待索引完成后重试`;

      // Stream error message character by character for better UX
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
          sources: new Map()
        }
      };
    }

    // 2. Build enhanced prompt with conversation history
    const { prompt, systemPrompt } = this.buildPrompt(userQuery, relevantChunks, contextMessages);

    // 3. Generate response
    const response = await this.generate(prompt, systemPrompt, onStream);

    // 4. Extract and format sources
    const citationSources = this.sourceTracker.extractSources(relevantChunks);
    const sourcesMarkdown = this.sourceTracker.formatSourcesAsMarkdown(citationSources);

    // 5. Append sources to response
    const responseWithSources = response + sourcesMarkdown;

    // 6. Build source map
    const sources = this.buildSourceMap(relevantChunks);

    return {
      response: responseWithSources,
      context: {
        selectedFiles,
        relevantChunks,
        sources
      }
    };
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
      minScore: 0.3,  // Lowered from 0.5 to improve recall
      filterFiles: selectedFiles.map(f => f.path)
    });

    return results.map(r => r.chunk);
  }

  /**
   * Build enhanced prompt with context
   */
  private buildPrompt(
    query: string,
    chunks: FileChunk[],
    contextMessages: ChatMessage[] = []
  ): { prompt: string; systemPrompt: string } {
    const systemPrompt = `You are a helpful AI assistant that answers questions based on the provided document context.

IMPORTANT RULES:
1. Base your answers ONLY on the provided context documents
2. If the context doesn't contain enough information, say so clearly
3. When referencing information, mention which document it comes from
4. Be concise but thorough
5. If asked to summarize, focus on key points`;

    // Build context from chunks
    const contextParts = chunks.map((chunk, idx) => {
      const fileName = chunk.filePath.split('/').pop() || chunk.filePath;
      return `[Document ${idx + 1}: ${fileName}]
${chunk.content}
`;
    });

    // Build conversation history
    let conversationHistory = '';
    if (contextMessages.length > 0) {
      conversationHistory = '\nConversation History:\n';
      for (const msg of contextMessages) {
        conversationHistory += `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}\n\n`;
      }
    }

    const prompt = `Context from selected documents:

${contextParts.join('\n---\n')}
${conversationHistory}
Current Question: ${query}

Please answer the question based on the context provided above.`;

    return { prompt, systemPrompt };
  }

  /**
   * Generate response with streaming
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
}
