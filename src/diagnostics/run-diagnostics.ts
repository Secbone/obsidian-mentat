import type { RunRecord } from '../runtime/types';

/** One incident per operation; the run failure is emitted once at its owning boundary. */
export function projectRunIncidents(records: RunRecord[]) {
  return records.flatMap(record => {
    const operations = Object.values(record.operations).filter(op => op.result?.success === false || op.status === 'unknown').map(op => ({
      timestamp: [...record.events].reverse().find(e => e.operationId === op.id)?.timestamp || record.updatedAt,
      sessionId: record.sessionId, runId: record.id, toolName: op.name, errorMessage: op.result?.error || '操作结果未知，请核对实际结果',
      strategy: String(op.result?.outcome || op.status), originalArgs: '', success: false, details: { operationId: op.id, outcome: op.result?.outcome, status: String(op.status) }
    }));
    const terminal = [...record.events].reverse().find(e => e.type === 'run:failed' || e.type === 'run:interrupted');
    if (terminal && !Object.values(record.operations).some(op => op.status === 'unknown')) operations.push({
      timestamp: terminal.timestamp, sessionId: record.sessionId, runId: record.id, toolName: 'run',
      errorMessage: String(terminal.details?.message || record.error || '运行中断'), strategy: terminal.type, originalArgs: '', success: false,
      details: { operationId: '', outcome: undefined, status: record.status }
    });
    return operations;
  });
}
export function renderRunFacts(records: RunRecord[]): string {
  if (!records.length) return '';
  let text = '## 执行状态与检查点\n\n';
  for (const record of records) {
    text += `### ${record.id}\n\n状态：${record.status}；模型配置：${record.providerId || '未固定'}。\n\n`;
    const pending = Object.values(record.interactions).filter(i => !i.outcome);
    text += `待处理人工交互：${pending.length}；未知操作：${Object.values(record.operations).filter(o => o.status === 'unknown').length}。\n\n`;
    text += '| 模型请求 | 输出上限 | 结束原因 | 输入 Tokens | 输出 Tokens | 推理 Tokens |\n| --- | --- | --- | --- | --- | --- |\n';
    const requested = record.events.filter(e => e.type === 'model:requested');
    let attempt = 0;
    for (const event of record.events.filter(e => e.type === 'model:result')) {
      const details = event.details || {}, usage = details.usage as Record<string, number> | undefined;
      const response = details.response as Record<string, unknown> | undefined;
      const request = requested[attempt++];
      text += `| ${attempt} | ${response?.outputLimit ?? request?.details?.outputLimit ?? '未知'} | ${details.finishReason || '未知'} | ${usage?.promptTokens ?? '未知'} | ${usage?.completionTokens ?? '未知'} | ${response?.reasoningTokens ?? '未知'} |\n`;
    }
    text += '\n已校验产物：\n\n';
    const artifacts = record.events.filter(e => e.type === 'artifact:verified');
    text += artifacts.length ? artifacts.map(e => `- ${e.details?.path}（回读核验通过；operationId=${e.operationId}）`).join('\n') + '\n\n' : '没有已回读核验的产物。\n\n';
    text += '执行事件（不含逐 token 内容）：\n\n```json\n' + JSON.stringify(record.events, null, 2) + '\n```\n\n';
  }
  return text;
}
