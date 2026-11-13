import { renderRunSummary, RunObservationProjection } from '../observability/run-projection';
import { renderObservationEvents, renderObservationRunSummaries } from '../observability/report';
import type { ObservationQuery } from '../contracts/observation-query';
import type { RunRecord } from '../runtime/types';

/** One incident per operation; the run failure is emitted once at its owning boundary. */
export function projectRunIncidents(records: RunRecord[]) {
  return records.flatMap(record => {
    const operations = Object.values(record.operations).filter(op => op.result?.success === false || op.status === 'unknown').map(op => ({
      timestamp: [...record.events].reverse().find(e => e.operationId === op.id)?.timestamp || record.updatedAt,
      sessionId: record.sessionId, runId: record.id, toolName: op.name, errorMessage: op.result?.error || '操作结果未知，请核对实际结果',
      strategy: String(op.result?.outcome || op.status), originalArgs: '', success: false, details: { operationId: op.id, outcome: op.result?.outcome, status: String(op.status) }
    }));
    const failures = record.events.filter(e => e.type === 'run:failed' || e.type === 'run:interrupted');
    for (const terminal of failures) if (!Object.values(record.operations).some(op => op.status === 'unknown')) operations.push({
      timestamp: terminal.timestamp, sessionId: record.sessionId, runId: record.id, toolName: 'run',
      errorMessage: String(terminal.details?.message || record.error || '运行中断'), strategy: terminal.type, originalArgs: '', success: false,
      details: { operationId: '', outcome: undefined, status: record.status }
    });
    return operations;
  });
}
export function renderRunFacts(records: RunRecord[], query?: ObservationQuery): string {
  if (!records.length) return '';
  let text=(query ? renderObservationRunSummaries(query,records):renderRunSummary(records))+'## 执行状态与检查点\n\n';
  for (const record of records) {
    text+=`### ${record.id}\n\n状态：${record.status}；模型配置：${record.providerId || '未固定'}。\n\n`;
    text+=`待处理人工交互：${Object.values(record.interactions).filter(i=>!i.outcome).length}；未知操作：${Object.values(record.operations).filter(o=>o.status==='unknown').length}。\n\n`;
    text+='| 模型请求 | 输出上限 | 结束原因 | 耗时秒 | 输入 Tokens | 输出 Tokens | 推理 Tokens |\n| --- | --- | --- | --- | --- | --- | --- |\n';
    const projection=new RunObservationProjection();
    const fallback=query ? []:record.events.map(event=>projection.append(record,event));
    const requests=query ? query.modelRequests(record.id):projection.modelRequests;
    for (const [index,{request,finish}] of requests.entries()) {
      const details=finish?.attributes || {},usage=details.usage as Record<string,number> | undefined;
      const response=details.response as Record<string,unknown> | undefined;
      const seconds=finish ? ((finish.durationMs ?? finish.timestamp-request.timestamp)/1000).toFixed(2):'等待中';
      text+=`| ${index+1} | ${response?.outputLimit ?? request.attributes?.outputLimit ?? '未知'} | ${details.finishReason || (finish ? '请求失败':'等待中')} | ${seconds} | ${usage?.promptTokens ?? '未知'} | ${usage?.completionTokens ?? '未知'} | ${response?.reasoningTokens ?? '未知'} |\n`;
    }
    text+='\n已校验产物：\n\n';
    const artifacts=record.events.filter(event=>event.type==='artifact:verified');
    text+=artifacts.length ? artifacts.map(event=>`- ${event.details?.path}（回读核验通过；operationId=${event.operationId}）`).join('\n')+'\n\n':'没有已回读核验的产物。\n\n';
    text+='最近执行事件（最多 200 条；完整筛选可在运行检查器导出）：\n\n';
    text+=renderObservationEvents(query ? query.page({runId:record.id},200).events.reverse():fallback.slice(-200));
  }
  return text;
}
