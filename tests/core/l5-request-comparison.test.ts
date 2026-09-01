import { describe, it, expect } from 'vitest';
import { Context } from '../../src/core/cordis';
import { HeadlessPlatform } from '../../src/platform/headless/headless-platform';
import { LLMRegistry } from '../../src/llm/llm.service';
import { ToolsRegistry } from '../../src/tools/tools.service';
import { VaultToolsPlugin } from '../../src/tools/vault/vault-tools';
import { WebToolsPlugin } from '../../src/tools/web/web-tools';
import { ContextWindowService } from '../../src/session/context.service';
import { CompactionService, SummarizeCompactionStrategy } from '../../src/session/compaction.service';
import { AgentLoopService } from '../../src/agents/loop.service';
import { ContextAssemblerService } from '../../src/context/context-assembler';
import { adaptLegacyProvider } from '../../src/llm/legacy-adapter';
import { OpenAIProvider } from '../../src/providers/openai-provider';
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ChatMessage } from '../../src/types';
import type { LLMProvider } from '../../src/llm/contract';

/**
 * L5.7 REQUEST COMPARISON: builds the EXACT requestParams both architectures
 * would send for the same user question, same vault, same provider config.
 * No network needed — intercepts the provider to capture the payload.
 */
describe('L5.7 old vs new architecture — request payload comparison', () => {
  it('prints both payloads side by side for manual review', async () => {
    const root = mkdtempSync(join(tmpdir(), 'req-compare-'));
    mkdirSync(join(root, 'notes'));
    writeFileSync(join(root, 'notes/ideas.md'), '# Ideas\nBuild a mentorship plugin.');
    writeFileSync(join(root, 'notes/todo.md'), '# Todo\nShip the feature.');
    writeFileSync(join(root, 'readme.md'), '# Mentat\nAn Obsidian AI plugin.');
    const platform = new HeadlessPlatform(root, root);

    const USER_QUESTION = '我的笔记都涉及哪些领域？';

    // ── NEW ARCHITECTURE ──────────────────────────────────────────────────────
    // Build the exact messages + system prompt that the new architecture sends.
    const newCtx = new Context();
    newCtx.provide('documents', platform.documents);
    newCtx.provide('search', platform.search);
    newCtx.provide('storage', platform.storage);

    const newTools = new ToolsRegistry();
    newCtx.provide('tools', newTools);
    VaultToolsPlugin.apply(newCtx as never);
    WebToolsPlugin.apply(newCtx as never);

    const newLlm = new LLMRegistry();
    const captured: { new: Record<string, unknown> | null; old: Record<string, unknown> | null } = { new: null, old: null };

    const capturingProvider: LLMProvider = {
      id: 'capture', name: 'Capture', capabilities: { chat: true, streaming: true, embeddings: false, tools: true },
      getContextWindow: () => 128000, getCompactionThreshold: () => 0.8,
      generate: async () => '', generateStream: async () => {},
      generateWithTools: async (_m, onChunk, options) => {
        captured.new = options as Record<string, unknown>;
        onChunk?.({ delta: 'ok' });
        return { content: 'ok', toolCalls: undefined };
      },
      isAvailable: async () => true,
    };
    newLlm.register(capturingProvider);
    newCtx.provide('llm', newLlm);

    const cw = new ContextWindowService();
    const comp = new CompactionService(cw); comp.register(new SummarizeCompactionStrategy());
    const assembler = new ContextAssemblerService(platform.documents);
    const loop = new AgentLoopService(newLlm, newTools, cw, comp, undefined, {
      documents: platform.documents, search: platform.search,
    }, assembler);
    newCtx.provide('context-window', cw);
    newCtx.provide('compaction', comp);
    newCtx.provide('agent-loop', loop);

    const userMsg: ChatMessage = { role: 'user', content: USER_QUESTION, timestamp: Date.now() };
    for await (const _e of loop.run([userMsg], { maxTurns: 1 }, new AbortController().signal)) {}

    // ── OLD ARCHITECTURE (simulated) ──────────────────────────────────────────
    // Reconstruct what the legacy orchestrator + BaseAgent would send.
    // 1) System prompt (simplified version of what PromptLoader builds)
    const skillList = newTools.list().map((t) => `- \`${t.name}\` - ${t.description}`).join('\n');
    const oldSystemPrompt = `You are Mentat, an intelligent assistant for Obsidian vaults.

Available tools:
${skillList}

RULES:
- Use available tools to help the user
- When you have finished all tool calls, wrap your final answer in <final_answer>...</final_answer> tags
- Be concise but thorough

OBSIDIAN SYNTAX:
- Use [[Note Name]] for links
- Use YAML frontmatter for metadata`;

    // 2) Vault session context (injected into first user message)
    const allFiles = platform.documents.listDocuments();
    const fileTree = allFiles.map((f) => `- ${f.path}`).join('\n');
    const vaultSessionContext = `[Vault Session Context]
当前时间: ${new Date().toLocaleString('zh-CN', { hour12: false })}
文件总数: ${allFiles.length}

Semantic Directory Hierarchy:
${fileTree}

Vault Knowledge Map:
- notes/: Contains personal notes on various topics
- readme.md: Project description`;

    // 3) Old arch tool definitions (via skillToOpenAIFunction: namespace:mangled)
    const oldTools = newTools.list().map((t) => ({
      type: 'function',
      function: {
        name: t.name, // old arch uses __ mangling; we show as-is for comparison
        description: t.description,
        parameters: t.schema ? (() => {
          const { zodToJsonSchema } = require('zod-to-json-schema');
          const js = zodToJsonSchema(t.schema, { $refStrategy: 'none' });
          return { type: 'object', properties: js.properties ?? {}, required: js.required ?? [] };
        })() : { type: 'object', properties: {} },
      },
    }));

    // 4) Old arch message format (first user message has context prepended)
    const oldMessages = [
      { role: 'system', content: oldSystemPrompt },
      { role: 'user', content: `${vaultSessionContext}\n\n[User Query]\n${USER_QUESTION}` },
    ];

    captured.old = {
      systemPrompt: oldSystemPrompt,
      messages: oldMessages,
      tools: oldTools,
      toolChoice: 'auto',
    };

    // ── PRINT COMPARISON ──────────────────────────────────────────────────────
    console.log('\n' + '═'.repeat(80));
    console.log('  OLD ARCHITECTURE (Legacy BaseAgent → OpenAIProvider)');
    console.log('═'.repeat(80));
    console.log('system prompt (messages[0]):');
    console.log(oldSystemPrompt);
    console.log('\nfirst user message (messages[1]):');
    console.log(oldMessages[1].content);
    console.log('\ntools:');
    console.log(JSON.stringify(oldTools, null, 2));
    console.log('\ntool_choice: auto');

    console.log('\n' + '═'.repeat(80));
    console.log('  NEW ARCHITECTURE (AgentLoop → adapter → OpenAIProvider)');
    console.log('═'.repeat(80));
    const newOpts = captured.new as { systemPrompt?: string; tools?: unknown[] };
    console.log('system prompt (options.systemPrompt → messages[0]):');
    console.log(newOpts.systemPrompt ?? '(none)');
    console.log('\nfirst user message (messages[1]):');
    console.log(USER_QUESTION);
    console.log('\ntools:');
    console.log(JSON.stringify(newOpts.tools ?? [], null, 2));
    console.log('\ntool_choice: (not sent — provider defaults)');
    console.log('═'.repeat(80));

    await (await import('fs/promises')).rm(root, { recursive: true, force: true }).catch(() => {});
    expect(captured.new).not.toBeNull();
    expect(captured.old).not.toBeNull();
  }, 30000);
});
