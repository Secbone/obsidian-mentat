import { ItemView, WorkspaceLeaf, setIcon, TFile, Notice } from 'obsidian';
import { DiagnosticsExporter } from '../../diagnostics/diagnostics-exporter';
import { ChatManager } from '../../chat/chat-manager';
import { MessageRenderer } from '../message-renderer';
import { ChatOrchestrator, ChatQueryResult } from '../../chat/chat-orchestrator';
import { FileSelectorModal } from '../file-selector-modal';
import { ConfirmationModal } from '../confirmation-modal';
import { ChatMessage } from '../../types';
import { AgentEvent, AgentContext } from '../../agents/agent-types';
import MentatPlugin from '../../main';
import { ThemeRegistry } from '../themes/registry';
import { BubbleTheme } from '../themes/bubble';
import { TerminalTheme } from '../themes/terminal';
import {
  ChatTheme,
  ThemeCallbacks,
  AssistantMessageData,
  ToolCallRender,
  StreamingBubble,
  InputAreaElements,
} from '../themes/types';
import { InputHandler, InputHandlerCallbacks } from './input-handler';

export const CHAT_VIEW_TYPE = 'mentat-chat';

interface ActiveTask {
  id: string;
  name: string;
  status: 'pending' | 'executing' | 'success' | 'error' | 'confirm';
  params?: Record<string, unknown>;
  result?: unknown;
  explanation?: string;
}

export class ChatView extends ItemView {
  plugin: MentatPlugin;
  chatManager: ChatManager;
  messageRenderer: MessageRenderer;
  chatOrchestrator: ChatOrchestrator;

  private themeRegistry: ThemeRegistry;
  private theme: ChatTheme;

  private isStreaming: boolean = false;
  private currentStreamingBubble: StreamingBubble | null = null;
  private currentAbortController: AbortController | null = null;
  private activeContext: AgentContext | null = null;

  private inputHandler: InputHandler | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: MentatPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.chatManager = new ChatManager(plugin);
    this.messageRenderer = new MessageRenderer();
    this.chatOrchestrator = plugin.chatOrchestrator;

    this.themeRegistry = new ThemeRegistry(plugin.settings.chatTheme || 'bubble');
    this.themeRegistry.register('bubble', () => new BubbleTheme(this.app, this.messageRenderer));
    this.themeRegistry.register('terminal', () => new TerminalTheme(this.app, this.messageRenderer, this.plugin.settings.terminalPreset || 'green'));
    this.theme = this.themeRegistry.getCurrent();
  }

  getViewType(): string {
    return CHAT_VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'AI Chat';
  }

  getIcon(): string {
    return 'message-square';
  }

  async onOpen(): Promise<void> {
    const callbacks: ThemeCallbacks = {
      onSend: (_text, _paths) => this.handleSend(),
      onSteer: (_text) => this.handleSteer(),
      onCancel: () => this.handleCancel(),
      onClear: () => { void this.handleClear(); },
      onConfirmApprove: (_taskId) => { /* handled by orchestrator */ },
      onConfirmReject: (_taskId) => { /* handled by orchestrator */ },
      onAddDocument: () => this.showDocumentSelector(),
      onRemoveDocument: (path) => { void this.chatManager.removeDocument(path); this.renderDocumentList(); },
      onSettings: () => {
        (this.app as unknown as { setting: { open: () => void; openTabById: (id: string) => void } }).setting.open();
        (this.app as unknown as { setting: { open: () => void; openTabById: (id: string) => void } }).setting.openTabById(this.plugin.manifest.id);
      },
      onExportDiagnostics: () => {
        DiagnosticsExporter.exportSession(this.plugin, this.chatManager);
      },
      onToggleOutput: (_typeKey) => { /* expand/collapse handled by theme */ },
    };

    this.themeRegistry.init(this.containerEl, callbacks);
    this.theme = this.themeRegistry.getCurrent();

    this.setupInputHandler();
    await this.loadHistory();
    this.renderDocumentList();
    await this.inputHandler?.restoreDraft();
  }

  async onClose(): Promise<void> {
    this.themeRegistry.dispose();
  }

  async switchTheme(themeId: string): Promise<void> {
    if (themeId === this.themeRegistry.getCurrentId()) return;
    if (this.isStreaming) return;

    this.themeRegistry.switchTo(themeId);
    this.theme = this.themeRegistry.getCurrent();
    this.setupInputHandler();
    this.renderDocumentList();
    await this.loadHistory();
    await this.inputHandler?.restoreDraft();
  }

  private get inputArea(): HTMLDivElement {
    return this.theme.getInputArea();
  }

  private get sendButton(): HTMLButtonElement {
    return this.theme.getSendButton();
  }

  private get inputEls(): InputAreaElements {
    return this.theme.createInputArea();
  }

  private setupInputHandler(): void {
    const inputCb: InputHandlerCallbacks = {
      onSend: () => this.handleSend(),
      onSteer: () => this.handleSteer(),
      getIsStreaming: () => this.isStreaming,
      getSendWithCmdEnter: () => !!this.plugin.settings.sendWithCmdEnter,
      getVaultMarkdownFiles: () => this.app.vault.getMarkdownFiles(),
      updateInputInfoBar: () => this.updateInputInfoBar(),
      saveSessionDraft: async (html: string) => {
        const sessionInfo = this.chatManager.getSessionInfo();
        const sessionId = sessionInfo.sessionId;
        if (!sessionId) return;
        const pluginData = await this.plugin.loadData() || {};
        if (!pluginData.drafts) pluginData.drafts = {};
        pluginData.drafts[sessionId] = html;
        await this.plugin.saveData(pluginData);
      },
      loadSessionDraft: async () => {
        const sessionInfo = this.chatManager.getSessionInfo();
        const sessionId = sessionInfo.sessionId;
        if (!sessionId) return null;
        const pluginData = await this.plugin.loadData();
        if (pluginData && pluginData.drafts && pluginData.drafts[sessionId]) {
          return pluginData.drafts[sessionId] as string;
        }
        return null;
      },
      clearSessionDraft: async () => {
        const sessionInfo = this.chatManager.getSessionInfo();
        const sessionId = sessionInfo.sessionId;
        if (!sessionId) return;
        const pluginData = await this.plugin.loadData();
        if (pluginData && pluginData.drafts && pluginData.drafts[sessionId]) {
          delete pluginData.drafts[sessionId];
          await this.plugin.saveData(pluginData);
        }
      },
    };

    if (this.inputHandler) {
      this.inputHandler.updateElements(this.inputArea, this.sendButton, this.inputEls);
      this.inputHandler.setupListeners();
    } else {
      this.inputHandler = new InputHandler(this.inputArea, this.sendButton, this.inputEls, inputCb);
      this.inputHandler.setupListeners();
    }
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

  // --- Send / Steer / Cancel / Clear ---

  private async handleSteer(): Promise<void> {
    if (!this.inputHandler) return;
    const text = this.inputHandler.getRawTextContent().trim();
    if (!text) return;

    this.inputHandler.clearInput();

    if (this.activeContext) {
      if (!this.activeContext.pendingSteerMessages) {
        this.activeContext.pendingSteerMessages = [];
      }
      this.activeContext.pendingSteerMessages.push(text);
    }
  }

  private async handleSend(): Promise<void> {
    if (!this.inputHandler) return;
    const userMessage = this.inputHandler.getRawTextContent();
    const referencedFiles = this.inputHandler.getContextPillPaths();

    if (!userMessage && referencedFiles.length === 0) return;

    if (userMessage.startsWith('/')) {
      const parts = userMessage.split(' ');
      const cmd = parts[0].toLowerCase();
      const arg = parts.slice(1).join(' ').trim();

      this.inputHandler.clearInput();

      if (cmd === '/clear') {
        this.handleClear();
        return;
      }
      if (cmd === '/settings') {
        (this.app as unknown as { setting: { open: () => void; openTabById: (id: string) => void } }).setting.open();
        (this.app as unknown as { setting: { open: () => void; openTabById: (id: string) => void } }).setting.openTabById(this.plugin.manifest.id);
        return;
      }
      if (cmd === '/index') {
        let filesToSearch = this.app.vault.getMarkdownFiles();
        if (arg) {
          filesToSearch = filesToSearch.filter(f => f.path.includes(arg));
        }

        if (filesToSearch.length === 0) {
          new Notice('没有找到匹配的文档以重建索引。');
          return;
        }

        const notice = new Notice(`正在重建 ${filesToSearch.length} 个文档的向量索引...`, 0);
        try {
          let processed = 0;
          await this.plugin.indexManager.indexFiles(filesToSearch, (progress: { current: number; total: number; currentFile: string }) => {
            processed = progress.current;
            notice.setMessage(`索引进度: ${progress.current}/${progress.total} - ${progress.currentFile}`);
          });
          notice.hide();
          new Notice(`✓ 成功索引了 ${processed} 个文档`);
        } catch (err) {
          notice.hide();
          new Notice(`✗ 索引失败: ${err instanceof Error ? err.message : String(err)}`);
        }
        return;
      }
      if (cmd === '/help') {
        this.theme.renderUserMessage(`
          <h3>💡 Mentat 快捷指令帮助手册</h3>
          <p>您可以在输入框中输入以下以 <code>/</code> 开头的指令快速控制智能体：</p>
          <ul>
            <li><code>/clear</code>: 清空历史会话记录</li>
            <li><code>/index [路径]</code>: 重建索引。如果指定了路径，则仅索引该路径下的笔记。</li>
            <li><code>/settings</code>: 快速打开 Mentat 插件配置面板</li>
            <li><code>/help</code>: 渲染本帮助说明</li>
          </ul>
          <p>另外，在输入文字中输入 <code>@文件名</code>，可以直接召唤出文件模糊检索卡片，将笔记以"胶囊"形式加入到当前对话上下文中。</p>
        `);
        this.theme.scrollToBottom();
        return;
      }
    }

    referencedFiles.forEach(path => { void this.chatManager.addDocument(path); });
    this.renderDocumentList();

    this.inputHandler.clearInput();

    this.theme.renderUserMessage(userMessage);

    this.currentStreamingBubble = this.theme.createStreamingBubble();

    this.isStreaming = true;
    this.theme.updateInputState({
      isStreaming: true,
      charCount: 0,
      documentCount: this.inputHandler.getContextPillPaths().length,
    });

    try {
      const contextMessages = await this.chatManager.getContextForLLM({ maxMessages: 50 });
      const activeTasks: ActiveTask[] = [];
      let currentStatus = '初始化智能体...';
      let lastToolStatus: { name: string; status: 'success' | 'error' | 'pending' } = { name: '', status: 'pending' };

      this.currentAbortController = new AbortController();

      this.activeContext = {
        messages: contextMessages as ChatMessage[],
        sessionId: this.chatManager.getSessionInfo().sessionId || Date.now().toString(),
        metadata: {
          maxTurns: this.plugin.settings.maxTurns || 20
        },
        pendingSteerMessages: [],
        abortSignal: this.currentAbortController.signal
      };

      const stream = this.chatOrchestrator.query(
        userMessage,
        {
          enableSkills: this.plugin.settings.skillsEnabled,
          maxTurns: this.plugin.settings.maxTurns || 20,
          context: this.activeContext ?? undefined
        }
      );

      let currentTurnResponse = '';
      let finalAnswer = '';
      let hasFinalAnswerTag = false;
      let current = await stream.next();

      while (!current.done) {
        const event = current.value as AgentEvent;

        if (event.type === 'steer') {
          currentTurnResponse = '';
          const steerEl = this.theme.renderSteerCard(event.message);
          if (this.currentStreamingBubble) {
            this.currentStreamingBubble.el.appendChild(steerEl);
          }
          this.theme.scrollToBottom();
        } else if (event.type === 'status') {
          currentStatus = event.message;
          this.updateStreaming(activeTasks, currentStatus, finalAnswer, currentTurnResponse);
        } else if (event.type === 'chunk') {
          currentTurnResponse += event.text;

          if (currentTurnResponse.includes('<final_answer>')) {
            hasFinalAnswerTag = true;
            const parts = currentTurnResponse.split('<final_answer>');
            const explanationPart = parts[0];
            let answerPart = parts[1] || '';

            if (answerPart.includes('</final_answer>')) {
              answerPart = answerPart.split('</final_answer>')[0];
            }

            finalAnswer = answerPart;
            this.updateStreaming(activeTasks, currentStatus, finalAnswer, explanationPart);
          } else {
            if (activeTasks.length === 0) {
              this.updateStreaming(activeTasks, currentStatus, currentTurnResponse, currentTurnResponse);
            } else {
              this.updateStreaming(activeTasks, currentStatus, finalAnswer, currentTurnResponse);
            }
          }
        } else if (event.type === 'skill_call') {
          const shortName = event.name.split(':').pop() || event.name;
          lastToolStatus = { name: shortName, status: 'pending' };

          const existingConfirmTask = activeTasks.find(t =>
            t.status === 'confirm' &&
            (t.name === event.name || `invoke:${t.name}` === event.name)
          );
          if (existingConfirmTask) {
            existingConfirmTask.status = 'executing';
            existingConfirmTask.params = event.params as Record<string, unknown> | undefined;
          } else {
            activeTasks.push({
              id: event.name + Date.now(),
              name: event.name,
              status: 'executing',
              params: event.params as Record<string, unknown> | undefined,
              explanation: currentTurnResponse.trim()
            });
          }
          currentTurnResponse = '';
          currentStatus = `执行工具: ${shortName}`;
          this.updateStreaming(activeTasks, currentStatus, finalAnswer, currentTurnResponse, true, lastToolStatus);
        } else if (event.type === 'skill_success') {
          const shortName = event.name.split(':').pop() || event.name;
          if (shortName === lastToolStatus.name) {
            lastToolStatus.status = 'success';
          }

          const task = activeTasks.find(t =>
            (t.name === event.name || `invoke:${t.name}` === event.name) &&
            t.status === 'executing'
          );
          if (task) {
            task.status = 'success';
            task.result = event.result;
          }
          currentStatus = '';
          this.updateStreaming(activeTasks, currentStatus, finalAnswer, currentTurnResponse, true, lastToolStatus);
        } else if (event.type === 'skill_error') {
          const shortName = event.name.split(':').pop() || event.name;
          if (shortName === lastToolStatus.name) {
            lastToolStatus.status = 'error';
          }

          const task = activeTasks.find(t =>
            (t.name === event.name || `invoke:${t.name}` === event.name) &&
            (t.status === 'executing' || t.status === 'confirm')
          );
          if (task) {
            task.status = 'error';
            task.result = event.error;
          }
          currentStatus = '';
          this.updateStreaming(activeTasks, currentStatus, finalAnswer, currentTurnResponse, true, lastToolStatus);
        } else if (event.type === 'confirm_request') {
          const shortName = event.skillName.split(':').pop() || event.skillName;
          lastToolStatus = { name: shortName, status: 'pending' };

          const task: ActiveTask = {
            id: event.skillName + Date.now(),
            name: event.skillName,
            status: 'confirm',
            params: event.params as Record<string, unknown> | undefined,
            explanation: currentTurnResponse.trim()
          };
          currentTurnResponse = '';
          activeTasks.push(task);

          currentStatus = `等待授权: ${shortName}`;
          this.updateStreaming(activeTasks, currentStatus, finalAnswer, currentTurnResponse, true, lastToolStatus);

          current = await stream.next();
          continue;
        }

        current = await stream.next();
      }

      if (hasFinalAnswerTag) {
        const parts = currentTurnResponse.split('<final_answer>');
        const explanationPart = parts[0].trim();
        let answerPart = parts[1] || '';
        if (answerPart.includes('</final_answer>')) {
          answerPart = answerPart.split('</final_answer>')[0];
        }
        finalAnswer = answerPart.trim();
        currentTurnResponse = explanationPart;
      } else {
        if (currentTurnResponse) {
          finalAnswer = finalAnswer ? `${finalAnswer}\n\n${currentTurnResponse}` : currentTurnResponse;
        }
      }
      this.updateStreaming(activeTasks, currentStatus, finalAnswer, '', true);

      const result = current.value as ChatQueryResult;
      await this.chatManager.replaceMessages(result.messages);

      const lastUserIndex = result.messages.map(m => m.role).lastIndexOf('user');
      const currentTurnMessages = lastUserIndex !== -1 ? result.messages.slice(lastUserIndex + 1) : result.messages;

      if (this.currentStreamingBubble) {
        const data: AssistantMessageData = {
          messages: currentTurnMessages,
          toolCalls: activeTasks.map(t => ({
            id: t.id,
            name: t.name,
            status: t.status as ToolCallRender['status'],
            params: t.params,
            result: t.result,
            explanation: t.explanation,
          })),
          explanation: currentTurnResponse || undefined,
          finalAnswer: finalAnswer || undefined,
        };
        this.theme.finalizeStreaming(this.currentStreamingBubble, data);
        this.currentStreamingBubble = null;
      }

    } catch (error) {
      console.error('Chat error:', error);
      const errMsg = error instanceof Error ? error.message : String(error);
      const isAbort = (error instanceof DOMException && error.name === 'AbortError') ||
        (error instanceof Error && error.name === 'AbortError') ||
        errMsg.toLowerCase().includes('aborted') ||
        errMsg.toLowerCase().includes('cancel');

      if (this.currentStreamingBubble) {
        if (isAbort) {
          const infoEl = this.theme.renderInfoBanner('已终止生成');
          this.currentStreamingBubble.answerContainer.appendChild(infoEl);
        } else {
          const errorEl = this.theme.renderError(`${errMsg}. Please check your AI provider settings.`);
          this.currentStreamingBubble.answerContainer.appendChild(errorEl);
        }
      }
    } finally {
      this.currentAbortController = null;

      if (this.currentStreamingBubble) {
        this.currentStreamingBubble.el.removeClass('streaming');
      }

      this.isStreaming = false;
      this.theme.updateInputState({
        isStreaming: false,
        charCount: this.inputHandler?.getRawTextContent().length ?? 0,
        documentCount: this.inputHandler?.getContextPillPaths().length ?? 0,
      });

      this.currentStreamingBubble = null;
      this.activeContext = null;
      this.inputHandler?.focusInput();
    }
  }

  private updateStreaming(
    activeTasks: ActiveTask[],
    statusMessage: string,
    finalAnswer: string,
    explanation: string,
    force: boolean = false,
    lastToolStatus?: { name: string; status: 'success' | 'error' | 'pending' }
  ): void {
    if (!this.currentStreamingBubble) return;

    const toolCallRenders: ToolCallRender[] = activeTasks.map(t => ({
      id: t.id,
      name: t.name,
      status: t.status as ToolCallRender['status'],
      params: t.params,
      result: t.result,
      explanation: t.explanation,
    }));

    this.theme.updateStreamingUI(this.currentStreamingBubble, {
      statusMessage,
      activeTasks: toolCallRenders,
      explanation,
      finalAnswer,
      force,
      lastToolStatus,
    });
  }

  private async handleClear(): Promise<void> {
    if (this.isStreaming) return;

    const confirmed = await this.confirmClear();
    if (!confirmed) return;

    this.theme.getMessagesContainer().empty();
    await this.chatManager.clearHistory();
  }

  private handleCancel(): void {
    if (this.currentAbortController) {
      this.currentAbortController.abort();
      this.currentAbortController = null;
    }
  }

  private async confirmClear(): Promise<boolean> {
    return new Promise((resolve) => {
      const modal = new ConfirmationModal(
        this.app,
        {
          skillName: 'Clear Chat',
          description: 'Clear all chat messages. This cannot be undone.',
          parameters: {},
          operationType: 'delete'
        },
        resolve
      );
      modal.open();
    });
  }

  private async loadHistory(): Promise<void> {
    const messages = await this.chatManager.getHistory();

    let i = 0;
    while (i < messages.length) {
      const msg = messages[i];
      if (msg.role === 'user') {
        this.theme.renderUserMessage(msg.content);
        i++;
      } else if (msg.role === 'assistant') {
        const group: ChatMessage[] = [];
        while (i < messages.length && messages[i].role !== 'user') {
          group.push(messages[i]);
          i++;
        }
        this.theme.renderAssistantMessage({ messages: group });
      } else {
        i++;
      }
    }

    this.theme.scrollToBottom();
  }

  // --- Input Helpers ---

  private updateInputInfoBar(): void {
    const text = this.inputHandler?.getRawTextContent() ?? '';
    const docCount = this.inputHandler?.getContextPillPaths().length ?? 0;
    this.theme.updateInputState({
      isStreaming: this.isStreaming,
      charCount: text.length,
      documentCount: docCount,
    });
  }
}
