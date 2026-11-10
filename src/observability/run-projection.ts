import type { RunEvent, RunRecord } from '../runtime/types';
import type { ObservationEvent } from './types';

/** Also projects pre-observer snapshots; event IDs allow safe merging with JSONL. */
export function projectRunEvents(records: RunRecord[]): ObservationEvent[] {
  return records.flatMap(record => {
    let attempt = 0;
    const operations = new Map<string, number>();
    return record.events.map(e => {
      if (e.type === 'run:started' || e.type === 'run:resumed') attempt++;
      const event = projectRunEvent(record, e, Math.max(1,attempt));
      if (e.type === 'operation:running' && e.operationId) operations.set(e.operationId, e.timestamp);
      if (e.operationId && ['operation:finished', 'operation:unknown', 'operation:planned'].includes(e.type)) {
        const start = operations.get(e.operationId);
        if (start !== undefined) { event.durationMs = Math.max(0, e.timestamp - start); operations.delete(e.operationId); }
      }
      return event;
    });
  });
}
export function summarizeRun(record: RunRecord): { failures: ObservationEvent[]; modelMs: number; toolMs: number; waitingMs: number; incomplete: number } {
  const events = projectRunEvents([record]);
  let waitingMs = 0;
  const waits = new Map<string, number>();
  const requests = new Map<string, number>();
  for (const e of events) {
    if (e.name === 'interaction:requested') waits.set(String(e.attributes?.interactionId), e.timestamp);
    if (e.name === 'interaction:resolved') {
      const id = String(e.attributes?.interactionId), start = waits.get(id);
      if (start !== undefined) { waitingMs += Math.max(0, e.timestamp - start); waits.delete(id); }
    }
    if (e.name === 'model:requested') requests.set(`${e.attemptId}:${e.requestId || 'legacy'}`, e.timestamp);
    if (e.name === 'model:result' || e.name === 'model:failed') {
      const id = `${e.attemptId}:${e.requestId || 'legacy'}`;
      const start = requests.get(id);
      if (e.durationMs === undefined && start !== undefined) e.durationMs = Math.max(0, e.timestamp - start);
      requests.delete(id);
    }
  }
  return { failures: events.filter(e => e.level === 'error' || e.level === 'warn'),
    modelMs: events.filter(e => e.name === 'model:result' || e.name === 'model:failed').reduce((n,e) => n + (e.durationMs || 0), 0),
    toolMs: events.filter(e => e.name.startsWith('operation:')).reduce((n,e) => n + (e.durationMs || 0), 0),
    waitingMs, incomplete: requests.size + waits.size };
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
        name: e.type, component: e.type.split(':')[0], level: /failed/.test(e.type) || e.details?.error ? 'error' as const : /interrupted/.test(e.type) ? 'warn' as const : 'info' as const,
        sessionId: record.sessionId, runId: record.id, attemptId: `${record.id}:attempt-${Math.max(1,attempt)}`,
        operationId: e.operationId, requestId: String(e.details?.requestId || response?.requestId || '') || undefined,
        durationMs: typeof response?.elapsedMs === 'number' ? response.elapsedMs : typeof e.details?.elapsedMs === 'number' ? e.details.elapsedMs : undefined,
        attributes: e.details };
}

export async function renderObservationHealth(observer: import('./observer').Observer | undefined, sessionId?: string): Promise<string> {
  if (!observer) return '';
  const events = await observer.query();
  const failures = events.filter(e => (!sessionId || e.sessionId === sessionId || !e.runId) && (e.level === 'error' || e.level === 'warn'));
  return `## 日志完整性与补充异常\n\n目录：\`${observer.store.folder}\`；轮转保留最多 8 个文件；运行快照独立保留。\n\n健康状态：${JSON.stringify(observer.store.health)}\n\n以下为最近 30 条异常记录，可能属于同一失败链；使用关联 ID 核对，不能把记录条数当作独立故障数。\n\n` + failures.slice(-30).map(e => `- ${new Date(e.timestamp).toISOString()} · ${e.name} · run=${e.runId || '后台'} · request=${e.requestId || '-'}：${JSON.stringify(e.attributes || {})}`).join('\n') + '\n\n';
}
