import type { RunRecord } from '../../runtime/types';
import { UserInputModal } from '../user-input-modal';
import { ItemView, WorkspaceLeaf, setIcon, TFile, Notice, sanitizeHTMLToDom } from 'obsidian';
import { DiagnosticsExporter } from '../../diagnostics/diagnostics-exporter';
import { ChatManager } from '../../chat/chat-manager';
import { MessageRenderer } from '../message-renderer';
import { ChatOrchestrator } from '../../chat/chat-orchestrator';
import { FileSelectorModal } from '../file-selector-modal';
import { ChatMessage, TaskType } from '../../types';
import type { AgentEvent } from '../../agents/agent-types';
import type MentatPlugin from '../../main';
import { ThemeRegistry } from '../themes/registry';
import { BubbleTheme } from '../themes/bubble';
import { TerminalTheme } from '../themes/terminal';
import type { ChatTheme, ThemeCallbacks, InputAreaElements } from '../themes/types';
import { InputHandler, InputHandlerCallbacks } from './input-handler';
import { ConfirmationModal } from '../confirmation-modal';
import { EventBus } from '../../extensions/event-bus';
import { errorMessage } from '../../utils/execution';
import { ChatPresenter, projectRunControls } from '../chat-cards/presenter';
import type { CardAction, ChatCard, ChatViewState } from '../chat-cards/types';
import { RunInspectorModal } from '../run-inspector-modal';
import type { DraftStore } from '../../storage/draft-store';

export const CHAT_VIEW_TYPE = 'mentat-chat';

export class ChatView extends ItemView {
  plugin: MentatPlugin;
  chatManager: ChatManager;
  messageRenderer: MessageRenderer;
  chatOrchestrator: ChatOrchestrator;
  private themeRegistry: ThemeRegistry;
  private theme: ChatTheme;
  private inputHandler: InputHandler | null = null;
  private eventBus: EventBus;
  private runtimeUnsubscribe?: () => void;
  private renderTimer?: ReturnType<typeof setTimeout>;
  private history: ChatMessage[] = [];
  private closed = false;
  private sending = false;
  private draftSession = '';
  private loadingVersion = 0;
  private notice?: ChatCard;
  private presenter = new ChatPresenter();

  constructor(leaf: WorkspaceLeaf, plugin: MentatPlugin, private drafts: DraftStore = plugin.draftStore) {
    super(leaf); this.plugin = plugin;
    this.chatManager = plugin.chatManager || new ChatManager(plugin);
    this.messageRenderer = new MessageRenderer(); this.chatOrchestrator = plugin.chatOrchestrator;
    this.themeRegistry = new ThemeRegistry(plugin.settings.chatTheme || 'bubble');
    this.themeRegistry.register('bubble','卡片 · 舒适','单列卡片与分段彩色边框',() => new BubbleTheme(this.app,this.messageRenderer));
    this.themeRegistry.register('terminal','卡片 · 紧凑','相同交互，更紧凑的工具文字',() => new TerminalTheme(this.app,this.messageRenderer,plugin.settings.terminalPreset || 'green'));
    this.theme = this.themeRegistry.getCurrent();
    this.eventBus = plugin.eventBus || plugin.extensionManager.getEventBus();
  }
  getViewType(): string { return CHAT_VIEW_TYPE; }
  getDisplayText(): string { return 'AI Chat'; }
  getIcon(): string { return 'message-square'; }

  async onOpen(): Promise<void> {
    this.closed = false;
    const callbacks: ThemeCallbacks = {
      onSend: () => { void this.handleSend(); }, onCancel: () => this.handleCancel(), onClear: () => { void this.handleClear(); },
      onAddDocument: () => this.showDocumentSelector(), onSettings: () => this.openSettings(),
      onInspect: () => new RunInspectorModal(this.plugin,this.currentState().runId).open(),
      onExportDiagnostics: () => { void DiagnosticsExporter.exportSession(this.plugin,this.chatManager); },
      onCardAction: (card,action,answer) => this.handleCardAction(card,action,answer),
    };
    this.themeRegistry.init(this.containerEl,callbacks); this.theme = this.themeRegistry.getCurrent();
    this.setupInputHandler();
    // Subscribe before reading history. Rendering always reconciles against the latest runtime snapshot.
    this.runtimeUnsubscribe = this.eventBus.on('*',event => this.handleRuntimeEvent(event));
    await this.refreshRuntime();
    this.renderDocumentList(); await this.inputHandler?.restoreDraft();
  }
  async onClose(): Promise<void> {
    this.closed = true; this.loadingVersion++;
    this.runtimeUnsubscribe?.();
    if (this.renderTimer) clearTimeout(this.renderTimer);
    this.inputHandler?.dispose(); this.themeRegistry.dispose();
  }
  async refreshRuntime(): Promise<void> {
    const version = ++this.loadingVersion, session = this.chatManager.getSessionInfo().sessionId;
    const messages = await this.chatManager.getHistory();
    if (this.closed || version !== this.loadingVersion || session !== this.chatManager.getSessionInfo().sessionId) return;
    this.history = messages; this.notice = undefined;
    if (this.draftSession !== session) {
      this.setupInputHandler(); this.inputArea.replaceChildren(); await this.inputHandler?.restoreDraft();
    }
    this.render();
  }
  async switchTheme(themeId: string): Promise<void> {
    if (themeId === this.themeRegistry.getCurrentId()) return;
    const draft = this.inputArea.innerHTML;
    this.inputHandler?.dispose(); this.themeRegistry.switchTo(themeId); this.theme = this.themeRegistry.getCurrent();
    this.setupInputHandler(); this.inputArea.replaceChildren(sanitizeHTMLToDom(draft)); this.renderDocumentList(); this.render();
  }
  updateTerminalPreset(preset: string): void { this.theme.updatePreset?.(preset); }
  private get inputArea(): HTMLDivElement { return this.theme.getInputArea(); }
  private get sendButton(): HTMLButtonElement { return this.theme.getSendButton(); }
  private get inputEls(): InputAreaElements { return this.theme.getInputAreaElements(); }

  private currentState(): ChatViewState {
    const sessionId = this.chatManager.getSessionInfo().sessionId;
    const records = this.plugin.runController?.list(sessionId) || [], latest = records[0];
    this.presenter ||= new ChatPresenter();
    const state = this.presenter.project({sessionId,history:this.history || [],records,
      displayMessages:latest ? this.plugin.runController.getDisplayMessages(latest.id):undefined,
      live:latest ? this.plugin.runController.getLiveState(latest.id):undefined,
      secrets:[...(this.plugin.settings.aiProviders || []).map(p => p.apiKey || ''),this.plugin.settings.braveSearchApiKey || '',this.plugin.settings.browserlessApiKey || '']});
    if (this.notice) state.cards.push(this.notice);
    if (this.sending) { state.inputMode = 'blocked'; state.label = '正在提交任务…'; }
    return state;
  }
  private render(): void {
    if (this.closed) return;
    this.theme.render(this.currentState()); this.updateInputInfoBar();
  }
  private handleRuntimeEvent(event: AgentEvent): void {
    const latest = this.plugin.runController?.list(this.chatManager.getSessionInfo().sessionId)[0];
    if (event.sessionId !== this.chatManager.getSessionInfo().sessionId || event.runId !== latest?.id || event.agentId !== 'default-chat-agent') return;
    if (this.closed || this.renderTimer) return;
    this.renderTimer = setTimeout(() => { this.renderTimer = undefined; this.render(); },event.type === 'message:update' ? 100:0);
  }
  private openSettings(): void {
    const setting = (this.app as unknown as {setting:{open:()=>void;openTabById:(id:string)=>void}}).setting;
    setting.open(); setting.openTabById(this.plugin.manifest.id);
  }
  private showError(error: unknown): void {
    this.plugin.observer?.error('ui:chat:failed',error,{component:'ui',sessionId:this.chatManager.getSessionInfo().sessionId});
    this.notice = {id:'ui-notice',kind:'system',title:'操作未完成',status:'failed',text:errorMessage(error),timestamp:Date.now()};
    this.render();
  }
  private setupInputHandler(): void {
    const sessionId = this.chatManager.getSessionInfo().sessionId;
    this.draftSession = sessionId;
    const inputCb: InputHandlerCallbacks = {
      onSend: () => { void this.handleSend(); },
      onSteer: () => { void this.handleSteer(); },
      getIsStreaming: () => this.inputMode() === 'steer',
      getSendWithCmdEnter: () => !!this.plugin.settings.sendWithCmdEnter,
      getVaultMarkdownFiles: () => this.app.vault.getMarkdownFiles(),
      updateInputInfoBar: () => this.updateInputInfoBar(),
      saveSessionDraft: async html => { if (sessionId) await this.drafts.save(sessionId,html); },
      loadSessionDraft: () => sessionId ? this.drafts.load(sessionId) : Promise.resolve(null),
      clearSessionDraft: async () => { if (sessionId) await this.drafts.clear(sessionId); },
    };

    this.inputHandler?.dispose();
    this.inputHandler = new InputHandler(this.inputArea,this.sendButton,this.inputEls,inputCb);
    this.inputHandler.setupListeners();
  }


  // --- Document Management ---

  private showDocumentSelector(): void {
    new FileSelectorModal(this.plugin, (file) => {
      this.addDocument(file);
    }).open();
  }

  private addDocument(file: TFile): void {
    void this.chatManager.addDocument(file.path);
    this.renderDocumentList();
  }

  private renderDocumentList(): void {
    const els = this.inputEls;
    if (!els.documentList) return;
    els.documentList.empty();

    const selectedPaths = this.chatManager.selectedFilesList;
    const selectedFiles = selectedPaths
      .map(path => this.app.vault.getAbstractFileByPath(path))
      .filter((f): f is TFile => f instanceof TFile);

    if (selectedFiles.length === 0) {
      els.documentList.createDiv({
        cls: 'document-list-empty',
        text: 'No documents selected. Click + to add.'
      });
      return;
    }

    const stats = this.plugin.indexManager.getStats();
    const hasIndex = stats.totalChunks > 0;

    selectedFiles.forEach(file => {
      const item = els.documentList.createDiv('document-item');

      const icon = item.createDiv('document-icon');
      setIcon(icon, 'file-text');

      const name = item.createDiv('document-name');
      name.setText(file.basename);

      if (!hasIndex) {
        const badge = item.createDiv('document-status-badge document-status-unindexed');
        badge.setText('未索引');
        badge.setAttribute('aria-label', '此文档尚未索引，无法用于问答');
      }

      const removeBtn = item.createEl('button', {
        cls: 'document-remove-button',
        attr: { 'aria-label': 'Remove document' }
      });
      setIcon(removeBtn, 'x');

      removeBtn.addEventListener('click', () => {
        void this.chatManager.removeDocument(file.path);
        this.renderDocumentList();
      });
    });

    if (!hasIndex) {
      const hint = els.documentList.createDiv('document-list-hint');
      hint.createDiv({ cls: 'hint-icon', text: 'ℹ️' });
      const hintText = hint.createDiv({ cls: 'hint-text' });
      hintText.createSpan({ text: '文档尚未索引。请执行 ' });
      hintText.createEl('strong', { text: 'Ctrl/Cmd+P → "Index all documents"' });
    }
  }


  private async handleSteer(): Promise<void> {
    if (!this.inputHandler || this.sending) return;
    const state = this.currentState(), text = this.inputHandler.getRawTextContent().trim();
    if (!text || state.inputMode !== 'steer' || !state.runId) return;
    const handler = this.inputHandler;
    this.sending = true; this.updateInputInfoBar();
    try {
      if (!await this.plugin.runController.steer(state.runId,text)) throw new Error('当前任务已结束，指令未发送；草稿已保留。');
      if (this.inputHandler === handler && handler.getRawTextContent().trim() === text) handler.clearInput();
      this.notice = {id:'ui-notice',kind:'system',title:'补充指令已排队',text:'将在下一个执行边界处理；已开始的操作不会被改写。',timestamp:Date.now()};
    } catch (error) { this.showError(error); }
    finally { this.sending = false; this.render(); }
  }
  private async handleSend(): Promise<void> {
    if (!this.inputHandler || this.sending) return;
    const state = this.currentState();
    if (state.inputMode === 'steer') { await this.handleSteer(); return; }
    if (state.inputMode !== 'send') return;
    const text = this.inputHandler.getRawTextContent(), paths = this.inputHandler.getContextPillPaths();
    if (!text.trim() && !paths.length) return;
    if (text.startsWith('/')) { await this.handleCommand(text); return; }
    this.sending = true; this.notice = undefined; this.updateInputInfoBar();
    try {
      for (const path of paths) await this.chatManager.addDocument(path);
      this.renderDocumentList();
      const messages = await this.chatManager.getHistory();
      const provider = await this.plugin.aiRouter?.getProvider(TaskType.CHAT);
      await this.plugin.runController.start(text,{sessionId:this.chatManager.getSessionInfo().sessionId,messages,
        maxTurns:this.plugin.settings.maxTurns || 20,enableSkills:this.plugin.settings.skillsEnabled,providerId:provider?.id});
      if (this.inputHandler.getRawTextContent() === text) this.inputHandler.clearInput();
      this.history = await this.chatManager.getHistory();
    } catch (error) { this.showError(error); }
    finally { this.sending = false; this.render(); }
  }
  private async handleCommand(text: string): Promise<void> {
    const [command,...args] = text.split(' ');
    if (command === '/clear') { await this.handleClear(); return; }
    if (command === '/settings') { this.openSettings(); return; }
    if (command === '/help') {
      this.notice = {id:'ui-notice',kind:'system',title:'快捷指令',text:'/clear 新建会话；/settings 打开设置；/index [路径] 重建索引。输入 @ 可引用笔记。',timestamp:Date.now()};
      this.inputHandler?.clearInput(); this.render(); return;
    }
    if (command === '/index') {
      const files = this.app.vault.getMarkdownFiles().filter(f => !args.length || f.path.includes(args.join(' ')));
      if (!files.length) { new Notice('没有找到匹配的文档。'); return; }
      try { const result = await this.plugin.indexManager.indexFiles(files); new Notice(`已索引 ${result.length}/${files.length} 个文件`); this.inputHandler?.clearInput(); }
      catch (error) { this.showError(error); }
      return;
    }
    new Notice('未知指令，输入 /help 查看帮助。');
  }
  private handleCancel(): void {
    const id = this.currentState().runId;
    if (id) void this.plugin.runController.cancel(id).catch(error => this.showError(error));
  }
  private async handleClear(): Promise<void> {
    if (this.currentState().busy) return;
    const confirmed = await new Promise<boolean>(resolve => new ConfirmationModal(this.app,{skillName:'新建会话',description:'清空当前聊天显示，开始新会话。已有运行快照仍可从运行记录查看。',parameters:{},operationType:'delete'},resolve).open());
    if (!confirmed) return;
    await this.chatManager.clearHistory(); this.inputHandler?.clearInput(); await this.refreshRuntime();
  }
  private async handleCardAction(card: ChatCard, action: CardAction, answer?: string): Promise<void> {
    const controller = this.plugin.runController;
    try {
      if (action === 'open' && card.path) { await this.app.workspace.openLinkText(card.path,'',true); return; }
      if (!card.runId) return;
      if (action === 'inspect') { new RunInspectorModal(this.plugin,card.runId).open(); return; }
      const record = controller.get(card.runId);
      if (!record || record.sessionId !== this.chatManager.getSessionInfo().sessionId || controller.list(record.sessionId)[0]?.id !== record.id) throw new Error('此操作不属于当前最新运行，请刷新后重试。');
      if (action === 'resume') await controller.resume(record.id);
      else if (action === 'reconcile' && card.operationId) this.reconcile(record,card.operationId);
      else if (card.interaction) await controller.respond(record.id,card.interaction.id,action === 'approve' ? {kind:'approved'} : action === 'reject' ? {kind:'rejected'} : {kind:'answered',answer});
      this.render();
    } catch (error) { this.showError(error); throw error; }
  }
  private reconcile(record: RunRecord, operationId: string): void {
    new UserInputModal(this.app,'核对实际执行结果','请检查实际文件或外部操作，避免重复产生副作用。',['确认未执行，重新申请执行','确认已执行，填写结果'],undefined,true,result => {
      if (result.cancelled) return;
      if (result.answer.startsWith('确认未执行')) void this.plugin.runController.reconcile(record.id,operationId,null).catch(error => this.showError(error));
      else new UserInputModal(this.app,'填写已核验的实际结果','此结果将作为原操作结果，不会再次执行。',undefined,undefined,true,verified => {
        if (!verified.cancelled) void this.plugin.runController.reconcile(record.id,operationId,{success:true,outcome:'success',data:{verifiedByUser:true,result:verified.answer}}).catch(error => this.showError(error));
      }).open();
    }).open();
  }
  private inputMode(): ChatViewState['inputMode'] {
    if (this.sending) return 'blocked';
    const latest = this.plugin.runController?.list(this.chatManager.getSessionInfo().sessionId)[0];
    return projectRunControls(latest,latest ? this.plugin.runController.getLiveState(latest.id):undefined).inputMode;
  }
  private updateInputInfoBar(): void {
    this.theme.updateInputState({mode:this.inputMode(),charCount:this.inputHandler?.getRawTextContent().length || 0,
      documentCount:this.inputHandler?.getContextPillPaths().length || this.chatManager.selectedFilesList.length});
  }
}
