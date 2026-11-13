import type { AIProvider } from '../types';
import type { ChatModel, Embedder, GenerateOptions, GenerateResponse, ModelRequest, ToolDefinition } from '../contracts/model';
import { throwIfAborted } from '../utils/execution';

export function normalizeTools(tools: unknown[] = []): ToolDefinition[] {
  return tools.map(value => {
    if (!value || typeof value !== 'object') throw new Error('工具定义无效');
    const tool = value as Record<string, unknown>;
    const source = (tool.function || tool) as Record<string, unknown>;
    const inputSchema = source.inputSchema || source.parameters || source.input_schema;
    if (typeof source.name !== 'string' || !inputSchema || typeof inputSchema !== 'object' || Array.isArray(inputSchema)) throw new Error('工具定义缺少名称或输入 schema');
    return { name: source.name, description: typeof source.description === 'string' ? source.description : '', inputSchema: inputSchema as Record<string, unknown> };
  });
}

/** Compatibility stays at the protocol edge; the gateway consumes one portable chat contract. */
export function asChatModel(provider: AIProvider | ChatModel): ChatModel {
  if ('kind' in provider && provider.kind === 'chat-model') return provider;
  const legacy = provider as AIProvider;
  return {
    kind: 'chat-model', id: legacy.id, name: legacy.name,
    capabilities: { tools: !!legacy.supportsSkills?.(), protocolState: true },
    contextWindow: legacy.getContextWindow(), maxOutputTokens: legacy.getMaxOutputTokens?.() ?? 16384,
    compactionThreshold: legacy.getCompactionThreshold(), requestMetadata: () => legacy.getRequestMetadata?.() || {},
    async stream(request, emit, signal) {
      throwIfAborted(signal);
      const options: GenerateOptions = { ...request, abortSignal: signal,
        toolChoice: request.toolChoice,
        onProgress: message => emit({ type: 'progress', message }),
        skills: request.tools?.map(tool => legacy.type === 'anthropic'
          ? { name: tool.name, description: tool.description, input_schema: tool.inputSchema }
          : { name: tool.name, description: tool.description, parameters: tool.inputSchema }) };
      const text = (value: string) => emit({ type: 'text', text: value });
      if (legacy.generateStreamWithSkills && legacy.supportsSkills?.()) {
        return legacy.generateStreamWithSkills(request.messages, text, undefined, options);
      }
      if (request.tools?.length) throw new Error('当前模型不支持工具调用');
      let content = '', result: GenerateResponse | undefined;
      await legacy.generateStream(request.messages.map(message => `[${message.role}]: ${message.content}`).join('\n\n'), value => { content += value; text(value); },
        { ...options, onResponse: response => { result = response; } });
      throwIfAborted(signal);
      return result || { content, finishReason: 'stop' };
    },
  };
}

export function asEmbedder(provider: AIProvider | Embedder): Embedder {
  if (!('generateEmbedding' in provider)) return provider;
  return {
    id: provider.id,
    async embed(texts, signal) {
      throwIfAborted(signal);
      const result = provider.generateEmbeddings ? await provider.generateEmbeddings(texts) : await (async () => {
        const rows = [];
        for (const text of texts) { throwIfAborted(signal); rows.push(await provider.generateEmbedding(text)); }
        return { embeddings: rows.map(row => row.embedding), tokens: rows.reduce((sum, row) => sum + (row.tokens || 0), 0) };
      })();
      throwIfAborted(signal);
      if (result.embeddings.length !== texts.length || result.embeddings.some(row => !row.length || row.some(value => !Number.isFinite(value)))) throw new Error('向量响应维度或数量无效');
      return result;
    },
  };
}

/** Lets existing composition select a new chat-only implementation without implementing embeddings. */
export function providerFromChatModel(model: ChatModel): AIProvider {
  const generate = (request: ModelRequest, onChunk: (text: string) => void, options?: GenerateOptions) => model.stream(request, event => {
    if (event.type === 'text') onChunk(event.text); else options?.onProgress?.(event.message);
  }, options?.abortSignal);
  return {
    id: model.id, name: model.name, type: 'openai', supportsSkills: () => model.capabilities.tools,
    getContextWindow: () => model.contextWindow, getMaxOutputTokens: () => model.maxOutputTokens,
    getCompactionThreshold: () => model.compactionThreshold, getRequestMetadata: () => model.requestMetadata(), isAvailable: async () => true,
    generate: async (prompt, options) => (await generate({ ...options, messages: [{ role: 'user', content: prompt, timestamp: Date.now() }] }, () => {}, options)).content,
    generateStream: async (prompt, onChunk, options) => { const result = await generate({ ...options, messages: [{ role: 'user', content: prompt, timestamp: Date.now() }] }, onChunk, options); options?.onResponse?.(result); },
    generateStreamWithSkills: (messages, onChunk, _onTool, options) => generate({ ...options, messages, tools: normalizeTools(options?.skills) }, onChunk, options),
    generateEmbedding: async () => { throw new Error('No embedding model configured'); },
    embed: async () => { throw new Error('No embedding model configured'); },
  };
}
