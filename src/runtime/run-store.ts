import { runSchema } from './run-schema';
import type { IPlatformAdapter } from '../types/platform';
import type { RunRecord } from './types';

/** One serialized writer per plugin runtime. Snapshots include the compact event journal. */
export class RunStore {
  private pending: Promise<unknown> = Promise.resolve();
  readonly folder: string;
  readonly warnings: string[] = [];
  constructor(private platform: IPlatformAdapter) {
    this.folder = `${platform.getConfigDir()}/plugins/obsidian-mentat/runs`;
  }
  private path(id: string): string {
    if (!/^run-[a-zA-Z0-9-]+$/.test(id)) throw new Error('Invalid run ID');
    return `${this.folder}/${id}.json`;
  }
  async save(record: RunRecord): Promise<void> {
    const data = JSON.stringify(record);
    const write = this.pending.catch(() => undefined).then(async () => {
      const segments = this.folder.split('/');
      for (let i = 1; i <= segments.length; i++) {
        const path = segments.slice(0, i).join('/');
        if (!await this.platform.exists(path)) await this.platform.mkdir(path);
      }
      const path = this.path(record.id);
      if (await this.platform.exists(path)) {
        const previous = await this.platform.read(path);
        JSON.parse(previous);
        await this.platform.write(`${path}.bak`, previous);
      }
      await this.platform.write(path, data);
    });
    this.pending = write;
    await write;
  }
  async load(id: string): Promise<RunRecord> {
    const path = this.path(id);
    const parse = (text: string) => {
      const r = runSchema.parse(JSON.parse(text)) as RunRecord;
      if (r.id !== id || r.events.some((event,index) => event.sequence !== index + 1 || event.id !== `${id}:${index + 1}`)) throw new Error(`Invalid run event sequence: ${id}`);
      return r;
    };
    try { return parse(await this.platform.read(path)); }
    catch (error) {
      if (!await this.platform.exists(`${path}.bak`)) throw error;
      const recovered = parse(await this.platform.read(`${path}.bak`));
      // A backup can predate an actual side effect. Never automatically replay it.
      recovered.status = 'interrupted';
      recovered.error = '运行快照损坏，已读取上一份备份；请核对实际结果后继续。';
      for (const op of Object.values(recovered.operations)) if (op.category !== 'read') op.status = 'unknown';
      const damaged = await this.platform.read(path).catch(() => '');
      if (damaged) await this.platform.write(`${path}.corrupt-${Date.now()}`, damaged);
      await this.platform.write(path, JSON.stringify(recovered));
      return recovered;
    }
  }
  async list(): Promise<RunRecord[]> {
    if (!await this.platform.exists(this.folder)) return [];
    this.warnings.length = 0;
    const listing = await this.platform.list(this.folder);
    const records: RunRecord[] = [];
    for (const file of listing.files) {
      const name = file.split('/').pop()!;
      if (!/^run-[a-zA-Z0-9-]+\.json$/.test(name)) continue;
      try { records.push(await this.load(name.slice(0, -5))); }
      catch (error) { this.warnings.push(`无法恢复 ${name}：${String(error)}`); }
    }
    return records.sort((a, b) => b.updatedAt - a.updatedAt);
  }
  async flush(): Promise<void> { await this.pending; }
}
