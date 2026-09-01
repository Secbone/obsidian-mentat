import { describe, it, expect } from 'vitest';
import { buildHeadlessE2E } from '../helpers/headless-e2e';
import { OpenAIProvider } from '../../src/providers/openai-provider';
import { adaptLegacyProvider } from '../../src/llm/legacy-adapter';
import type { LLMProvider } from '../../src/llm/contract';

const KEY = process.env.DEEPSEEK_KEY || '';

function realProvider(): LLMProvider {
  const raw = new OpenAIProvider({
    id: 'deepseek', apiKey: KEY, baseURL: 'https://api.deepseek.com', model: 'deepseek-v4-flash',
    maxTokens: 1024,
  } as never);
  return adaptLegacyProvider(raw as never);
}

// A vault with clearly verifiable ground-truth content, so a human reviewer
// can judge whether the answer is TRUE, hallucinated, or a non-answer.
const VAULT = {
  '笔记/人工智能.md': '# 人工智能\n我的笔记主要研究 LLM（大语言模型）、强化学习和训练方法。重点模型是 DeepSeek-V3。',
  '笔记/金融.md': '# 金融\n记录风控模型、贷前策略和量化交易相关内容。',
  '项目计划.md': '# 项目计划\n目标：Q3 上线智能客服。进度：需求已完成，开发进行中，预计 10 月测试。负责人：张伟。',
  '会议记录-2026-08-20.md': '# 会议记录\n决定：1) 使用 Milvus 做向量检索；2) 下周演示原型；3) 李雷负责部署。',
};

/**
 * L5.6 ANSWER-QUALITY MANUAL AUDIT.
 *
 * Deliberately NO regex/assertion on the answer content. This harness prints
 * the FULL assistant output for each realistic question so a human reviewer
 * reads it and judges: does it truly answer, does it hallucinate, is it an
 * unexpected reply? Tool-call counts are shown only for context.
 */
describe('L5.6 answer quality — MANUAL audit (print, do not assert)', () => {
  const questions = [
    '我的笔记都涉及哪些领域？',
    '哪一篇笔记讲机器学习相关的模型？',
    '项目计划目前的进度到哪一步了？负责人是谁？',
    '最近那次会议决定了哪些事？',
    '我的笔记里重点研究的那个模型是什么？',
  ];

  it('prints full answers for manual review', async () => {
    for (const q of questions) {
      const h = await buildHeadlessE2E(realProvider(), VAULT);
      const res = await h.run(q);
      console.log('\n================ MANUAL-AUDIT ================');
      console.log('QUESTION:', q);
      console.log('TOOLS:', JSON.stringify(res.toolCalls.map((c) => c.name)));
      console.log('ANSWER (full):\n' + res.assistantText);
      await (await import('fs/promises')).rm(h.root, { recursive: true, force: true }).catch(() => {});
    }
    // The point is the printed output for a human to read; only ensure the
    // battery executed without throwing.
    expect(true).toBe(true);
  }, 120000);
});
