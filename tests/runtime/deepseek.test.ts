import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('obsidian');
import { z } from 'zod';
import { OpenAIProvider } from '../../src/providers/openai-provider';
import { BaseAgent } from '../../src/agents/base-agent';
import { SkillRegistry } from '../../src/skills/core/skill-registry';
import { SkillExecutor } from '../../src/skills/core/skill-executor';
import { SkillInvocationContext } from '../../src/skills/strategies/skill-invocation-strategy';
import { ChatManager } from '../../src/chat/chat-manager';
import { Compactor } from '../../src/agents/compactor';
import { AIRouter } from '../../src/providers/ai-router';
import { DEFAULT_SETTINGS } from '../../src/settings/settings';
import { MemoryPlatformAdapter } from '../utils/memory-platform-adapter';
import { projectRunIncidents, renderRunFacts } from '../../src/diagnostics/run-diagnostics';

const tools=[{name:'read',description:'read a value',parameters:{type:'object',properties:{}}}];
const config={id:'deepseek',apiKey:'test',baseURL:'https://api.deepseek.com',model:'deepseek-v4-flash',maxTokens:16384};
function stream(content='done',reasoning='opaque state') {
  return (async function*(){yield {choices:[{delta:{reasoning_content:reasoning}}]};yield {choices:[{delta:{content},finish_reason:'stop'}]};})();
}
afterEach(()=>vi.restoreAllMocks());
describe('DeepSeek thinking protocol and latency',()=>{
  it('persists exact opaque reasoning state through the agent, storage reload and the next API request',async()=>{
    const provider=new OpenAIProvider({...config,reasoningEffort:'low'}) as any;
    const create=vi.fn().mockImplementationOnce(async function*(){
      yield {choices:[{delta:{reasoning_content:'opaque '}}]};
      yield {choices:[{delta:{reasoning_content:'state',tool_calls:[{index:0,id:'r',function:{name:'obsidian__read',arguments:'{}'}}]},finish_reason:'tool_calls'}]};
    }).mockImplementation(async()=>stream());
    provider.client={chat:{completions:{create}}};
    const registry=new SkillRegistry();registry.register({name:'read',namespace:'obsidian',description:'',schema:z.object({}),metadata:{executionCategory:'read'},execute:async()=>({success:true,data:'value'})});
    const agent=new BaseAgent({id:'default-chat-agent',name:'Chat',description:'',enableSkills:true},provider,{skillRegistry:registry,skillExecutor:new SkillExecutor(registry,{} as any),skillInvocationContext:new SkillInvocationContext('native')});
    const platform=new MemoryPlatformAdapter(),plugin={platform,loadData:async()=>({}),saveData:async()=>{}} as any;
    let chat=new ChatManager(plugin);
    await agent.execute('read once',{messages:[],sessionId:'s',onCheckpoint:m=>chat.replaceMessages(m)});
    const assistant=create.mock.calls[1][0].messages.find((m:any)=>m.tool_calls);
    expect(assistant.reasoning_content).toBe('opaque state');
    expect(create.mock.calls[0][0].reasoning_effort).toBe('low');
    expect(create.mock.calls[1][0].thinking).toEqual({type:'enabled'});
    chat=new ChatManager(plugin);const saved=await chat.getHistory();
    expect(saved.find(m=>m.tool_calls)?.metadata?.providerState).toMatchObject({adapterId:'deepseek:deepseek',codecVersion:1,payload:{reasoningContent:'opaque state'}});
    await agent.execute('next',{messages:saved,sessionId:'s'});
    expect(create.mock.calls[2][0].messages.find((m:any)=>m.tool_calls).reasoning_content).toBe('opaque state');
  });
  it('recovers legacy messages without fabricating lost reasoning or resending interrupted output',async()=>{
    const provider=new OpenAIProvider({...config,reasoningEffort:'high'}) as any;const create=vi.fn(async()=>stream('done','opaque'));
    provider.client={chat:{completions:{create}}};const progress=vi.fn();
    const messages:any[]=[{role:'user',content:'q',timestamp:1},{role:'assistant',content:'',timestamp:2,tool_calls:[{id:'w',name:'write',arguments:'{}'}]},
      {role:'tool',tool_call_id:'w',content:'already completed',timestamp:3},{role:'assistant',content:'incomplete diagram',timestamp:4,metadata:{interrupted:true}}];
    const result=await provider.generateStreamWithSkills(messages,()=>{},undefined,{skills:tools,onProgress:progress});
    expect(create.mock.calls[0][0].thinking).toEqual({type:'enabled'});
    expect(create.mock.calls[0][0].reasoning_effort).toBe('high');
    expect(create.mock.calls[0][0].messages.some((m:any)=>m.content==='incomplete diagram')).toBe(false);
    expect(create.mock.calls[0][0].messages.some((m:any)=>m.tool_calls || m.role==='tool')).toBe(false);
    expect(create.mock.calls[0][0].messages.map((m:any)=>m.content).join('')).toContain('already completed');
    expect(messages).toHaveLength(4);expect(result.diagnostics.legacyCompatibility).toBe(true);
    expect(progress).toHaveBeenCalled();
  });
  it('keeps high even when the previous tool turn supplied an empty reasoning field',async()=>{
    const provider=new OpenAIProvider({...config,reasoningEffort:'high'}) as any;
    const create=vi.fn(async()=>stream());provider.client={chat:{completions:{create}}};
    await provider.generateStreamWithSkills([
      {role:'assistant',content:'',timestamp:1,tool_calls:[{id:'done',name:'read',arguments:'{}'}],metadata:{providerState:{providerId:'deepseek',reasoningContent:''}}},
      {role:'tool',tool_call_id:'done',content:'completed',timestamp:2}
    ],()=>{},undefined,{skills:tools});
    expect(create.mock.calls[0][0].reasoning_effort).toBe('high');
    expect(create.mock.calls[0][0].thinking).toEqual({type:'enabled'});
    expect(create.mock.calls[0][0].messages.some((m:any)=>m.tool_calls||m.role==='tool')).toBe(false);
  });
  it('keeps provider reasoning opaque while reporting live progress',async()=>{
    const provider=new OpenAIProvider(config) as any;
    provider.client={chat:{completions:{create:async()=>stream('visible','opaque private state')}}};
    const chunks=vi.fn(),progress=vi.fn();await provider.generateStreamWithSkills([],chunks,undefined,{onProgress:progress});
    expect(chunks.mock.calls.map(c=>c[0]).join('')).toBe('visible');
    expect(progress.mock.calls.flat().join('')).not.toContain('opaque private state');
    expect(progress).toHaveBeenCalled();
  });
  it('does not send DeepSeek-specific controls or state to another provider',async()=>{
    const provider=new OpenAIProvider({...config,baseURL:'https://api.openai.com/v1'}) as any;
    const create=vi.fn(async()=>stream());provider.client={chat:{completions:{create}}};
    await provider.generateStreamWithSkills([{role:'assistant',content:'prior',timestamp:1,metadata:{providerState:{providerId:'deepseek',reasoningContent:'opaque'}}}],()=>{},undefined,{skills:tools});
    expect(create.mock.calls[0][0].thinking).toBeUndefined();expect(create.mock.calls[0][0].messages[0]).not.toHaveProperty('reasoning_content');
  });
  it('uses DeepSeek thinking output defaults while preserving explicit limits and other providers',()=>{
    expect(new OpenAIProvider({...config,maxTokens:undefined}).getMaxOutputTokens()).toBe(65536);
    expect(new OpenAIProvider({...config,maxTokens:32768}).getMaxOutputTokens()).toBe(32768);
    expect(new OpenAIProvider({...config,maxTokens:undefined,baseURL:'https://api.openai.com/v1'}).getMaxOutputTokens()).toBe(16384);
  });
  it('propagates the configured reasoning effort through AIRouter',()=>{
    const settings=structuredClone(DEFAULT_SETTINGS);settings.aiProviders=[{...config,type:'openai',name:'DS',enabled:true,supportsEmbedding:false,supportsStreaming:true,reasoningEffort:'low'}];
    const provider=new AIRouter(settings).getProviderById('deepseek') as any;expect(provider.config.reasoningEffort).toBe('low');
  });
  it('counts persisted reasoning and Chinese text in context budgeting',()=>{
    const a:any={role:'assistant',content:'中文内容',timestamp:1};
    expect(Compactor.estimateTokens([{...a,metadata:{providerState:{providerId:'deepseek',reasoningContent:'x'.repeat(400)}}}])-Compactor.estimateTokens([a])).toBeGreaterThanOrEqual(100);
    expect(Compactor.estimateTokens([{...a,metadata:{providerState:{adapterId:'fake',codecVersion:1,configFingerprint:'config',payload:{opaque:'ignored'},estimatedTokens:100}}}])-Compactor.estimateTokens([a])).toBe(100);
    expect(Compactor.estimateTokens([a])).toBeGreaterThan(Compactor.estimateTokens([{...a,content:'abcd'}]));
  });
  it('retains each failed continuation while avoiding duplicate layer-level incidents',()=>{
    const r:any={id:'run-a',sessionId:'s',status:'failed',providerId:'deepseek',operations:{},interactions:{},updatedAt:100,events:[
      {id:'e1',sequence:1,timestamp:0,type:'model:requested',details:{outputLimit:16384}},
      {id:'e2',sequence:2,timestamp:65000,type:'model:result',details:{finishReason:'length',usage:{completionTokens:16384}}},
      {id:'e3',sequence:3,timestamp:65001,type:'incident',details:{error:'length'}},
      {id:'e4',sequence:4,timestamp:65002,type:'run:failed',details:{message:'length'}},
      {id:'e5',sequence:5,timestamp:66000,type:'model:requested',details:{outputLimit:16384}},
      {id:'e6',sequence:6,timestamp:66500,type:'run:failed',details:{message:'400 reasoning_content'}}]};
    expect(projectRunIncidents([r])).toHaveLength(2);const report=renderRunFacts([r]);
    expect(report).toContain('65.00');expect(report).toContain('0.50');expect(report).toContain('请求失败');
  });
  it('exposes write_note natively in auto mode to avoid a schema-discovery model round trip',()=>{
    const registry=new SkillRegistry();registry.register({name:'write_note',namespace:'obsidian',description:'write',schema:z.object({path:z.string(),content:z.string()}),execute:async()=>({success:true})});
    const definitions=new SkillInvocationContext('auto').getToolDefinitions(registry,'openai') as any[];
    expect(definitions.some(d=>d.name==='obsidian__write_note')).toBe(true);
  });
});
