import type { ObservationEvent } from './types';

export interface LogIO {
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  read(path: string): Promise<string>;
  append(path: string, data: string): Promise<void>;
  list(path: string): Promise<{ files: string[] }>;
  remove(path: string): Promise<void>;
}

/** A bounded queue; telemetry failures never change execution state. */
export class LogStore {
  private queue: ObservationEvent[] = [];
  private pending: Promise<void> = Promise.resolve();
  private timer?: ReturnType<typeof setTimeout>;
  private file?: string;
  private bytes = 0;
  private serial = Math.floor(Math.random() * 1000000000);
  private reportedDrops = 0;
  private inFlight = 0;
  readonly health = { writeError: '', readError: '', dropped: 0, malformed: 0 };
  constructor(private io: LogIO, readonly folder: string, private maxBytes = 4 * 1024 * 1024, private maxFiles = 8, private capacity = 1000) {}

  enqueue(event: ObservationEvent): void {
    if (this.queue.length + this.inFlight >= this.capacity) {
      const rank = { debug: 0, info: 1, warn: 2, error: 3 };
      const replace = this.queue.findIndex(e => rank[e.level] < rank[event.level]);
      this.health.dropped++;
      if (replace < 0) return;
      this.queue.splice(replace, 1);
    }
    this.queue.push(event);
    if (this.queue.length >= 50 || event.level === 'error') void this.flush();
    else if (!this.timer) this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, 500);
  }
  flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    const write = this.pending.then(async () => {
      const batch = this.queue.splice(0, 50);
      if (!batch.length) return;
      this.inFlight = batch.length;
      try {
        const segments = this.folder.split('/');
        for (let i = 1; i <= segments.length; i++) {
          const path = segments.slice(0, i).join('/');
          if (!await this.io.exists(path)) await this.io.mkdir(path);
        }
        const dropped = this.health.dropped;
        const gap: ObservationEvent[] = dropped > this.reportedDrops ? [{ ...batch[0], eventId: `gap:${batch[0].eventId}`, name: 'log:persistence_gap',
          component: 'logging', level: 'warn', attributes: { droppedSinceLastReport: dropped - this.reportedDrops, droppedTotal: dropped } }] : [];
        const data = [...gap, ...batch].map(e => JSON.stringify(e)).join('\n') + '\n';
        const size = new TextEncoder().encode(data).length;
        if (!this.file || this.bytes + size > this.maxBytes) {
          this.file = `${this.folder}/events-${Date.now()}-${String(this.serial++).padStart(6, '0')}.jsonl`;
          this.bytes = 0;
        }
        await this.io.append(this.file, data);
        this.bytes += size;
        this.reportedDrops = dropped;
        const files = (await this.io.list(this.folder)).files.filter(p => /\/events-\d+-\d+\.jsonl$/.test(p)).sort();
        for (const path of files.slice(0, Math.max(0, files.length - this.maxFiles))) if (path !== this.file) await this.io.remove(path);
        this.health.writeError = '';
      } catch (error) {
        this.health.writeError = String(error);
        this.file = undefined; // Never append after a potentially partial line.
        this.health.dropped += batch.length;
        console.error('[Mentat LogStore] Log persistence failed', error);
      } finally { this.inFlight = 0; }
    });
    this.pending = write;
    return write.then(() => {
      if (this.queue.length && !this.timer) this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, 500);
    });
  }
  async drain(): Promise<void> {
    do { await this.flush(); } while (this.queue.length);
  }
  async read(): Promise<ObservationEvent[]> {
    await this.drain();
    const events: ObservationEvent[] = [];
    this.health.malformed = 0;
    this.health.readError = '';
    try {
      if (!await this.io.exists(this.folder)) return [];
      const files = (await this.io.list(this.folder)).files.filter(p => /\/events-\d+-\d+\.jsonl$/.test(p)).sort().slice(-this.maxFiles);
      for (const path of files) for (const line of (await this.io.read(path)).split('\n')) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line);
          if (e.schemaVersion !== 1 || typeof e.eventId !== 'string' || typeof e.timestamp !== 'number' || typeof e.name !== 'string' || !['debug','info','warn','error'].includes(e.level)) throw new Error('Invalid event');
          events.push(e);
        } catch { this.health.malformed++; }
      }
    } catch (error) { this.health.readError = String(error); }
    return events;
  }
}
