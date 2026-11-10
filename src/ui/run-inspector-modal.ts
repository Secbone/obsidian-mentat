import { Modal, Notice } from 'obsidian';
import type MentatPlugin from '../main';
import type { ObservationEvent } from '../observability/types';
import { projectRunEvents, summarizeRun } from '../observability/run-projection';

export class RunInspectorModal extends Modal {
  private persisted: ObservationEvent[] = [];
  private selected: string;
  private filter = '';
  private errorsOnly = false;
  private unsubscribe?: () => void;
  private timer?: ReturnType<typeof setTimeout>;
  private body!: HTMLElement;
  private closed = false;
  private loading = false;
  constructor(private plugin: MentatPlugin, runId = '') { super(plugin.app); this.selected = runId; }
  onOpen(): void {
    this.closed = false;
    this.modalEl?.classList.add('mentat-run-inspector-modal');
    this.contentEl.classList.add('mentat-run-inspector');
    this.contentEl.createEl('h2', { text: 'Mentat 运行检查器' });
    const controls = this.contentEl.createDiv();
    controls.classList.add('mentat-run-inspector-controls');
    const runs = controls.createEl('select', { attr: { 'aria-label': '选择运行' } });
    runs.createEl('option', { value: '', text: '全部运行与插件后台事件' });
    for (const r of this.plugin.runController?.list() || []) runs.createEl('option', { value: r.id, text: `${r.id} · ${r.status}` });
    runs.value = this.selected;
    runs.addEventListener('change', () => { this.selected = runs.value; this.render(); });
    const search = controls.createEl('input', { attr: { type: 'search', placeholder: '搜索事件、请求 ID、模块或错误', 'aria-label': '搜索日志' } });
    search.addEventListener('input', () => { this.filter = search.value.toLowerCase(); this.render(); });
    const label = controls.createEl('label');
    const check = label.createEl('input', { type: 'checkbox' });
    label.appendText('只看异常');
    check.addEventListener('change', () => { this.errorsOnly = check.checked; this.render(); });
    controls.createEl('button', { text: '刷新历史日志' }).addEventListener('click', () => { void this.reload(); });
    controls.createEl('button', { text: '导出当前筛选' }).addEventListener('click', () => { void this.export().catch(e => { this.plugin.observer.error('inspector:export:failed', e, { component: 'ui' }); new Notice(String(e)); }); });
    this.body = this.contentEl.createDiv();
    this.unsubscribe = this.plugin.observer.subscribe(() => {
      if (!this.timer) this.timer = setTimeout(() => { this.timer = undefined; if (!this.closed) this.render(); }, 500);
    });
    this.render();
    void this.reload();
  }
  private async reload(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    try { this.persisted = await this.plugin.observer.query(); }
    catch (error) { this.plugin.observer.error('inspector:read:failed', error, { component: 'ui' }); new Notice(`日志读取失败：${String(error)}`); }
    finally { this.loading = false; if (!this.closed) this.render(); }
  }
  private events(): ObservationEvent[] {
    const selected = this.selected ? this.plugin.runController?.get(this.selected) : undefined;
    const records = this.selected ? (selected ? [selected] : []) : this.plugin.runController?.list() || [];
    const snapshots = projectRunEvents(records);
    const indexed = new Map(snapshots.map(e => [e.eventId, this.plugin.observer.sanitize(e)]));
    for (const event of [...this.persisted, ...this.plugin.observer.snapshot()]) {
      indexed.set(event.eventId, { ...event, durationMs: event.durationMs ?? indexed.get(event.eventId)?.durationMs });
    }
    const merged = [...indexed.values()];
    return merged.filter(e => (!this.selected || e.runId === this.selected) && (!this.errorsOnly || e.level === 'warn' || e.level === 'error')
      && (!this.filter || JSON.stringify(e).toLowerCase().includes(this.filter))).sort((a,b) => a.timestamp - b.timestamp || a.sequence - b.sequence);
  }
  private render(): void {
    const expanded = new Set(Array.from(this.body.querySelectorAll<HTMLDetailsElement>('details[open]')).map(el => el.dataset.eventId));
    this.body.empty();
    const health = this.plugin.observer.store.health;
    const events = this.events();
    this.body.createEl('p', { text: `日志目录：${this.plugin.observer.store.folder} · 最近 ${events.length} 条匹配记录。历史文件有轮转上限，快照可补充执行事件。` });
    const warnings = this.plugin.runController?.store?.warnings || [];
    if (warnings.length) this.body.createEl('p', { cls: 'mod-warning', text: warnings.join('；') });
    if (health.writeError || health.readError || health.dropped || health.malformed) this.body.createEl('p', { cls: 'mod-warning', text: `日志可能不完整：写入 ${health.writeError || '正常'}；读取 ${health.readError || '正常'}；丢弃 ${health.dropped}；损坏行 ${health.malformed}。` });
    const record = this.selected ? this.plugin.runController?.get(this.selected) : undefined;
    if (record) {
      const s = summarizeRun(record);
      this.body.createEl('p', { text: `状态：${record.status} · 模型请求累计 ${(s.modelMs/1000).toFixed(2)} 秒 · 工具累计 ${(s.toolMs/1000).toFixed(2)} 秒 · 已结束人工等待 ${(s.waitingMs/1000).toFixed(2)} 秒 · 未闭合步骤 ${s.incomplete}。并行请求耗时可能重叠。` });
    }
    if (!events.length) this.body.createEl('p', { text: '暂无匹配记录。新事件会自动显示。' });
    this.body.createEl('p', { text: '显示最新 200 条；导出包含全部匹配记录。展开事件可查看关联 ID 和详情。' });
    for (const event of events.slice(-200).reverse()) {
      const details = this.body.createEl('details');
      details.dataset.eventId = event.eventId;
      details.open = expanded.has(event.eventId);
      details.createEl('summary', { text: `${new Date(event.timestamp).toLocaleTimeString()} · ${event.level} · ${event.name}${event.durationMs !== undefined ? ` · ${(event.durationMs/1000).toFixed(2)}秒` : ''}` });
      details.createEl('pre', { text: JSON.stringify(event, null, 2) });
    }
  }
  private async export(): Promise<void> {
    await this.reload();
    const events = this.events();
    const folder = 'Mentat/Diagnostics';
    const platform = this.plugin.platform;
    for (const path of ['Mentat', folder]) if (!await platform.exists(path)) await platform.mkdir(path);
    const path = `${folder}/Run_Log_${Date.now()}.md`;
    const text = `# 运行日志\n\n范围：${this.selected || '全部运行与插件后台事件'}；查询：${this.filter || '无'}；只看异常：${this.errorsOnly}。\n\n日志健康：${JSON.stringify(this.plugin.observer.store.health)}\n\n` + events.map(e => `## ${new Date(e.timestamp).toISOString()} · ${e.name}\n\n\`\`\`json\n${JSON.stringify(e,null,2)}\n\`\`\`\n`).join('\n');
    await platform.write(path, text);
    await this.app.workspace.openLinkText(path, '', true);
  }
  onClose(): void {
    this.closed = true;
    this.unsubscribe?.();
    if (this.timer) clearTimeout(this.timer);
    this.contentEl.empty();
  }
}
