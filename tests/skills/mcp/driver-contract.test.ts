import { describe, expect, it, vi } from 'vitest';
import { MCPClient } from '../../../src/skills/mcp/mcp-client';
import { MCPManager } from '../../../src/skills/mcp/mcp-manager';
import { SkillRegistry } from '../../../src/skills/core/skill-registry';
import { SkillExecutor } from '../../../src/skills/core/skill-executor';
import { RunBlocked, RunSuspended } from '../../../src/runtime/types';
import type { RunRuntime, OperationRecord, InteractionRequest } from '../../../src/runtime/types';

const inputSchema={type:'object' as const,properties:{text:{type:'string'},options:{type:'object',properties:{count:{type:'integer',minimum:1}}}},required:['text'],additionalProperties:false};
function setup(){
  const client=new MCPClient({id:'server',name:'Server',type:'http',url:'https://example.invalid',enabled:true,autoConnect:false});
  const send=vi.fn(async()=>({jsonrpc:'2.0',id:1,result:{content:[{type:'text',text:'accepted'}]}}));
  (client as any).state={status:'connected',tools:[{name:'send',description:'External action',inputSchema}]};(client as any).transport={send};
  const registry=new SkillRegistry(),manager=new MCPManager(registry);(manager as any).clients.set('server',client);manager.copySkillsTo(registry);
  const settings={skillConfigurations:{}} as any,context={settings,files:{getAbstractFileByPath:()=>null}} as any;
  const executor=new SkillExecutor(registry,context),operations=new Map<string,OperationRecord>(),requests=new Map<string,InteractionRequest>();
  const runtime={getOperation:(id:string)=>operations.get(id),setOperation:async(op:OperationRecord)=>{operations.set(op.id,op);},interact:async(request:InteractionRequest)=>{
    const prior=requests.get(request.id);if(prior?.outcome&&prior.fingerprint===request.fingerprint)return prior.outcome;requests.set(request.id,request);throw new RunSuspended(request);
  }} as unknown as RunRuntime;
  const call=(input:Record<string,unknown>={text:'hello'})=>executor.executeFromToolCall({id:'op',name:'mcp__server__send',arguments:JSON.stringify(input)},{runtime});
  const approve=()=>{requests.get('op:approval')!.outcome={kind:'approved'};};
  return {registry,send,settings,operations,requests,call,approve};
}
describe('MCP drivers share the real tool host contract',()=>{
  it('preserves native JSON Schema and waits for approval before sending any remote request',async()=>{
    const f=setup();expect(f.registry.resolveTool('mcp:server:send')?.inputSchema).toEqual(inputSchema);
    expect(f.registry.toOpenAIFunctions()[0].parameters).toEqual(inputSchema);
    expect(f.registry.toAnthropicTools()[0].input_schema).toEqual(inputSchema);
    await expect(f.call()).rejects.toBeInstanceOf(RunSuspended);expect(f.send).not.toHaveBeenCalled();
    expect(f.operations.get('op')?.category).toBe('external');f.approve();
    expect((await f.call()).success).toBe(true);expect(f.send).toHaveBeenCalledOnce();expect(f.operations.get('op')?.status).toBe('finished');
    await f.call();expect(f.send).toHaveBeenCalledOnce();
  });
  it('enforces permissions and required input before remote dispatch',async()=>{
    const denied=setup();denied.settings.skillConfigurations['mcp:server:send']={allowedPermissions:[]};
    expect((await denied.call()).outcome).toBe('denied');expect(denied.send).not.toHaveBeenCalled();
    const invalid=setup();expect((await invalid.call({})).outcome).toBe('input_error');expect(invalid.send).not.toHaveBeenCalled();expect(invalid.requests.size).toBe(0);
  });
  it.each(['transport','remote-error'])('retains an unknown operation on %s and blocks automatic replay',async kind=>{
    const f=setup();await expect(f.call()).rejects.toBeInstanceOf(RunSuspended);f.approve();
    if(kind==='transport')f.send.mockRejectedValueOnce(new Error('connection lost after dispatch'));
    else f.send.mockResolvedValueOnce({jsonrpc:'2.0',id:1,result:{content:[{type:'text',text:'failed after partial effect'}],isError:true}} as any);
    expect((await f.call()).outcome).toBe('unknown');expect(f.operations.get('op')?.status).toBe('unknown');
    await expect(f.call()).rejects.toBeInstanceOf(RunBlocked);expect(f.send).toHaveBeenCalledOnce();
  });
});
