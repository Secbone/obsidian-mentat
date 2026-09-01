import type { PluginObject, Context } from '../core/cordis';
import type { AgentEvent } from './agent-types';
import type { ChatMessage, ToolCall } from '../types';
import type { LLMRegistry } from '../llm/llm.service';
import type { LLMToolDefinition } from '../llm/contract';
import type { ToolsRegistry } from '../tools/tools.service';
import type { ToolDefinition, ToolContext } from '../tools/contract';
import type { CompactionService } from '../session/compaction.service';
import type { ContextWindowService } from '../session/context.service';
import type { Logger, LoggerService } from '../logger/logger.service';
import zodToJsonSchema from 'zod-to-json-schema';

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
import type { ContextAssemblerService } from '../context/context-assembler';

export class AgentLoopService {
  constructor(
    private llm: LLMRegistry,
    private tools: ToolsRegistry,
    private window: ContextWindowService,
    private compaction: CompactionService,
    private logger?: Logger,
    private context: ToolContext = {},
    private assembler?: ContextAssemblerService,
  ) {}

  async *run(messages: ChatMessage[], options: LoopOptions = {}, signal?: AbortSignal): AsyncGenerator<AgentEvent> {
    const maxTurns = options.maxTurns ?? 4;
    // Log the ACTUAL input (full content) so we can see exactly what the user
    // asked. Capped at a generous size to avoid pathological log growth.
    const CAP = 20000;
    const inputPreview = messages.map((m) => `${m.role}:${String(m.content).slice(0, CAP)}`).join(' || ');
    this.logger?.info(`agent-loop run start: ${messages.length} messages, maxTurns=${maxTurns}`, { input: inputPreview });
    yield { type: 'agent:start' };

    const state = { messages };
    let answered = false;

    for (let turn = 0; turn < maxTurns; turn++) {
      if (signal?.aborted) { yield { type: 'agent:error' as never }; break; }
      yield { type: 'turn:start', turnIndex: turn };

      this.logger?.info(`turn ${turn} start: resolving chat provider`);
      const provider = this.llm.resolve('chat');
      if (!provider) {
        this.logger?.error('no chat provider configured in llm registry');
        yield { type: 'system:error', message: 'no chat provider configured' } as never; break;
      }
      this.logger?.info(`turn ${turn}: provider=${provider.id} tools=${provider.capabilities.tools} stream=${provider.capabilities.streaming}`);

      // Use the provider's REAL context window (e.g. DeepSeek = 128k) instead of
      // the hardcoded ~4k default. The tiny default made tool results instantly
      // "exceed budget" and triggered destructive compaction on nearly every
      // turn, erasing the user's question and tool results before the model
      // could use them — the root cause of non-answers and tool spirals.
      const windowTokens = provider.getContextWindow();
      const budget = Math.max(4096, Math.floor(windowTokens * 0.6)); // reserve headroom for output
      const stats = this.window.stats(state.messages, budget);
      if (stats.exceedsBudget) {
        const compacted = await this.compaction.maybeCompact({ messages: state.messages, maxTokens: budget }, this.llm, budget);
        if (compacted.compacted) { state.messages = compacted.messages; yield { type: 'context:compact:start' }; }
      }

      let content = '';
      let toolCalls: ToolCall[] | undefined = undefined;
      const tools = toApiTools(this.tools.list());
      const genWithTools = provider.generateWithTools;
      // Direct the model to answer the user's question with the data it
      // gathered, rather than asking for confirmation or spiralling into more
      // tool calls. Without this the model often replies "what do you want me
      // to do" or keeps exploring until maxTurns.
      const basePrompt = '你是一个智能助手。请直接、完整地回答用户的问题。用工具获取所需数据后，基于真实返回的数据给出直接、具体的回答；如果已经拿到足够数据，立即作答，不要反问用户、不要重复问题、不要空泛地确认。';
      const vaultContext = this.assembler?.getSystemContext();
      const systemPrompt = vaultContext ? `${basePrompt}\n\n${vaultContext}` : basePrompt;
      try {
        if (provider.capabilities.tools && typeof genWithTools === 'function') {
          // True streaming: bridge the provider's callback-based chunks into an
          // async generator so each SSE delta is yielded to the UI immediately,
          // rather than buffered until the whole turn completes.
          const resultHolder: { toolCalls?: ToolCall[] } = {};
          const stream = callbackStreamToAsync((push) =>
            genWithTools(
              state.messages,
              (chunk) => { content += chunk.delta; push(chunk.delta); },
              { signal, tools, systemPrompt },
            ).then((r) => { resultHolder.toolCalls = r.toolCalls; }),
          );
          for await (const delta of stream) {
            yield { type: 'message:update', delta } as AgentEvent;
          }
          toolCalls = resultHolder.toolCalls;
        } else {
          content = await provider.generate(state.messages, { signal, systemPrompt });
          yield { type: 'message:update', delta: content };
        }
      } catch (error) {
        // A provider failure must NOT abort the whole run: surface it as an
        // event and finish cleanly (system:error -> agent:end), so the UI
        // shows the failure inline instead of hanging.
        if (signal?.aborted) {
          yield { type: 'agent:error' as never };
        } else {
          this.logger?.error(`turn ${turn}: generation failed`, { error: error instanceof Error ? error.message : String(error) });
          yield { type: 'system:error', message: `模型调用失败：${error instanceof Error ? error.message : String(error)}` } as never;
        }
        break;
      }

      // Append assistant message (with tool_calls when present), then execute
      // any tool calls. Keeping the API tool_call ids paired is required for
      // OpenAI-compatible APIs to accept the follow-up turn.
      state.messages = [
        ...state.messages,
        {
          role: 'assistant',
          content,
          ...(toolCalls?.length ? { tool_calls: toolCalls } : {}),
          timestamp: Date.now(),
        },
      ];
      this.logger?.info(`turn ${turn}: generate done, contentLen=${content.length}, toolCalls=${toolCalls?.length ?? 0}`, { content: content.slice(0, 20000) });
      if (toolCalls && toolCalls.length) {
        for (const call of toolCalls) {
          const input = typeof call.arguments === 'string' ? parseJsonSafe(call.arguments) : (call.arguments ?? {});
          this.logger?.info(`turn ${turn}: tool:start ${call.name}`, { toolName: call.name, args: input });
          yield { type: 'tool:start', toolCallId: call.id ?? call.name, toolName: call.name, args: input } as never;
          // Pass the platform services (documents/search/knowledge/graph) into
          // the ToolContext so capability tools can actually read the vault.
          // Without these, vault tools see no document store and return empty
          // / "not found" results even though the model called them correctly.
          const toolCtx: ToolContext = { signal, ...this.context };
          const toolResult = await this.tools.execute(call.name, input, toolCtx).catch((e) => {
            this.logger?.error(`tool ${call.name} failed`, { toolName: call.name, error: e instanceof Error ? e.message : String(e) });
            return { success: false, error: e instanceof Error ? e.message : String(e) };
          });
          this.logger?.info(`turn ${turn}: tool:end ${call.name} success=${!!(toolResult && (toolResult as { success?: boolean }).success)}`, {
            toolName: call.name,
            result: JSON.stringify(toolResult).slice(0, 20000),
          });
          state.messages = [
            ...state.messages,
            {
              role: 'tool',
              content: JSON.stringify(toolResult),
              name: call.name,
              tool_call_id: call.id ?? call.name,
              timestamp: Date.now(),
            },
          ];
          const isError = !toolResult || !(toolResult as { success?: boolean }).success;
          yield { type: 'tool:end', toolCallId: call.id ?? call.name, toolName: call.name, result: toolResult as never, isError } as never;
        }
        yield { type: 'turn:end', turnIndex: turn, message: { role: 'assistant', content, timestamp: Date.now() }, toolResults: toolCalls };
        continue; // tool results feed the next turn
      }

      yield { type: 'turn:end', turnIndex: turn, message: { role: 'assistant', content, timestamp: Date.now() }, toolResults: [] };
      answered = true;
      break; // no tools -> done
    }

    // Guarantee the user gets an answer even if the model spent every turn on
    // tool calls (tool-calling spiral / maxTurns exhaustion). If no plain-text
    // answer was produced, do one final non-tool generation so the run never
    // ends with an empty response.
    if (!answered && !signal?.aborted) {
      const provider = this.llm.resolve('chat');
      if (provider) {
        try {
          const finalVaultCtx = this.assembler?.getSystemContext();
          const finalText = await provider.generate(state.messages, { signal, systemPrompt: `请直接回答用户的问题，基于已获取的数据给出完整、具体的回答。${finalVaultCtx ? '\n\n' + finalVaultCtx : ''}` });
          if (finalText) {
            state.messages = [...state.messages, { role: 'assistant', content: finalText, timestamp: Date.now() }];
            this.logger?.info('final-answer guarantee: produced answer after tool-call exhaustion', { len: finalText.length });
            yield { type: 'message:update', delta: finalText } as AgentEvent;
            yield { type: 'turn:end', turnIndex: maxTurns, message: { role: 'assistant', content: finalText, timestamp: Date.now() }, toolResults: [] };
            answered = true;
          } else {
            this.logger?.warn('final-answer guarantee: provider returned empty text');
          }
        } catch (error) {
          this.logger?.error('final-answer generation failed', { error: error instanceof Error ? error.message : String(error) });
        }
      }
    }

    this.logger?.info(`agent-loop run end: total messages=${state.messages.length}${answered ? '' : ' (NO final answer)'}`, {
      final: state.messages.map((m) => `${m.role}:${String(m.content).slice(0, 20000)}`).join(' || '),
    });
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
    const logger = ctx.get<LoggerService>('logger', false);
    const assembler = ctx.get<ContextAssemblerService>('context-assembler', false);
    // Optional platform services injected into the ToolContext for capability
    // tools (documents/search/knowledge/graph). Absent on minimal platforms —
    // tools relying on them stay inert, exactly as designed.
    const context: ToolContext = {
      documents: ctx.get('documents', false),
      search: ctx.get('search', false),
      knowledge: ctx.get('knowledge', false),
      graph: ctx.get('graph', false),
    };
    const service = new AgentLoopService(llm, tools, window, compaction, logger?.get('agent-loop'), context, assembler ?? undefined);
    return ctx.provide('agent-loop', service);
  },
};

function parseJsonSafe(s: string): Record<string, unknown> {
  try { return JSON.parse(s); } catch { return {}; }
}

/** Convert registered ToolDefinitions into the neutral API tool shape. */
function toApiTools(defs: ToolDefinition[]): LLMToolDefinition[] {
  return defs.map((t) => {
    let parameters: Record<string, unknown> | undefined;
    if (t.schema) {
      const jsonSchema = zodToJsonSchema(t.schema as unknown as Parameters<typeof zodToJsonSchema>[0], {
        $refStrategy: 'none',
      }) as { properties?: Record<string, unknown>; required?: string[] };
      parameters = { type: 'object', properties: jsonSchema.properties ?? {}, required: jsonSchema.required ?? [] };
    } else {
      // Defensive default: never advertise a tool with an undefined schema.
      parameters = { type: 'object', properties: {} };
    }
    return { name: t.name, description: t.description, parameters };
  });
}

/**
 * Bridge a callback-based streaming start function into an async generator,
 * so the caller can `for await` deltas as they arrive. `start` receives a
 * `push` it calls per chunk; the returned promise should resolve when the
 * stream completes (or reject on error).
 */
async function* callbackStreamToAsync(
  start: (push: (delta: string) => void) => Promise<unknown>,
): AsyncGenerator<string> {
  const buffer: string[] = [];
  let wake: (() => void) | null = null;
  let done = false;
  let error: unknown;

  const push = (delta: string) => { buffer.push(delta); wake?.(); wake = null; };
  const finish = () => { done = true; wake?.(); wake = null; };

  const job = (async () => {
    try { await start(push); } catch (e) { error = e; } finally { finish(); }
  })();

  try {
    while (!done || buffer.length) {
      if (buffer.length) {
        yield buffer.shift()!;
      } else {
        await new Promise<void>((resolve) => { wake = resolve; });
      }
    }
    await job;
  } finally {
    finish();
  }
  if (error !== undefined) throw error;
}
