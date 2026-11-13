import { describe, expect, it, vi } from 'vitest';
vi.mock('obsidian');
import MentatPlugin from '../../src/main';
import type { MentatSettings } from '../../src/settings/settings';
import { Notice } from 'obsidian';

async function fixture() {
  let persisted:Record<string,unknown>={maxTurns:20,chatTheme:'bubble'};
  const order:string[]=[];
  const oldRouter={prepare:vi.fn((_settings:MentatSettings)=>{order.push('prepare router');return candidateRouter;})};
  const candidateRouter={name:'candidate',prepare:vi.fn((_settings:MentatSettings)=>{order.push('prepare router');return candidateRouter;})};
  const commit=vi.fn(()=>{order.push('commit graph');}),rollback=vi.fn();
  const view={switchTheme:vi.fn(async()=>{}),updateTerminalPreset:vi.fn()};
  const plugin:any={loadData:async()=>structuredClone(persisted),
    saveData:vi.fn(async(next:MentatSettings)=>{order.push('persist');persisted=structuredClone(next);}),
    aiRouter:oldRouter,runController:{hasUnsettledWork:vi.fn(()=>false)},
    chatOrchestrator:{prepareProviderRefresh:vi.fn(async()=>{order.push('prepare graph');return {commit,rollback};})},
    app:{workspace:{getLeavesOfType:()=>[{view}]}},observer:{error:vi.fn()}};
  await MentatPlugin.prototype.loadSettings.call(plugin);
  const settings=plugin.settings;
  const save=()=>MentatPlugin.prototype.saveSettings.call(plugin);
  return {plugin,save,settings,oldRouter,candidateRouter,commit,rollback,order,view,data:()=>persisted};
}

describe('Settings configuration transaction',()=>{
  it('prepares, persists and commits in order while retaining the settings object identity',async()=>{
    const s=await fixture();s.settings.maxTurns=42;
    await s.save();
    expect(s.order).toEqual(['prepare router','prepare graph','persist','commit graph']);
    expect(s.plugin.aiRouter).toBe(s.candidateRouter);expect(s.plugin.settings).toBe(s.settings);
    expect(s.data().maxTurns).toBe(42);expect(s.settings.maxTurns).toBe(42);
  });
  it('rejects execution edits before saving when work is unsettled and restores the successful configuration in place',async()=>{
    const s=await fixture();s.plugin.runController.hasUnsettledWork.mockReturnValue(true);s.settings.maxTurns=42;
    await expect(s.save()).rejects.toThrow('未结束');
    expect(Notice).toHaveBeenCalledWith('配置未应用：当前还有未结束或未确认的运行，请先处理后再修改执行配置。');
    expect(s.plugin.saveData).not.toHaveBeenCalled();expect(s.oldRouter.prepare).not.toHaveBeenCalled();
    expect(s.plugin.settings).toBe(s.settings);expect(s.settings.maxTurns).toBe(20);expect(s.data().maxTurns).toBe(20);
  });
  it('saves presentation edits during a run without rebuilding or replacing providers',async()=>{
    const s=await fixture();s.plugin.runController.hasUnsettledWork.mockReturnValue(true);s.settings.chatTheme='terminal';
    await s.save();
    expect(s.oldRouter.prepare).not.toHaveBeenCalled();expect(s.plugin.chatOrchestrator.prepareProviderRefresh).not.toHaveBeenCalled();
    expect(s.plugin.aiRouter).toBe(s.oldRouter);expect(s.data().chatTheme).toBe('terminal');
    expect(s.view.switchTheme).toHaveBeenCalledWith('terminal');
  });
  it('explicitly reports that saved MCP connection changes require a reload',async()=>{
    const s=await fixture();s.settings.mcpServers=[{id:'local',command:'example-server',enabled:true}];
    vi.mocked(Notice).mockClear();
    await s.save();
    expect(Notice).toHaveBeenCalledWith('MCP连接配置已保存，重载插件后生效；当前连接暂保持原配置。');
    expect(s.data().mcpServers).toEqual(s.settings.mcpServers);
  });
  it('keeps live providers and persisted settings when candidate construction fails',async()=>{
    const s=await fixture();s.plugin.chatOrchestrator.prepareProviderRefresh.mockRejectedValue(new Error('invalid graph'));s.settings.maxTurns=42;
    await expect(s.save()).rejects.toThrow('invalid graph');
    expect(s.plugin.saveData).not.toHaveBeenCalled();expect(s.plugin.aiRouter).toBe(s.oldRouter);
    expect(s.settings.maxTurns).toBe(20);expect(s.commit).not.toHaveBeenCalled();
  });
  it('discards a prepared candidate before persistence if a run starts during preparation',async()=>{
    const s=await fixture();s.settings.maxTurns=42;
    s.plugin.runController.hasUnsettledWork.mockReturnValueOnce(false).mockReturnValueOnce(true);
    await expect(s.save()).rejects.toThrow('运行状态已变化');
    expect(s.rollback).toHaveBeenCalledOnce();expect(s.plugin.saveData).not.toHaveBeenCalled();
    expect(s.plugin.aiRouter).toBe(s.oldRouter);expect(s.settings.maxTurns).toBe(20);
  });
  it('releases the prepared graph and restores the old configuration after a storage failure',async()=>{
    const s=await fixture();s.plugin.saveData.mockRejectedValueOnce(new Error('disk full'));s.settings.maxTurns=42;
    await expect(s.save()).rejects.toThrow('disk full');
    expect(s.rollback).toHaveBeenCalledOnce();expect(s.commit).not.toHaveBeenCalled();
    expect(s.plugin.aiRouter).toBe(s.oldRouter);expect(s.settings.maxTurns).toBe(20);expect(s.data().maxTurns).toBe(20);
    expect(s.plugin.saveData).toHaveBeenCalledTimes(2);
  });
  it('restores persisted settings if a final commit guard detects changed runtime state',async()=>{
    const s=await fixture();s.commit.mockImplementationOnce(()=>{throw new Error('runtime changed');});s.settings.maxTurns=42;
    await expect(s.save()).rejects.toThrow('runtime changed');
    expect(s.rollback).toHaveBeenCalledOnce();expect(s.plugin.aiRouter).toBe(s.oldRouter);
    expect(s.settings.maxTurns).toBe(20);expect(s.data().maxTurns).toBe(20);
  });
  it('reports a failed disk rollback while keeping the prior in-memory configuration',async()=>{
    const s=await fixture();s.settings.maxTurns=42;
    s.plugin.saveData.mockRejectedValueOnce(new Error('write failed')).mockRejectedValueOnce(new Error('restore failed'));
    await expect(s.save()).rejects.toThrow('write failed');
    expect(s.plugin.observer.error).toHaveBeenCalledWith('settings:rollback:failed',expect.objectContaining({message:'restore failed'}),{component:'settings'});
    expect(s.settings.maxTurns).toBe(20);expect(s.plugin.aiRouter).toBe(s.oldRouter);
  });
  it('serializes overlapping saves and captures each requested configuration before asynchronous work',async()=>{
    const s=await fixture();let release!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;});
    s.plugin.chatOrchestrator.prepareProviderRefresh.mockImplementationOnce(async()=>{await gate;return {commit:s.commit,rollback:s.rollback};});
    s.settings.maxTurns=42;const first=s.save();
    s.settings.maxTurns=43;const second=s.save();
    release();await Promise.all([first,second]);
    expect(s.plugin.chatOrchestrator.prepareProviderRefresh.mock.calls.map((call:any[])=>call[1].maxTurns)).toEqual([42,43]);
    expect(s.data().maxTurns).toBe(43);
    expect(s.plugin.settings).toBe(s.settings);expect(s.settings.maxTurns).toBe(43);
  });
});
