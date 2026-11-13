import { afterEach, describe, expect, it, vi } from 'vitest';
import { IndexedObservationQuery } from '../../src/observability/observation-query';
import { LegacyObservationReader } from '../../src/observability/legacy-reader';
import { Observer } from '../../src/observability/observer';
import { LogStore } from '../../src/observability/log-store';
import { renderObservationLog, renderObservationRunSummaries } from '../../src/observability/report';
import { MemoryPlatformAdapter } from '../utils/memory-platform-adapter';
import type { RunRecord } from '../../src/runtime/types';

const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{for (const stop of cleanup.splice(0)) await stop();vi.restoreAllMocks();});
function fixture(records:RunRecord[] = []) {
  const io=new MemoryPlatformAdapter();
  const store=new LogStore({exists:p=>io.exists(p),mkdir:p=>io.mkdir(p),read:p=>io.read(p),list:p=>io.list(p),remove:p=>io.delete(p),
    append:async(p,text)=>io.write(p,(await io.exists(p) ? await io.read(p):'')+text)},'.obsidian/plugins/mentat/logs');
  const observer=new Observer(store,()=>['private-secret']);
  const runs={list:(session?:string)=>records.filter(record=>!session || record.sessionId===session),get:(id:string)=>records.find(record=>record.id===id),getWarnings:()=>[]};
  const query=new IndexedObservationQuery(runs,observer,new LegacyObservationReader(io));
  cleanup.push(async()=>{query.dispose();await store.drain();});
  return {io,observer,query,runs};
}
function record(size=1):RunRecord {
  return {version:1,id:'run-a',sessionId:'s',agentId:'default-chat-agent',prompt:'private prompt',maxTurns:20,enableSkills:true,
    status:'running',createdAt:0,updatedAt:size,baseMessageCount:0,messages:[],operations:{},interactions:{},
    events:Array.from({length:size},(_,i)=>({id:`run-a:${i+1}`,sequence:i+1,timestamp:i,type:'model:progress',details:{requestId:`req-${i}`,error:i===size-1 ? 'private-secret issue':undefined}}))};
}

describe('Shared indexed observation query',()=>{
  it('normalizes only the selected page and reuses indexed history when one new event arrives',()=>{
    const r=record(2000),s=fixture([r]),sanitize=vi.spyOn(s.observer,'sanitize');
    const page=s.query.page({},200);expect(page.total).toBe(2000);expect(page.events).toHaveLength(200);
    expect(sanitize).toHaveBeenCalledTimes(200);
    s.query.page({},200);expect(sanitize).toHaveBeenCalledTimes(200);
    r.events.push({id:'run-a:2001',sequence:2001,timestamp:2001,type:'run:failed',details:{error:'private-secret'}});
    const newest=s.query.page({},200);expect(newest.total).toBe(2001);expect(sanitize).toHaveBeenCalledTimes(201);
    expect(JSON.stringify(newest)).not.toContain('private-secret');
    expect(s.query.summary(r.id)?.failures).toBe(2);
  });
  it('keeps pagination anchored while newer events arrive and returns detached details',()=>{
    const r=record(450),s=fixture([r]);
    const first=s.query.page({},200);expect(first.events[0].eventId).toBe('run-a:450');
    r.events.push({id:'run-a:451',sequence:451,timestamp:451,type:'run:failed'});
    const second=s.query.page({},200,first.nextCursor);expect(second.events[0].eventId).toBe('run-a:250');
    expect(new Set([...first.events,...second.events].map(event=>event.eventId)).size).toBe(400);
    first.events[0].attributes!.error='mutated';
    expect(s.query.page({},200).events.find(event=>event.eventId==='run-a:450')?.attributes?.error).not.toBe('mutated');
  });
  it('merges live, persisted and snapshot copies by event identity and preserves derived durations',async()=>{
    const r=record(0);r.events=[
      {id:'run-a:1',sequence:1,timestamp:10,type:'operation:running',operationId:'op'},
      {id:'run-a:2',sequence:2,timestamp:35,type:'operation:finished',operationId:'op'},
    ];
    const s=fixture([r]);
    s.observer.event('operation:finished',{eventId:'run-a:2',timestamp:35,runId:r.id,sessionId:'s',operationId:'op'});
    await s.query.refresh();
    const events=s.query.all({runId:r.id});expect(events).toHaveLength(2);expect(events[1].durationMs).toBe(25);
    expect(s.query.summary(r.id)?.toolMs).toBe(25);
  });
  it('uses the same request pairing, statistics and sanitized events for reports and interactive queries',()=>{
    const r=record(0);r.events=[
      ['run:started',0,{}],['model:requested',10,{requestId:'r'}],['model:failed',110,{requestId:'r',error:'private-secret network'}],
      ['interaction:requested',120,{interactionId:'approval'}],['interaction:resolved',220,{interactionId:'approval'}],
    ].map(([type,timestamp,details],index)=>({id:`run-a:${index+1}`,sequence:index+1,type,timestamp,details})) as any;
    const s=fixture([r]);
    expect(s.query.summary(r.id)).toMatchObject({modelMs:100,waitingMs:100,incomplete:0,attempts:1});
    expect(s.query.modelRequests(r.id)[0].finish?.durationMs).toBe(100);
    const report=renderObservationRunSummaries(s.query,[r]);expect(report).toContain('0.10 秒');expect(report).not.toContain('private-secret');
    const events=s.query.all({runId:r.id,errorsOnly:true});
    const exported=renderObservationLog(s.query,{runId:r.id,errorsOnly:true});
    for (const event of events) expect(exported).toContain(event.eventId);
    expect(exported).not.toContain('private-secret');
  });
  it('searches sanitized content, including safe legacy compatibility events, and reports damaged input',async()=>{
    const s=fixture([record(1)]);
    s.io.addFile('.mentat/diagnostics.jsonl',JSON.stringify({timestamp:1,toolName:'old',errorMessage:'private-secret legacy failure'})+'\n{damaged');
    await s.query.refresh();
    expect(s.query.page({search:'private-secret'}).total).toBe(0);
    expect(s.query.page({search:'legacy failure'}).events[0].name).toBe('legacy:incident');
    expect(s.query.page({sessionId:'s',includeUnscoped:true,errorsOnly:true}).total).toBe(2);
    expect(s.query.health.legacyMalformed).toBe(1);expect(s.query.warnings.join('')).toContain('无法解析');
    expect(renderObservationLog(s.query,{search:'private-secret'})).not.toContain('private-secret');
  });
  it('indexes only the requested run and unsubscribes on disposal',()=>{
    const a=record(20),b={...record(1000),id:'run-b',sessionId:'other'};
    const s=fixture([a,b]),get=vi.spyOn(s.runs,'get');
    s.query.page({runId:a.id});expect(get.mock.calls.map(call=>call[0])).toEqual([a.id]);
    const listener=vi.fn();s.query.subscribe(listener);s.observer.event('background:ready');expect(listener).toHaveBeenCalledOnce();
    s.query.dispose();s.observer.event('background:next');expect(listener).toHaveBeenCalledOnce();
  });
});
