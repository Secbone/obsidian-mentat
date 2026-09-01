import type { Context } from '../../core/cordis';
import type { AgentBackend, AgentBackendCapabilities, AgentChatInput } from '../agent-backend';
import type { AgentEvent } from '../agent-types';
import type { AgentLoopService } from '../loop.service';

/**
 * Embedded backend (L3.4): the AgentBackend implementation built on the new
 * `agent-loop` service (llm/tools/knowledge/window/compaction). This replaces
 * the legacy BaseAgent adapter as the default in-process agent — same
 * contract, new orchestration core. No host types; may run on any platform.
 */
export class EmbeddedBackend implements AgentBackend {
  readonly id = 'embedded';
  readonly displayName = '内置 Agent';
  readonly capabilities: AgentBackendCapabilities = {
    supportsStreaming: true,
    supportsCancellation: true,
    supportsSkills: true,
  };

  constructor(private ctx: Context, private options: { sessionId?: string } = {}) {}

  async *streamChat(input: AgentChatInput): AsyncGenerator<AgentEvent> {
    const loop = this.ctx.get<AgentLoopService>('agent-loop')!;
    // Allow enough turns for real multi-step tool analysis (read several notes,
    // search, then answer). Combined with the loop's final-answer guarantee the
    // user always gets a plain-text response.
    yield* loop.run(input.messages, { maxTurns: 10, mode: this.options.sessionId }, input.signal);
  }

  dispose(): void {
    // No external resources held by the embedded backend.
  }
}
