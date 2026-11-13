import type { ObservationFilter, ObservationQuery } from '../contracts/observation-query';
import type { ObservationEvent } from './types';
import type { RunRecord } from '../runtime/types';

function json(value: unknown): string {
  const text=JSON.stringify(value,null,2), longest=Math.max(2,...(text.match(/`+/g) || []).map(match=>match.length));
  const fence='`'.repeat(longest+1);return `${fence}json\n${text}\n${fence}\n`;
}
export function renderObservationEvents(events: ObservationEvent[]): string {
  return events.map(event=>`### ${new Date(event.timestamp).toISOString()} · ${event.name}\n\n${json(event)}`).join('\n');
}
export function renderObservationLog(query: ObservationQuery, filter: ObservationFilter = {}): string {
  return `# 运行日志\n\n范围：${filter.runId || filter.sessionId || '全部运行与插件后台事件'}；搜索：${filter.search ? '已应用':'无'}；只看异常：${!!filter.errorsOnly}。\n\n日志健康：${JSON.stringify(query.health)}\n\n`
    + renderObservationEvents(query.all(filter));
}
export function renderObservationHealth(query: ObservationQuery, sessionId?: string): string {
  const failures=query.page({sessionId,includeUnscoped:true,errorsOnly:true},30).events.reverse();
  const warnings=query.warnings.length ? `日志读取不完整：${query.warnings.join('；')}\n\n`:'';
  return `## 日志完整性与补充异常\n\n目录：\`${query.folder}\`；日志文件有轮转上限；运行快照独立保留。\n\n健康状态：${JSON.stringify(query.health)}\n\n${warnings}`
    + '以下为最近 30 条异常记录；可能属于同一失败链，记录条数不等于独立故障数。\n\n'+renderObservationEvents(failures);
}
export function renderObservationRunSummaries(query: ObservationQuery, records: RunRecord[]): string {
  if (!records.length) return '';
  let text='## 运行排障摘要\n\n模型和工具耗时为请求累计值，可能包含并行重叠；人工等待单独统计。未记录的信息不自动推断。\n\n';
  for (const record of records) {
    const summary=query.summary(record.id);if (!summary) continue;
    text+=`### ${record.id}\n\n状态：${record.status}；执行尝试：${summary.attempts}；模型累计 ${(summary.modelMs/1000).toFixed(2)} 秒；工具累计 ${(summary.toolMs/1000).toFixed(2)} 秒；已结束人工等待 ${(summary.waitingMs/1000).toFixed(2)} 秒；未闭合步骤 ${summary.incomplete}。\n\n`;
    const failures=query.page({runId:record.id,errorsOnly:true},30);
    text+=failures.total ? `异常记录 ${failures.total} 条，以下展示最近 ${failures.events.length} 条。\n\n`+renderObservationEvents(failures.events.reverse()):'未记录到异常；不代表业务结果均已验证。\n\n';
  }
  return text;
}
