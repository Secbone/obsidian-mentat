import { describe, expect, it, vi } from 'vitest';
import type { ContextBuilder } from '../../src/contracts/context-builder';
import type { ChatMessage } from '../../src/contracts/conversation';
import { SummaryContextBuilder } from '../../src/context/summary-context-builder';

function conversation():ChatMessage[] {
  return [
    {role:'user',content:'old question',timestamp:1},{role:'assistant',content:'old answer',timestamp:2},
    {role:'assistant',content:'read two',timestamp:3,tool_calls:[{id:'a',name:'read',arguments:'{}'},{id:'b',name:'read',arguments:'{}'}],
      metadata:{providerState:{adapterId:'fake',codecVersion:1,configFingerprint:'model-v1',payload:{opaque:'state'}}}},
    {role:'tool',tool_call_id:'a',content:'first result',timestamp:4},{role:'tool',tool_call_id:'b',content:'second result',timestamp:5},
  ];
}

describe('Replaceable context builder contract',()=>{
  it.each(['summary','fake'])('accepts the %s strategy through the same consumer and retains complete tool exchanges',async strategy=>{
    const messages=conversation(),before=structuredClone(messages),compact=vi.fn(async()=> 'old decisions');
    const fake:ContextBuilder={id:'verbatim-test',build:async input=>({messages:input.messages,summaryLength:0})};
    const builder:ContextBuilder=strategy==='summary' ? new SummaryContextBuilder({compact}):fake;
    const consumer=(port:ContextBuilder)=>port.build({messages,keepRecent:1});
    const result=await consumer(builder);
    expect(result.messages.slice(-3)).toEqual(before.slice(-3));
    expect(messages).toEqual(before);
    const calls=result.messages.flatMap(message=>message.tool_calls || []).map(call=>call.id);
    const responses=result.messages.filter(message=>message.role==='tool').map(message=>message.tool_call_id);
    expect(responses).toEqual(calls);
    if (strategy==='summary') {
      expect(compact).toHaveBeenCalledWith(messages,{keepRecent:3,abortSignal:undefined});
      expect(result.summaryLength).toBe('old decisions'.length);expect(result.messages).toHaveLength(4);
    } else {expect(result.messages).toBe(messages);expect(compact).not.toHaveBeenCalled();}
  });
  it('keeps the original context when summarization is empty or all messages are recent',async()=>{
    const messages=conversation(),compact=vi.fn(async()=> '   '),builder=new SummaryContextBuilder({compact});
    expect(await builder.build({messages,keepRecent:1})).toEqual({messages,summaryLength:0});
    compact.mockClear();
    expect((await builder.build({messages,keepRecent:100})).messages).toBe(messages);expect(compact).not.toHaveBeenCalled();
    expect(await builder.build({messages:[],keepRecent:6})).toEqual({messages:[],summaryLength:0});
  });
  it('honors cancellation before and during summarization without changing the archive',async()=>{
    const messages=conversation(),before=structuredClone(messages),controller=new AbortController();
    const compact=vi.fn(async()=>new Promise<string>(()=>{})),builder=new SummaryContextBuilder({compact});
    const building=builder.build({messages,keepRecent:1,signal:controller.signal});
    controller.abort();await expect(building).rejects.toMatchObject({name:'AbortError'});
    await expect(builder.build({messages,keepRecent:1,signal:controller.signal})).rejects.toMatchObject({name:'AbortError'});
    expect(compact).toHaveBeenCalledOnce();expect(messages).toEqual(before);
  });
});
