import type { RunAccess } from '../contracts/run-access';
import type { ChatMessage } from '../types';
import type { RunRecord } from './types';
import type { RunController } from './run-controller';

function snapshot<T>(value: T): T {
  const copy = structuredClone(value);
  const seen = new WeakSet<object>();
  const freeze = (item: unknown): void => {
    if (!item || typeof item !== 'object' || seen.has(item)) return;
    seen.add(item);
    for (const child of Object.values(item)) freeze(child);
    Object.freeze(item);
  };
  freeze(copy);
  return copy;
}

/** Keep settled snapshots stable so streaming views do not recopy historical transcripts. */
export function createRunAccess(controller: RunController): RunAccess {
  const records = new WeakMap<RunRecord, { stamp: unknown[]; value: RunRecord }>();
  const messages = new Map<string, { source: ChatMessage[]; length: number; value: ChatMessage[] }>();
  const recordSnapshot = (record: RunRecord): RunRecord => {
    const stamp = [record.revision,record.updatedAt,record.status,record.error,record.messages,record.messages.length,record.partial,
      record.events.length,record.events,record.operations,record.interactions,record.children,
      record.instructions,record.instructions?.map(instruction => instruction.status).join(','),
      ...Object.entries(record.childPartials || {}).flat()];
    const cached = records.get(record);
    if (cached && stamp.length === cached.stamp.length && stamp.every((value,index) => value === cached.stamp[index])) return cached.value;
    const value = snapshot(record);
    records.set(record,{stamp,value});
    return value;
  };
  return {
    start: (prompt,options) => controller.start(prompt,structuredClone(options)),
    open: id => controller.open(id),
    resume: id => controller.resume(id),
    cancel: (id,reason) => controller.cancel(id,reason),
    steer: (id,text) => controller.steer(id,text),
    respond: (id,interactionId,outcome) => controller.respond(id,interactionId,structuredClone(outcome)),
    reconcile: (id,operationId,result) => controller.reconcile(id,operationId,structuredClone(result)),
    list: sessionId => controller.list(sessionId).map(recordSnapshot),
    get: id => { const record=controller.get(id); return record ? recordSnapshot(record) : undefined; },
    getLiveState: id => { const live=controller.getLiveState(id); return live ? snapshot(live) : undefined; },
    getDisplayMessages: id => {
      const source=controller.getDisplayMessages(id), record=controller.get(id);
      if (record && source === record.messages) {
        messages.delete(id);
        return recordSnapshot(record).messages;
      }
      const cached=messages.get(id);
      if (cached?.source === source && cached.length === source.length) return cached.value;
      const value=snapshot(source);
      messages.set(id,{source,length:source.length,value});
      return value;
    },
    getWarnings: () => controller.getWarnings(),
    hasUnsettledWork: () => controller.hasUnsettledWork(),
  };
}
