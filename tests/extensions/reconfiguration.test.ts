import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ExtensionManager } from '../../src/extensions/extension-manager';
import type { ExtensionAPI } from '../../src/extensions/extension-api';
import { EventBus } from '../../src/extensions/event-bus';
import { SkillRegistry } from '../../src/skills/core/skill-registry';
import { SkillExecutor } from '../../src/skills/core/skill-executor';
import { DEFAULT_SETTINGS } from '../../src/settings/settings';
import type { SkillDefinition } from '../../src/skills/skill-types';

function graph() {
  const skillRegistry = new SkillRegistry();
  return {skillRegistry,skillExecutor:new SkillExecutor(skillRegistry,{} as any)};
}
function fixture() {
  let current = graph();
  const bus = new EventBus();
  const manager = new ExtensionManager({} as any,current.skillRegistry,current.skillExecutor,structuredClone(DEFAULT_SETTINGS),bus,()=>current);
  const replace = () => {
    const candidate = graph();
    const validate = manager.copySkillsTo(candidate.skillRegistry); validate();
    current = candidate;
    return candidate;
  };
  return {manager,bus,replace,current:()=>current};
}
const tool = (name='extension_tool'): SkillDefinition => ({name,namespace:'custom',description:'test extension',schema:z.object({}),metadata:{executionCategory:'read'},execute:vi.fn(async()=>({success:true,data:'extension result'}))});

async function register(f:ReturnType<typeof fixture>, factory:(api:ExtensionAPI)=>void | Promise<void>) {
  f.manager.register({id:'example',name:'Example',description:'test',factory});
  await f.manager.loadAll();
}

describe('Extension declarations across chat graph replacement', () => {
  it('preserves declared tools, uses current services and does not re-run factories/listeners', async () => {
    const f = fixture(), skill=tool(), listener=vi.fn();
    let api!: ExtensionAPI;
    const factory=vi.fn((value:ExtensionAPI)=>{api=value;api.registerSkill(skill);api.on('system:status',listener);});
    await register(f,factory);
    const original=f.current(), replacement=f.replace();
    await f.manager.loadAll();
    expect(factory).toHaveBeenCalledOnce();
    expect(api.getSkillRegistry()).toBe(replacement.skillRegistry);
    expect(api.getSkillExecutor()).toBe(replacement.skillExecutor);
    expect(await api.getSkillExecutor().execute('custom','extension_tool',{})).toMatchObject({success:true,data:'extension result'});
    const later=tool('later');api.registerSkill(later);
    expect(replacement.skillRegistry.get('custom:later')).toBe(later);
    expect(original.skillRegistry.get('custom:later')).toBeUndefined();
    f.bus.emit({type:'system:status',message:'once'});expect(listener).toHaveBeenCalledOnce();
  });
  it('does not resurrect unregistered tools on another catalog replacement', async () => {
    const f=fixture();let api!:ExtensionAPI;
    await register(f,value=>{api=value;api.registerSkill(tool());});
    f.replace();api.unregisterSkill('custom','extension_tool');
    expect(f.replace().skillRegistry.get('custom:extension_tool')).toBeUndefined();
  });
  it('rejects candidate conflicts without changing the live catalog', async () => {
    const f=fixture(), skill=tool();
    await register(f,api=>api.registerSkill(skill));
    const candidate=graph();candidate.skillRegistry.register(tool());
    expect(()=>f.manager.copySkillsTo(candidate.skillRegistry)).toThrow('conflicts');
    expect(f.current().skillRegistry.get('custom:extension_tool')).toBe(skill);
  });
  it('invalidates a prepared catalog when declarations change before commit', async () => {
    const f=fixture();let api!:ExtensionAPI;
    await register(f,value=>{api=value;api.registerSkill(tool());});
    const validate=f.manager.copySkillsTo(graph().skillRegistry);
    api.unregisterSkill('custom','extension_tool');
    expect(validate).toThrow('发生变化');
  });
  it('unloads tools and listeners from the current graph', async () => {
    const f=fixture(),listener=vi.fn();
    await register(f,api=>{api.registerSkill(tool());api.on('system:status',listener);});
    f.replace();f.manager.unregister('example');
    expect(f.current().skillRegistry.get('custom:extension_tool')).toBeUndefined();
    f.bus.emit({type:'system:status',message:'unloaded'});expect(listener).not.toHaveBeenCalled();
    expect(f.replace().skillRegistry.get('custom:extension_tool')).toBeUndefined();
  });
  it('rolls back partially registered tools and subscriptions when a factory fails', async () => {
    const f=fixture(),listener=vi.fn();
    await register(f,api=>{api.registerSkill(tool());api.on('system:status',listener);throw new Error('factory failed');});
    expect(f.current().skillRegistry.get('custom:extension_tool')).toBeUndefined();
    f.bus.emit({type:'system:status',message:'failed'});expect(listener).not.toHaveBeenCalled();
    expect(f.replace().skillRegistry.get('custom:extension_tool')).toBeUndefined();
  });
});
