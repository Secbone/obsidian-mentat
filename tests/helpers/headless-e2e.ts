import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Context } from '../../src/core/cordis';
import { HeadlessPlatform } from '../../src/platform/headless/headless-platform';
import { LLMRegistry } from '../../src/llm/llm.service';
import { ToolsRegistry } from '../../src/tools/tools.service';
import { VaultToolsPlugin } from '../../src/tools/vault/vault-tools';
import { WebToolsPlugin } from '../../src/tools/web/web-tools';
import { ContextWindowService } from '../../src/session/context.service';
import { CompactionService, SummarizeCompactionStrategy } from '../../src/session/compaction.service';
import { AgentLoopService } from '../../src/agents/loop.service';
import { AgentModeRegistry, EMBEDDED_MODE } from '../../src/agents/agent-mode';
import { EmbeddedBackend } from '../../src/agents/backends/embedded.backend';
import { createSession } from '../../src/chat/session';
import type { LLMProvider } from '../../src/llm/contract';
import type { AgentEvent } from '../../src/agents/agent-types';
import type { Logger } from '../../src/logger/logger.service';

export interface HeadlessE2EHarness {
  ctx: Context;
  root: string;
  platform: HeadlessPlatform;
  tools: ToolsRegistry;
  llm: LLMRegistry;
  logs: string[];
  run(prompt: string): Promise<E2EResult>;
}

export interface E2EResult {
  events: string[];
  toolCalls: { name: string; args: unknown }[];
  toolEnds: { name: string; result: unknown; isError: boolean }[];
  assistantText: string;
  finalMessages: unknown;
}

/**
 * Build a headless context with REAL vault/web tools over a real (fs) vault,
 * a real agent-loop (with platform services injected into ToolContext), and a
 * caller-supplied LLM provider. `run()` drives one user prompt and records a
 * structured log.
 */
export async function buildHeadlessE2E(provider: LLMProvider, files: Record<string, string>): Promise<HeadlessE2EHarness> {
  const root = mkdtempSync(join(tmpdir(), 'mentat-e2e-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(join(root, rel.split('/').slice(0, -1).join('/')), { recursive: true });
    writeFileSync(full, content);
  }
  const platform = new HeadlessPlatform(root, root);

  const logs: string[] = [];
  const line = (...a: unknown[]) => { const s = a.join(' '); logs.push(s); console.log('[E2E]', s); };

  const ctx = new Context();
  ctx.provide('documents', platform.documents);
  ctx.provide('search', platform.search);
  ctx.provide('storage', platform.storage);

  const llm = new LLMRegistry();
  llm.register(provider);
  ctx.provide('llm', llm);

  const tools = new ToolsRegistry();
  ctx.provide('tools', tools);
  VaultToolsPlugin.apply(ctx as never);
  WebToolsPlugin.apply(ctx as never);

  const window = new ContextWindowService();
  const compaction = new CompactionService(window);
  compaction.register(new SummarizeCompactionStrategy());
  const logger: Logger = {
    info: (m, c) => line('L ', m, c ?? ''),
    error: (m, c) => line('LE', m, c ?? ''),
  } as unknown as Logger;
  const loop = new AgentLoopService(llm, tools, window, compaction, logger, {
    documents: platform.documents,
    search: platform.search,
  });
  ctx.provide('context-window', window);
  ctx.provide('compaction', compaction);
  ctx.provide('agent-loop', loop);

  const modes = new AgentModeRegistry();
  modes.register({ id: EMBEDDED_MODE, displayName: 'E', description: '', createBackend: ({ ctx: c, sessionId }) => new EmbeddedBackend(c, { sessionId }) });
  ctx.provide('modes', modes);

  const session = createSession(ctx, 's-e2e', EMBEDDED_MODE, modes);

  async function run(prompt: string): Promise<E2EResult> {
    const res: E2EResult = { events: [], toolCalls: [], toolEnds: [], assistantText: '', finalMessages: undefined };
    for await (const ev of session.backend.streamChat({
      sessionId: 's-e2e',
      messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
    })) {
      res.events.push(ev.type);
      if (ev.type === 'tool:start') {
        res.toolCalls.push({ name: ev.toolName, args: ev.args });
        line('TOOL CALL →', ev.toolName, 'args=', JSON.stringify(ev.args));
      } else if (ev.type === 'tool:end') {
        res.toolEnds.push({ name: ev.toolName, result: ev.result, isError: ev.isError });
        line('TOOL RESULT ←', ev.toolName, 'isError=', ev.isError, 'result=', JSON.stringify(ev.result).slice(0, 20000));
      } else if (ev.type === 'message:update') {
        res.assistantText += ev.delta;
      } else if (ev.type === 'agent:end') {
        res.finalMessages = (ev as AgentEvent & { messages?: unknown }).messages;
      }
    }
    line('EVENTS =', JSON.stringify(res.events));
    line('ASSISTANT (full) =', res.assistantText);
    return res;
  }

  return { ctx, root, platform, tools, llm, logs, run };
}
