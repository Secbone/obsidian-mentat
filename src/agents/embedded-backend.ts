import type { Context } from '../core/cordis';
import { BaseAgent } from './base-agent';
import type { AgentBackend, AgentBackendCapabilities, AgentChatInput } from './agent-backend';
import type { AgentResponse } from './agent-types';
import type { AgentEvent } from './agent-types';
import { TaskType } from '../types';
import type { AIRouter } from '../providers/ai-router';
import type { ChatOrchestrator } from '../chat/chat-orchestrator';

/**
 * The in-process agent backend: adapts the existing `BaseAgent` RAGP loop
 * to the `AgentBackend` contract (RFC §3.1 / docs M6). Events are yielded
 * directly instead of being routed through the legacy EventBus.
 */
export class EmbeddedBackend implements AgentBackend {
  readonly id = 'embedded';
  readonly displayName = '内置 Agent';
  readonly capabilities: AgentBackendCapabilities = {
    supportsStreaming: true,
    supportsCancellation: true,
    supportsSkills: true,
  };

  constructor(
    private ctx: Context,
    private options: { sessionId?: string; config?: Record<string, unknown> } = {},
  ) {}

  async *streamChat(input: AgentChatInput): AsyncGenerator<AgentEvent> {
    const provider = await this.ctx.get<AIRouter>('aiRouter')!.getProvider(TaskType.CHAT);
    if (!provider) {
      throw new Error('EmbeddedBackend: no AI provider configured');
    }
    const chat = this.ctx.get<ChatOrchestrator>('chat', false);
    const agent = new BaseAgent(
      {
        id: input.sessionId,
        name: `session-${input.sessionId}`,
        description: '',
        ...(this.options.config ?? {}),
        enableSkills: chat ? true : false,
      },
      provider,
      {
        skillRegistry: chat?.getSkillRegistry(),
        skillExecutor: chat?.getSkillExecutor(),
        skillInvocationContext: chat?.getSkillInvocationContext(),
        eventBus: this.ctx.get('eventBus', false),
      } as never,
    );
    const prompt = input.messages.at(-1)?.content ?? '';
    const result: AgentResponse = yield* agent.streamExecute(prompt, {
      messages: input.messages,
      sessionId: input.sessionId,
      abortSignal: input.signal,
      ...(this.options.config ?? {}),
    });
    void result;
  }

  dispose(): void {
    // The embedded backend holds no external resources; its agent is created
    // per interaction. Session-scoped resources are managed by the session.
  }
}
