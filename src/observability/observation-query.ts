import type { ObservationFilter, ObservationHealth, ObservationPage, ObservationQuery, ObservationSource, ObservationSummary } from '../contracts/observation-query';
import type { RunQueries } from '../contracts/run-access';
import type { ObservationEvent } from './types';
import { RunObservationProjection } from './run-projection';

interface Entry {
  event: ObservationEvent;
  observed?: ObservationEvent;
  snapshot?: ObservationEvent;
  safe?: ObservationEvent;
  search?: string;
}
interface RunCursor { count: number; lastId?: string; projection: RunObservationProjection; ids: string[] }
const compare = (a:Entry,b:Entry) => a.event.timestamp-b.event.timestamp || a.event.sequence-b.event.sequence
  || (a.event.eventId < b.event.eventId ? -1:a.event.eventId > b.event.eventId ? 1:0);

/** Append-only run cursors and lazy detail normalization keep normal page reads bounded. */
export class IndexedObservationQuery implements ObservationQuery {
  private entries = new Map<string,Entry>();
  private ordered: Entry[] = [];
  private dirty = new Set<Entry[]>();
  private byRun = new Map<string,Entry[]>();
  private bySession = new Map<string,Entry[]>();
  private cursors = new Map<string,RunCursor>();
  private listeners = new Set<() => void>();
  private revision = 0;
  private filters = new Map<string,{revision:number;entries:Entry[]}>();
  private unsubscribe: () => void;
  private loading?: Promise<void>;
  private disposed = false;
  constructor(private runs: Pick<RunQueries,'list'|'get'|'getWarnings'>, private observer: ObservationSource,
    private legacy?: { readonly health: {readError:string;malformed:number};read():Promise<ObservationEvent[]> }) {
    this.unsubscribe = observer.subscribe(event => {
      if (event.runId) this.syncRun(event.runId);
      this.upsert(event,'observed');
      for (const listener of this.listeners) { try { listener(); } catch { /* A reader cannot interrupt logging. */ } }
    });
    for (const event of observer.snapshot()) this.upsert(event,'observed');
  }
  get folder(): string { return this.observer.store.folder; }
  get health(): ObservationHealth {
    return this.observer.sanitize({schemaVersion:1,eventId:'health',timestamp:0,sequence:0,processInstanceId:'query',name:'log:health',component:'logging',level:'info',
      attributes:{...this.observer.store.health,legacyReadError:this.legacy?.health.readError,legacyMalformed:this.legacy?.health.malformed}}).attributes as unknown as ObservationHealth;
  }
  get warnings(): string[] {
    const warnings = this.runs.getWarnings();
    if (this.legacy?.health.readError) warnings.push(`旧日志读取失败：${this.legacy.health.readError}`);
    if (this.legacy?.health.malformed) warnings.push(`${this.legacy.health.malformed} 条旧日志无法解析`);
    return warnings.map(message=>String(this.observer.sanitize({schemaVersion:1,eventId:'warning',timestamp:0,sequence:0,processInstanceId:'query',name:'log:warning',component:'logging',level:'warn',attributes:{message}}).attributes?.message || '日志读取异常'));
  }
  private insert(list: Entry[], entry: Entry): void {
    if (list.length && compare(list[list.length-1],entry) > 0) this.dirty.add(list);
    list.push(entry);
  }
  private upsert(event: ObservationEvent, source: 'snapshot'|'observed'): void {
    if (this.disposed) return;
    let entry = this.entries.get(event.eventId);
    if (entry) {
      if (entry[source]) return; // Persisted and live copies have immutable event IDs.
      const previous=entry.event;
      entry[source] = event;
      entry.event = { ...(entry.snapshot || event), ...(entry.observed || event),
        sequence:entry.snapshot?.sequence ?? event.sequence,timestamp:entry.snapshot?.timestamp ?? event.timestamp,
        durationMs:entry.observed?.durationMs ?? entry.snapshot?.durationMs };
      for (const [index,key,old] of [[this.byRun,entry.event.runId,previous.runId],[this.bySession,entry.event.sessionId,previous.sessionId]] as const) {
        if (key !== old) {
          const prior=old ? index.get(old):undefined;
          if (prior) {const at=prior.indexOf(entry);if(at>=0)prior.splice(at,1);}
          if (key) {let list=index.get(key);if(!list)index.set(key,list=[]);this.insert(list,entry);}
        }
      }
      if (previous.timestamp !== entry.event.timestamp || previous.sequence !== entry.event.sequence) {
        this.dirty.add(this.ordered);
        for (const list of [this.byRun.get(entry.event.runId || ''),this.bySession.get(entry.event.sessionId || '')]) if(list)this.dirty.add(list);
      }
      entry.safe = undefined; entry.search = undefined; this.revision++; return;
    }
    entry = {event,[source]:event}; this.entries.set(event.eventId,entry); this.insert(this.ordered,entry);
    if (event.runId) { let list=this.byRun.get(event.runId); if (!list) this.byRun.set(event.runId,list=[]); this.insert(list,entry); }
    if (event.sessionId) { let list=this.bySession.get(event.sessionId); if (!list) this.bySession.set(event.sessionId,list=[]); this.insert(list,entry); }
    this.revision++;
  }
  private remove(id: string): void {
    const entry = this.entries.get(id); if (!entry) return;
    this.entries.delete(id);
    for (const list of [this.ordered,this.byRun.get(entry.event.runId || ''),this.bySession.get(entry.event.sessionId || '')]) {
      if (list) { const index=list.indexOf(entry); if (index >= 0) list.splice(index,1); }
    }
    this.revision++;
  }
  private removeLegacy(): void {
    const keep=(entry:Entry)=>!entry.event.eventId.startsWith('legacy:');
    this.dirty.clear();this.filters.clear();
    for (const id of this.entries.keys()) if (id.startsWith('legacy:')) this.entries.delete(id);
    this.ordered=this.ordered.filter(keep);this.dirty.add(this.ordered);
    for (const [id,list] of this.byRun) { const next=list.filter(keep);this.byRun.set(id,next);this.dirty.add(next); }
    for (const [id,list] of this.bySession) { const next=list.filter(keep);this.bySession.set(id,next);this.dirty.add(next); }
    this.revision++;
  }
  private syncRun(id: string): void {
    if (this.disposed) return;
    const record = this.runs.get(id); if (!record) return;
    let cursor = this.cursors.get(id);
    if (cursor && (record.events.length < cursor.count || cursor.count && record.events[cursor.count-1]?.id !== cursor.lastId)) {
      for (const eventId of cursor.ids) this.remove(eventId);
      cursor = undefined;
    }
    if (!cursor) { cursor={count:0,projection:new RunObservationProjection(),ids:[]}; this.cursors.set(id,cursor); }
    for (let index=cursor.count;index<record.events.length;index++) {
      const event = cursor.projection.append(record,record.events[index]);
      this.upsert(event,'snapshot'); cursor.ids.push(event.eventId);
    }
    cursor.count=record.events.length; cursor.lastId=record.events.at(-1)?.id;
  }
  private syncRuns(): void { for (const record of this.runs.list()) this.syncRun(record.id); }
  private safe(entry: Entry): ObservationEvent { return entry.safe ||= this.observer.sanitize(entry.event); }
  private matching(filter: ObservationFilter): Entry[] {
    if (filter.runId) this.syncRun(filter.runId);
    else if (filter.sessionId && !filter.includeUnscoped) { for (const record of this.runs.list(filter.sessionId)) this.syncRun(record.id); }
    else this.syncRuns();
    const key=JSON.stringify(filter), cached=this.filters.get(key);
    if (cached?.revision === this.revision) return cached.entries;
    const source=filter.runId ? this.byRun.get(filter.runId) || [] : filter.sessionId && !filter.includeUnscoped ? this.bySession.get(filter.sessionId) || [] : this.ordered;
    if (this.dirty.delete(source)) source.sort(compare);
    const search=filter.search?.trim().toLowerCase();
    const matches=source.filter(entry => {
      const event=entry.event;
      if (filter.sessionId && event.sessionId !== filter.sessionId && !(filter.includeUnscoped && !event.sessionId)) return false;
      if (filter.errorsOnly && event.level !== 'warn' && event.level !== 'error') return false;
      if (filter.since !== undefined && event.timestamp < filter.since || filter.until !== undefined && event.timestamp > filter.until) return false;
      return !search || (entry.search ||= JSON.stringify(this.safe(entry)).toLowerCase()).includes(search);
    });
    if (this.filters.size >= 20) this.filters.delete(this.filters.keys().next().value!);
    this.filters.set(key,{revision:this.revision,entries:matches}); return matches;
  }
  page(filter: ObservationFilter = {}, limit=200, cursor?: string): ObservationPage {
    const matches=this.matching(filter), size=Math.max(1,Math.min(1000,Math.floor(limit) || 200));
    const end=cursor ? matches.findIndex(entry=>entry.event.eventId===cursor) : matches.length;
    if (end < 0) throw new Error('日志分页位置已失效，请刷新列表。');
    const start=Math.max(0,end-size), selected=matches.slice(start,end).reverse();
    return { events:selected.map(entry=>structuredClone(this.safe(entry))),total:matches.length,
      nextCursor:start > 0 ? selected.at(-1)?.event.eventId:undefined };
  }
  all(filter: ObservationFilter = {}): ObservationEvent[] {
    return this.matching(filter).map(entry=>structuredClone(this.safe(entry)));
  }
  summary(runId: string): ObservationSummary | undefined { this.syncRun(runId); return this.cursors.get(runId)?.projection.summary(); }
  modelRequests(runId: string) {
    this.syncRun(runId);
    const safe=(event:ObservationEvent) => {
      const entry=this.entries.get(event.eventId);return structuredClone(entry ? this.safe(entry):this.observer.sanitize(event));
    };
    return (this.cursors.get(runId)?.projection.modelRequests || []).map(span=>({request:safe(span.request),finish:span.finish ? safe(span.finish):undefined}));
  }
  refresh(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.loading) return this.loading;
    this.loading=(async()=>{
      this.syncRuns();
      for (const event of await this.observer.query()) this.upsert(event,'observed');
      if (this.legacy) {
        const events=await this.legacy.read();
        if (!this.legacy.health.readError) { this.removeLegacy();for (const event of events) this.upsert(event,'observed'); }
      }
    })().finally(()=>{this.loading=undefined;});
    return this.loading;
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return ()=>this.listeners.delete(listener); }
  dispose(): void { this.disposed=true;this.unsubscribe(); this.listeners.clear(); this.entries.clear(); this.cursors.clear(); this.ordered=[]; this.byRun.clear(); this.bySession.clear(); this.filters.clear(); this.dirty.clear(); }
}
