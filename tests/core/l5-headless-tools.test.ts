import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { buildHeadlessE2E, type E2EResult } from '../helpers/headless-e2e';
import type { LLMProvider } from '../../src/llm/contract';
import type { ToolCall } from '../../src/types';

type Step = { content: string; toolCalls?: ToolCall[] };

/** A provider that replays a fixed script of generateWithTools responses. */
function scriptedProvider(script: Step[]): LLMProvider {
  let i = 0;
  return {
    id: 'mock', name: 'Mock', capabilities: { chat: true, streaming: true, embeddings: false, tools: true },
    generate: async () => '',
    generateStream: async () => {},
    generateWithTools: async (_m, onChunk) => {
      const step = script[Math.min(i++, script.length - 1)];
      onChunk?.({ delta: step.content });
      return { content: step.content, toolCalls: step.toolCalls };
    },
    getContextWindow: () => 8000, getCompactionThreshold: () => 6000, isAvailable: async () => true,
  };
}

describe('L5 headless end-to-end — real tools over real fs vault (offline, deterministic)', () => {
  it('vault_read returns the ACTUAL file content to the model (ToolContext.documents injected)', async () => {
    const h = await buildHeadlessE2E(scriptedProvider([
      { content: 'reading', toolCalls: [{ id: 'c1', name: 'vault_read', arguments: { path: 'notes/hello.md' } }] },
      { content: 'ok', toolCalls: undefined },
    ]), { 'notes/hello.md': 'Hello world content' });
    const res = await h.run('read hello.md');
    const read = res.toolEnds.find((t) => t.name === 'vault_read');
    expect(read?.isError).toBe(false);
    expect((read?.result as { data?: { content?: string } }).data?.content).toBe('Hello world content');
  });

  it('vault_list returns the real files, recursively', async () => {
    const h = await buildHeadlessE2E(scriptedProvider([
      { content: 'listing', toolCalls: [{ id: 'c1', name: 'vault_list', arguments: {} }] },
      { content: 'ok', toolCalls: undefined },
    ]), { 'a.md': 'x', 'notes/b.md': 'y' });
    const res = await h.run('list all files');
    const list = res.toolEnds.find((t) => t.name === 'vault_list');
    const paths = ((list?.result as { data?: { path: string }[] }).data ?? []).map((d) => d.path);
    expect(paths).toEqual(expect.arrayContaining(['a.md', 'notes/b.md']));
  });

  it('vault_write actually persists the file to disk', async () => {
    const h = await buildHeadlessE2E(scriptedProvider([
      { content: 'writing', toolCalls: [{ id: 'c1', name: 'vault_write', arguments: { path: 'out.md', content: 'hi there' } }] },
      { content: 'ok', toolCalls: undefined },
    ]), { 'existing.md': 'keep' });
    const res = await h.run('write out.md');
    expect(res.toolEnds.find((t) => t.name === 'vault_write')?.isError).toBe(false);
    const outPath = join(h.root, 'out.md');
    expect(existsSync(outPath)).toBe(true);
    expect(readFileSync(outPath, 'utf-8')).toBe('hi there');
  });

  it('a tool returning an error is surfaced and the loop still finishes', async () => {
    const h = await buildHeadlessE2E(scriptedProvider([
      { content: 'x', toolCalls: [{ id: 'c1', name: 'ghost_tool', arguments: {} }] },
      { content: 'recovered', toolCalls: undefined },
    ]), {});
    const res: E2EResult = await h.run('go');
    expect(res.toolEnds[0].isError).toBe(true);
    expect(res.events).toContain('agent:end');
  });
});
