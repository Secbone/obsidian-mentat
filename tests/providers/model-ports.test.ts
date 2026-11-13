import { describe, expect, it, vi } from 'vitest';
vi.mock('obsidian');
import { asChatModel, asEmbedder, providerFromChatModel } from '../../src/providers/model-adapters';
import type { ChatModel } from '../../src/contracts/model';
import { ModelGateway, ModelResponseError } from '../../src/runtime/model-gateway';
import { OpenAIProvider } from '../../src/providers/openai-provider';

const request = [{ role: 'user' as const, content: 'hi', timestamp: 1 }];
function portable(): ChatModel {
  return { kind: 'chat-model', id: 'portable', name: 'portable', capabilities: { tools: true, protocolState: false },
    contextWindow: 10000, maxOutputTokens: 1000, compactionThreshold: .8, requestMetadata: () => ({}),
    stream: vi.fn(async (_input, emit) => { emit({ type: 'text', text: 'done' }); return { content: 'done', finishReason: 'stop' }; }) };
}
for (const [name, create] of [
  ['portable model', () => portable()],
  ['legacy adapter', () => asChatModel(providerFromChatModel(portable()))],
] as const) describe(`ChatModel consumer contract: ${name}`, () => {
  it('streams through the same gateway with a complete terminal result', async () => {
    const chunks: string[] = [];
    const result = await new ModelGateway(create()).generate(request, text => chunks.push(text), {});
    expect(result).toMatchObject({ content: 'done', finishReason: 'stop' }); expect(chunks.join('')).toBe('done');
  });
  it('propagates cancellation even when an underlying driver ignores it', async () => {
    const model = create(); model.stream = () => new Promise(() => {});
    const controller = new AbortController();
    const result = new ModelGateway(model).generate(request, () => {}, { abortSignal: controller.signal });
    controller.abort(); await expect(result).rejects.toMatchObject({ name: 'AbortError' });
  });
});
describe('Model protocol boundaries', () => {
  it('rejects a missing terminal marker and incomplete tool response', async () => {
    const model = portable(); model.stream = async () => ({ content: 'partial', toolCalls: [{ id: 'x', name: 'write', arguments: '{' }] });
    await expect(new ModelGateway(model).generate(request, () => {}, {})).rejects.toBeInstanceOf(ModelResponseError);
  });
  it('budgets tools before generation and converts neutral tools only at the adapter edge', async () => {
    const stream = vi.fn(async () => ({ content: 'ok', finishReason: 'stop' }));
    const provider = { id: 'a', type: 'anthropic', name: 'a', supportsSkills: () => true, getContextWindow: () => 500,
      getMaxOutputTokens: () => 300, getCompactionThreshold: () => .8, generateStreamWithSkills: stream } as any;
    await new ModelGateway(provider).generate(request, () => {}, { skills: [{ name: 'read', description: 'd', parameters: { type: 'object', properties: {} } }] });
    expect(stream.mock.calls[0][3].skills[0]).toHaveProperty('input_schema');
    expect(stream.mock.calls[0][3].maxTokens).toBeLessThan(300);
  });
  it('keeps embeddings independently replaceable and validates a legacy driver response', async () => {
    const embedder = { id: 'embed-only', embed: vi.fn(async () => ({ embeddings: [[1, 0]] })) };
    expect(await asEmbedder(embedder).embed(['text'])).toEqual({ embeddings: [[1, 0]] });
    await expect(asEmbedder({ id: 'bad', generateEmbedding: async () => ({ embedding: [] }) } as any).embed(['text'])).rejects.toThrow('无效');
  });
  it('reads legacy DeepSeek state and rejects incompatible new codecs/configurations', async () => {
    const provider = new OpenAIProvider({ id: 'p', apiKey: 'test', baseURL: 'https://api.deepseek.com', model: 'fake', reasoningEffort: 'high' }) as any;
    expect(provider.readReasoningState({ providerId: 'p', reasoningContent: 'legacy' })).toBe('legacy');
    const state = provider.reasoningState('private text');
    expect(state).toMatchObject({ adapterId: 'deepseek:p', codecVersion: 1, payload: { reasoningContent: 'private text' } });
    expect(() => provider.readReasoningState({ ...state, codecVersion: 2 })).toThrow('不兼容');
    provider.config.model = 'other'; expect(() => provider.readReasoningState(state)).toThrow('不兼容');
  });
});
