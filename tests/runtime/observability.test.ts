import { afterEach, describe, expect, it, vi } from 'vitest';
import { Observer } from '../../src/observability/observer';
import { LogStore, type LogIO } from '../../src/observability/log-store';
import { projectRunEvents, renderRunSummary, summarizeRun } from '../../src/observability/run-projection';
import { RunController } from '../../src/runtime/run-controller';
import { RunStore } from '../../src/runtime/run-store';
import { ChatManager } from '../../src/chat/chat-manager';
import { EventBus } from '../../src/extensions/event-bus';
import { ModelGateway } from '../../src/runtime/model-gateway';
import { MemoryPlatformAdapter } from '../utils/memory-platform-adapter';

function setup(maxBytes = 4096, maxFiles = 8, capacity = 1000) {
  const files = new Map<string, string>();
  const io: LogIO = { exists: async p => files.has(p), mkdir: async p => { files.set(p, ''); }, read: async p => files.get(p)!,
    append: vi.fn(async (p, data) => { files.set(p, (files.get(p) || '') + data); }), list: async p => ({ files: [...files.keys()].filter(f => f.startsWith(p + '/') && f.endsWith('.jsonl')) }),
    remove: async p => { files.delete(p); } };
  const store = new LogStore(io, '.obsidian/plugins/mentat/logs', maxBytes, maxFiles, capacity);
  const observer = new Observer(store, () => ['private-api-key', 'a'.repeat(4100)]);
  return { files, io, store, observer };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('Unified observability', () => {
  it('redacts before truncation and omits model/tool bodies in disk and live views', async () => {
    const s = setup();
    const circular: any = { token: 'credential', message: 'private-api-key ' + 'a'.repeat(4100), prompt: 'private prompt', partialContent: 'private response', arguments: 'private args' };
    circular.self = circular;
    s.observer.event('model:failed', { attributes: circular });
    await s.store.drain();
    const text = JSON.stringify(await s.observer.query());
    for (const secret of ['private-api-key', 'credential', 'private prompt', 'private response', 'private args', 'a'.repeat(100)]) expect(text).not.toContain(secret);
    expect(text).toContain('[REDACTED]');
    expect(text).toContain('[CIRCULAR]');
    expect(s.io.append).toHaveBeenCalledOnce();
  });
  it('batches events, preserves order and deduplicates live/disk records', async () => {
    const s = setup();
    for (let i = 0; i < 120; i++) s.observer.event('step:completed', { attributes: { i } });
    await s.store.drain();
    const events = await s.observer.query();
    expect(events).toHaveLength(120);
    expect(events.map(e => e.attributes?.i)).toEqual(Array.from({ length: 120 }, (_,i) => i));
    expect(s.io.append).toHaveBeenCalledTimes(3);
  });
  it('bounds the queue and reports drops without rejecting execution', async () => {
    const s = setup(4096,8,3);
    for (let i = 0; i < 8; i++) s.observer.event('progress');
    expect(s.store.health.dropped).toBe(5);
    await s.store.drain();
    const events = await s.store.read();
    expect(events.filter(e => e.name === 'progress')).toHaveLength(3);
    expect(events.find(e => e.name === 'log:persistence_gap')?.attributes?.droppedSinceLastReport).toBe(5);
  });
  it('keeps errors ahead of lower priority events when the queue is full', async () => {
    const s = setup(4096,8,2);
    s.observer.event('debug', {level:'debug'}); s.observer.event('info');
    s.observer.error('critical',new Error('important'));
    await s.store.drain();
    const events = await s.store.read();
    expect(events.some(e => e.name === 'critical')).toBe(true);
    expect(events.some(e => e.name === 'debug')).toBe(false);
    expect(s.store.health.dropped).toBe(1);
  });
  it('isolates append failures, reports incomplete persistence and recovers on subsequent events', async () => {
    const s = setup(); vi.spyOn(console,'error').mockImplementation(() => {});
    vi.mocked(s.io.append).mockRejectedValueOnce(new Error('disk full'));
    s.observer.event('step');
    await s.store.drain();
    expect(s.store.health.writeError).toContain('disk full');
    expect(s.store.health.dropped).toBe(1);
    expect(s.observer.snapshot()).toHaveLength(1);
    s.observer.event('next'); await s.store.drain();
    expect(s.store.health.writeError).toBe('');
    expect((await s.store.read()).at(-1)?.name).toBe('next');
  });
  it('rotates only its log files and preserves unrelated files', async () => {
    const s = setup(1,2);
    s.files.set('.obsidian/plugins/mentat/logs/keep.json','history');
    for (let i = 0; i < 4; i++) { s.observer.event('step'); await s.store.drain(); }
    expect([...s.files.keys()].filter(p => p.endsWith('.jsonl'))).toHaveLength(2);
    expect(s.files.get('.obsidian/plugins/mentat/logs/keep.json')).toBe('history');
  });
  it('reads valid lines around corruption and reports malformed data', async () => {
    const s = setup(); s.observer.event('step'); await s.store.drain();
    const file = [...s.files.keys()].find(p => p.endsWith('.jsonl'))!;
    s.files.set(file, s.files.get(file) + '{broken\n{}\n');
    expect(await s.store.read()).toHaveLength(1);
    expect(s.store.health.malformed).toBe(2);
  });
  it('records task timing and errors while preserving caller exception semantics', async () => {
    const s = setup(); const error = new Error('failure', { cause: new Error('root') });
    await expect(s.observer.task('index', async () => { throw error; })).rejects.toBe(error);
    await s.store.drain();
    const events = s.observer.snapshot();
    expect(events.map(e => e.name)).toEqual(['index:started','index:failed']);
    expect(events[1].durationMs).toBeGreaterThanOrEqual(0);
    expect(events[1].attributes?.error).toMatchObject({ message: 'failure', cause: 'Error: root' });
  });
  it('captures rejected async event handlers and continues delivery', async () => {
    const errors: unknown[] = [], received: string[] = [];
    const bus = new EventBus(error => { errors.push(error); });
    bus.on('test', async () => { throw new Error('async callback'); });
    bus.on('test', () => { throw new Error('sync callback'); });
    bus.on('*', e => { received.push(e.type); });
    bus.emit({ type: 'test' } as any);
    await Promise.resolve(); await Promise.resolve();
    expect(errors).toHaveLength(2); expect(received).toEqual(['test']);
  });
  it('correlates actual run failures and resume attempts without replaying execution', async () => {
    const s = setup(); const platform = new MemoryPlatformAdapter();
    const plugin = { platform, settings: {}, loadData: async () => ({}), saveData: async () => {} } as any;
    const chat = new ChatManager(plugin);
    const controller = new RunController(new RunStore(platform), new EventBus(), chat, async (_prompt, context) => {
      await context.runtime!.record('model:requested', { requestId: 'request' });
      throw new Error('provider failure');
    }, s.observer);
    await controller.initialize();
    const id = await controller.start('private prompt', { sessionId: chat.getSessionInfo().sessionId, messages: [], maxTurns: 2, enableSkills: true });
    await controller.wait(id); await controller.resume(id); await s.store.drain();
    const events = (await s.observer.query()).filter(e => e.runId === id);
    const failed = events.filter(e => e.name === 'run:failed');
    expect(failed).toHaveLength(2);
    expect(failed[0].attemptId).not.toBe(failed[1].attemptId);
    expect(events.every(e => e.sessionId === chat.getSessionInfo().sessionId)).toBe(true);
    const snapshotEvents = projectRunEvents([controller.get(id)!]);
    expect(new Set([...snapshotEvents, ...events].map(e => e.eventId)).size).toBe(events.length);
    expect(JSON.stringify(events)).not.toContain('private prompt');
  });
  it('retains distinct event IDs for concurrent tool transitions', async () => {
    const s = setup(); const platform = new MemoryPlatformAdapter();
    const chat = new ChatManager({ platform, settings:{}, loadData:async()=>({}), saveData:async()=>{} } as any);
    const controller = new RunController(new RunStore(platform),new EventBus(),chat,async (_prompt,context) => {
      await Promise.all(['a','b','c'].map(id => context.runtime!.setOperation({id,name:id,category:'read',status:'running'})));
      await Promise.all(['a','b','c'].map(id => context.runtime!.setOperation({id,name:id,category:'read',status:'finished',result:{success:true}})));
    },s.observer);
    const id = await controller.start('q',{ sessionId:chat.getSessionInfo().sessionId,messages:[],maxTurns:2,enableSkills:true });
    await controller.wait(id); await s.store.drain();
    const events = (await s.observer.query()).filter(e => e.runId === id);
    expect(events).toHaveLength(8);
    expect(events.filter(e => e.name === 'operation:running').map(e => e.operationId)).toEqual(['a','b','c']);
    expect(events.filter(e => e.name === 'operation:finished').map(e => e.operationId)).toEqual(['a','b','c']);
  });
  it('emits a bounded heartbeat during a slow request and stops it on failure', async () => {
    vi.useFakeTimers();
    const observe = vi.fn(); let reject!: (error: Error) => void;
    const provider = {id:'fake',getMaxOutputTokens:()=>1024,generateStream:()=>new Promise((_resolve,fail)=>{reject=fail;})} as any;
    const result = new ModelGateway(provider).generateSimple([],()=>{},{},{record:async()=>{},observe} as any);
    const rejected = expect(result).rejects.toThrow('stop');
    await vi.advanceTimersByTimeAsync(30000);
    expect(observe).toHaveBeenCalledTimes(3);
    expect(observe.mock.calls[0][1].phase).toBe('waiting_for_response');
    reject(new Error('stop')); await rejected;
    await vi.advanceTimersByTimeAsync(30000);
    expect(observe).toHaveBeenCalledTimes(3);
  });
  it('records simple-provider request timing and rejection details', async () => {
    const record = vi.fn(async () => {}), modelResult = vi.fn(async () => {});
    const provider = { id: 'fake', getMaxOutputTokens: () => 1024, generateStream: async () => { throw new Error('connection failed'); } } as any;
    await expect(new ModelGateway(provider).generateSimple([], () => {}, {}, { record, modelResult } as any)).rejects.toThrow('connection failed');
    expect(record.mock.calls.map(c => c[0])).toEqual(['model:requested','model:failed']);
    expect(record.mock.calls[0][1].requestId).toBe(record.mock.calls[1][1].requestId);
  });
  it('separates model duration from human wait and keeps each failed attempt', () => {
    const record = { id: 'run-test', sessionId: 'session', status: 'failed', events: [
      ['run:started',0,{}], ['model:requested',10,{requestId:'r1'}], ['model:failed',110,{requestId:'r1',error:'network'}],
      ['run:failed',111,{message:'network'}], ['run:resumed',200,{}], ['interaction:requested',210,{interactionId:'approval'}],
      ['interaction:resolved',1210,{interactionId:'approval'}], ['model:requested',1220,{requestId:'r2'}], ['model:failed',1420,{requestId:'r2',error:'protocol'}], ['run:failed',1421,{message:'protocol'}],
    ].map(([type,timestamp,details],i) => ({id:`run-test:${i+1}`, sequence:i+1,type,timestamp,details})) } as any;
    const summary = summarizeRun(record);
    expect(summary.modelMs).toBe(300); expect(summary.waitingMs).toBe(1000); expect(summary.incomplete).toBe(0);
    expect(summary.failures.filter(e => e.name === 'run:failed')).toHaveLength(2);
    expect(renderRunSummary([record])).toContain('protocol');
  });
});
