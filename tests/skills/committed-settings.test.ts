import { adaptTestSkillContext } from '../utils/skill-context';
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('obsidian',()=>({requestUrl:vi.fn()}));
import { requestUrl } from 'obsidian';
import { z } from 'zod';
import { SkillRegistry } from '../../src/skills/core/skill-registry';
import { SkillExecutor } from '../../src/skills/core/skill-executor';
import type { SkillContext } from '../../src/skills/skill-types';
import { RunSuspended, type OperationRecord, type RunRuntime } from '../../src/runtime/types';
import { DEFAULT_SETTINGS } from '../../src/settings/settings';
import { createSkill as searchSkill } from '../../skills/web-search/scripts';
import { createSkill as fetchSkill } from '../../skills/web-fetch/scripts';

function context() {
  const source=structuredClone(DEFAULT_SETTINGS);
  source.skillConfigurations={'obsidian:write':{enabled:true,requireConfirmation:true}};
  source.braveSearchApiKey='committed-brave';source.browserlessApiKey='committed-browserless';
  const settings=structuredClone(source);
  const context={settings,plugin:{settings:source},vault:{}} as unknown as SkillContext;
  return {source,settings,context};
}
beforeEach(()=>{vi.mocked(requestUrl).mockReset();});

describe('Skills use their committed graph configuration',()=>{
  it('keeps approval required when editable settings disable it before an unsuccessful save',async()=>{
    const s=context(), registry=new SkillRegistry(), effect=vi.fn(async()=>({success:true}));
    registry.register({name:'write',namespace:'obsidian',description:'write',schema:z.object({}),metadata:{executionCategory:'write'},execute:effect});
    const executor=new SkillExecutor(registry,s.context);
    s.source.skillConfigurations!['obsidian:write'].requireConfirmation=false;
    const operations:Record<string,OperationRecord>={};
    const interact=vi.fn(async(input:any)=>{throw new RunSuspended(input);});
    const runtime={getOperation:(id:string)=>operations[id],setOperation:async(op:OperationRecord)=>{operations[op.id]=op;},interact} as unknown as RunRuntime;
    await expect(executor.execute('obsidian','write',{}, {operationId:'w',runtime})).rejects.toBeInstanceOf(RunSuspended);
    expect(interact).toHaveBeenCalledWith(expect.objectContaining({kind:'approval',operationId:'w'}));
    expect(effect).not.toHaveBeenCalled();
    expect(s.settings.skillConfigurations!['obsidian:write'].requireConfirmation).toBe(true);
  });

  it('keeps committed permission restrictions when editable settings grant additional permissions',async()=>{
    const s=context(), registry=new SkillRegistry(), effect=vi.fn(async()=>({success:true}));
    s.settings.skillConfigurations!['obsidian:write'].allowedPermissions=['read'];
    s.source.skillConfigurations!['obsidian:write'].allowedPermissions=['read','write'];
    registry.register({name:'write',namespace:'obsidian',description:'write',schema:z.object({}),metadata:{executionCategory:'write',permissions:['write']},execute:effect});
    const result=await new SkillExecutor(registry,s.context).execute('obsidian','write',{});
    expect(result.outcome).toBe('denied');expect(effect).not.toHaveBeenCalled();
  });

  it('uses committed web credentials rather than edited credentials',async()=>{
    const s=context();s.source.braveSearchApiKey='unsaved-brave';s.source.browserlessApiKey='unsaved-browserless';
    vi.mocked(requestUrl).mockResolvedValue({status:200,text:'<p>Content</p>',headers:{},json:{web:{results:[]}},arrayBuffer:new ArrayBuffer(0)});
    const search=searchSkill(s.context);expect((await search.execute(search.schema.parse({query:'test'}))).success).toBe(true);
    expect(requestUrl).toHaveBeenCalledWith(expect.objectContaining({headers:expect.objectContaining({'X-Subscription-Token':'committed-brave'})}));
    const fetch=fetchSkill(s.context);expect((await fetch.execute(fetch.schema.parse({url:'https://example.com',strategy:'browserless'}))).success).toBe(true);
    expect(requestUrl).toHaveBeenCalledWith(expect.objectContaining({url:'https://chrome.browserless.io/content?token=committed-browserless'}));
  });

  it('does not fall through to newly edited credentials when the committed value is empty',async()=>{
    const s=context();s.settings.browserlessApiKey='';s.source.browserlessApiKey='unsaved-key';
    const fetch=fetchSkill(s.context), result=await fetch.execute(fetch.schema.parse({url:'https://example.com',strategy:'browserless'}));
    expect(result.success).toBe(false);expect(requestUrl).not.toHaveBeenCalled();
  });

  it('requires an explicit adapter to import legacy host settings',async()=>{
    const s=context();delete s.context.settings;
    vi.mocked(requestUrl).mockResolvedValue({status:200,text:'content',headers:{},json:{web:{results:[]}},arrayBuffer:new ArrayBuffer(0)});
    s.source.braveSearchApiKey='legacy-key';
    const adapted=adaptTestSkillContext(s.context);
    expect('plugin' in adapted).toBe(false);
    const search=searchSkill(adapted);await search.execute(search.schema.parse({query:'test'}));
    expect(requestUrl).toHaveBeenCalledWith(expect.objectContaining({headers:expect.objectContaining({'X-Subscription-Token':'legacy-key'})}));
  });
});
