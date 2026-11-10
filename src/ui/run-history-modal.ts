import { RunInspectorModal } from './run-inspector-modal';
import { Modal, Notice } from 'obsidian';
import type MentatPlugin from '../main';
import { CHAT_VIEW_TYPE, ChatView } from './chat-view';
import { errorMessage } from '../utils/execution';

export class RunHistoryModal extends Modal {
  constructor(private plugin: MentatPlugin) { super(plugin.app); }
  onOpen(): void {
    this.contentEl.createEl('h2', { text: '运行记录与恢复' });
    const records = this.plugin.runController.list();
    if (!records.length) this.contentEl.createEl('p', { text: '暂无新版运行记录；已有聊天历史仍保留。' });
    for (const record of records) {
      const row = this.contentEl.createDiv();
      row.createEl('p', { text: `${new Date(record.createdAt).toLocaleString()} · ${record.status} · ${record.prompt.slice(0, 100)}` });
      row.createEl('button', { text: '查看日志' }).addEventListener('click', () => new RunInspectorModal(this.plugin, record.id).open());
      row.createEl('button', { text: '打开记录' }).addEventListener('click', () => {
        void (async () => {
          await this.plugin.runController.open(record.id);
          await this.plugin.activateChatView();
          const view = this.plugin.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)[0]?.view as ChatView | undefined;
          await view?.refreshRuntime();
          this.close();
        })().catch(error => new Notice(errorMessage(error)));
      });
    }
  }
  onClose(): void { this.contentEl.empty(); }
}
