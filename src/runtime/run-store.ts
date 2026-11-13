import { runSchema } from './run-schema';
import type { RunRepository, RunStorageIO } from '../contracts/run-repository';
import type { RunRecord } from './types';
import { fingerprint } from './fingerprint';

export class RunRevisionConflict extends Error {
  constructor(id: string) { super(`运行 ${id} 已被其他写入者修改，请重新加载并核对，当前更改未提交。`); this.name='RunRevisionConflict'; }
}

/** Serialized file commits with optimistic revision checks; no cross-device execution lock. */
export class RunStore implements RunRepository {
  private pending: Promise<unknown> = Promise.resolve();
  private known = new Map<string,string>();
  readonly folder: string;
  readonly warnings: string[] = [];
  readonly capabilities: {safeReplace:boolean;externalChangeDetection:boolean};
  constructor(private io: RunStorageIO) {
    this.folder = `${io.getConfigDir()}/plugins/obsidian-mentat/runs`;
    this.capabilities={safeReplace:!!io.replaceFile,externalChangeDetection:true};
  }
  private path(id: string): string {
    if (!/^run-[a-zA-Z0-9-]+$/.test(id)) throw new Error('Invalid run ID');
    return `${this.folder}/${id}.json`;
  }
  private parse(id:string,text:string):RunRecord {
    const record=runSchema.parse(JSON.parse(text)) as RunRecord;
    if(record.id!==id || record.events.some((event,index)=>event.sequence!==index+1 || event.id!==`${id}:${index+1}`)) throw new Error(`Invalid run event sequence: ${id}`);
    return record;
  }
  async commit(record:RunRecord,expectedRevision:number):Promise<number> {
    await this.save(record,expectedRevision);
    return record.revision!;
  }
  /** Compatibility for existing callers; controllers use commit with an explicit revision. */
  async save(record: RunRecord, expectedRevision=record.revision || 0): Promise<void> {
    const candidate=structuredClone(record);
    candidate.revision=expectedRevision+1;
    const data=JSON.stringify(candidate.messageBase ? {...candidate,messageEncoding:'delta-v1',messages:candidate.messages.slice(candidate.messageBase.count)}:candidate);
    this.parse(record.id,data);
    const write=this.pending.catch(()=>undefined).then(async()=>{
      const segments=this.folder.split('/');
      for(let index=1;index<=segments.length;index++) {
        const folder=segments.slice(0,index).join('/');
        if(!await this.io.exists(folder)) await this.io.mkdir(folder);
      }
      const path=this.path(record.id),exists=await this.io.exists(path);
      const previous=exists ? await this.io.read(path):undefined;
      if(previous!==undefined) {
        const current=this.parse(record.id,previous);
        if((current.revision || 0)!==expectedRevision || this.known.has(record.id) && this.known.get(record.id)!==previous) throw new RunRevisionConflict(record.id);
      } else if(expectedRevision!==0 || this.known.has(record.id)) throw new RunRevisionConflict(record.id);
      const temporary=`${path}.pending`;
      await this.io.write(temporary,data);
      if(await this.io.read(temporary)!==data) throw new Error('运行临时快照回读校验失败');
      if(previous!==undefined) await this.io.write(`${path}.bak`,previous);
      // Check again after staging/backup: refuse an external edit discovered before replacement.
      if((await this.io.exists(path) ? await this.io.read(path):undefined)!==previous) throw new RunRevisionConflict(record.id);
      if(this.io.replaceFile) await this.io.replaceFile(temporary,path);
      else { await this.io.write(path,data); await this.io.delete(temporary).catch(()=>undefined); }
      if(await this.io.read(path)!==data) throw new Error('运行提交回读校验失败，请重新加载并核对快照');
      this.known.set(record.id,data);
      record.revision=candidate.revision;
    });
    this.pending=write;
    await write;
  }
  async load(id:string,ancestors=new Set<string>(),resolved=new Map<string,Promise<RunRecord>>()):Promise<RunRecord> {
    if(ancestors.has(id)) throw new Error('运行历史基线存在循环引用');
    const materialize=async(record:RunRecord):Promise<RunRecord>=>{
      if(record.messageEncoding!=='delta-v1') return record;
      const base=record.messageBase;if(!base) throw new Error('运行增量缺少基线');
      if(ancestors.has(base.runId) || base.runId===id) throw new Error('运行历史基线存在循环引用');
      let loading=resolved.get(base.runId);
      if(!loading){loading=this.load(base.runId,new Set([...ancestors,id]),resolved);resolved.set(base.runId,loading);}
      const previous=await loading;
      const prefix=previous.messages.slice(0,base.count);
      if(prefix.length!==base.count || await fingerprint(prefix)!==base.digest) throw new Error('运行历史基线已变化，请核对原始记录');
      record.messages=[...prefix,...record.messages];
      delete record.messageEncoding;return record;
    };
    const path=this.path(id);
    try {
      const text=await this.io.read(path),record=this.parse(id,text);
      const complete=await materialize(record);if(!this.known.has(id))this.known.set(id,text);return complete;
    } catch(error) {
      if(!await this.io.exists(`${path}.bak`)) throw error;
      const recovered=this.parse(id,await this.io.read(`${path}.bak`));
      recovered.status='interrupted';recovered.error='运行快照损坏，已读取上一份备份；请核对实际结果后继续。';
      for(const operation of Object.values(recovered.operations)) if(operation.category!=='read') operation.status='unknown';
      const damaged=await this.io.read(path).catch(()=>'');
      if(damaged) await this.io.write(`${path}.corrupt-${Date.now()}`,damaged);
      const restored=JSON.stringify(recovered);
      await this.io.write(`${path}.recovery`,restored);
      if(await this.io.read(`${path}.recovery`)!==restored) throw new Error('恢复快照校验失败');
      if(this.io.replaceFile) await this.io.replaceFile(`${path}.recovery`,path);
      else {await this.io.write(path,restored);await this.io.delete(`${path}.recovery`);}
      const complete=await materialize(recovered);this.known.set(id,restored);return complete;
    }
  }
  async list():Promise<RunRecord[]> {
    if(!await this.io.exists(this.folder)) return [];
    this.warnings.length=0;
    const listing=await this.io.list(this.folder),records:RunRecord[]=[],resolved=new Map<string,Promise<RunRecord>>();
    for(const file of listing.files) {
      const name=file.split('/').pop()!;
      if(!/^run-[a-zA-Z0-9-]+\.json$/.test(name)) continue;
      const id=name.slice(0,-5);
      try {let loading=resolved.get(id);if(!loading){loading=this.load(id,new Set(),resolved);resolved.set(id,loading);}records.push(await loading);}
      catch(error) {this.warnings.push(`无法恢复 ${name}：${String(error)}`);}
    }
    return records.sort((a,b)=>b.updatedAt-a.updatedAt);
  }
  async flush():Promise<void> {await this.pending;}
}
