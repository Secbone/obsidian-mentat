import type { ObservationEvent } from './types';

export interface LegacyLogIO {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
}
/** Read-only compatibility: legacy incidents cannot safely be merged by operation identity. */
export class LegacyObservationReader {
  readonly health = { readError: '', malformed: 0 };
  constructor(private io: LegacyLogIO, readonly path = '.mentat/diagnostics.jsonl') {}
  async read(): Promise<ObservationEvent[]> {
    this.health.readError = ''; this.health.malformed = 0;
    try {
      if (!await this.io.exists(this.path)) return [];
      const lines = (await this.io.read(this.path)).split('\n'), events: ObservationEvent[] = [];
      for (const [index,line] of lines.entries()) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (!entry || typeof entry !== 'object' || !Number.isFinite(entry.timestamp)) throw new Error('Invalid incident');
          events.push({ schemaVersion:1, eventId:`legacy:${index}`, timestamp:entry.timestamp, processInstanceId:'legacy', sequence:index,
            level:entry.success === true ? 'info':'error', name:'legacy:incident', component:'legacy',
            sessionId:typeof entry.sessionId === 'string' ? entry.sessionId:undefined,
            runId:typeof entry.runId === 'string' ? entry.runId:undefined, attributes:{...entry,legacy:true} });
        } catch { this.health.malformed++; }
      }
      return events;
    } catch (error) { this.health.readError = String(error); return []; }
  }
}
