import { readFileSync } from 'fs';
import { SkillLoader } from '../../src/skills/core/skill-loader';
import { describe, expect, it, vi } from 'vitest';
import { parseYaml } from 'obsidian';
import { z } from 'zod';
import { MutationService } from '../../src/skills/mutations/mutation-service';
import { FileMutationPlanStore } from '../../src/skills/mutations/plan-store';
import { buildMovePlan } from '../../src/skills/mutations/move-plan';
import { SkillExecutor } from '../../src/skills/core/skill-executor';
import { SkillRegistry } from '../../src/skills/core/skill-registry';
import { fromToolOutcome, toToolOutcome } from '../../src/skills/results';
import { RunBlocked, RunSuspended } from '../../src/runtime/types';
import type { RunRuntime, OperationRecord, InteractionRequest } from '../../src/runtime/types';
import type { MutationIO, MutationPlan, SkillFile } from '../../src/contracts/tools';
import type { SkillContext, SkillDefinition } from '../../src/skills/skill-types';
import { MemoryPlatformAdapter } from '../utils/memory-platform-adapter';
import * as Batch from '../../skills/batch-operation/scripts';
import * as Write from '../../skills/write-note/scripts';
import * as Edit from '../../skills/edit-note/scripts';
import * as Move from '../../skills/move-note/scripts';

function fixture(initial:Record<string,string>={}) {
  const files=new Map(Object.entries(initial)), disk=new MemoryPlatformAdapter();
  const ref=(path:string):SkillFile=>({path,name:path.split('/').pop()!,basename:path.split('/').pop()!.replace(/\.[^.]+$/,''),extension:path.split('.').pop()!,stat:{mtime:1,ctime:1,size:files.get(path)?.length||0}});
  const io:MutationIO={read:async path=>files.get(path)??null,exists:async path=>files.has(path),listMarkdown:async()=>[...files.keys()].filter(p=>p.endsWith('.md')),
    write:vi.fn(async(path,text)=>{files.set(path,text);}),move:vi.fn(async(from,to)=>{const text=files.get(from);if(text===undefined)throw Error('missing');files.delete(from);files.set(to,text);}),
    resolveLink:(link,source)=>{
      const directory=source.split('/').slice(0,-1);
      const parts=[...directory,...link.split('/')],relative:string[]=[];for(const part of parts){if(part==='..')relative.pop();else if(part&&part!=='.')relative.push(part);}
      const direct=[link,`${link}.md`,relative.join('/'),`${relative.join('/')}.md`].find(p=>files.has(p));
      if(direct)return direct;const matching=[...files.keys()].filter(p=>p.split('/').pop()!.replace(/\.md$/,'')===link.replace(/\.md$/,''));return matching.length===1?matching[0]:null;
    }};
  const store=new FileMutationPlanStore(disk,'.obsidian/mutation-plans');
  const context:SkillContext={files:{getAbstractFileByPath:path=>files.has(path)?ref(path):null,getMarkdownFiles:()=>[...files.keys()].filter(p=>p.endsWith('.md')).map(ref),read:async file=>files.get(file.path)!},
    metadataCache:{getFileCache:file=>{const match=files.get(file.path)?.match(/^---\n([\s\S]*?)\n---/);return match?{frontmatter:parseYaml(match[1])}:{};}},mutations:new MutationService(io,store)};
  const operations=new Map<string,OperationRecord>(),requests=new Map<string,InteractionRequest>(),record=vi.fn(async()=>{});
  const runtime={runId:'run-test',sessionId:'test',scope:'',getOperation:(id:string)=>operations.get(id),setOperation:async(op:OperationRecord)=>{operations.set(op.id,op);},record,
    interact:async(request:InteractionRequest)=>{const previous=requests.get(request.id);if(previous?.outcome&&previous.fingerprint===request.fingerprint)return previous.outcome;requests.set(request.id,request);throw new RunSuspended(request);}} as unknown as RunRuntime;
  const registry=new SkillRegistry(),executor=new SkillExecutor(registry,context);
  const bind=(impl:any)=>{
    const definition:SkillDefinition={name:impl.metadata.name,namespace:'obsidian',description:impl.metadata.description,schema:impl.schema,metadata:impl.metadata,
      prepare:(input,options)=>impl.prepare(input,{...context,...options}),execute:(input,options)=>impl.execute(input,{...context,...options})};registry.register(definition);
  };
  const approve=(id='op')=>{requests.get(`${id}:approval`)!.outcome={kind:'approved'};};
  return {files,disk,io,store,context,runtime,registry,executor,operations,requests,record,bind,approve};
}
const batchInput=()=>Batch.schema.parse({operation:'append-content',filter:{folders:['Notes']},params:{content:'approved addition'}});

describe('Shared mutation host contract',()=>{
  it('loads real shipped manifests with prepared handlers and executes them through the same host',async()=>{
    const f=fixture({'a.md':'before'}),base='.obsidian/plugins/mentat/skills';
    for(const dir of ['write-note','edit-note','batch-operation','move-note']){
      f.disk.addFile(`${base}/${dir}/SKILL.md`,readFileSync(`skills/${dir}/SKILL.md`,'utf8'));
    }
    f.disk.directories.add(base);
    const io={getConfigDir:()=>'.obsidian',exists:f.disk.exists.bind(f.disk),read:f.disk.read.bind(f.disk),list:async(path:string)=>{
      const value=await f.disk.list(path);return {files:value.files.map(name=>`${path}/${name}`),folders:value.folders.map(name=>`${path}/${name}`)};
    }};
    const loaded=await new SkillLoader(io).loadAllSkills(f.context,{strict:true});
    expect(loaded).toHaveLength(4);expect(loaded.every(skill=>'prepare' in skill&&typeof skill.prepare==='function')).toBe(true);
    f.registry.registerBulk(loaded);
    const input=Edit.schema.parse({path:'a.md',old_string:'before',new_string:'after'});
    await expect(f.executor.execute('obsidian','edit_note',input,{runtime:f.runtime,operationId:'op'})).rejects.toBeInstanceOf(RunSuspended);f.approve();
    expect((await f.executor.execute('obsidian','edit_note',input,{runtime:f.runtime,operationId:'op'})).success).toBe(true);expect(f.files.get('a.md')).toBe('after');
  });
  it('persists and freezes the approved batch target set even when a matching file appears later',async()=>{
    const f=fixture({'Notes/a.md':'before'});f.bind(Batch);
    await expect(f.executor.execute('obsidian','batch_operation',batchInput(),{runtime:f.runtime,operationId:'op'})).rejects.toBeInstanceOf(RunSuspended);
    expect(f.disk.files.size).toBe(1);expect(f.io.write).not.toHaveBeenCalled();
    expect(f.requests.get('op:approval')?.context).toContain('Notes/a.md');
    f.files.set('Notes/new.md','unapproved');f.approve();
    const result=await f.executor.execute('obsidian','batch_operation',batchInput(),{runtime:f.runtime,operationId:'op'});
    expect(result.success).toBe(true);expect(f.files.get('Notes/a.md')).toContain('approved addition');expect(f.files.get('Notes/new.md')).toBe('unapproved');
    expect(f.io.write).toHaveBeenCalledOnce();
  });
  it('invalidates a stale plan before side effects and requires a new approval fingerprint',async()=>{
    const f=fixture({'Notes/a.md':'before'});f.bind(Batch);
    await expect(f.executor.execute('obsidian','batch_operation',batchInput(),{runtime:f.runtime,operationId:'op'})).rejects.toBeInstanceOf(RunSuspended);
    const previousFingerprint=f.requests.get('op:approval')!.fingerprint;f.approve();f.files.set('Notes/a.md','external edit');
    await expect(f.executor.execute('obsidian','batch_operation',batchInput(),{runtime:f.runtime,operationId:'op'})).rejects.toBeInstanceOf(RunBlocked);
    expect(f.io.write).not.toHaveBeenCalled();expect(f.files.get('Notes/a.md')).toBe('external edit');
    await expect(f.executor.execute('obsidian','batch_operation',batchInput(),{runtime:f.runtime,operationId:'op'})).rejects.toBeInstanceOf(RunSuspended);
    expect(f.requests.get('op:approval')!.fingerprint).not.toBe(previousFingerprint);
    f.approve();expect((await f.executor.execute('obsidian','batch_operation',batchInput(),{runtime:f.runtime,operationId:'op'})).success).toBe(true);
    expect(f.files.get('Notes/a.md')).toBe('external edit\n\napproved addition');
  });
  it('recovers the same prepared target set after constructing a new service instance',async()=>{
    const f=fixture({'Notes/a.md':'before'}),invocation={runtime:f.runtime,operationId:'op'};
    const plan=await Batch.prepare(batchInput(),{...f.context,...invocation});
    f.files.set('Notes/new.md','new');f.context.mutations=new MutationService(f.io,new FileMutationPlanStore(f.disk,'.obsidian/mutation-plans'));
    const recovered=await Batch.prepare(batchInput(),{...f.context,...invocation});
    expect(recovered).toEqual(plan);expect(recovered.changes).toHaveLength(1);
  });
  it('keeps unknown write results unknown and does not continue with later files',async()=>{
    const f=fixture({'a.md':'a','b.md':'b'}),service=f.context.mutations!;
    const plan=await service.prepare('test',{},async()=>({summary:'two',changes:[await service.writeChange('a.md','A','a'),await service.writeChange('b.md','B','b')]}));
    vi.mocked(f.io.write).mockImplementationOnce(async(path,text)=>{f.files.set(path,text);throw Error('transport lost after write');});
    const result=await service.apply(plan);
    expect(result.outcome).toBe('unknown');expect(result.items).toHaveLength(2);expect(result.items?.[0].outcome).toBe('unknown');
    expect(f.files.get('a.md')).toBe('A');expect(f.files.get('b.md')).toBe('b');
  });
  it('returns partial with verified successes when a later file changes before its write starts',async()=>{
    const f=fixture({'a.md':'a','b.md':'b'}),service=f.context.mutations!;
    const plan=await service.prepare('test',{},async()=>({summary:'two',changes:[await service.writeChange('a.md','A','a'),await service.writeChange('b.md','B','b')]}));
    vi.mocked(f.io.write).mockImplementationOnce(async(path,text)=>{f.files.set(path,text);f.files.set('b.md','external');});
    const result=await service.apply(plan);
    expect(result.outcome).toBe('partial');expect(result.data?.filesModified).toEqual(['a.md']);expect(f.files.get('b.md')).toBe('external');
  });
  it('rejects concurrent stale writes through the shared host writer',async()=>{
    const f=fixture({'a.md':'before'}),service=f.context.mutations!;
    const first=await service.prepare('one',{},async()=>({summary:'one',changes:[await service.writeChange('a.md','first','before')]}));
    const second=await service.prepare('two',{},async()=>({summary:'two',changes:[await service.writeChange('a.md','second','before')]}));
    const results=await Promise.allSettled([service.apply(first),service.apply(second)]);
    expect(results[0].status).toBe('fulfilled');expect(results[1].status).toBe('rejected');expect(f.files.get('a.md')).toBe('first');
  });
  it('refuses corrupted plan storage and operation-ID reuse without writing files',async()=>{
    const f=fixture({'a.md':'before'}),service=f.context.mutations!,invocation={runtime:f.runtime,operationId:'op'};
    const plan=await service.prepare('write',{content:'one'},async()=>({summary:'write',changes:[await service.writeChange('a.md','one','before')]}),invocation);
    await expect(service.prepare('write',{content:'two'},async()=>({summary:'never',changes:[]}),invocation)).rejects.toBeInstanceOf(RunBlocked);
    const staged=[...f.disk.files.keys()][0];await f.disk.write(staged,JSON.stringify({...plan,summary:'tampered'}));
    await expect(service.prepare('write',{content:'one'},async()=>({summary:'never',changes:[]}),invocation)).rejects.toThrow('checksum');
    expect(f.io.write).not.toHaveBeenCalled();
  });
  it.each([
    ['write_note',Write,()=>Write.schema.parse({path:'a.md',content:'after'})],
    ['edit_note',Edit,()=>Edit.schema.parse({path:'a.md',old_string:'before',new_string:'after'})],
    ['batch_operation',Batch,()=>Batch.schema.parse({operation:'append-content',filter:{paths:['a.md']},params:{content:'after'}})],
    ['move_note',Move,()=>Move.schema.parse({path:'a.md',new_path:'b.md'})],
  ] as const)('uses prepare/approval/apply/readback for %s',async(name,impl,input)=>{
    const f=fixture({'a.md':'before'});f.bind(impl);
    await expect(f.executor.execute('obsidian',name,input(),{runtime:f.runtime,operationId:'op'})).rejects.toBeInstanceOf(RunSuspended);
    expect(f.io.write).not.toHaveBeenCalled();expect(f.io.move).not.toHaveBeenCalled();f.approve();
    expect((await f.executor.execute('obsidian',name,input(),{runtime:f.runtime,operationId:'op'})).success).toBe(true);
    expect(f.record).toHaveBeenCalledWith('artifact:verified',expect.objectContaining({planId:expect.any(String)}),'op');
  });
  it('freezes move destinations and explicit wiki/markdown backlinks, leaving code examples intact',async()=>{
    const f=fixture({'Old/a.md':'before','Notes/ref.md':'![[Old/a#Section|Alias]]\n[read](../Old/a.md#Section)\n`[[Old/a]]`\n```\n[[Old/a]]\n```'}),service=f.context.mutations!;
    const plan=await service.prepare('move',{},()=>buildMovePlan(service,'Old/a.md','New/a.md'));
    expect(plan.changes.map(c=>c.path)).toEqual(['Old/a.md','Notes/ref.md']);
    expect((await service.apply(plan)).outcome).toBe('success');
    expect(f.files.has('Old/a.md')).toBe(false);expect(f.files.get('New/a.md')).toBe('before');
    expect(f.files.get('Notes/ref.md')).toContain('![[New/a.md#Section|Alias]]');expect(f.files.get('Notes/ref.md')).toContain('[read](../New/a.md#Section)');
    expect(f.files.get('Notes/ref.md')).toContain('`[[Old/a]]`\n```\n[[Old/a]]\n```');
  });
  it('rewrites outgoing relative links in moved markdown and reports unresolved links as partial',async()=>{
    const f=fixture({'Old/a.md':'[out](../refs/b.md)\n[[Missing]]','refs/b.md':'target'}),service=f.context.mutations!;
    const plan=await service.prepare('move',{},()=>buildMovePlan(service,'Old/a.md','New/deep/a.md'));
    const result=await service.apply(plan);expect(result.outcome).toBe('partial');
    expect(f.files.get('New/deep/a.md')).toContain('[out](../../refs/b.md)');expect(result.warnings?.[0]).toContain('Missing');
  });
  it('blocks a move when a backlink version changes after approval',async()=>{
    const f=fixture({'a.md':'before','ref.md':'[[a]]'}),service=f.context.mutations!;
    const plan=await service.prepare('move',{},()=>buildMovePlan(service,'a.md','b.md'));f.files.set('ref.md','external');
    await expect(service.apply(plan)).rejects.toBeInstanceOf(RunBlocked);expect(f.io.move).not.toHaveBeenCalled();
  });
  it('resumes a partially applied append plan without appending successful items twice',async()=>{
    const f=fixture({'Notes/a.md':'a','Notes/b.md':'b'}),invocation={runtime:f.runtime,operationId:'op'};
    const plan=await Batch.prepare(batchInput(),{...f.context,...invocation});
    const write=f.io.write;
    vi.mocked(write).mockImplementationOnce(async(path,text)=>{f.files.set(path,text);}).mockRejectedValueOnce(new Error('unknown second write'));
    expect((await f.context.mutations!.apply(plan,invocation)).outcome).toBe('unknown');
    const appendOnce=f.files.get('Notes/a.md');
    const recovered=new MutationService(f.io,new FileMutationPlanStore(f.disk,'.obsidian/mutation-plans'));
    const frozen=await recovered.prepare('obsidian:batch_operation',batchInput(),async()=>{throw new Error('must not replan');},invocation);
    const result=await recovered.apply(frozen,invocation);
    expect(result.outcome).toBe('success');expect(f.files.get('Notes/a.md')).toBe(appendOnce);
    expect(result.items?.[0].disposition).toBe('already_satisfied');expect(write).toHaveBeenCalledTimes(3);
  });
  it('keeps the original plan evidence when a completed item coexists with a remaining conflict',async()=>{
    const f=fixture({'Notes/a.md':'a','Notes/b.md':'b'}),invocation={runtime:f.runtime,operationId:'op'};
    const plan=await Batch.prepare(batchInput(),{...f.context,...invocation});
    f.files.set('Notes/a.md',(plan.changes[0] as any).content);f.files.set('Notes/b.md','external edit');
    await expect(f.context.mutations!.apply(plan,invocation)).rejects.toThrow('已有完成项');
    const loaded=await Batch.prepare(batchInput(),{...f.context,...invocation});expect(loaded.id).toBe(plan.id);
    expect(f.io.write).not.toHaveBeenCalled();
  });
  it('resumes a move and its backlinks without repeating the completed rename',async()=>{
    const f=fixture({'Old/a.md':'a','ref.md':'[[Old/a]]'}),invocation={runtime:f.runtime,operationId:'op'},service=f.context.mutations!;
    const plan=await service.prepare('move',{},()=>buildMovePlan(service,'Old/a.md','New/a.md'),invocation);
    vi.mocked(f.io.write).mockRejectedValueOnce(new Error('unknown backlink write'));
    expect((await service.apply(plan,invocation)).outcome).toBe('unknown');
    const restarted=new MutationService(f.io,f.store),frozen=await restarted.prepare('move',{},async()=>{throw Error('must not replan');},invocation);
    expect((await restarted.apply(frozen,invocation)).outcome).toBe('success');expect(f.io.move).toHaveBeenCalledOnce();expect(f.files.get('ref.md')).toBe('[[New/a.md]]');
  });
  it('continues an interrupted moved-note content update without repeating the rename',async()=>{
    const f=fixture({'Old/a.md':'[out](../refs/b.md)','refs/b.md':'b'}),invocation={runtime:f.runtime,operationId:'op'},service=f.context.mutations!;
    const plan=await service.prepare('move',{},()=>buildMovePlan(service,'Old/a.md','New/deep/a.md'),invocation);
    vi.mocked(f.io.write).mockRejectedValueOnce(new Error('content write interrupted after rename'));
    expect((await service.apply(plan,invocation)).outcome).toBe('unknown');expect(f.files.has('Old/a.md')).toBe(false);
    const restarted=new MutationService(f.io,f.store);
    expect((await restarted.apply(plan,invocation)).outcome).toBe('success');expect(f.io.move).toHaveBeenCalledOnce();
    expect(f.files.get('New/deep/a.md')).toBe('[out](../../refs/b.md)');
  });
  it('records a resolved unknown effect as an unknown operation rather than finished',async()=>{
    const f=fixture({'a.md':'before'});f.bind(Write);
    const input=Write.schema.parse({path:'a.md',content:'after'});
    await expect(f.executor.execute('obsidian','write_note',input,{runtime:f.runtime,operationId:'op'})).rejects.toBeInstanceOf(RunSuspended);f.approve();
    vi.mocked(f.io.write).mockRejectedValueOnce(new Error('connection lost'));
    const result=await f.executor.execute('obsidian','write_note',input,{runtime:f.runtime,operationId:'op'});
    expect(result.outcome).toBe('unknown');expect(f.operations.get('op')?.status).toBe('unknown');
  });
  it('exposes a narrow catalog and canonical result adapter without contradictory success flags',async()=>{
    const f=fixture();f.registry.register({name:'read',namespace:'custom',description:'read',schema:z.object({limit:z.number().int()}),metadata:{executionCategory:'read'},execute:async()=>({success:true,data:'ok'})});
    expect(f.registry.listTools()[0]).toMatchObject({id:'custom:read',effect:'read'});
    expect((await f.executor.invoke({toolId:'custom:read',input:{limit:1}})).outcome).toBe('success');
    expect((await f.executor.invoke({toolId:'custom:read',input:{limit:'invalid'}})).outcome).toBe('failure');
    expect(toToolOutcome({success:true,data:{filesModified:['a'],errors:[{path:'b'}]}}).outcome).toBe('partial');
    expect(fromToolOutcome({outcome:'partial',error:'some failed'}).success).toBe(false);
    expect(toToolOutcome({success:true,outcome:'unknown'}).outcome).toBe('unknown');
  });
  it('fails closed when legacy approval arguments reference paths without a file-reader capability',async()=>{
    const registry=new SkillRegistry(),effect=vi.fn(async()=>({success:true}));
    registry.register({name:'legacy',namespace:'custom',description:'legacy',schema:z.object({path:z.string()}),metadata:{requiresConfirmation:true,executionCategory:'external'},execute:effect});
    const result=await new SkillExecutor(registry,{} as SkillContext).execute('custom','legacy',{path:'a.md'});
    expect(result.success).toBe(false);expect(result.error).toContain('file reader');expect(effect).not.toHaveBeenCalled();
  });
});
