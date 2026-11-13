import type { MutationIO, MutationPlan, MutationChange, MutationPlanStore, MutationItemResult, ToolOutcome } from '../../contracts/tools';
import type { RunRuntime } from '../../runtime/types';
import { RunBlocked } from '../../runtime/types';
import { fingerprint } from '../../runtime/fingerprint';
import { throwIfAborted } from '../../utils/execution';
import { validateArtifact } from '../verified-artifact';

export interface MutationInvocation {
  runtime?: Pick<RunRuntime, 'runId' | 'scope' | 'record'>;
  operationId?: string;
  abortSignal?: AbortSignal;
}
export interface MutationDraft { changes: MutationChange[]; summary: string; warnings?: string[]; skipped?: string[] }
type ApplyResult = ToolOutcome<{ planId: string; filesModified: string[] }>;
type TargetState = 'pending' | 'moved_pending_content' | 'already_satisfied' | 'conflict';

export function assertVaultPath(path: string): void {
  if (!path || path.startsWith('/') || path.includes('\\') || path.split('/').some(p => !p || p === '.' || p === '..') || /[\0\r\n]/.test(path)) {
    throw new Error('文件路径必须位于当前 vault 内');
  }
}

/** Plans are durable approval inputs; only this service applies host file mutations. */
export class MutationService {
  private pending: Promise<unknown> = Promise.resolve();
  private preparing = new Map<string, Promise<MutationPlan>>();
  constructor(readonly io: MutationIO, private store?: MutationPlanStore) {}

  private async key(invocation: MutationInvocation): Promise<string | undefined> {
    return invocation.runtime && invocation.operationId
      ? fingerprint({ runId: invocation.runtime.runId, scope: invocation.runtime.scope, operationId: invocation.operationId }) : undefined;
  }

  async prepare(toolId: string, input: unknown, build: () => Promise<MutationDraft>, invocation: MutationInvocation = {}): Promise<MutationPlan> {
    throwIfAborted(invocation.abortSignal);
    const requestHash = await fingerprint({ toolId, input }), key = await this.key(invocation);
    if (key && !this.store) throw new Error('无法持久化变更计划，禁止执行写入');
    const work = key && this.preparing.get(key) || this.preparePlan(toolId, requestHash, key, build, invocation);
    if (key) this.preparing.set(key, work);
    try {
      const plan = await work;
      if (plan.requestHash !== requestHash) throw new RunBlocked('同一操作ID的工具或参数已变化，禁止重放');
      return structuredClone(plan);
    } finally {
      if (key && this.preparing.get(key) === work) this.preparing.delete(key);
    }
  }

  private async preparePlan(toolId: string, requestHash: string, key: string | undefined, build: () => Promise<MutationDraft>, invocation: MutationInvocation): Promise<MutationPlan> {
    const saved = key ? await this.store!.load(key) : null;
    if (saved) { await this.validate(saved); return saved; }
    const draft = await build();
    const body = { version: 1 as const, requestHash, toolId, changes: draft.changes, summary: draft.summary, warnings: draft.warnings || [], ...(draft.skipped ? { skipped: draft.skipped } : {}) };
    const plan: MutationPlan = { ...body, id: await fingerprint(body) };
    await this.validate(plan);
    if (key) await this.store!.save(key, plan);
    await invocation.runtime?.record('mutation:prepared', { planId: plan.id, targets: plan.changes.map(c => c.path), changeCount: plan.changes.length }, invocation.operationId);
    return plan;
  }

  async validate(plan: MutationPlan): Promise<void> {
    if (!plan || plan.version !== 1 || !Array.isArray(plan.changes) || !Array.isArray(plan.warnings)
      || plan.warnings.some(w => typeof w !== 'string') || typeof plan.summary !== 'string' || typeof plan.toolId !== 'string'
      || !/^[a-f0-9]{64}$/.test(plan.requestHash)) throw new Error('Invalid mutation plan');
    const { id, ...body } = plan;
    if (id !== await fingerprint(body)) throw new Error('Mutation plan checksum mismatch');
    const seen = new Set<string>();
    for (const change of plan.changes) {
      if (!/^[a-f0-9]{64}$/.test(change.beforeHash) || !/^[a-f0-9]{64}$/.test(change.afterHash)) throw new Error('Invalid mutation hash');
      assertVaultPath(change.path);
      if (seen.has(change.path)) throw new Error('Duplicate mutation target');
      seen.add(change.path);
      if (change.kind === 'move') {
        assertVaultPath(change.to);
        if (seen.has(change.to) || change.to === change.path) throw new Error('Duplicate mutation destination');
        seen.add(change.to);
      } else if (change.kind !== 'write' || typeof change.content !== 'string') throw new Error('Invalid mutation change');
      const expectedHash = change.kind === 'write' || change.content !== undefined ? await fingerprint(change.content) : change.beforeHash;
      if (expectedHash !== change.afterHash) throw new Error('Mutation expected content mismatch');
    }
  }

  async writeChange(path: string, content: string, previous: string | null): Promise<MutationChange> {
    assertVaultPath(path);
    validateArtifact(path, content, previous);
    return { kind: 'write', path, content, beforeHash: await fingerprint(previous), afterHash: await fingerprint(content) };
  }

  private async targetState(change: MutationChange): Promise<TargetState> {
    const current = await this.io.read(change.path), currentHash = await fingerprint(current);
    if (change.kind === 'move') {
      if (!await this.io.exists(change.path)) {
        const destinationHash = await fingerprint(await this.io.read(change.to));
        if (destinationHash === change.afterHash) return 'already_satisfied';
        if (change.content !== undefined && destinationHash === change.beforeHash) return 'moved_pending_content';
      }
      return currentHash === change.beforeHash && !await this.io.exists(change.to) ? 'pending' : 'conflict';
    }
    if (currentHash === change.afterHash) return 'already_satisfied';
    return currentHash === change.beforeHash && !(current === null && await this.io.exists(change.path)) ? 'pending' : 'conflict';
  }

  async assertCurrent(plan: MutationPlan, invocation: MutationInvocation = {}): Promise<void> {
    await this.validate(plan);
    const states = [];
    for (const change of plan.changes) { throwIfAborted(invocation.abortSignal); states.push(await this.targetState(change)); }
    const conflicting = states.findIndex(state => state === 'conflict');
    if (conflicting < 0) return;
    const partiallyApplied = states.includes('already_satisfied') || states.includes('moved_pending_content');
    // Never rebuild a whole append/move batch after some of its effects have already happened.
    if (!partiallyApplied) { const key = await this.key(invocation); if (key) await this.store!.clear(key); }
    await invocation.runtime?.record('mutation:invalidated', { planId: plan.id, path: plan.changes[conflicting].path, partiallyApplied }, invocation.operationId);
    throw new RunBlocked(partiallyApplied
      ? '计划已有完成项，已保留原计划；请核对或拆分剩余冲突，禁止整批重放'
      : '审批目标或版本已变化，尚未写入；继续时将准备新计划并重新授权');
  }

  apply(plan: MutationPlan, invocation: MutationInvocation = {}): Promise<ApplyResult> {
    const work = this.pending.then(() => this.commit(plan, invocation));
    this.pending = work.catch(() => undefined);
    return work;
  }

  private async commit(plan: MutationPlan, invocation: MutationInvocation): Promise<ApplyResult> {
    await this.assertCurrent(plan, invocation);
    const items: MutationItemResult[] = [];
    for (const change of plan.changes) {
      if (invocation.abortSignal?.aborted && items.length) { items.push({ path: change.path, kind: change.kind, outcome: 'failure', error: '取消后未开始执行' }); break; }
      throwIfAborted(invocation.abortSignal);
      let started = false;
      try {
        const state = await this.targetState(change);
        if (state === 'conflict') throw new Error('文件在批量提交期间发生变化');
        const path = change.kind === 'move' ? change.to : change.path;
        if (state === 'pending' || state === 'moved_pending_content') {
          started = true;
          if (change.kind === 'write') await this.io.write(change.path, change.content);
          else { if (state !== 'moved_pending_content') await this.io.move(change.path, change.to); if (change.content !== undefined) await this.io.write(change.to, change.content); }
          if (await this.targetState(change) !== 'already_satisfied') throw new Error('提交后的内容或路径核验失败');
        }
        await invocation.runtime?.record('artifact:verified', { path, afterHash: change.afterHash, planId: plan.id, disposition: state === 'already_satisfied' ? 'already_satisfied' : 'applied' }, invocation.operationId);
        items.push({ path, kind: change.kind, outcome: 'success', disposition: state === 'already_satisfied' ? 'already_satisfied' : 'applied' });
      } catch (error) {
        items.push({ path: change.path, kind: change.kind, outcome: started ? 'unknown' : 'failure', error: error instanceof Error ? error.message : String(error) });
        break;
      }
    }
    for (const change of plan.changes.slice(items.length)) items.push({ path: change.path, kind: change.kind, outcome: 'failure', error: '前序变更停止后未执行' });
    const data = { planId: plan.id, filesModified: items.filter(i => i.outcome === 'success').map(i => i.path) };
    if (items.some(i => i.outcome === 'unknown')) return { outcome: 'unknown', error: '部分副作用尚未确认，请核对后继续', data, items, warnings: plan.warnings };
    if (items.some(i => i.outcome === 'failure')) return data.filesModified.length
      ? { outcome: 'partial', error: '已提交项请勿重放；部分文件未提交，请查看逐文件结果', data, items, warnings: plan.warnings }
      : { outcome: 'failure', code: 'failure', error: '文件未提交，请查看逐文件结果', data, items, warnings: plan.warnings };
    if (plan.warnings.length) return { outcome: 'partial', error: '已完成明确计划内变更，但仍有未解析引用或验证警告', data, items, warnings: plan.warnings };
    return { outcome: 'success', data, items };
  }
}
