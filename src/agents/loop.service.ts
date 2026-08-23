import type { PluginObject, Context } from '../core/cordis';
import type { AgentEvent } from './agent-types';
import type { AgentBackend } from './agent-backend';
import type { ChatMessage } from '../types';
import type { LLMRegistry } from '../llm/llm.service';
import type { ToolsRegistry } from '../tools/tools.service';
import type { CompactionService } from '../session/compaction.service';
import type { ContextWindowService } from '../session/context.service';

export interface LoopOptions {
  maxTurns?: number;
  mode?: string;
}

/**
 * Agent loop service (L3.3): the RAGP-style multi-turn reasoning loop over the
 * new contracts (llm registry + tools registry + knowledge + window +
 * compaction). Emits AgentEvent via the backend (not the legacy EventBus).
 *
 * This is the orchestration core both embedded and delegated backends build
 * on. It is deliberately thin and testable — no host types.
 */
export class AgentLoopService {
  constructor(
    private llm: LLMRegistry,
    private tools: ToolsRegistry,
    private window: ContextWindowService,
    private compaction: CompactionService,
  ) {}

  async *run(messages: ChatMessage[], options: LoopOptions = {}, signal?: AbortSignal): AsyncGenerator<AgentEvent> {
    const maxTurns = options.maxTurns ?? 4;
    yield { type: 'agent:start' };

    let state = { messages };

    for (let turn = 0; turn < maxTurns; turn++) {
      if (signal?.aborted) { yield { type: 'agent:error' as never }; break; }
      yield { type: 'turn:start', turnIndex: turn };

      const provider = this.llm.resolve('chat');
      if (!provider) { yield { type: 'system:error', message: 'no chat provider configured' } as never; break; }

      const stats = this.window.stats(state.messages);
      if (stats.exceedsBudget) {
        const compacted = await this.compaction.maybeCompact({ messages: state.messages, maxTokens: 4096 }, this.llm);
        if (compacted.compacted) { state.messages = compacted.messages; yield { type: 'context:compact:start' }; }
      }

      let content = '';
      let toolCalls;
      if (provider.capabilities.tools && typeof provider.generateWithTools === 'function') {
        // accumulate deltas, then emit a single message:update event
        const deltas: string[] = [];
        const result = await provider.generateWithTools(state.messages, (chunk) => {
          content += chunk.delta;
          deltas.push(chunk.delta);
        });
        for (const d of deltas) yield { type: 'message:update', delta: d } as AgentEvent;
        toolCalls = result.toolCalls;
      } else {
        content = await provider.generate(state.messages);
        yield { type: 'message:update', delta: content };
      }

      // Append assistant message, then execute any tool calls.
      state.messages = [...state.messages, { role: 'assistant', content, timestamp: Date.now() }];
      if (toolCalls && toolCalls.length) {
        for (const call of toolCalls) {
          const input = typeof call.arguments === 'string' ? parseJsonSafe(call.arguments) : (call.arguments ?? {});
          yield { type: 'tool:start', toolCallId: call.id ?? call.name, toolName: call.name, args: input } as never;
          const toolResult = await this.tools.execute(call.name, input, { signal }).catch((e) => ({ success: false, error: e.message }));
          state.messages = [...state.messages, { role: 'tool', content: JSON.stringify(toolResult), name: call.name, timestamp: Date.now() }];
          const isError = !toolResult || !(toolResult as { success?: boolean }).success;
          yield { type: 'tool:end', toolCallId: call.id ?? call.name, toolName: call.name, result: toolResult as never, isError } as never;
        }
        yield { type: 'turn:end', turnIndex: turn, message: { role: 'assistant', content, timestamp: Date.now() }, toolResults: toolCalls };
        continue; // tool results feed the next turn
      }

      yield { type: 'turn:end', turnIndex: turn, message: { role: 'assistant', content, timestamp: Date.now() }, toolResults: [] };
      break; // no tools -> done
    }

    yield { type: 'agent:end', messages: state.messages };
  }
}

export const AgentLoopServicePlugin: PluginObject = {
  inject: ['llm', 'tools', 'context-window', 'compaction'],
  apply(ctx: Context) {
    const llm = ctx.get<LLMRegistry>('llm')!;
    const tools = ctx.get<ToolsRegistry>('tools')!;
    const window = ctx.get<ContextWindowService>('context-window')!;
    const compaction = ctx.get<CompactionService>('compaction')!;
    const service = new AgentLoopService(llm, tools, window, compaction);
    return ctx.provide('agent-loop', service);
  },
};

function parseJsonSafe(s: string): Record<string, unknown> {
  try { return JSON.parse(s); } catch { return {}; }
}
