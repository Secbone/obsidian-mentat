import { describe, expect, it } from 'vitest';
import { ChatPresenter, projectChat, projectRunControls } from '../../src/ui/chat-cards/presenter';
import type { RunRecord } from '../../src/runtime/types';
import type { ChatMessage } from '../../src/types';

function record(overrides: Partial<RunRecord> = {}): RunRecord {
  return {version:1,id:'run-1',sessionId:'session',agentId:'default-chat-agent',prompt:'question',maxTurns:20,enableSkills:true,
    createdAt:100,updatedAt:300,status:'running',baseMessageCount:0,messages:[{role:'user',content:'question',timestamp:100}],operations:{},interactions:{},events:[],...overrides};
}
const project = (r: RunRecord, extra: Record<string,unknown> = {}) => projectChat({sessionId:'session',history:r.messages,records:[r],...extra});

describe('Unified chat card projection', () => {
  it('uses the latest run rather than resurrecting an older failure', () => {
    const old = record({status:'failed',error:'old error'});
    const current = record({id:'run-2',status:'completed',createdAt:400,baseMessageCount:2,messages:[...old.messages,{role:'assistant',content:'old',timestamp:200},{role:'user',content:'new',timestamp:400},{role:'assistant',content:'done',timestamp:500}]});
    const state = projectChat({sessionId:'session',history:current.messages,records:[current,old]});
    expect(state.label).toBe('已完成'); expect(state.busy).toBe(false); expect(state.canCancel).toBe(false);
    expect(state.cards.find(c => c.id === 'run-1:outcome')?.canResume).toBe(false);
  });
  it('keeps approvals inline and derives waiting controls identically on reopen', () => {
    const r = record({status:'waiting_for_approval',operations:{write:{id:'write',name:'write_note',category:'write',status:'planned'}},
      interactions:{approval:{id:'approval',operationId:'write',kind:'approval',question:'Allow write?',fingerprint:'v1',context:'large tool payload'}},
      events:[{id:'e',sequence:1,timestamp:250,type:'interaction:requested',operationId:'write',details:{interactionId:'approval'}}]});
    const a = project(r), b = project(JSON.parse(JSON.stringify(r)));
    expect(a).toEqual(b); expect(a.inputMode).toBe('blocked'); expect(a.label).toBe('等待你的授权');
    expect(a.cards.find(c => c.kind === 'interaction')?.interaction?.fingerprint).toBe('v1');
    expect(a.cards.find(c => c.kind === 'tool')?.status).toBe('waiting');
    expect(a.cards.find(c => c.kind === 'interaction')?.text).not.toContain('large tool payload');
    expect(a.cards.find(c => c.kind === 'interaction')?.detail).toContain('large tool payload');
  });
  it('updates a streaming reply into its persisted card without duplication or losing its prefix', () => {
    const r = record();
    const live = project(r,{live:{message:{index:1,content:'完整前缀 + 新内容',startedAt:200,complete:false}}});
    const reply = live.cards.find(c => c.kind === 'reply')!;
    expect(reply.text).toBe('完整前缀 + 新内容'); expect(reply.streaming).toBe(true);
    r.messages.push({role:'assistant',content:reply.text!,timestamp:200}); r.status='completed';
    const restored = project(r);
    expect(restored.cards.filter(c => c.kind === 'reply')).toHaveLength(1);
    expect(restored.cards.find(c => c.kind === 'reply')?.id).toBe(reply.id);
  });
  it('restores a persisted partial when no live stream is available', () => {
    const state = project(record({partial:'saved prefix'}));
    expect(state.cards.find(c => c.kind === 'reply')?.text).toBe('saved prefix');
  });
  it('uses operation IDs and structured results for concurrent calls of the same tool', () => {
    const r = record({messages:[{role:'user',content:'q',timestamp:100},{role:'assistant',content:'read both',timestamp:200,
      tool_calls:[{id:'a',name:'read_note',arguments:{path:'a.md'}},{id:'b',name:'read_note',arguments:{path:'b.md'}}]},
      {role:'tool',tool_call_id:'a',content:'Not prefixed with Error:',timestamp:250}],
      operations:{a:{id:'a',name:'read_note',category:'read',status:'finished',result:{success:false,error:'permission denied'}},b:{id:'b',name:'read_note',category:'read',status:'running'}}});
    const tools = project(r).cards.filter(c => c.kind === 'tool');
    expect(tools).toHaveLength(2); expect(tools.map(c => c.status)).toEqual(['failed','running']);
    expect(tools[0].id).not.toBe(tools[1].id); expect(tools[0].text).toBe('a.md');
  });
  it('does not claim success for unstructured legacy tool results', () => {
    const history: ChatMessage[] = [{role:'assistant',content:'',timestamp:100,tool_calls:[{id:'a',name:'read',arguments:'{}'}]},
      {role:'tool',tool_call_id:'a',content:'old prose',timestamp:200}];
    const state = projectChat({sessionId:'legacy',history,records:[]});
    expect(state.cards.find(c => c.kind === 'tool')?.status).toBe('unknown');
  });
  it('keeps unknown operations blocked and exposes reconciliation', () => {
    const r = record({status:'interrupted',operations:{write:{id:'write',name:'write',category:'write',status:'unknown'}}});
    const state = project(r);
    expect(state.inputMode).toBe('blocked'); expect(state.cards.find(c => c.kind === 'tool')?.canReconcile).toBe(true);
    expect(state.cards.find(c => c.kind === 'system')?.canResume).toBe(false);
  });
  it('shows cancellation as pending rather than completed before runtime acknowledgement', () => {
    const state = projectRunControls(record(),{cancelling:true});
    expect(state.cancelling).toBe(true); expect(state.runStatus).toBe('running'); expect(state.inputMode).toBe('blocked');
    expect(state.label).toContain('等待确认');
  });
  it('records verified artifacts and excludes opaque provider reasoning and credentials', () => {
    const r = record({status:'completed',messages:[{role:'user',content:'q',timestamp:100},{role:'assistant',content:'done',timestamp:200,metadata:{providerState:{reasoningContent:'private reasoning'}}}],
      operations:{a:{id:'a',name:'fetch',category:'read',status:'finished',result:{success:true,data:{token:'secret-key'}}}},
      events:[{id:'artifact',sequence:1,type:'artifact:verified',timestamp:180,details:{path:'Research/result.canvas'}}]});
    const before = JSON.stringify(r), state = project(r,{secrets:['secret-key']});
    expect(state.cards.find(c => c.kind === 'artifact')?.path).toBe('Research/result.canvas');
    expect(JSON.stringify(state)).not.toContain('private reasoning'); expect(JSON.stringify(state)).not.toContain('secret-key');
    expect(JSON.stringify(r)).toBe(before);
  });
  it('preserves truncation and each request across resume attempts', () => {
    const r = record({status:'failed',events:[
      {id:'1',sequence:1,timestamp:100,type:'model:requested',details:{requestId:'a'}},
      {id:'2',sequence:2,timestamp:150,type:'model:result',details:{finishReason:'length',response:{requestId:'a',elapsedMs:50}}},
      {id:'3',sequence:3,timestamp:200,type:'model:requested',details:{requestId:'b'}},
      {id:'4',sequence:4,timestamp:230,type:'model:failed',details:{requestId:'b',error:'protocol'}}]});
    const requests = project(r).cards.filter(c => c.kind === 'activity');
    expect(requests).toHaveLength(2); expect(requests.every(c => c.status === 'failed')).toBe(true);
    expect(requests[0].text).toContain('长度上限'); expect(requests[1].durationMs).toBe(30);
  });
  it('caches settled history while keeping live controls and cards current', () => {
    const old = record({status:'failed',error:'old',messages:[{role:'user',content:'old',timestamp:100},{role:'assistant',content:'old answer',timestamp:150}]});
    const current = record({id:'run-2',createdAt:400,baseMessageCount:2,messages:[...old.messages,{role:'user',content:'new',timestamp:400}]});
    const presenter = new ChatPresenter();
    const input={sessionId:'session',history:current.messages,records:[current,old]};
    const a=presenter.project({...input,live:{message:{index:3,content:'prefix',startedAt:500,complete:false}}});
    const b=presenter.project({...input,live:{message:{index:3,content:'prefix suffix',startedAt:500,complete:false}}});
    expect(a.cards.find(c=>c.id==='session:message:0')).toBe(b.cards.find(c=>c.id==='session:message:0'));
    expect(b.cards.find(c=>c.id==='session:message:3')?.text).toBe('prefix suffix');
    expect(b.cards.find(c=>c.id==='run-1:outcome')?.canResume).toBe(false);
    expect(new Set(b.cards.map(c=>c.id)).size).toBe(b.cards.length);
  });

});
