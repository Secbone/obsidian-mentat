import type { ToolOutcome } from '../contracts/tools';
import type { SkillResult } from './skill-types';
/** Only this adapter accepts the legacy boolean/result vocabulary. */
export function toToolOutcome<T>(result: SkillResult<T>): ToolOutcome<T> {
    const shared = { data: result.data, metadata: result.metadata };
    const items = result.metadata?.items as ToolOutcome<T>['items'];
    const warnings = result.metadata?.warnings as string[] | undefined;
    if (result.outcome === 'unknown' || items?.some(item => item.outcome === 'unknown'))
        return { ...shared, items, warnings, outcome: 'unknown', error: result.error || '实际操作结果尚未确认' };
    if (result.outcome === 'partial')
        return { ...shared, items, warnings, outcome: 'partial', error: result.error || '部分操作已完成' };
    const errors = (result.data as {
        errors?: unknown[];
    } | undefined)?.errors;
    if (errors?.length && (result.data as {
        filesModified?: unknown[];
    })?.filesModified?.length)
        return { ...shared, items, warnings, outcome: 'partial', error: result.error || '批量操作部分失败' };
    if (result.success && (!result.outcome || result.outcome === 'success') && !errors?.length)
        return { ...shared, items, warnings, outcome: 'success' };
    return { ...shared, items, warnings, outcome: 'failure', code: result.outcome && result.outcome !== 'success' ? result.outcome : 'failure', error: result.error || '操作失败' };
}
export function fromToolOutcome<T>(result: ToolOutcome<T>): SkillResult<T> {
    const metadata = { ...result.metadata, ...(result.items ? { items: result.items } : {}), ...(result.warnings?.length ? { warnings: result.warnings } : {}) };
    return { success: result.outcome === 'success', outcome: result.outcome === 'failure' ?
            (['input_error', 'denied', 'expired', 'cancelled', 'timeout'].includes(result.code) ? result.code as SkillResult['outcome'] : 'failure') : result.outcome,
        data: result.data, error: result.outcome === 'success' ? undefined : result.error, metadata };
}
export function normalizeSkillResult<T>(result: SkillResult<T>): SkillResult<T> { return fromToolOutcome(toToolOutcome(result)); }
