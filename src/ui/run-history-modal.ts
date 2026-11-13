import { Modal, Notice } from 'obsidian';
import type { App } from 'obsidian';
import type { RunAccess } from '../contracts/run-access';
import { errorMessage } from '../utils/execution';

export interface RunHistoryHost {
  app: App;
  runs: Pick<RunAccess,'list'|'open'>;
  inspect(runId: string): void;
  activateChat(): Promise<void>;
  refreshChat(): Promise<void>;
}

export class RunHistoryModal extends Modal {
  private offset=0;
  constructor(private host: RunHistoryHost) { super(host.app); }
  onOpen(): void { this.render(); }
  private render(): void {
    this.contentEl.empty();this.contentEl.createEl('h2',{text:'运行记录与恢复'});
    const records=this.host.runs.list();
    if (!records.length) this.contentEl.createEl('p',{text:'暂无新版运行记录；已有聊天历史仍保留。'});
    for (const record of records.slice(this.offset,this.offset+50)) {
      const row=this.contentEl.createDiv();
      row.createEl('p',{text:`${new Date(record.createdAt).toLocaleString()} · ${record.status} · ${record.prompt.slice(0,100)}`});
      row.createEl('button',{text:'查看日志'}).addEventListener('click',()=>this.host.inspect(record.id));
      const open=row.createEl('button',{text:'打开记录'});
      open.addEventListener('click',()=>{
        if (open.disabled) return;open.disabled=true;
        void (async()=>{
          await this.host.runs.open(record.id);await this.host.activateChat();await this.host.refreshChat();this.close();
        })().catch(error=>{open.disabled=false;new Notice(errorMessage(error));});
      });
    }
    const pages=this.contentEl.createDiv();
    if (this.offset) pages.createEl('button',{text:'上一页'}).addEventListener('click',()=>{this.offset=Math.max(0,this.offset-50);this.render();});
    if (this.offset+50 < records.length) pages.createEl('button',{text:'下一页'}).addEventListener('click',()=>{this.offset+=50;this.render();});
  }
  onClose(): void { this.contentEl.empty(); }
}
