import type { Observer } from '../observability/observer';
import { projectRunEvent } from '../observability/run-projection';
import type { AgentContext, AgentEvent } from '../agents/agent-types';
import type { ChatMessage } from '../contracts/conversation';
import type { ChatManager } from '../chat/chat-manager';
import type { RunRepository } from '../contracts/run-repository';
import { EventBus } from '../extensions/event-bus';
import { InteractionRequest, RunBlocked, RunRecord, RunRuntime, RunSuspended, RunLiveState } from './types';
import { errorDetails, isAbortError } from '../utils/execution';
import { fingerprint } from './fingerprint';

type Execute = (prompt: string, context: AgentContext) => Promise<void>;
interface RecordedEvent { type:string|((record:RunRecord)=>string); details?:Record<string,unknown>; operationId?:string; }
export class RunController {
  private records = new Map<string, RunRecord>();
  private active = new Map<string, { controller: AbortController; context: AgentContext; promise: Promise<void> }>();
  private commits = new Map<string,Promise<unknown>>();
  private disposed = false;
  private live = new Map<string, RunLiveState>();
  private inFlight = new Map<string, Map<string, Set<Promise<unknown>>>>();
  private pendingIngress = new Map<string, Set<string>>();
  private unsubscribe: () => void;
  constructor(readonly store: RunRepository, private bus: EventBus, private chat: ChatManager, private execute: Execute, private observer?: Observer) {
    this.unsubscribe = bus.on('*', event => this.captureProgress(event));
  }
  private captureProgress(event: AgentEvent): void {
    const record = event.runId ? this.records.get(event.runId) : undefined;
    if (!record || event.sessionId !== record.sessionId || event.agentId !== record.agentId || record.status !== 'running') return;
    if (!['message:start','message:update','message:end','system:status','context:compact:start','context:compact:end'].includes(event.type)) return;
    const live = this.live.get(record.id) || {};
    if (event.type === 'message:start' && event.role === 'assistant') live.message = { index: (this.getContext(record.id)?.transcript || record.messages).length, content: '', startedAt: Date.now(), complete: false };
    else if (event.type === 'message:update') {
      live.message ||= { index: (this.getContext(record.id)?.transcript || record.messages).length, content: '', startedAt: Date.now(), complete: false };
      live.message.content = event.accumulatedText ?? live.message.content + event.delta; live.phase = '正在生成回复';
    } else if (event.type === 'message:end' && live.message) { live.message.content = event.content; live.message.complete = true; }
    else if (event.type === 'system:status') live.phase = event.message;
    else if (event.type === 'context:compact:start') live.phase = '正在压缩上下文';
    else if (event.type === 'context:compact:end') live.phase = '等待模型响应';
    this.live.set(record.id, live);
  }
  getLiveState(id: string): RunLiveState | undefined { return this.live.get(id); }
  getDisplayMessages(id: string): ChatMessage[] {
    const record=this.records.get(id);if(!record) return [];
    const transcript=this.getContext(id)?.transcript;
    return transcript && transcript.length>=record.baseMessageCount+1 ? transcript:record.messages;
  }
  async initialize(): Promise<void> {
    for(const record of await this.store.list()) {
      this.records.set(record.id,record);
      if(Object.values(record.operations).some(operation=>operation.status==='finished' && operation.result?.outcome==='unknown')) await this.commit(record,draft=>{
        for(const operation of Object.values(draft.operations)) if(operation.result?.outcome==='unknown')operation.status='unknown';
        if(draft.status==='completed'){draft.status='interrupted';draft.error='历史运行包含尚未核对的操作结果，请先核对。';}
      },{type:'run:unknown_normalized'});
      if(record.status==='running') await this.commit(record,draft=>{
        draft.status='interrupted';
        if(draft.partial) {draft.messages.push({role:'assistant',content:draft.partial,timestamp:Date.now(),metadata:{interrupted:true}});draft.partial=undefined;}
        for(const [scope,text] of Object.entries(draft.childPartials || {})) if(text && draft.children?.[scope]) draft.children[scope].push({role:'assistant',content:text,timestamp:Date.now(),metadata:{interrupted:true}});
        draft.childPartials={};
        for(const operation of Object.values(draft.operations)) if(operation.status==='running') operation.status=operation.category==='read'?'planned':'unknown';
        draft.error='上次运行被中断；请检查未确认操作，再从检查点继续。';
      },{type:'run:interrupted',details:{reason:'process_restart'}});
    }
    await this.chat.bindRunHistory(async sessionId=>this.list(sessionId)[0]);
    for(const warning of this.chat.recoveryWarnings) this.observer?.event('storage:session_projection:warning',{component:'storage',level:'warn',attributes:{warning}});
  }
  getWarnings():string[] {return [...this.store.warnings,...this.chat.recoveryWarnings];}
  list(sessionId?:string):RunRecord[] {return [...this.records.values()].filter(r=>!sessionId || r.sessionId===sessionId).sort((a,b)=>b.createdAt-a.createdAt);}
  get(id:string):RunRecord|undefined {return this.records.get(id);}
  getContext(id:string):AgentContext|undefined {return this.active.get(id)?.context;}
  hasUnsettledWork():boolean {
    return !!(this.active.size || this.inFlight.size || this.pendingIngress.size) || this.list().some(record=>
      ['running','waiting_for_user','waiting_for_approval','interrupted'].includes(record.status)
      || Object.values(record.operations).some(operation=>operation.status==='unknown' || operation.status==='running' || operation.result?.outcome==='unknown')
      || Object.values(record.interactions).some(interaction=>!interaction.outcome)
      || record.status!=='cancelled' && record.instructions?.some(instruction=>instruction.status==='queued'));
  }
  private notify(record:RunRecord):void {this.bus.emit({type:'run:changed',sessionId:record.sessionId,runId:record.id,agentId:record.agentId,status:record.status,error:record.error});}
  /** Mutations are private candidates until their single revision commit succeeds. */
  private commit<T>(record:RunRecord,mutate:(draft:RunRecord)=>T,event?:RecordedEvent):Promise<T> {
    const previous=this.commits.get(record.id) || Promise.resolve();
    const write=previous.catch(()=>undefined).then(async()=>{
      const draft=structuredClone(record),result=mutate(draft);
      draft.updatedAt=Date.now();
      const sequence=draft.events.length+1;
      const savedEvent=event ? {id:`${draft.id}:${sequence}`,sequence,timestamp:draft.updatedAt,type:typeof event.type==='function'?event.type(draft):event.type,details:event.details,operationId:event.operationId}:undefined;
      if(savedEvent) draft.events.push(savedEvent);
      try {draft.revision=await this.store.commit(draft,record.revision || 0);}
      catch(error) {this.observer?.error('storage:checkpoint:failed',error,{component:'storage',runId:record.id,sessionId:record.sessionId});throw error;}
      for(const key of Object.keys(record)) if(!(key in draft)) delete (record as unknown as Record<string,unknown>)[key];
      Object.assign(record,draft);
      if(savedEvent) {
        const attempt=Math.max(1,record.events.filter(item=>item.type==='run:started' || item.type==='run:resumed').length);
        this.observer?.event(savedEvent.type,projectRunEvent(record,savedEvent,attempt));
        if(savedEvent.type==='model:requested' && !savedEvent.operationId) this.live.set(record.id,{...this.live.get(record.id),message:undefined,phase:'等待模型响应',phaseStartedAt:savedEvent.timestamp});
      }
      this.notify(record);return result;
    });
    this.commits.set(record.id,write);
    void write.finally(()=>{if(this.commits.get(record.id)===write) this.commits.delete(record.id);}).catch(()=>undefined);
    return write;
  }
  private event(record:RunRecord,type:string,details?:Record<string,unknown>,operationId?:string):Promise<void> {return this.commit(record,()=>undefined,{type,details,operationId});}
  private async project(record:RunRecord):Promise<void> {
    try {await this.chat.projectRun(record);}
    catch(error) {this.observer?.error('storage:session_projection:failed',error,{component:'storage',runId:record.id,sessionId:record.sessionId});}
  }
  private runtime(record:RunRecord,scope=''):RunRuntime {
    const key=(id:string)=>scope+id;
    return {
      runId:record.id,sessionId:record.sessionId,scope,
      child:id=>{
        const childKey=key(id)+'/';
        return {runtime:this.runtime(record,childKey),messages:structuredClone(record.children?.[childKey] || []),checkpoint:async messages=>{
          const snapshot=structuredClone(messages);
          await this.commit(record,draft=>{draft.children||={};draft.children[childKey]=snapshot;if(draft.childPartials) delete draft.childPartials[childKey];},
            {type:'subagent:checkpoint',details:{messageCount:messages.length},operationId:key(id)});
        }};
      },
      partial:async text=>{await this.commit(record,draft=>{if(scope){draft.childPartials||={};draft.childPartials[scope]=text;}else draft.partial=text;});},
      observe:(type,details)=>this.observer?.event(type,{component:type.split(':')[0],runId:record.id,sessionId:record.sessionId,
        attemptId:`${record.id}:attempt-${Math.max(1,record.events.filter(e=>e.type==='run:started' || e.type==='run:resumed').length)}`,
        requestId:typeof details?.requestId==='string'?details.requestId:undefined,attributes:details}),
      record:(type,details,operationId)=>this.event(record,type,details,operationId?key(operationId):undefined),
      getOperation:id=>{const operation=record.operations[key(id)];return operation?{...structuredClone(operation),id}:undefined;},
      trackOperation:(id,completion)=>{
        const operations=this.inFlight.get(record.id)||new Map<string,Set<Promise<unknown>>>(),pending=operations.get(key(id))||new Set<Promise<unknown>>();
        pending.add(completion);operations.set(key(id),pending);this.inFlight.set(record.id,operations);
        const settled=()=>{pending.delete(completion);if(!pending.size) operations.delete(key(id));if(!operations.size) this.inFlight.delete(record.id);};
        void completion.then(settled,settled);
      },
      takeInstructions:async()=>scope?[]:(record.instructions || []).filter(i=>i.status==='queued').map(({id,text})=>({id,text})),
      ackInstructions:async ids=>{
        if(scope || !(record.instructions || []).some(i=>ids.includes(i.id) && i.status==='queued')) return;
        await this.commit(record,draft=>{
          const committed=new Set(draft.messages.map(message=>message.metadata?.instructionId));
          for(const instruction of draft.instructions || []) if(ids.includes(instruction.id) && committed.has(instruction.id)) instruction.status='consumed';
        },{type:'instructions:consumed',details:{instructionIds:ids}});
      },
      getContextSnapshot:()=>structuredClone(scope?record.childContextSnapshots?.[scope]:record.contextSnapshot),
      saveContextSnapshot:async snapshot=>{
        const source=structuredClone((scope?record.children?.[scope] || []:record.messages).slice(0,snapshot.sourceMessageCount));
        if(source.length!==snapshot.sourceMessageCount || await fingerprint(source)!==snapshot.sourceDigest) throw new RunBlocked('上下文摘要与已提交会话基线不一致');
        await this.commit(record,draft=>{
          const current=(scope?draft.children?.[scope] || []:draft.messages).slice(0,snapshot.sourceMessageCount);
          if(JSON.stringify(current)!==JSON.stringify(source)) throw new RunBlocked('摘要准备期间会话基线已变化');
          if(scope){draft.childContextSnapshots||={};draft.childContextSnapshots[scope]=structuredClone(snapshot);}else draft.contextSnapshot=structuredClone(snapshot);
        },{type:'context:checkpoint',details:{scope,sourceMessageCount:snapshot.sourceMessageCount}});
      },
      bindEngine:async binding=>{
        const bound=scope?record.childEngineBindings?.[scope]:record.engineBinding;
        if(bound) {
          if(bound.id!==binding.id || bound.version!==binding.version || bound.codecVersion!==binding.codecVersion) throw new RunBlocked('此运行绑定的引擎或检查点版本不兼容，请在安全边界创建新运行');
          return;
        }
        await this.commit(record,draft=>{
          const current=scope?draft.childEngineBindings?.[scope]:draft.engineBinding;
          if(current && (current.id!==binding.id || current.version!==binding.version || current.codecVersion!==binding.codecVersion)) throw new RunBlocked('此运行已绑定其他引擎或检查点版本');
          if(scope){draft.childEngineBindings||={};draft.childEngineBindings[scope]=structuredClone(binding);}else draft.engineBinding=structuredClone(binding);
        },
          {type:'engine:bound',details:{scope,...binding}});
      },
      getEngineCheckpoint:()=>structuredClone(scope?record.childEngineCheckpoints?.[scope]:record.engineCheckpoint),
      saveEngineCheckpoint:async checkpoint=>{await this.commit(record,draft=>{
        const binding=scope?draft.childEngineBindings?.[scope]:draft.engineBinding,messages=scope?draft.children?.[scope] || []:draft.messages;
        if(!binding || JSON.stringify(binding)!==JSON.stringify(checkpoint.binding) || checkpoint.transcriptLength!==messages.length) throw new RunBlocked('引擎检查点与已提交会话或绑定不一致');
        if(scope){draft.childEngineCheckpoints||={};draft.childEngineCheckpoints[scope]=structuredClone(checkpoint);}else draft.engineCheckpoint=structuredClone(checkpoint);
      },{type:'engine:checkpoint',details:{scope,transcriptLength:checkpoint.transcriptLength}});},
      setOperation:async operation=>{await this.commit(record,draft=>{draft.operations[key(operation.id)]={...structuredClone(operation),id:key(operation.id)};},
        {type:`operation:${operation.status}`,operationId:key(operation.id),details:{name:operation.name,category:operation.category,outcome:operation.result?.outcome,error:operation.result?.error}});},
      modelResult:async result=>{await this.event(record,'model:result',{finishReason:result.finishReason,usage:result.usage,response:result.diagnostics});},
      interact:async input=>{
        const request={...structuredClone(input),id:key(input.id),operationId:key(input.operationId)},existing=record.interactions[request.id];
        if(existing?.outcome && existing.fingerprint===request.fingerprint) return structuredClone(existing.outcome);
        if(existing?.outcome) await this.commit(record,draft=>{delete draft.interactions[request.id];},{type:'interaction:invalidated',operationId:request.operationId,details:{reason:'文件或操作已变化，请重新授权'}});
        await this.commit(record,draft=>{draft.interactions[request.id]=request;draft.status=request.kind==='approval'?'waiting_for_approval':'waiting_for_user';},
          {type:'interaction:requested',operationId:request.operationId,details:{interactionId:request.id,kind:request.kind}});
        this.bus.emit({type:'interaction:request',request,runId:record.id,sessionId:record.sessionId,agentId:record.agentId});
        throw new RunSuspended(request);
      },
    };
  }
  async start(prompt:string,options:{sessionId:string;messages:ChatMessage[];maxTurns:number;enableSkills:boolean;providerId?:string}):Promise<string> {
    if(this.disposed) throw new Error('运行管理器已停止');
    if(this.store.warnings.length) throw new Error('部分运行记录损坏，自动执行已暂停。请导出诊断并恢复记录后重试。');
    if(this.list().some(record=>Object.values(record.operations).some(op=>op.status==='unknown' || op.result?.outcome==='unknown'))) throw new Error('存在尚未核对的操作，请从运行记录中核对实际结果后继续');
    if(options.sessionId!==this.chat.getSessionInfo().sessionId) throw new Error('会话已变化，请刷新聊天页面');
    if(this.list(options.sessionId).some(record=>['running','waiting_for_user','waiting_for_approval','interrupted'].includes(record.status))) throw new Error('当前会话还有未结束的运行，请先继续或停止它。');
    const createdAt=Math.max(Date.now(),...this.list().map(record=>record.createdAt+1)),id=`run-${createdAt}-${Math.random().toString(36).slice(2)}`;
    const record:RunRecord={version:1,id,sessionId:options.sessionId,prompt,agentId:'default-chat-agent',providerId:options.providerId,maxTurns:options.maxTurns,enableSkills:options.enableSkills,
      status:'running',createdAt,updatedAt:createdAt,messages:[...structuredClone(options.messages),{role:'user',content:prompt,timestamp:Date.now()}],baseMessageCount:options.messages.length,operations:{},interactions:{},events:[]};
    this.records.set(id,record);
    const baseline=this.list(options.sessionId).find(item=>item.id!==id);
    if(baseline && baseline.messages.length===options.messages.length && JSON.stringify(baseline.messages)===JSON.stringify(options.messages)) {
      record.messageBase={runId:baseline.id,count:baseline.messages.length,digest:await fingerprint(baseline.messages)};
      if(baseline.providerId===record.providerId) record.contextSnapshot=structuredClone(baseline.contextSnapshot);
    }
    try {await this.event(record,'run:started');}
    catch(error){record.status='interrupted';record.error=String(error);this.notify(record);throw error;}
    await this.project(record);this.notify(record);void this.drive(record,false);return id;
  }
  async open(id:string):Promise<void> {
    const record=this.records.get(id);if(!record) throw new Error('运行不存在');
    if(this.list(record.sessionId)[0]?.id!==id) throw new Error('该会话已有更新的运行，请打开该会话最新记录，避免覆盖后续对话');
    if(this.active.size && !this.active.has(id)) throw new Error('请先停止当前运行，再切换会话');
    await this.chat.openRun(record);
  }
  async resume(id:string):Promise<void> {
    if(this.store.warnings.length) throw new Error('请先恢复损坏的运行记录，再继续执行');
    const record=this.records.get(id);if(!record || this.disposed) throw new Error('运行不存在或插件已停止');
    this.assertCurrent(record);
    if(this.active.has(id)) throw new Error('运行仍在执行，请稍后再试');
    if(!['interrupted','waiting_for_user','waiting_for_approval','failed'].includes(record.status)) throw new Error('此运行不能继续');
    if(Object.values(record.operations).some(operation=>operation.status==='unknown' || operation.result?.outcome==='unknown')) throw new Error('存在结果未知的操作，请先核对实际结果');
    if(Object.values(record.interactions).some(interaction=>!interaction.outcome)){this.notify(record);return;}
    await this.commit(record,draft=>{if(draft.status==='running') throw new Error('运行仍在执行');draft.status='running';draft.error=undefined;},{type:'run:resumed'});
    await this.drive(record,true);
  }
  async respond(id:string,interactionId:string,outcome:NonNullable<InteractionRequest['outcome']>):Promise<void> {
    if(this.store.warnings.length) throw new Error('请先恢复损坏的运行记录，再继续执行');
    const record=this.records.get(id);if(!record) throw new Error('交互已结束或响应重复');this.assertCurrent(record);
    await this.commit(record,draft=>{
      const request=draft.interactions[interactionId];
      if(!request || request.outcome || !['waiting_for_user','waiting_for_approval','interrupted'].includes(draft.status)) throw new Error('交互已结束或响应重复');
      if(Object.values(draft.operations).some(operation=>operation.status==='unknown' || operation.result?.outcome==='unknown')) throw new Error('存在结果未知的操作，请先核对');
      if(request.kind==='approval' && !['approved','rejected','cancelled','expired'].includes(outcome.kind)) throw new Error('审批响应不合法');
      if(request.kind==='question' && !['answered','cancelled','expired'].includes(outcome.kind)) throw new Error('问答响应不合法');
      if(outcome.kind==='answered' && request.requiresInput && !outcome.answer?.trim()) throw new Error('回答不能为空');
      request.outcome=structuredClone(outcome);
    },{type:'interaction:resolved',details:{interactionId,outcome:outcome.kind},operationId:record.interactions[interactionId]?.operationId});
    if(['cancelled','expired','rejected'].includes(outcome.kind)){await this.cancel(id,`人工交互${outcome.kind==='expired'?'已过期':outcome.kind==='rejected'?'已拒绝':'已取消'}`);return;}
    await this.wait(id);await this.resume(id);
  }
  async reconcile(id:string,operationId:string,result:import('../skills/skill-types').SkillResult|null):Promise<void> {
    const record=this.records.get(id);if(!record) throw new Error('没有可核对的操作');this.assertCurrent(record);
    await this.commit(record,draft=>{
      const operation=draft.operations[operationId];
      if(!operation || (operation.status!=='unknown' && operation.result?.outcome!=='unknown') || this.active.has(id)) throw new Error('没有可核对的操作');
      if(this.inFlight.get(id)?.has(operationId)) throw new Error('操作仍在实际执行或保存结果，请等待结束后再核对，避免重复执行');
      operation.status=result?'finished':'planned';operation.result=result?structuredClone(result):undefined;
      if(!result) for(const [key,interaction] of Object.entries(draft.interactions)) if(interaction.operationId===operationId) delete draft.interactions[key];
    },{type:'operation:reconciled',details:{applied:!!result},operationId});
  }
  async cancel(id:string,reason='已停止生成'):Promise<void> {
    const record=this.records.get(id);if(!record)return;
    const active=this.active.get(id);
    if(active){this.live.set(id,{...this.live.get(id),cancelling:true});this.notify(record);active.controller.abort(new DOMException(reason,'AbortError'));await active.promise;return;}
    if(['completed','cancelled'].includes(record.status)) return;this.assertCurrent(record);
    await this.commit(record,draft=>{draft.status='cancelled';draft.error=reason;for(const request of Object.values(draft.interactions)) request.outcome||={kind:'cancelled'};this.closePendingCalls(draft,reason);},{type:'run:cancelled',details:{reason}});
    const newlyActive=this.active.get(id);if(newlyActive){newlyActive.controller.abort(new DOMException(reason,'AbortError'));await newlyActive.promise;}
    await this.project(record);
  }
  private assertCurrent(record:RunRecord):void {
    if(record.sessionId!==this.chat.getSessionInfo().sessionId || this.list(record.sessionId)[0]?.id!==record.id) throw new Error('此操作不属于当前会话最新运行，请先打开对应会话');
  }
  private closePendingCalls(record:RunRecord,reason:string):void {
    const done=new Set(record.messages.filter(message=>message.role==='tool').map(message=>message.tool_call_id));
    for(const message of [...record.messages]) for(const call of message.tool_calls || []) if(!done.has(call.id)) {
      const operation=record.operations[call.id];record.messages.push({role:'tool',name:call.name,tool_call_id:call.id,content:operation?.result?JSON.stringify(operation.result):`Error: ${reason}；未执行或结果尚未确认，请先核对。`,timestamp:Date.now()});done.add(call.id);
    }
  }
  private async drive(record:RunRecord,resume:boolean):Promise<void> {
    if(record.status!=='running' || this.disposed) return;
    const controller=new AbortController();
    const context:AgentContext={messages:resume?structuredClone(record.messages):structuredClone(record.messages.slice(0,record.baseMessageCount)),sessionId:record.sessionId,runId:record.id,
      abortSignal:controller.signal,pendingSteerMessages:[],runtime:this.runtime(record),metadata:{recoverFromTruncation:resume && [...record.events].reverse().find(event=>event.type==='model:result')?.details?.finishReason==='length',maxTurns:record.maxTurns,resume,providerId:record.providerId,enableSkills:record.enableSkills},
      onCheckpoint:async messages=>{
        const snapshot=structuredClone(messages);
        await this.commit(record,draft=>{
          draft.messages=snapshot;draft.partial=undefined;
          const included=new Set(snapshot.map(message=>message.metadata?.instructionId));
          for(const instruction of draft.instructions || []) if(included.has(instruction.id)) instruction.status='consumed';
        });
        await this.project(record);
      }};
    const promise=Promise.resolve().then(async()=>{
      try {
        await this.execute(record.prompt,context);
        await this.commit(record,draft=>{
          const queued=draft.instructions?.some(instruction=>instruction.status==='queued') || this.pendingIngress.get(record.id)?.size;
          const pending=Object.values(draft.interactions).find(interaction=>!interaction.outcome);
          const unresolved=Object.values(draft.operations).some(operation=>operation.status==='running' || operation.status==='unknown' || operation.result?.outcome==='unknown') || this.inFlight.get(record.id)?.size;
          draft.status=pending?(pending.kind==='approval'?'waiting_for_approval':'waiting_for_user')
            :unresolved || context.metadata?.completionStatus==='max_turns_exceeded' || queued?'interrupted'
              :controller.signal.aborted?(this.disposed?'interrupted':'cancelled'):'completed';
          draft.error=pending?undefined:unresolved?'实际操作仍在执行或结果尚未核对，不能确认运行完成。'
            :queued?'补充指令已保存但尚未处理，请从检查点继续。':draft.status==='interrupted'?'本次执行达到轮次上限，可从检查点继续。':undefined;
        },{type:draft=>`run:${draft.status}`});
      }catch(error){
        if(error instanceof RunSuspended) return;
        const status=this.disposed || error instanceof RunBlocked?'interrupted':isAbortError(error)?'cancelled':'failed';
        await this.commit(record,draft=>{draft.status=status;draft.error=error instanceof Error?error.message:String(error);},{type:`run:${status}`,details:errorDetails(error)});
      }finally{this.active.delete(record.id);this.live.delete(record.id);this.notify(record);}
    }).catch(error=>{this.observer?.error('runtime:boundary:failed',error,{component:'runtime',runId:record.id,sessionId:record.sessionId});console.error('[RunController] Persistence/execution failed:',error);record.status='interrupted';record.error=String(error);this.active.delete(record.id);this.notify(record);});
    this.active.set(record.id,{controller,context,promise});await promise;
  }
  async steer(id:string,text:string):Promise<boolean> {
    const active=this.active.get(id),record=this.records.get(id);
    if(!active || !record || record.status!=='running' || active.controller.signal.aborted || !text.trim()) return false;
    this.assertCurrent(record);
    const instruction={id:`instruction-${Date.now()}-${Math.random().toString(36).slice(2)}`,text,status:'queued' as const};
    const pending=this.pendingIngress.get(id)||new Set<string>();pending.add(instruction.id);this.pendingIngress.set(id,pending);
    try {await this.commit(record,draft=>{
      if(draft.status==='cancelled' || this.disposed) throw new Error('当前任务已结束，补充指令未接收；草稿已保留。');
      draft.instructions||=[];draft.instructions.push(instruction);
      if(draft.status==='completed'){draft.status='interrupted';draft.error='补充指令已保存但尚未处理，请从检查点继续。';}
    },{type:'instruction:queued',details:{instructionId:instruction.id}});}
    finally{pending.delete(instruction.id);if(!pending.size)this.pendingIngress.delete(id);}
    return true;
  }
  async wait(id:string):Promise<void>{await this.active.get(id)?.promise;}
  async dispose():Promise<void>{
    this.disposed=true;for(const item of this.active.values()) item.controller.abort(new DOMException('插件卸载，执行已中断','AbortError'));
    await Promise.all([...this.active.values()].map(item=>item.promise));await Promise.all([...this.commits.values()].map(write=>write.catch(()=>undefined)));await this.store.flush();this.unsubscribe();this.live.clear();
  }
}
