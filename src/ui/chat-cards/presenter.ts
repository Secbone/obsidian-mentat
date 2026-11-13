import type { ChatMessage, ToolCall } from '../../types';
import type { OperationRecord, RunLiveState, RunRecord } from '../../runtime/types';
import { redactDiagnostics } from '../../observability/redaction';
import { getToolShortName, parseFinalAnswer, resolveToolDisplayName } from '../themes/message-utils';
import type { CardStatus, ChatCard, ChatViewState } from './types';

const liveStatuses = new Set(['running','waiting_for_user','waiting_for_approval']);
export const RUN_LABELS = { running:'运行中', waiting_for_user:'等待你的回答', waiting_for_approval:'等待你的授权', completed:'已完成', failed:'执行失败', cancelled:'已停止', interrupted:'执行已中断' };
export const CARD_LABELS: Record<CardStatus,string> = { running:'执行中', pending:'待执行', waiting:'等待处理', completed:'已完成', failed:'失败', cancelled:'已停止', unknown:'结果待核对', interrupted:'已中断' };

function detail(value: unknown, secrets: string[]): string {
  return JSON.stringify(redactDiagnostics(value, secrets), null, 2)?.slice(0, 16000) || '';
}
function operationStatus(operation: OperationRecord | undefined, record: RunRecord | undefined, response?: ChatMessage): CardStatus {
  if (operation?.status === 'unknown' || operation?.result?.outcome === 'unknown') return 'unknown';
  if (operation?.result) return operation.result.success ? 'completed' : ['cancelled','denied','expired'].includes(operation.result.outcome || '') ? 'cancelled' : 'failed';
  if (operation && record?.status === 'running') return operation.status === 'running' ? 'running' : 'pending';
  if (operation && record && ['waiting_for_user','waiting_for_approval'].includes(record.status)) return 'waiting';
  if (operation && record?.status === 'cancelled') return 'cancelled';
  if (response?.content.startsWith('Error:')) return 'failed';
  // Legacy prose is evidence, not an authoritative success flag.
  return 'unknown';
}

/** A single projection for history, live updates and reattachment. No writes or execution decisions. */
export function projectChat(input: { sessionId: string; history: ChatMessage[]; records: RunRecord[]; displayMessages?: ChatMessage[]; live?: RunLiveState; secrets?: string[]; messageStart?: number }): ChatViewState {
  const records = [...input.records].filter(r => r.sessionId === input.sessionId).sort((a,b) => a.createdAt - b.createdAt);
  const latest = records.at(-1), secrets = input.secrets || [];
  const messages = input.displayMessages || latest?.messages || input.history;
  const cards: ChatCard[] = [];
  const toolCards = new Map<string,ChatCard>();
  const owner = (index: number) => [...records].reverse().find(r => r.baseMessageCount <= index);
  const lastAssistant = new Map<string,number>();
  messages.forEach((m,i) => { if (m.role === 'assistant' && !m.metadata?.isSubagent) lastAssistant.set(owner(i)?.id || 'legacy', i); });
  const tool = (id: string, record: RunRecord | undefined, call?: ToolCall, message?: ChatMessage, timestamp?: number): ChatCard => {
    const key = `${record?.id || input.sessionId}:tool:${id}`;
    const existing = toolCards.get(key);
    if (existing) return existing;
    const op = record?.operations[id];
    const response = message || messages.find(m => m.role === 'tool' && m.tool_call_id === id && !m.metadata?.isSubagent);
    const displayName = resolveToolDisplayName(call?.name || op?.name || '工具', call?.arguments);
    let args: Record<string,unknown> = {};
    try { args = typeof call?.arguments === 'string' ? JSON.parse(call.arguments) : call?.arguments || {}; } catch { /* Display raw arguments in details. */ }
    const params = args.params && typeof args.params === 'object' ? args.params as Record<string,unknown> : args;
    const target = params.path || params.file_path || params.query || params.command || '';
    const events = record?.events.filter(e => e.operationId === id) || [];
    const start = events.find(e => e.type === 'operation:running'), end = [...events].reverse().find(e => ['operation:finished','operation:unknown'].includes(e.type));
    const card: ChatCard = { id:key, kind:'tool', title:getToolShortName(displayName), runId:record?.id, operationId:id,
      timestamp:timestamp ?? events[0]?.timestamp ?? response?.timestamp ?? record?.createdAt ?? 0,
      status:operationStatus(op,record,response), text:String(target).slice(0,220),
      detail:detail({ parameters:call?.arguments, result:op?.result || response?.content || '尚无执行结果',
        children: record?.children ? Object.entries(record.children).filter(([scope]) => scope.startsWith(id + '/')).map(([scope,entries]) => ({ scope, messages: entries.map(m => ({ role:m.role, content:m.content })) })) : undefined },secrets),
      durationMs:start && end ? Math.max(0,end.timestamp - start.timestamp) : undefined,
      canReconcile:op?.status === 'unknown' && latest?.id === record?.id && record?.status !== 'running' };
    toolCards.set(key,card); cards.push(card); return card;
  };
  const messageCard = (m: ChatMessage, index: number, streaming = false, timestamp?: number) => {
    if (m.metadata?.isSubagent || m.role === 'system' || m.role === 'tool') return;
    const record = owner(index);
    const id = `${input.sessionId}:message:${index}`;
    const time = timestamp ?? m.timestamp ?? record?.createdAt ?? index;
    if (m.role === 'user') {
      const steer = m.content.startsWith('[HUMAN DYNAMIC INTERVENTION]:');
      cards.push({ id,kind:'user',title:steer ? '补充指令' : '你',timestamp:time,text:m.content.replace(/^\[HUMAN DYNAMIC INTERVENTION\]:\s*/,''),runId:record?.id });
      return;
    }
    const { explanation,answer } = parseFinalAnswer(m.content);
    const intermediate = !!m.tool_calls?.length || (!streaming && index !== lastAssistant.get(record?.id || 'legacy'));
    if (explanation) cards.push({ id:id+':process',kind:'process',title:'处理过程',timestamp:time,text:explanation,runId:record?.id });
    if (answer.trim()) cards.push({id,kind:intermediate ? 'process':'reply',title:intermediate ? '处理过程':'回复',timestamp:time,text:answer,streaming,runId:record?.id,
      status:m.metadata?.interrupted ? 'interrupted':undefined });
    for (const call of m.tool_calls || []) tool(call.id,record,call,undefined,time);
  };
  messages.forEach((m,i) => { if (i >= (input.messageStart || 0)) messageCard(m,i); });
  if (latest && latest.status === 'running') {
    const live = input.live?.message;
    if (live?.content && live.index >= messages.length) messageCard({role:'assistant',content:live.content,timestamp:live.startedAt},live.index,!live.complete,live.startedAt);
    else if (!live && latest.partial && !messages.at(-1)?.metadata?.interrupted) messageCard({role:'assistant',content:latest.partial,timestamp:latest.updatedAt},messages.length,true,latest.updatedAt);
  }
  for (const record of records) {
    for (const instruction of record.instructions || []) {
      if (instruction.status !== 'queued' || messages.some(message => message.metadata?.instructionId === instruction.id)) continue;
      cards.push({ id:`${record.id}:instruction:${instruction.id}`,kind:'user',title:'补充指令 · 尚未处理',
        timestamp:record.updatedAt,runId:record.id,text:instruction.text,status:record.status === 'cancelled' ? 'cancelled':'pending' });
    }
    const requests = record.events.filter(e => e.type === 'model:requested');
    for (const [i,event] of requests.entries()) {
      const requestId = event.details?.requestId;
      const next = requests[i+1];
      const result = record.events.find(e => {
        if (e.sequence <= event.sequence) return false;
        if (requestId) return e.type === 'model:failed' && e.details?.requestId === requestId || e.type === 'model:result' && (e.details?.response as Record<string,unknown> | undefined)?.requestId === requestId;
        return (!next || e.sequence < next.sequence) && ['model:result','model:failed'].includes(e.type);
      });
      const current = record === latest && record.status === 'running' && event === requests.at(-1) && !result;
      const info = result?.details?.response as Record<string,unknown> | undefined;
      const truncated = result?.details?.finishReason === 'length';
      cards.push({id:`${record.id}:request:${event.id}`,kind:'activity',title:current ? input.live?.phase || '等待模型响应' : '模型请求', timestamp:event.timestamp,
        runId:record.id,status:current ? 'running' : result?.type === 'model:result' && !truncated ? 'completed' : record.status === 'cancelled' ? 'cancelled' : result || record.status === 'failed' ? 'failed' : record.status === 'interrupted' ? 'interrupted':'unknown',
        durationMs:result ? Number(info?.elapsedMs ?? result.details?.elapsedMs ?? result.timestamp-event.timestamp) : undefined,
        detail:detail({ requestId:requestId || '历史请求无 ID', request:event.details, finish:result?.details || '未记录到结束事件' },secrets),
        text:truncated ? '输出达到长度上限，未执行不完整工具调用' : undefined });
    }
    for (const op of Object.values(record.operations)) if (!op.id.includes('/')) tool(op.id,record);
    for (const interaction of Object.values(record.interactions)) {
      const event = record.events.find(e => e.type === 'interaction:requested' && e.details?.interactionId === interaction.id);
      const active = !interaction.outcome && record === latest && ['waiting_for_user','waiting_for_approval','interrupted'].includes(record.status);
      cards.push({id:`${record.id}:interaction:${interaction.id}`,kind:'interaction',title:interaction.kind === 'approval' ? '操作授权':'需要你的回答',timestamp:event?.timestamp || record.updatedAt,
        runId:record.id,operationId:interaction.operationId,status:interaction.outcome ? ['rejected','cancelled','expired'].includes(interaction.outcome.kind) ? 'cancelled':'completed' : active ? 'waiting':'interrupted',
        text:interaction.outcome ? interaction.outcome.answer || ({approved:'已批准',rejected:'已拒绝',answered:'已回答',cancelled:'已取消',expired:'已过期'}[interaction.outcome.kind]) : interaction.question,
        detail:detail({question:interaction.question,context:interaction.context},secrets),
        interaction:active ? interaction:undefined });
    }
    for (const event of record.events.filter(e => e.type === 'artifact:verified')) {
      const path = String(event.details?.path || '');
      cards.push({id:`${record.id}:artifact:${event.id}`,kind:'artifact',title:path.split('/').pop() || '产物',timestamp:event.timestamp,runId:record.id,path,text:path,status:'completed',detail:'已写入并回读校验通过'});
    }
    if (record.status !== 'running' && !['waiting_for_user','waiting_for_approval'].includes(record.status)) {
      const terminal = [...record.events].reverse().find(e => ['run:completed','run:failed','run:cancelled','run:interrupted'].includes(e.type));
      cards.push({id:`${record.id}:outcome`,kind:'system',title:RUN_LABELS[record.status],timestamp:terminal?.timestamp || record.updatedAt,runId:record.id,status:record.status as CardStatus,
        text:record.error, canResume:record === latest && ['failed','interrupted'].includes(record.status) && !Object.values(record.operations).some(op => op.status === 'unknown') });
    }
  }
  const priority = {user:0,activity:1,process:2,tool:3,interaction:4,artifact:5,reply:6,system:7};
  cards.sort((a,b) => a.timestamp-b.timestamp || priority[a.kind]-priority[b.kind]);
  return { cards, ...projectRunControls(latest,input.live) };
}

export function projectRunControls(latest?: RunRecord, live?: RunLiveState): Omit<ChatViewState, 'cards'> {
  const busy = !!latest && liveStatuses.has(latest.status);
  const unknown = !!latest && Object.values(latest.operations).some(op => op.status === 'unknown');
  const running = latest?.status === 'running';
  const executing = latest && Object.values(latest.operations).filter(op => op.status === 'running');
  const label = !latest ? '准备就绪' : live?.cancelling ? '正在停止，等待确认操作结果' : running
    ? executing?.length ? `正在执行 ${executing.length} 个工具` : live?.phase || '等待执行进展'
    : RUN_LABELS[latest.status];
  const phaseEvent = [...(latest?.events || [])].reverse().find(e => ['model:requested','operation:running','interaction:requested','run:resumed','run:started'].includes(e.type));
  const startedAt = live?.message?.content && live.phase === '正在生成回复' ? live.message.startedAt : phaseEvent?.timestamp;
  return {runId:latest?.id,runStatus:latest?.status,label,startedAt:busy ? startedAt:undefined,busy,
    inputMode:running && !live?.cancelling ? 'steer' : busy || unknown || latest?.status === 'interrupted' ? 'blocked':'send',
    canCancel:!!latest && (busy || latest.status === 'interrupted'),cancelling:!!live?.cancelling };
}

/** Cache settled history so streaming one new reply does not repeatedly parse old tool results. */
export class ChatPresenter {
  private prefixKey = '';
  private prefix: ChatCard[] = [];
  private resultKey = '';
  private result?: ChatViewState;
  project(input: Parameters<typeof projectChat>[0]): ChatViewState {
    const records = [...input.records].filter(r => r.sessionId === input.sessionId).sort((a,b) => a.createdAt-b.createdAt);
    const latest = records.at(-1);
    const messages = input.displayMessages || latest?.messages || input.history;
    if (!latest) return projectChat(input);
    const older = records.slice(0,-1);
    const prefixKey = JSON.stringify([input.sessionId,latest.baseMessageCount,input.secrets,older.map(r => [r.id,r.status,r.updatedAt,r.events.length])]);
    if (prefixKey !== this.prefixKey) {
      this.prefixKey = prefixKey;
      this.prefix = projectChat({...input,records:older,displayMessages:messages.slice(0,latest.baseMessageCount),live:undefined}).cards
        .map(card => ({...card,canResume:false,canReconcile:false,interaction:undefined}));
      this.result = undefined;
    }
    const resultKey = JSON.stringify([latest.id,latest.status,latest.updatedAt,latest.events.length,messages.length,latest.partial,input.live]);
    if (!this.result || this.resultKey !== resultKey) {
      this.resultKey = resultKey;
      const current = projectChat({...input,records:[latest],messageStart:latest.baseMessageCount});
      this.result = {...current,cards:[...this.prefix,...current.cards]};
    }
    return {...this.result,cards:[...this.result.cards]};
  }
}
