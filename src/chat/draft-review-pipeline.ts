import { BaseAgent, AgentDependencies } from '../agents/base-agent';
import { AgentConfig, AgentContext, AgentResponse, AgentEvent } from '../agents/agent-types';
import { AIProvider } from '../types';

/**
 * DraftReviewPipeline - Multi-agent Drafting and Quality Auditing Pipeline
 * Co-ordinates a Writer Agent and a Reviewer/Critic Agent to converge on high-quality Markdown outputs.
 */
export class DraftReviewPipeline {
  private writerAgent: BaseAgent;
  private reviewerAgent: BaseAgent;

  constructor(
    provider: AIProvider,
    dependencies: AgentDependencies,
    baseSystemPrompt: string
  ) {
    // 1. Writer Agent Prompt - focuses on thoroughness, examples, and deep RAG
    const writerSystemPrompt = `${baseSystemPrompt}

=======================================================
WRITER ROLE INSTRUCTIONS (CRITICAL):
You are an expert technical note writer. Your goal is to draft comprehensive, accurate, and high-density technical notes.
- Use available skills/tools to gather information.
- Structure your output elegantly using headers and bulleted lists.
- Avoid generic filler text and boilerplate headers.
- Always review your own outputs for LaTeX math and wikilink syntax.
=======================================================`;

    // 2. Reviewer Agent Prompt - focuses strictly on Markdown quality, math balance, wikilinks, and structures
    const reviewerSystemPrompt = `You are a strict, detail-oriented Obsidian note auditor.
Your job is to critically review technical drafts for quality, syntax correctness, and structural integrity.

CRITICAL INSTRUCTIONS:
- Verify that all LaTeX block formulas '$$' and inline formulas '$' are balanced and closed.
- Verify that code blocks are balanced and closed with triple backticks.
- Verify that wikilinks '[[Note]]' are balanced.
- Verify that there are no decorative emojis in headings.
- Check if the technical content is deep enough and has concrete examples.

IF the draft is of stellar quality and has NO structural or formatting errors:
- Respond with exactly: APPROVED

OTHERWISE:
- Respond with a clear, concise bulleted list of specific criticisms and actions that the Writer MUST fix.
- Do NOT include any other text besides the bulleted list.
`;

    const writerConfig: AgentConfig = {
      id: 'writer-agent',
      name: 'Writer Agent',
      description: 'Specialized technical content draft agent with skill capabilities',
      enableSkills: true,
      maxTurns: 20,
      temperature: 0.7,
      systemPrompt: writerSystemPrompt
    };

    const reviewerConfig: AgentConfig = {
      id: 'reviewer-agent',
      name: 'Reviewer Agent',
      description: 'Obsidian note formatting and quality auditor',
      enableSkills: false, // critic does not need direct file writing skills
      maxTurns: 5,
      temperature: 0.2, // low temperature for high critic consistency
      systemPrompt: reviewerSystemPrompt
    };

    this.writerAgent = new BaseAgent(writerConfig, provider, dependencies);
    this.reviewerAgent = new BaseAgent(reviewerConfig, provider, dependencies);
  }

  /**
   * Co-ordinate cooperative draft-review iteration
   */
  async *execute(
    prompt: string,
    context: AgentContext
  ): AsyncGenerator<AgentEvent, AgentResponse, any> {
    const startTime = Date.now();

    yield { type: 'status', message: '✍️ Writer Agent 正在进行初始技术调研并起草内容...' };

    // Turn 1: Writer Agent drafts initial note
    let writerResponse: AgentResponse;
    try {
      const generator = this.writerAgent.execute(prompt, context);
      let result = await generator.next();
      while (!result.done) {
        yield result.value as AgentEvent;
        result = await generator.next();
      }
      writerResponse = result.value as AgentResponse;
    } catch (err: any) {
      yield { type: 'error', message: `Writer Agent 初始写作阶段异常: ${err.message}` };
      throw err;
    }

    yield { type: 'status', message: '🔍 Reviewer Agent 正在独立校验内容与语法格式...' };

    // Turn 2: Reviewer audits the draft
    const reviewerPrompt = `Please critically audit the following technical note draft:\n\n${writerResponse.content}`;
    let reviewerResponse: AgentResponse;
    try {
      const reviewerGen = this.reviewerAgent.execute(reviewerPrompt, {
        messages: [],
        sessionId: `reviewer-${Date.now()}`
      });
      let revResult = await reviewerGen.next();
      while (!revResult.done) {
        if (revResult.value.type === 'status') {
          yield revResult.value;
        }
        revResult = await reviewerGen.next();
      }
      reviewerResponse = revResult.value as AgentResponse;
    } catch (err: any) {
      yield { type: 'status', message: `⚠️ Reviewer Agent 评估失败: ${err.message}，默认批准首版本。` };
      return writerResponse;
    }

    const reviewResultText = reviewerResponse.content.trim();
    const isApproved = reviewResultText.toUpperCase().includes('APPROVED');

    if (isApproved) {
      yield { type: 'status', message: '✅ Reviewer 已批准！内容结构合规且完美闭合。' };
      return writerResponse;
    }

    // Got criticisms, run revision
    yield { type: 'status', message: `⚠️ Reviewer 提出修订修改要求：\n${reviewResultText}` };
    yield { type: 'status', message: '✍️ Writer Agent 根据评审建议开始第二轮针对性优化与重写...' };

    // Turn 3: Run Writer Agent revision turn
    const revisionPrompt = `The Reviewer Agent rejected your initial draft and provided the following critical feedback:
${reviewResultText}

Please rewrite/revise your technical note to address every item on the list. Maintain high quality. Make sure LaTeX formulas and wikilinks are balanced.`;

    const revisionContext: AgentContext = {
      messages: writerResponse.messages, // Maintain Writer's conversation history!
      sessionId: context.sessionId,
      metadata: context.metadata
    };

    let revisedWriterResponse: AgentResponse;
    try {
      const writerRevisionGen = this.writerAgent.execute(revisionPrompt, revisionContext);
      yield { type: 'chunk', text: '\n\n---\n\n### 📝 Writer 优化修订版本\n\n' };
      let revWriteResult = await writerRevisionGen.next();
      while (!revWriteResult.done) {
        yield revWriteResult.value as AgentEvent;
        revWriteResult = await writerRevisionGen.next();
      }
      revisedWriterResponse = revWriteResult.value as AgentResponse;
    } catch (err: any) {
      yield { type: 'status', message: `⚠️ Writer 修订失败: ${err.message}，回退使用初始草稿。` };
      return writerResponse;
    }

    // Final Reviewer check
    yield { type: 'status', message: '🔍 Reviewer Agent 正在进行最终质量合规审核...' };
    const finalReviewPrompt = `Please critically audit the final revised technical note draft:\n\n${revisedWriterResponse.content}`;
    
    let finalReviewerResponse: AgentResponse;
    try {
      const finalReviewerGen = this.reviewerAgent.execute(finalReviewPrompt, {
        messages: [],
        sessionId: `final-reviewer-${Date.now()}`
      });
      let finalRevResult = await finalReviewerGen.next();
      while (!finalRevResult.done) {
        if (finalRevResult.value.type === 'status') {
          yield finalRevResult.value;
        }
        finalRevResult = await finalReviewerGen.next();
      }
      finalReviewerResponse = finalRevResult.value as AgentResponse;
    } catch (err: any) {
      yield { type: 'status', message: `⚠️ Reviewer 最终审核异常: ${err.message}` };
      return revisedWriterResponse;
    }

    yield { type: 'status', message: `✅ 双智能体协同协作流程执行完成！最终修订意见：\n${finalReviewerResponse.content}` };

    const finalResponse: AgentResponse = {
      content: revisedWriterResponse.content,
      messages: revisedWriterResponse.messages,
      skillCalls: [...(writerResponse.skillCalls || []), ...(revisedWriterResponse.skillCalls || [])],
      metadata: {
        totalDurationMs: Date.now() - startTime,
        initialApproved: false,
        finalCritique: finalReviewerResponse.content
      }
    };

    return finalResponse;
  }
}
