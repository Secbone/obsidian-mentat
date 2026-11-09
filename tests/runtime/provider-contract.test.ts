import { getToolShortName, resolveToolDisplayName } from '../../src/ui/themes/message-utils';
import { describe, expect, it, vi } from 'vitest';
vi.mock('obsidian');
import { OllamaProvider } from '../../src/providers/ollama-provider';
import { ModelGateway, ModelResponseError } from '../../src/runtime/model-gateway';
import { ReadTracker } from '../../src/services/read-tracker';
import { DiagnosticsExporter } from '../../src/diagnostics/diagnostics-exporter';

describe('Normalized provider and reporting contracts',()=>{
  it('parses split NDJSON chunks and preserves usage in the plain-model path',async()=>{
    const encoder=new TextEncoder();
    const body='{"message":{"role":"assistant","content":"你好"},"done":false}\n{"done":true,"done_reason":"stop","prompt_eval_count":10,"eval_count":2}\n';
    const bytes=encoder.encode(body);
    vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,body:new ReadableStream({start(controller){for(let i=0;i<bytes.length;i+=7)controller.enqueue(bytes.slice(i,i+7));controller.close();}})})));
    try {
      const provider=new OllamaProvider({id:'local',baseURL:'http://localhost:11434',model:'fake',maxTokens:128} as any);
      const chunks:string[]=[];
      const result=await new ModelGateway(provider).generateSimple([{role:'user',content:'hi',timestamp:1}],text=>chunks.push(text),{});
      expect(chunks.join('')).toBe('你好');expect(result).toMatchObject({finishReason:'stop',usage:{promptTokens:10,completionTokens:2,totalTokens:12}});
    } finally {vi.unstubAllGlobals();}
  });
  it('does not claim plain-stream success without the provider terminal marker',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,body:new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('{"message":{"role":"assistant","content":"partial"}}\n'));controller.close();}})})));
    try{
      const provider=new OllamaProvider({id:'local',baseURL:'http://localhost:11434',model:'fake'} as any);
      await expect(new ModelGateway(provider).generateSimple([{role:'user',content:'hi',timestamp:1}],()=>{},{})).rejects.toBeInstanceOf(ModelResponseError);
    }finally{vi.unstubAllGlobals();}
  });
  it('restores read evidence for invoke calls but never from an error or schema lookup',()=>{
    const tracker=new ReadTracker();
    tracker.restore([
      {role:'assistant',content:'',timestamp:1,tool_calls:[{id:'read',name:'invoke',arguments:'{"skill_name":"obsidian:read_note"}'},{id:'spec',name:'spec',arguments:'{"skill_name":"obsidian:read_note"}'}]},
      {role:'tool',name:'invoke',tool_call_id:'read',content:'{"path":"good.md","content":"read content","metadata":{"modified":42}}',timestamp:2},
      {role:'tool',name:'spec',tool_call_id:'spec',content:'{"path":"unread.md","content":"schema"}',timestamp:2}
    ]);
    expect(tracker.getReadMtime('good.md')).toBe(42);expect(tracker.hasBeenRead('unread.md')).toBe(false);
  });
  it('labels schema lookup independently of actual tool execution',()=>{
    const diagram=(DiagnosticsExporter as any).generateMermaidDiagram([{role:'assistant',content:'',tool_calls:[{id:'spec',name:'spec',arguments:'{"skill_name":"obsidian:write_note"}'}]}]);
    expect(getToolShortName(resolveToolDisplayName('spec', {skill_name:'obsidian:write_note'}))).toBe('查看工具说明 · write_note');
    expect(diagram).toContain('查询工具说明 obsidian:write_note');
    expect(diagram).not.toContain('Agent->>Skill: write_note');
  });
});
