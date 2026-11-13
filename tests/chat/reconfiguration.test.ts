import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ChatOrchestrator, type ChatOrchestratorOptions } from '../../src/chat/chat-orchestrator';
import { createEngineFactory } from '../../src/agents/engine-factory';
import { ExtensionManager, type ExtensionAPI } from '../../src/extensions/extension-manager';
import { DEFAULT_SETTINGS } from '../../src/settings/settings';
import { MemoryPlatformAdapter } from '../utils/memory-platform-adapter';
import type { AIRouter } from '../../src/providers/ai-router';
import type { AIProvider } from '../../src/types';
import type { App } from 'obsidian';

function provider(id: string): AIProvider {
  return {
    id, name: id, type: 'openai', supportsSkills: () => false,
    getContextWindow: () => 32000, getCompactionThreshold: () => .8, getMaxOutputTokens: () => 4096,
    generateStream: vi.fn(async (_prompt, chunk) => { chunk(id); }),
    generate: vi.fn(async () => id),
  } as unknown as AIProvider;
}
function routerFor(value: AIProvider | null): AIRouter {
  return { getProvider: vi.fn(async () => value) } as unknown as AIRouter;
}
async function setup(options: ChatOrchestratorOptions = {}) {
  const platform = new MemoryPlatformAdapter();
  const base = '.obsidian/plugins/mentat/skills';
  platform.directories.add(base);
  platform.addFile(`${base}/read/SKILL.md`, '---\nname: read_note\ndescription: Read one note\nmetadata:\n  executable: true\n---\nRead the note.');
  platform.addFile('Mentat/Config/agents/custom.json', JSON.stringify({ id:'custom-agent', name:'Custom', description:'custom', enableSkills:false }));
  platform.directories.add('Mentat/Config/agents');
  const list = platform.list.bind(platform);
  platform.list = async path => {
    const value = await list(path);
    return { files:value.files.map(file=>`${path}/${file}`), folders:value.folders.map(folder=>`${path}/${folder}`) };
  };
  const app = { vault:{ ...platform.getVault(), configDir:'.obsidian', adapter:{ exists:platform.exists.bind(platform), list:platform.list.bind(platform), read:platform.read.bind(platform) } } } as unknown as App;
  platform.getApp = () => app;
  const oldProvider = provider('old'), router = routerFor(oldProvider);
  let allowed = true;
  const editableSettings = structuredClone(DEFAULT_SETTINGS);
  const dependencies = new WeakMap<object, any>();
  const makeEngine = createEngineFactory();
  const engineFactory: NonNullable<ChatOrchestratorOptions['engineFactory']> = (config, provider, deps, id) => {
    const engine = makeEngine(config, provider, deps, id); dependencies.set(engine, deps); return engine;
  };
  const orchestrator = new ChatOrchestrator(platform, editableSettings, router, {} as any, undefined, {canReconfigure:()=>allowed,engineFactory,...options});
  await orchestrator.refreshProvider();
  return {orchestrator,dependencies,platform,router,oldProvider,editableSettings,setAllowed:(value:boolean)=>{allowed=value;},base};
}
const context = () => ({ messages:[],sessionId:'test',metadata:{enableSkills:false,sessionContextPayload:'context'} });

async function askAll(orchestrator: ChatOrchestrator, expected: string) {
  const manager = orchestrator.getAgentManager();
  for (const id of ['default-chat-agent','writer-agent','reviewer-agent','custom-agent']) {
    const result = await manager.execute(id,'hello',context());
    expect(result.content).toBe(expected);
  }
}

describe('Atomic chat dependency reconfiguration', () => {
  it('rebuilds every agent against one new provider/registry/executor and keeps the manager facade', async () => {
    const {orchestrator,oldProvider,dependencies} = await setup();
    const manager = orchestrator.getAgentManager(), registry = orchestrator.getSkillRegistry();
    orchestrator.getSkillCache().set('old','stale detail');
    const replacement = provider('new');
    const prepared = await orchestrator.prepareProviderRefresh(routerFor(replacement));
    expect(orchestrator.getSkillRegistry()).toBe(registry);
    await expect(orchestrator.sendMessage('during prepare')).rejects.toThrow('维护');
    prepared.commit();
    expect(orchestrator.getAgentManager()).toBe(manager);
    expect(orchestrator.getSkillRegistry()).not.toBe(registry);
    expect(orchestrator.getSkillCache().get('old')).toBeNull();
    for (const agent of manager.listAgents()) {
      expect(dependencies.get(agent).skillRegistry).toBe(orchestrator.getSkillRegistry());
      expect(dependencies.get(agent).skillExecutor).toBe(orchestrator.getSkillExecutor());
    }
    await askAll(orchestrator,'new');
    expect(oldProvider.generateStream).not.toHaveBeenCalled();
    const delegate = orchestrator.getSkillRegistry().get('obsidian:delegate_task') as any;
    expect((await delegate.execute({agentId:'custom-agent',prompt:'hello'})).data).toBe('new');
    const spawn = orchestrator.getSkillRegistry().get('obsidian:spawn_subagent') as any;
    expect((await spawn.execute({name:'temporary',systemPrompt:'role',prompt:'hello'})).data).toBe('new');
    expect(manager.listAgents()).toHaveLength(4);
  });
  it('retains MCP clients, copies their tools and binds later disconnects to the live registry', async () => {
    const {orchestrator} = await setup();
    const mcp = orchestrator.getMCPManager(), invoke = vi.fn(async input=>({success:true,data:input}));
    let connected = true;
    const disconnect = vi.fn(async()=>{connected=false;});
    const tool = {name:'echo',namespace:'mcp',description:'echo',schema:z.object({text:z.string()}),execute:invoke};
    (mcp as any).clients.set('server',{isConnected:()=>connected,toSkillDefinitions:()=>connected?[tool]:[],disconnect});
    await orchestrator.reloadSkills();
    expect(orchestrator.getMCPManager()).toBe(mcp);
    const result = await orchestrator.getSkillExecutor().execute('mcp','server:echo',{text:'fresh'});
    expect(result.data).toEqual({text:'fresh'}); expect(invoke).toHaveBeenCalledOnce();
    expect(disconnect).not.toHaveBeenCalled();
    await mcp.removeServer('server');
    expect(orchestrator.getSkillRegistry().has('mcp','server:echo')).toBe(false);
  });
  it('keeps the complete old graph when strict manifest or custom-agent validation fails', async () => {
    const {orchestrator,platform,base} = await setup();
    const registry = orchestrator.getSkillRegistry(), executor = orchestrator.getSkillExecutor(), agent = orchestrator.getDefaultAgent();
    platform.addFile(`${base}/read/SKILL.md`,'---\nname: read_note\ndescription: invalid\nmetadata:\n  requiresConfirmation: "false"\n---\ntext');
    await expect(orchestrator.reloadSkills()).rejects.toThrow('Cannot load skill');
    expect(orchestrator.getSkillRegistry()).toBe(registry); expect(orchestrator.getSkillExecutor()).toBe(executor); expect(orchestrator.getDefaultAgent()).toBe(agent);
    platform.addFile(`${base}/read/SKILL.md`,'---\nname: read_note\ndescription: read\n---\ntext');
    platform.addFile('Mentat/Config/agents/custom.json',JSON.stringify({id:'writer-agent',name:'collision'}));
    await expect(orchestrator.refreshProvider()).rejects.toThrow('duplicate custom agent');
    expect(orchestrator.getSkillRegistry()).toBe(registry);
    await askAll(orchestrator,'old');
  });
  it('blocks reconfiguration for unsettled runtime work and checks again before commit', async () => {
    const {orchestrator,setAllowed} = await setup();
    const agent = orchestrator.getDefaultAgent();
    setAllowed(false); await expect(orchestrator.reloadSkills()).rejects.toThrow('未结束');
    setAllowed(true); const prepared = await orchestrator.prepareProviderRefresh(routerFor(provider('new')));
    setAllowed(false); expect(()=>prepared.commit()).toThrow('未结束'); prepared.rollback();
    expect(orchestrator.getDefaultAgent()).toBe(agent);
    setAllowed(true); await orchestrator.reloadSkills();
  });
  it('releases the maintenance gate after settings persistence rollback and does not keep a disabled provider', async () => {
    const {orchestrator} = await setup();
    const agent = orchestrator.getDefaultAgent();
    const prepared = await orchestrator.prepareProviderRefresh(routerFor(provider('new')));
    prepared.rollback(); expect(orchestrator.getDefaultAgent()).toBe(agent);
    await orchestrator.sendMessage('after rollback',{context:context(),enableSkills:false});
    const disabled = await orchestrator.prepareProviderRefresh(routerFor(null)); disabled.commit();
    expect(orchestrator.getDefaultAgent()).toBeNull();
    expect(orchestrator.getAgentManager().listAgents()).toEqual([]);
    await expect(orchestrator.sendMessage('no provider')).rejects.toThrow('配置 AI');
  });
  it('binds the committed settings snapshot and avoids file writes while preparing a new folder', async () => {
    const {orchestrator,platform} = await setup();
    const requested = {...structuredClone(DEFAULT_SETTINGS),userConfigFolder:'Candidate/Config'};
    const write = vi.spyOn(platform,'write');
    const prepared = await orchestrator.prepareProviderRefresh(routerFor(provider('new')),requested);
    expect(write).not.toHaveBeenCalled();
    platform.addFile('Candidate/Config/user-preferences.md','new configured preferences');
    prepared.commit();
    expect(await orchestrator.getUserPreferences()).toBe('new configured preferences');
  });
  it('isolates live tool settings from editable input and from later changes to a prepared snapshot', async () => {
    const {orchestrator,editableSettings} = await setup();
    const original = orchestrator.getSkillExecutor().getContext().settings!;
    editableSettings.skillConfigurations = { 'obsidian:read_note': {requireConfirmation:false} };
    expect(original.skillConfigurations).not.toEqual(editableSettings.skillConfigurations);
    const requested = structuredClone(editableSettings);
    const prepared = await orchestrator.prepareProviderRefresh(routerFor(provider('new')),requested);
    requested.skillConfigurations!['obsidian:read_note'].requireConfirmation = true;
    prepared.commit();
    expect(orchestrator.getSkillExecutor().getContext().settings?.skillConfigurations?.['obsidian:read_note'].requireConfirmation).toBe(false);
    expect(orchestrator.getSkillExecutor().getContext().settings).not.toBe(requested);
  });
  it('retains extension declarations and invalidates a prepared graph when a declaration is withdrawn', async () => {
    let extensions: ExtensionManager | undefined;
    const {orchestrator} = await setup({copyExtensionSkillsTo:registry=>extensions?.copySkillsTo(registry)});
    extensions = new ExtensionManager({} as any,orchestrator.getSkillRegistry(),orchestrator.getSkillExecutor(),structuredClone(DEFAULT_SETTINGS),undefined,
      ()=>({skillRegistry:orchestrator.getSkillRegistry(),skillExecutor:orchestrator.getSkillExecutor()}));
    let api!:ExtensionAPI;
    const factory = vi.fn((value:ExtensionAPI)=>{api=value;api.registerSkill({name:'extra',namespace:'custom',description:'extra',schema:z.object({}),metadata:{executionCategory:'read'},execute:async()=>({success:true,data:'preserved'})});});
    extensions.register({id:'example',name:'Example',description:'example',factory});await extensions.loadAll();
    await orchestrator.reloadSkills();
    expect(factory).toHaveBeenCalledOnce();
    expect(await api.getSkillExecutor().execute('custom','extra',{})).toMatchObject({success:true,data:'preserved'});
    const prepared = await orchestrator.prepareProviderRefresh(routerFor(provider('new')));
    api.unregisterSkill('custom','extra');
    expect(()=>prepared.commit()).toThrow('发生变化');prepared.rollback();
    await orchestrator.reloadSkills();
    expect(orchestrator.getSkillRegistry().get('custom:extra')).toBeUndefined();
  });
  it('blocks reconfiguration while a direct manager execution is in flight', async () => {
    const {orchestrator} = await setup();
    let finish!:()=>void;
    const agent = orchestrator.getDefaultAgent()!;
    vi.spyOn(agent,'execute').mockImplementationOnce(()=>new Promise(resolve=>{finish=()=>resolve({content:'done',messages:[]});}));
    const running = orchestrator.getAgentManager().execute(agent.getId(),'run',context());
    await expect(orchestrator.reloadSkills()).rejects.toThrow('未结束');
    finish(); await running;
    await orchestrator.reloadSkills();
  });
});
