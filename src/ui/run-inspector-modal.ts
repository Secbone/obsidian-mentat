import { Modal, Notice } from 'obsidian';
import type { App } from 'obsidian';
import type { RunQueries } from '../contracts/run-access';
import type { ObservationFilter, ObservationQuery } from '../contracts/observation-query';
import { renderObservationLog } from '../observability/report';

export interface RunInspectorHost {
  app: App;
  runs: Pick<RunQueries,'list'|'get'>;
  observations: ObservationQuery;
  writeLog(text: string): Promise<void>;
  reportError(error: unknown): void;
}

export class RunInspectorModal extends Modal {
  private selected: string;
  private filter = '';
  private errorsOnly = false;
  private summaryVisible = false;
  private unsubscribe?: () => void;
  private timer?: ReturnType<typeof setTimeout>;
  private searchTimer?: ReturnType<typeof setTimeout>;
  private body!: HTMLElement;
  private closed = false;
  private loading = false;
  private exporting = false;
  private cursor?: string;
  constructor(private host: RunInspectorHost, runId = '') { super(host.app); this.selected = runId; }
  onOpen(): void {
    this.closed = false;
    this.modalEl?.classList.add('mentat-run-inspector-modal');
    this.contentEl.classList.add('mentat-run-inspector');
    this.contentEl.createEl('h2', { text: 'Mentat 运行检查器' });
    const controls = this.contentEl.createDiv(); controls.classList.add('mentat-run-inspector-controls');
    const runs = controls.createEl('select', { attr: { 'aria-label': '选择运行' } });
    runs.createEl('option', { value: '', text: '全部运行与插件后台事件' });
    for (const r of this.host.runs.list()) runs.createEl('option', { value: r.id, text: `${r.id} · ${r.status}` });
    runs.value = this.selected;
    runs.addEventListener('change', () => { this.selected=runs.value; this.cursor=undefined; this.summaryVisible=false; this.render(); });
    const search = controls.createEl('input', { attr: { type: 'search', placeholder: '搜索事件、请求 ID、模块或错误', 'aria-label': '搜索日志' } });
    search.addEventListener('input', () => {
      this.filter=search.value.toLowerCase(); this.cursor=undefined;
      if (this.searchTimer) clearTimeout(this.searchTimer);
      this.searchTimer=setTimeout(()=>{this.searchTimer=undefined;if (!this.closed) this.render();},200);
    });
    const label=controls.createEl('label'), check=label.createEl('input',{type:'checkbox'});label.appendText('只看异常');
    check.addEventListener('change',()=>{this.errorsOnly=check.checked;this.cursor=undefined;this.render();});
    controls.createEl('button',{text:'刷新历史日志'}).addEventListener('click',()=>{void this.reload();});
    controls.createEl('button',{text:'显示运行摘要'}).addEventListener('click',event=>{
      this.summaryVisible=!this.summaryVisible;(event.currentTarget as HTMLButtonElement).textContent=this.summaryVisible ? '隐藏运行摘要':'显示运行摘要';this.render();
    });
    const exportButton=controls.createEl('button',{text:'导出当前筛选'});
    exportButton.addEventListener('click',()=>{
      if (this.exporting) return;this.exporting=true;exportButton.disabled=true;exportButton.textContent='正在导出…';
      void this.export().catch(error=>{this.host.reportError(error);new Notice(String(error));}).finally(()=>{
        this.exporting=false;exportButton.disabled=false;exportButton.textContent='导出当前筛选';
      });
    });
    this.body=this.contentEl.createDiv();
    this.unsubscribe=this.host.observations.subscribe(()=>{
      if (!this.timer) this.timer=setTimeout(()=>{this.timer=undefined;if (!this.closed) this.render();},500);
    });
    this.render();void this.reload();
  }
  private observationFilter(): ObservationFilter { return {runId:this.selected || undefined,errorsOnly:this.errorsOnly,search:this.filter}; }
  private async reload(): Promise<void> {
    if (this.loading) return;
    this.loading=true;
    try { await this.host.observations.refresh(); }
    catch (error) { this.host.reportError(error);new Notice(`日志读取失败：${String(error)}`); }
    finally { this.loading=false;if (!this.closed) this.render(); }
  }
  private render(): void {
    const expanded=new Set(Array.from(this.body.querySelectorAll<HTMLDetailsElement>('details[open]')).map(el=>el.dataset.eventId));
    const scroll=this.body.scrollTop;this.body.empty();
    const query=this.host.observations,health=query.health;
    let page;
    try { page=query.page(this.observationFilter(),200,this.cursor); }
    catch { this.cursor=undefined;page=query.page(this.observationFilter(),200); }
    this.body.createEl('p',{text:`日志目录：${query.folder} · ${page.total} 条匹配记录；每页最多 200 条。`});
    if (query.warnings.length) this.body.createEl('p',{cls:'mod-warning',text:`日志读取不完整：${query.warnings.join('；')}`});
    if (health.writeError || health.readError || health.dropped || health.malformed) this.body.createEl('p',{cls:'mod-warning',text:`日志可能不完整：写入 ${health.writeError || '正常'}；读取 ${health.readError || '正常'}；丢弃 ${health.dropped}；损坏行 ${health.malformed}。`});
    if (this.summaryVisible) {
      const record=this.selected ? this.host.runs.get(this.selected):undefined;
      const summary=this.selected ? query.summary(this.selected):undefined;
      this.body.createEl('p',{text:record && summary ? `状态：${record.status} · 模型请求累计 ${(summary.modelMs/1000).toFixed(2)} 秒 · 工具累计 ${(summary.toolMs/1000).toFixed(2)} 秒 · 已结束人工等待 ${(summary.waitingMs/1000).toFixed(2)} 秒 · 未闭合步骤 ${summary.incomplete}。并行请求耗时可能重叠。`:'选择一个运行后可查看摘要。'});
    }
    if (!page.events.length) this.body.createEl('p',{text:'暂无匹配记录。新事件会自动显示。'});
    this.body.createEl('p',{text:'导出包含全部匹配记录。日志文件有轮转上限，运行快照补充执行事件；异常记录条数不等于独立故障数。'});
    const navigation=this.body.createDiv();
    if (this.cursor) navigation.createEl('button',{text:'回到最新一页'}).addEventListener('click',()=>{this.cursor=undefined;this.render();});
    if (page.nextCursor) navigation.createEl('button',{text:'较早一页'}).addEventListener('click',()=>{this.cursor=page.nextCursor;this.render();});
    for (const event of page.events) {
      const details=this.body.createEl('details');details.dataset.eventId=event.eventId;details.open=expanded.has(event.eventId);
      details.createEl('summary',{text:`${new Date(event.timestamp).toLocaleTimeString()} · ${event.level} · ${event.name}${event.durationMs !== undefined ? ` · ${(event.durationMs/1000).toFixed(2)}秒`:''}`});
      // Details are created on demand, rather than formatting every event on each live refresh.
      const fill=()=>{if (details.open && !details.querySelector('pre')) details.createEl('pre',{text:JSON.stringify(event,null,2)});};
      details.addEventListener('toggle',fill);fill();
    }
    this.body.scrollTop=scroll;
  }
  private async export(): Promise<void> {
    await this.host.observations.refresh();
    await this.host.writeLog(renderObservationLog(this.host.observations,this.observationFilter()));
  }
  onClose(): void {
    this.closed=true;this.unsubscribe?.();
    if (this.timer) clearTimeout(this.timer);if (this.searchTimer) clearTimeout(this.searchTimer);
    this.contentEl.empty();
  }
}
