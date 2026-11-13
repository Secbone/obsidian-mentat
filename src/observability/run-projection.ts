import type { RunEvent, RunRecord } from '../runtime/types';
import type { ObservationEvent } from './types';

/** Incremental projector shared by the indexed query and standalone compatibility helpers. */
export class RunObservationProjection {
  private attempt = 0;
  private operations = new Map<string, number>();
  private requests = new Map<string, number>();
  private modelSpans = new Map<string,import('../contracts/observation-query').ObservationModelRequest>();
  readonly modelRequests: import('../contracts/observation-query').ObservationModelRequest[] = [];
  private waits = new Map<string, number>();
  private modelMs = 0;
  private toolMs = 0;
  private waitingMs = 0;
  readonly failures: ObservationEvent[] = [];
  append(record: RunRecord, source: RunEvent): ObservationEvent {
    if (source.type === 'run:started' || source.type === 'run:resumed') this.attempt++;
    const event = projectRunEvent(record,source,Math.max(1,this.attempt));
    if (event.name === 'operation:running' && event.operationId) this.operations.set(event.operationId,event.timestamp);
    if (event.operationId && ['operation:finished','operation:unknown','operation:planned'].includes(event.name)) {
      const start = this.operations.get(event.operationId);
      if (start !== undefined) { event.durationMs = Math.max(0,event.timestamp-start); this.operations.delete(event.operationId); this.toolMs += event.durationMs; }
    }
    if (event.name === 'interaction:requested') this.waits.set(String(event.attributes?.interactionId),event.timestamp);
    if (event.name === 'interaction:resolved') {
      const id = String(event.attributes?.interactionId), start = this.waits.get(id);
      if (start !== undefined) { this.waitingMs += Math.max(0,event.timestamp-start); this.waits.delete(id); }
    }
    const request = `${event.attemptId}:${event.requestId || 'legacy'}`;
    if (event.name === 'model:requested') {
      this.requests.set(request,event.timestamp);
      const span={request:event};this.modelRequests.push(span);this.modelSpans.set(request,span);
    }
    if (event.name === 'model:result' || event.name === 'model:failed') {
      const start = this.requests.get(request);
      if (event.durationMs === undefined && start !== undefined) event.durationMs = Math.max(0,event.timestamp-start);
      this.requests.delete(request); this.modelMs += event.durationMs || 0;
      const span=this.modelSpans.get(request);if (span) {span.finish=event;this.modelSpans.delete(request);}
    }
    if (event.name === 'run:failed' || event.name === 'run:interrupted' || event.name === 'run:cancelled') {
      for (const span of this.modelSpans.values()) span.finish ||= event;
    }
    if (event.level === 'error' || event.level === 'warn') this.failures.push(event);
    return event;
  }
  summary(): import('../contracts/observation-query').ObservationSummary {
    return { attempts:Math.max(1,this.attempt),modelMs:this.modelMs,toolMs:this.toolMs,waitingMs:this.waitingMs,
      incomplete:this.requests.size+this.waits.size,failures:this.failures.length };
  }
}

export function projectRunEvents(records: RunRecord[]): ObservationEvent[] {
  return records.flatMap(record => {
    const projection = new RunObservationProjection();
    return record.events.map(event => projection.append(record,event));
  });
}
export function summarizeRun(record: RunRecord): { failures: ObservationEvent[]; modelMs: number; toolMs: number; waitingMs: number; incomplete: number } {
  const projection = new RunObservationProjection();
  for (const event of record.events) projection.append(record,event);
  return {...projection.summary(),failures:projection.failures};
}
export function renderRunSummary(records: RunRecord[]): string {
  if (!records.length) return '';
  let text = '## 运行排障摘要\n\n模型耗时为请求累计值，可能包含并行重叠；人工等待单独统计。以下为已记录事实，不自动推断根因。\n\n';
  for (const record of records) {
    const s = summarizeRun(record);
    text += `### ${record.id}\n\n状态：${record.status}；执行尝试：${Math.max(1, record.events.filter(e => e.type === 'run:started' || e.type === 'run:resumed').length)}；模型累计 ${(s.modelMs / 1000).toFixed(2)} 秒；工具累计 ${(s.toolMs / 1000).toFixed(2)} 秒；已结束人工等待 ${(s.waitingMs / 1000).toFixed(2)} 秒；未闭合步骤 ${s.incomplete}。\n\n`;
    text += s.failures.length ? s.failures.map(e => `- ${new Date(e.timestamp).toISOString()} · ${e.attemptId} · ${e.name}：${JSON.stringify(e.attributes || {})}`).join('\n') + '\n\n' : '未记录到异常；不代表全部业务结果均已验证。\n\n';
  }
  return text;
}

export function projectRunEvent(record: RunRecord, e: RunEvent, attempt: number): ObservationEvent {
  const response = e.details?.response as Record<string, unknown> | undefined;
  return { schemaVersion: 1 as const, eventId: e.id, timestamp: e.timestamp, processInstanceId: 'snapshot', sequence: e.sequence,
        name: e.type, component: e.type.split(':')[0], level: /failed|error|incident/.test(e.type) || e.details?.error ? 'error' as const : /interrupted|unknown/.test(e.type) ? 'warn' as const : 'info' as const,
        sessionId: record.sessionId, runId: record.id, attemptId: `${record.id}:attempt-${Math.max(1,attempt)}`,
        operationId: e.operationId, requestId: String(e.details?.requestId || response?.requestId || '') || undefined,
        durationMs: typeof response?.elapsedMs === 'number' ? response.elapsedMs : typeof e.details?.elapsedMs === 'number' ? e.details.elapsedMs : undefined,
        attributes: e.details };
}
