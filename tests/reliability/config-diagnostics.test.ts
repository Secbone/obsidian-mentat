import { afterEach, describe, expect, it, vi } from 'vitest';
const { changes } = vi.hoisted(() => ({ changes: [] as Array<(value: string) => Promise<void>> }));
vi.mock('obsidian', async () => ({
  ...await vi.importActual<any>('../utils/obsidian.mock'),
  Setting: class {
    setName() { return this; } setDesc() { return this; } setHeading() { return this; }
    addDropdown(fn: any) { fn({ addOption() { return this; }, setValue() { return this; }, onChange(fn: any) { changes.push(fn); return this; } }); return this; }
  },
}));
import { SettingsTab } from '../../src/settings/settings-tab';
import MentatPlugin from '../../src/main';
import { DEFAULT_SETTINGS } from '../../src/settings/settings';
import { AIRouter } from '../../src/providers/ai-router';
import { EmbeddingBatch } from '../../src/indexing/embedding-batch';
import { OpenAIProvider } from '../../src/providers/openai-provider';
import { DiagnosticsExporter } from '../../src/diagnostics/diagnostics-exporter';
import { redactDiagnostics, VaultDiagnosticsLogger } from '../../src/diagnostics/vault-diagnostics-logger';
import { TaskType } from '../../src/types';
import { SkillLoader } from '../../src/skills/core/skill-loader';

afterEach(() => { changes.length = 0; vi.restoreAllMocks(); });
const provider = { id: 'chat', name: 'chat', type: 'openai', enabled: true, apiKey: 'test-provider-secret', model: 'deepseek-test', supportsEmbedding: false, supportsStreaming: true } as any;

describe('Configuration and diagnostics regressions', () => {
  it('writes routing at the same path the runtime reads and migrates legacy root keys', async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    const tab = Object.create(SettingsTab.prototype) as any;
    tab.plugin = { settings, saveSettings: vi.fn(async () => {}) };
    tab.displayTaskRoutingSection({ createEl() {} });
    await changes[3]('chosen');
    expect(settings.taskRouting.chat).toBe('chosen');
    expect((settings as any).chat).toBeUndefined();
    const plugin = { loadData: async () => ({ chat: 'legacy', taskRouting: { embedding: 'embed' } }) } as any;
    await MentatPlugin.prototype.loadSettings.call(plugin);
    expect(plugin.settings.taskRouting).toMatchObject({ chat: 'legacy', embedding: 'embed', review: '' });
    expect(plugin.settings.chat).toBeUndefined();
  });

  it('does not route embeddings to chat-only providers, including explicit or default routing', async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.aiProviders = [provider]; settings.defaultProvider = 'chat'; settings.taskRouting.embedding = 'chat';
    const router = new AIRouter(settings);
    expect(await router.getProvider(TaskType.EMBEDDING)).toBeNull();
    expect((await router.getProvider(TaskType.CHAT))?.id).toBe('chat');
    settings.aiProviders.push({ ...provider, id: 'embed', embeddingModel: 'embedding-test' });
    router.refresh(settings);
    expect((await router.getProvider(TaskType.EMBEDDING))?.id).toBe('embed');
  });

  it('does not retry permanent embedding errors or create an empty successful result without a model', async () => {
    const operation = vi.fn(async () => { throw new Error('No embedding model configured'); });
    const batch = new EmbeddingBatch(async () => null);
    await expect((batch as any).retryWithBackoff(operation)).rejects.toThrow('No embedding model configured');
    expect(operation).toHaveBeenCalledOnce();
    await expect(batch.generateBatch(['text'])).rejects.toThrow('未配置');
  });

  it('preserves builtin execution metadata and passes cancellation through the skill loader', async () => {
    const loader = new SkillLoader({ vault: { configDir: '.obsidian' } } as any) as any;
    const context = { vault: {}, plugin: { settings: {} } } as any;
    const edit = await loader.loadExecutableSkill({ name: 'edit_note', description: '', content: '' }, 'edit-note', context);
    expect(edit.metadata.executionCategory).toBe('write');
    const command = await loader.loadExecutableSkill({ name: 'run_command', description: '', content: '' }, 'run-command', context);
    expect(command.metadata.requiresConfirmation).toBe(true);
    const fetch = await loader.loadExecutableSkill({ name: 'web_fetch', description: '', content: '' }, 'web-fetch', context);
    const controller = new AbortController(); controller.abort();
    await expect(fetch.execute(fetch.schema.parse({ url: 'https://example.invalid' }), { abortSignal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('preserves provider error identity, code and cause and rejects truncated tool streams', async () => {
    const api = new OpenAIProvider({ id: 'p', apiKey: 'test', baseURL: 'https://example.invalid', model: 'test' }) as any;
    const error = Object.assign(new TypeError('network error'), { code: 'ERR_NETWORK_CHANGED', cause: new Error('socket') });
    api.client = { chat: { completions: { create: async () => { throw error; } } } };
    await expect(api.generateStreamWithSkills([], () => {})).rejects.toBe(error);
    api.client.chat.completions.create = async function* () {
      yield { choices: [{ delta: { tool_calls: [{ index: 0, id: 't', function: { name: 'write', arguments: '{}' } }] }, finish_reason: 'length' }] };
    };
    const invoked = vi.fn();
    await expect(api.generateStreamWithSkills([], () => {}, invoked)).rejects.toThrow('截断');
    expect(invoked).not.toHaveBeenCalled();
  });

  it('serializes logs and redacts nested credentials while preserving usage and error identity fields', async () => {
    let text = '', concurrent = 0, peak = 0;
    const adapter = { exists: async () => true, mkdir: vi.fn(), append: async (_: string, line: string) => { peak = Math.max(peak, ++concurrent); await Promise.resolve(); text += line; concurrent--; } };
    const logger = new VaultDiagnosticsLogger({ adapter }, () => ['known-secret']);
    const incident = { agentId: 'a', agentName: 'a', sessionId: 's', runId: 'r', toolName: 'x', originalArgs: '{"apiKey":"abc","promptTokens":42}', errorMessage: 'known-secret', strategy: 'test', success: false };
    await Promise.all([logger.logIncident(incident), logger.logIncident(incident)]);
    expect(peak).toBe(1);
    expect(text).not.toContain('known-secret'); expect(text).not.toContain('"abc"');
    const first = JSON.parse(text.split('\n')[0]);
    expect(first).toMatchObject({ sessionId: 's', runId: 'r' });
    expect(JSON.parse(first.originalArgs)).toEqual({ apiKey: '[REDACTED]', promptTokens: 42 });
    expect(redactDiagnostics({ authorization: 'Bearer secret', password: 'secret' })).toEqual({ authorization: '[REDACTED]', password: '[REDACTED]' });
  });

  function reportPlugin(lines: string, broken = false) {
    let report = '';
    const plugin = { settings: { ...structuredClone(DEFAULT_SETTINGS), aiProviders: [{ ...provider, contextWindow: 10000 }] },
      app: { vault: { adapter: { exists: async () => true, read: async () => { if (broken) throw new Error('unreadable'); return lines; } },
        create: vi.fn(async (path: string, content: string) => { report = content; return { path }; }) },
        workspace: { getLeaf: () => ({ openFile: vi.fn() }) } } } as any;
    return { plugin, content: () => report };
  }

  it('exports an empty session and includes failures after the last message', async () => {
    const { plugin, content } = reportPlugin(JSON.stringify({ timestamp: Date.now(), sessionId: 's', toolName: 'model', errorMessage: 'network failure' }));
    const manager = { getHistory: async () => [], getSessionInfo: () => ({ sessionId: 's', startTime: Date.now() - 10000, lastUpdated: Date.now() - 5000 }) } as any;
    expect(await DiagnosticsExporter.exportSession(plugin, manager)).toBeTruthy();
    expect(content()).toContain('network failure'); expect(content()).toContain('缺少已保存');
    expect(content()).not.toContain('所有的工具解析及执行调用全部运作正常');
  });

  it('reports unreadable logs and uses current prompt usage rather than cumulative consumption for saturation', async () => {
    const { plugin, content } = reportPlugin('', true);
    const messages = [1, 2].flatMap(i => [{ role: 'user', content: `q${i} test-provider-secret`, timestamp: Date.now() - 1000 },
      { role: 'assistant', content: 'answer', timestamp: Date.now() - 500, metadata: { usage: { promptTokens: 800, totalTokens: 1000, cacheReadTokens: 0 } } }]);
    const manager = { getHistory: async () => messages, getSessionInfo: () => ({ sessionId: 's' }) } as any;
    await DiagnosticsExporter.exportSession(plugin, manager);
    expect(content()).toContain('日志读取不完整'); expect(content()).toContain('unreadable');
    expect(content()).toContain('当前: 8%'); expect(content()).toContain('10,000 Tokens');
    expect(content()).not.toContain('test-provider-secret');
  });
});
