// Chat View - Main sidebar UI component

import { ItemView, WorkspaceLeaf, setIcon, TFile, Notice } from 'obsidian';
import { DiagnosticsExporter } from '../../diagnostics/diagnostics-exporter';
import { ChatManager } from '../../chat/chat-manager';
import { MessageRenderer } from '../message-renderer';
import { ChatOrchestrator, ChatQueryResult } from '../../chat/chat-orchestrator';
import { FileSelectorModal } from '../file-selector-modal';
import { ConfirmationModal } from '../confirmation-modal';
import { TaskType, ChatMessage, ToolCall } from '../../types';
import { AgentEvent } from '../../agents/agent-types';
import PersonalAgentPlugin from '../../main';

export const CHAT_VIEW_TYPE = 'mentat-chat';

interface ActiveTask {
  id: string;
  name: string;
  status: 'pending' | 'executing' | 'success' | 'error' | 'confirm';
  params?: any;
  result?: any;
  explanation?: string;
}

export class ChatView extends ItemView {
  plugin: any;
  chatManager: ChatManager;
  messageRenderer: MessageRenderer;
  chatOrchestrator: ChatOrchestrator;

  // UI elements
  private chatContainer: HTMLElement;
  private messagesContainer: HTMLElement;
  private inputContainer: HTMLElement;
  private inputWrapper: HTMLElement;
  private inputArea: HTMLDivElement;
  private sendButton: HTMLButtonElement;
  private clearButton: HTMLButtonElement;
  private settingsButton: HTMLButtonElement;
  private exportDiagnosticsButton: HTMLButtonElement;
  private stopButton: HTMLButtonElement;
  private currentAbortController: AbortController | null = null;
  private documentPanel: HTMLElement;
  private documentList: HTMLElement;
  private addDocumentButton: HTMLButtonElement;
  private charCountEl: HTMLElement;
  private badgesEl: HTMLElement;

  // State
  private isStreaming: boolean = false;
  private currentStreamingElement: HTMLElement | null = null;
  private lastRenderedStatus: string = '';
  private lastRenderedTasksJson: string = '';
  private lastRenderedTurnResponse: string = '';
  private expandedTaskOutputs = new Set<string>();
  private lastExecutedToolName: string = '';
  private lastExecutedToolStatus: 'success' | 'error' | 'pending' = 'pending';
  private lastRenderTime: number = 0;
  private renderTimeout: any = null;

  // Steerability & Autocomplete & Draft States
  private activeContext: any | null = null;
  private activeSuggestType: 'slash' | 'mention' | null = null;
  private suggestTriggerIdx: number = -1;
  private suggestDropdown: HTMLDivElement | null = null;
  private suggestSelectedIndex: number = 0;
  private suggestFilteredItems: any[] = [];
  private suggestQuery: string = '';
  private suggestTriggerNode: Node | null = null;
  private suggestTriggerRange: Range | null = null;
  private draftSaveTimeout: any = null;

  constructor(leaf: WorkspaceLeaf, plugin: PersonalAgentPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.chatManager = new ChatManager(plugin);
    this.messageRenderer = new MessageRenderer();
    // Use shared ChatOrchestrator instance from plugin
    this.chatOrchestrator = plugin.chatOrchestrator;
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
    // Create UI structure
    this.buildUI();

    // Load chat history
    await this.loadHistory();

    // Render document list
    this.renderDocumentList();

    // Setup event listeners
    this.setupEventListeners();

    // Restore draft
    await this.restoreDraft();
  }

  private buildUI(): void {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass('mentat-chat-view');

    // Header with icon, title, and action buttons
    const header = container.createDiv('chat-header');

    // Title area (icon + text)
    const titleContainer = header.createDiv('chat-header-title');
    const iconEl = titleContainer.createDiv('chat-header-icon');
    setIcon(iconEl, 'message-square');
    titleContainer.createEl('h4', { text: 'AI Chat' });

    // Actions area (settings + clear buttons)
    const actionsContainer = header.createDiv('chat-header-actions');

    this.settingsButton = actionsContainer.createEl('button', { cls: 'chat-icon-button' });
    setIcon(this.settingsButton, 'settings');
    this.settingsButton.setAttribute('aria-label', 'Settings');

    this.clearButton = actionsContainer.createEl('button', { cls: 'chat-icon-button' });
    setIcon(this.clearButton, 'trash-2');
    this.clearButton.setAttribute('aria-label', 'Clear chat');

    this.exportDiagnosticsButton = actionsContainer.createEl('button', { cls: 'chat-icon-button' });
    setIcon(this.exportDiagnosticsButton, 'scroll');
    this.exportDiagnosticsButton.setAttribute('aria-label', 'Export Session Diagnostics');

    this.stopButton = actionsContainer.createEl('button', { cls: 'chat-icon-button' });
    setIcon(this.stopButton, 'square');
    this.stopButton.setAttribute('aria-label', 'Stop generation');
    this.stopButton.style.display = 'none';

    // Document panel (between header and messages)
    this.documentPanel = container.createDiv('document-panel');
    this.buildDocumentPanel();

    // Messages container with scrolling
    this.messagesContainer = container.createDiv('chat-messages');

    // Input container at bottom
    this.inputContainer = container.createDiv('chat-input-container');

    // Input wrapper (contains contenteditable div + send button)
    this.inputWrapper = this.inputContainer.createDiv('chat-input-wrapper');

    this.inputArea = this.inputWrapper.createEl('div', {
      cls: 'chat-input',
      attr: {
        contenteditable: 'true',
        placeholder: 'Ask me anything...'
      }
    });

    // Send button (positioned inside input via CSS)
    this.sendButton = this.inputWrapper.createEl('button', { cls: 'chat-send-button' });
    setIcon(this.sendButton, 'send');
    this.sendButton.setAttribute('aria-label', 'Send message');

    // Bottom Info Bar
    const infoBar = this.inputContainer.createDiv('chat-input-info-bar');
    this.charCountEl = infoBar.createDiv('chat-input-char-count');
    this.charCountEl.setText('0 字');
    
    this.badgesEl = infoBar.createDiv('chat-input-badges');
    this.updateInputInfoBar();
  }

  private buildDocumentPanel(): void {
    const header = this.documentPanel.createDiv('document-panel-header');
    header.createEl('h5', { text: 'Context Documents' });

    this.addDocumentButton = header.createEl('button', {
      cls: 'chat-icon-button',
      attr: { 'aria-label': 'Add document' }
    });
    setIcon(this.addDocumentButton, 'plus');

    this.documentList = this.documentPanel.createDiv('document-list');

    // Event listener for add button
    this.addDocumentButton.addEventListener('click', () => {
      this.showDocumentSelector();
    });
  }

  private showDocumentSelector(): void {
    new FileSelectorModal(this.plugin, (file) => {
      this.addDocument(file);
    }).open();
  }

  private addDocument(file: TFile): void {
    this.chatManager.addDocument(file.path);
    this.renderDocumentList();
  }

  private renderDocumentList(): void {
    this.documentList.empty();

    const selectedPaths = this.chatManager.selectedFilesList;
    const selectedFiles = selectedPaths
      .map(path => this.app.vault.getAbstractFileByPath(path))
      .filter((f): f is TFile => f instanceof TFile);

    if (selectedFiles.length === 0) {
      this.documentList.createDiv({
        cls: 'document-list-empty',
        text: 'No documents selected. Click + to add.'
      });
      return;
    }

    // Get index status
    const stats = this.plugin.indexManager.getStats();
    const hasIndex = stats.totalChunks > 0;

    selectedFiles.forEach(file => {
      const item = this.documentList.createDiv('document-item');

      const icon = item.createDiv('document-icon');
      setIcon(icon, 'file-text');

      const name = item.createDiv('document-name');
      name.setText(file.basename);

      // Add index status badge if no index exists
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
        this.chatManager.removeDocument(file.path);
        this.renderDocumentList();
      });
    });

    // Show hint if no index exists
    if (!hasIndex) {
      const hint = this.documentList.createDiv('document-list-hint');
      hint.innerHTML = `
        <div class="hint-icon">ℹ️</div>
        <div class="hint-text">
          文档尚未索引。请执行 <strong>Ctrl/Cmd+P → "Index all documents"</strong>
        </div>
      `;
    }
  }

  private setupEventListeners(): void {
    // Send on button click
    this.sendButton.addEventListener('click', () => {
      if (this.isStreaming) {
        this.handleSteer();
      } else {
        this.handleSend();
      }
    });

    // Pill click delegation
    this.inputArea.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (target.hasClass('remove-pill')) {
        const pill = target.closest('.mentat-doc-pill');
        if (pill) {
          pill.remove();
          this.updateInputInfoBar();
          this.saveDraftDebounced();
        }
      }
    });

    // Custom Key Listeners
    this.inputArea.addEventListener('keydown', (e: KeyboardEvent) => {
      // 1. Intercept keys if Autocomplete Dropdown is open
      if (this.activeSuggestType && this.suggestDropdown && this.suggestFilteredItems.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          this.suggestSelectedIndex = (this.suggestSelectedIndex + 1) % this.suggestFilteredItems.length;
          this.renderSuggestDropdownItems();
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          this.suggestSelectedIndex = (this.suggestSelectedIndex - 1 + this.suggestFilteredItems.length) % this.suggestFilteredItems.length;
          this.renderSuggestDropdownItems();
          return;
        }
        if (e.key === 'Enter') {
          e.preventDefault();
          this.handleSuggestSelect();
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          this.closeSuggest();
          return;
        }
      }

      // 2. Clear input area on Escape key (if no suggestions open)
      if (e.key === 'Escape' && !this.activeSuggestType) {
        const rawText = this.getRawTextContent();
        if (rawText || this.inputArea.querySelectorAll('.mentat-doc-pill').length > 0) {
          e.preventDefault();
          this.inputArea.innerHTML = '';
          this.updateInputInfoBar();
          this.saveDraftDebounced();
          return;
        }
      }

      // 3. Handle Send Command via configured shortcuts
      if (e.key === 'Enter') {
        const sendWithCmdEnter = !!this.plugin.settings.sendWithCmdEnter;
        const isSendKey = sendWithCmdEnter ? (e.metaKey || e.ctrlKey) : !e.shiftKey;

        if (isSendKey) {
          e.preventDefault();
          if (this.isStreaming) {
            this.handleSteer();
          } else {
            this.handleSend();
          }
        }
      }
    });

    // Handle input, caret mention triggers, and auto-save
    this.inputArea.addEventListener('input', () => {
      this.updateInputInfoBar();
      this.saveDraftDebounced();
      
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) {
        this.closeSuggest();
        return;
      }
      
      const range = sel.getRangeAt(0);
      const node = range.endContainer;
      
      if (node.nodeType === Node.TEXT_NODE) {
        const nodeText = node.textContent || '';
        const offset = range.endOffset;
        const textBeforeCaret = nodeText.slice(0, offset);
        
        // Check Slash trigger (at start of text) - trim to strip browser trailing newlines
        const fullText = this.getRawTextContent().trim();
        if (fullText.startsWith('/') && !fullText.includes('\n')) {
          const query = fullText.slice(1);
          const rangeTrigger = document.createRange();
          rangeTrigger.setStart(this.inputArea.firstChild || node, 0);
          rangeTrigger.setEnd(node, offset);
          this.triggerSuggest('slash', 0, query, this.inputArea.firstChild || node, rangeTrigger);
          return;
        }
        
        // Check Mention trigger: '@' preceding current caret position
        const lastAtIdx = textBeforeCaret.lastIndexOf('@');
        if (lastAtIdx !== -1 && !textBeforeCaret.slice(lastAtIdx, offset).includes(' ')) {
          const query = textBeforeCaret.slice(lastAtIdx + 1);
          const rangeTrigger = range.cloneRange();
          rangeTrigger.setStart(node, lastAtIdx);
          this.triggerSuggest('mention', lastAtIdx, query, node, rangeTrigger);
          return;
        }
      }
      
      this.closeSuggest();
    });

    // Settings button
    this.settingsButton.addEventListener('click', () => {
      (this.app as any).setting.open();
      (this.app as any).setting.openTabById(this.plugin.manifest.id);
    });

    // Clear conversation
    this.clearButton.addEventListener('click', () => this.handleClear());

    // Export Session Diagnostics
    this.exportDiagnosticsButton.addEventListener('click', () => {
      DiagnosticsExporter.exportSession(this.plugin, this.chatManager);
    });

    // Stop Generation
    this.stopButton.addEventListener('click', () => {
      this.handleCancel();
    });
  }

  private async handleSteer(): Promise<void> {
    const text = this.getRawTextContent().trim();
    if (!text) return;

    // Clear input & draft
    this.inputArea.innerHTML = '';
    this.updateInputInfoBar();
    this.clearDraft();

    if (this.activeContext) {
      if (!this.activeContext.pendingSteerMessages) {
        this.activeContext.pendingSteerMessages = [];
      }
      this.activeContext.pendingSteerMessages.push(text);
    }
  }

  private async handleSend(): Promise<void> {
    const userMessage = this.getRawTextContent();
    const referencedFiles = this.getContextPillPaths();

    if (!userMessage && referencedFiles.length === 0) return;

    // 1. Handle Slash commands first
    if (userMessage.startsWith('/')) {
      const parts = userMessage.split(' ');
      const cmd = parts[0].toLowerCase();
      const arg = parts.slice(1).join(' ').trim();

      // Clear input
      this.inputArea.innerHTML = '';
      this.updateInputInfoBar();
      this.clearDraft();

      if (cmd === '/clear') {
        this.handleClear();
        return;
      }
      if (cmd === '/settings') {
        (this.app as any).setting.open();
        (this.app as any).setting.openTabById(this.plugin.manifest.id);
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
          await this.plugin.indexManager.indexFiles(filesToSearch, (progress: any) => {
            processed = progress.current;
            notice.setMessage(`索引进度: ${progress.current}/${progress.total} - ${progress.currentFile}`);
          });
          notice.hide();
          new Notice(`✓ 成功索引了 ${processed} 个文档`);
        } catch (err) {
          notice.hide();
          new Notice(`✗ 索引失败: ${(err as any).message}`);
        }
        return;
      }
      if (cmd === '/help') {
        const wrapper = this.createMessageElement('assistant');
        const contentEl = wrapper.createDiv('message-content');
        contentEl.innerHTML = `
          <h3>💡 Mentat 快捷指令帮助手册</h3>
          <p>您可以在输入框中输入以下以 <code>/</code> 开头的指令快速控制智能体：</p>
          <ul>
            <li><code>/clear</code>: 清空历史会话记录</li>
            <li><code>/index [路径]</code>: 重建索引。如果指定了路径，则仅索引该路径下的笔记。</li>
            <li><code>/settings</code>: 快速打开 Mentat 插件配置面板</li>
            <li><code>/help</code>: 渲染本帮助说明</li>
          </ul>
          <p>另外，在输入文字中输入 <code>@文件名</code>，可以直接召唤出文件模糊检索卡片，将笔记以“胶囊”形式加入到当前对话上下文中。</p>
        `;
        this.scrollToBottom();
        return;
      }
    }

    // 2. Add referenced files to context manager
    referencedFiles.forEach(path => this.chatManager.addDocument(path));
    this.renderDocumentList();

    // Clear input
    this.inputArea.innerHTML = '';
    this.updateInputInfoBar();
    this.clearDraft();

    // Add user message to UI only (not to history yet)
    this.addUserMessage(userMessage);

    // Prepare assistant message container
    const wrapper = this.createMessageElement('assistant');
    this.currentStreamingElement = wrapper.createDiv('message-content');
    this.currentStreamingElement.addClass('streaming');

    // Initialize decoupled sub-containers for jitter-free double-container streaming
    this.currentStreamingElement.createDiv('tui-console-container');
    this.currentStreamingElement.createDiv('final-answer-container');

    // Reset last rendered states
    this.lastRenderedStatus = '';
    this.lastRenderedTasksJson = '';

    // Add copy button immediately
    this.addCopyButtonToMessage(this.currentStreamingElement);

    // Scroll to bottom
    this.scrollToBottom();

    // Enable streaming steer mode state UI
    this.isStreaming = true;
    this.inputWrapper.addClass('is-streaming');
    this.inputArea.setAttribute('placeholder', '💡 智能体正在运行... 输入以动态引导其思考方向...');
    this.sendButton.addClass('is-steer-mode');
    setIcon(this.sendButton, 'lightbulb');
    this.sendButton.setAttribute('aria-label', 'Steer agent');
    this.stopButton.style.display = 'inline-flex';

    try {
      const selectedPaths = this.chatManager.selectedFilesList;
      const selectedFiles = selectedPaths
        .map(path => this.app.vault.getAbstractFileByPath(path))
        .filter((f): f is TFile => f instanceof TFile);

      // Get conversation history (does NOT include current message)
      // Using Context.getContext() for optimized LLM context
      const contextMessages = await this.chatManager
        .getContextForLLM({ maxMessages: 50 });

      let fullResponse = '';
      const activeTasks: ActiveTask[] = [];
      let currentStatus = '初始化智能体...';

      this.currentAbortController = new AbortController();

      // Setup activeContext reference
      this.activeContext = {
        messages: contextMessages,
        sessionId: this.chatManager.getSessionInfo().sessionId || Date.now().toString(),
        metadata: {
          maxTurns: this.plugin.settings.maxTurns || 20
        },
        pendingSteerMessages: [],
        abortSignal: this.currentAbortController.signal
      };

      // Use ChatOrchestrator for skill support - RAGP event generator loop
      const stream = this.chatOrchestrator.query(
        userMessage,
        {
          enableSkills: this.plugin.settings.skillsEnabled,
          maxTurns: this.plugin.settings.maxTurns || 20,
          context: this.activeContext
        }
      );

      let currentTurnResponse = ''; // Tracks text streamed inside the current turn
      let finalAnswer = ''; // Accumulates clean final answer text
      let hasFinalAnswerTag = false; // Tracks if the current run has outputted the <final_answer> tag
      let current = await stream.next();

      while (!current.done) {
        const event = current.value as AgentEvent;

        if (event.type === 'steer') {
          currentTurnResponse = ''; // Clear current turn response to prevent bleed-through
          this.renderSteerCard(event.message, this.currentStreamingElement);
          this.scrollToBottom();
        } else if (event.type === 'status') {
          currentStatus = event.message;
          this.updateStreamingUI(currentStatus, activeTasks, finalAnswer, currentTurnResponse);
        } else if (event.type === 'chunk') {
          currentTurnResponse += event.text;

          // 黄金流式混合解析器核心分流逻辑：
          if (currentTurnResponse.includes('<final_answer>')) {
            hasFinalAnswerTag = true;
            const parts = currentTurnResponse.split('<final_answer>');
            const explanationPart = parts[0]; // 标签前的中间思维链/工具解释
            let answerPart = parts[1] || ''; // 标签后的最终答复文本

            // 流式主动剔除可能尚未闭合的 </final_answer> 标签本身，杜绝 UI 杂质
            if (answerPart.includes('</final_answer>')) {
              answerPart = answerPart.split('</final_answer>')[0];
            }

            finalAnswer = answerPart;
            // 将标签前的文本送去审计折叠面板，最终回复实时送往主气泡框，流式打字爆发！
            this.updateStreamingUI(currentStatus, activeTasks, finalAnswer, explanationPart);
          } else {
            // 未检测到最终回复标签时：
            // 如果尚无任何工具执行，作为最终答案流输出（保证冷启动流式交互）；
            // 否则全部收纳在折叠 timeline 内作为思维链
            if (activeTasks.length === 0) {
              this.updateStreamingUI(currentStatus, activeTasks, currentTurnResponse, currentTurnResponse);
            } else {
              this.updateStreamingUI(currentStatus, activeTasks, finalAnswer, currentTurnResponse);
            }
          }
        } else if (event.type === 'skill_call') {
          const shortName = event.name.split(':').pop() || event.name;
          this.lastExecutedToolName = shortName;
          this.lastExecutedToolStatus = 'pending';

          activeTasks.push({
            id: event.name + Date.now(),
            name: event.name,
            status: 'executing',
            params: event.params,
            explanation: currentTurnResponse.trim() // Capture intermediate explanation
          });
          currentTurnResponse = ''; // Reset for next turn
          currentStatus = `执行工具: ${shortName}`;
          this.updateStreamingUI(currentStatus, activeTasks, finalAnswer, currentTurnResponse, true); // force update console immediately
        } else if (event.type === 'skill_success') {
          const shortName = event.name.split(':').pop() || event.name;
          if (shortName === this.lastExecutedToolName) {
            this.lastExecutedToolStatus = 'success';
          }

          const task = activeTasks.find(t => t.name === event.name && t.status === 'executing');
          if (task) {
            task.status = 'success';
            task.result = event.result;
          }
          currentStatus = '';
          this.updateStreamingUI(currentStatus, activeTasks, finalAnswer, currentTurnResponse, true);
        } else if (event.type === 'skill_error') {
          const shortName = event.name.split(':').pop() || event.name;
          if (shortName === this.lastExecutedToolName) {
            this.lastExecutedToolStatus = 'error';
          }

          const task = activeTasks.find(t => t.name === event.name && t.status === 'executing');
          if (task) {
            task.status = 'error';
            task.result = event.error;
          }
          currentStatus = '';
          this.updateStreamingUI(currentStatus, activeTasks, finalAnswer, currentTurnResponse, true);
        } else if (event.type === 'confirm_request') {
          const shortName = event.skillName.split(':').pop() || event.skillName;
          this.lastExecutedToolName = shortName;
          this.lastExecutedToolStatus = 'pending';

          // Native user interactive confirmations (Human-in-the-loop)
          const task: ActiveTask = {
            id: event.skillName + Date.now(),
            name: event.skillName,
            status: 'confirm',
            params: event.params,
            explanation: currentTurnResponse.trim() // Capture explanation for confirm request too!
          };
          currentTurnResponse = ''; // Reset for next turn
          activeTasks.push(task);
          
          currentStatus = `等待授权: ${shortName}`;
          this.updateStreamingUI(currentStatus, activeTasks, finalAnswer, currentTurnResponse, true);

          // Wait for Obsidian modal feedback asynchronously
          const approved = await new Promise<boolean>((resolve) => {
            new ConfirmationModal(
              this.app,
              {
                skillName: event.skillName,
                description: event.message || '',
                parameters: event.params || {},
                operationType: 'write'
              },
              (confirmed) => resolve(confirmed)
            ).open();
          });

          // Feed approved response back to generator
          if (approved) {
            task.status = 'executing';
            this.lastExecutedToolStatus = 'pending';
          } else {
            task.status = 'error';
            task.result = 'User cancelled execution';
            this.lastExecutedToolStatus = 'error';
          }

          this.updateStreamingUI(currentStatus, activeTasks, finalAnswer, currentTurnResponse, true);
          
          if (event.resolve) {
            event.resolve({ approved });
            current = await stream.next();
          } else {
            current = await stream.next({ approved });
          }
          continue;
        }

        current = await stream.next();
      }

      // End of streaming loop: consolidate final answer safely
      if (hasFinalAnswerTag) {
        const parts = currentTurnResponse.split('<final_answer>');
        const explanationPart = parts[0].trim();
        let answerPart = parts[1] || '';
        if (answerPart.includes('</final_answer>')) {
          answerPart = answerPart.split('</final_answer>')[0];
        }
        finalAnswer = answerPart.trim();
        // 将思维解释赋给 currentTurnResponse 以便记录到历史消息
        currentTurnResponse = explanationPart;
      } else {
        if (currentTurnResponse) {
          finalAnswer = finalAnswer ? `${finalAnswer}\n\n${currentTurnResponse}` : currentTurnResponse;
        }
      }
      this.updateStreamingUI(currentStatus, activeTasks, finalAnswer, '', true);

      const result = current.value as ChatQueryResult;

      // Replace history with complete messages (includes context + new messages with tool calls)
      await this.chatManager.replaceMessages(result.messages);

      // Render the final assistant bubble with collapsed logs for clean persistent UI
      const index = this.messagesContainer.children.length - 1;
      const lastBubble = this.messagesContainer.children[index] as HTMLElement;
      
      // If we rendered the streaming bubble, replace it with the clean rendered static message
      if (lastBubble && lastBubble.hasClass('chat-message-assistant')) {
        lastBubble.remove();
      }
      
      // Find all messages belonging to the current assistant turn (everything after the last user message)
      const lastUserIndex = result.messages.map(m => m.role).lastIndexOf('user');
      const currentTurnMessages = lastUserIndex !== -1 ? result.messages.slice(lastUserIndex + 1) : result.messages;

      // Render the permanent chronological timeline message
      this.renderAssistantMessage(currentTurnMessages, this.messagesContainer);

    } catch (error) {
      console.error('Chat error:', error);
      const errMsg = (error as any).message || String(error);
      const isAbort = (error instanceof DOMException && error.name === 'AbortError') || 
                      ((error as any).name === 'AbortError') || 
                      errMsg.toLowerCase().includes('aborted') || 
                      errMsg.toLowerCase().includes('cancel');

      if (this.currentStreamingElement) {
        const answerContainer = this.currentStreamingElement.querySelector('.final-answer-container') as HTMLElement;
        if (answerContainer) {
          if (isAbort) {
            const infoDiv = answerContainer.createDiv({ cls: 'chat-info-banner' });
            infoDiv.setText('已终止生成');
            infoDiv.style.color = 'var(--text-muted)';
            infoDiv.style.marginTop = '10px';
            infoDiv.style.padding = '8px';
            infoDiv.style.borderRadius = '4px';
            infoDiv.style.backgroundColor = 'var(--background-secondary)';
            infoDiv.style.fontSize = 'var(--font-smaller)';
            infoDiv.style.borderLeft = '3px solid var(--text-muted)';
          } else {
            const errorDiv = answerContainer.createDiv({ cls: 'chat-error-banner' });
            errorDiv.setText(`Error: ${errMsg}. Please check your AI provider settings.`);
            errorDiv.style.color = 'var(--text-error)';
            errorDiv.style.marginTop = '10px';
            errorDiv.style.padding = '8px';
            errorDiv.style.borderRadius = '4px';
            errorDiv.style.backgroundColor = 'var(--background-modifier-error)';
            errorDiv.style.fontSize = 'var(--font-smaller)';
            errorDiv.style.borderLeft = '3px solid var(--text-error)';
          }
        } else {
          this.currentStreamingElement.setText(
            isAbort ? '已终止生成' : `Error: ${errMsg}. Please check your AI provider settings.`
          );
        }
      }
    } finally {
      // Hide stop button and reset controller
      this.stopButton.style.display = 'none';
      this.currentAbortController = null;

      // Remove streaming indicator
      this.currentStreamingElement?.removeClass('streaming');

      // Re-enable input state UI
      this.isStreaming = false;
      this.inputWrapper.removeClass('is-streaming');
      this.inputArea.setAttribute('placeholder', 'Ask me anything...');
      this.sendButton.removeClass('is-steer-mode');
      setIcon(this.sendButton, 'send');
      this.sendButton.setAttribute('aria-label', 'Send message');

      this.currentStreamingElement = null;
      this.activeContext = null;
      this.updateInputInfoBar();
      this.inputArea.focus();
    }
  }

  private addUserMessage(content: string): void {
    if (content.startsWith('[HUMAN DYNAMIC INTERVENTION]:')) {
      const steerText = content.replace('[HUMAN DYNAMIC INTERVENTION]:', '').trim();
      this.renderSteerCard(steerText, this.messagesContainer);
      this.scrollToBottom();
      return;
    }

    const wrapper = this.createMessageElement('user');
    const contentEl = wrapper.createDiv('message-content');
    contentEl.innerHTML = this.messageRenderer.render(content);

    // Add copy button to message
    this.addCopyButtonToMessage(contentEl);

    this.setupCodeCopyButtons(wrapper);
    this.setupMessageCopyButtons(wrapper);
    this.scrollToBottom();
  }

  private createMessageElement(role: 'user' | 'assistant'): HTMLElement {
    const messageEl = this.messagesContainer.createDiv(`chat-message chat-message-${role}`);

    // Avatar
    const avatarEl = messageEl.createDiv('message-avatar');
    setIcon(avatarEl, role === 'user' ? 'user' : 'bot');

    // Message wrapper (contains role label and content)
    const wrapper = messageEl.createDiv('message-wrapper');

    // Role label
    const roleEl = wrapper.createDiv('message-role');
    roleEl.setText(role === 'user' ? 'You' : 'Assistant');

    return wrapper;
  }

  private scrollToBottom(): void {
    if (typeof this.messagesContainer.scrollTo === 'function') {
      this.messagesContainer.scrollTo({
        top: this.messagesContainer.scrollHeight,
        behavior: 'smooth'
      });
    } else {
      this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
    }
  }

  private autoResizeTextarea(): void {}

  private setupCodeCopyButtons(messageEl: HTMLElement): void {
    const copyButtons = messageEl.querySelectorAll('.code-copy-button');
    copyButtons.forEach(button => {
      button.addEventListener('click', async (e) => {
        const target = e.currentTarget as HTMLElement;
        const codeId = target.getAttribute('data-code-id');
        const codeEl = document.getElementById(codeId!);

        if (codeEl) {
          await navigator.clipboard.writeText(codeEl.textContent || '');
          const originalText = target.textContent;
          target.textContent = 'Copied!';
          setTimeout(() => {
            target.textContent = originalText;
          }, 2000);
        }
      });
    });
  }

  private addCopyButtonToMessage(contentEl: HTMLElement): void {
    const copyButton = contentEl.createEl('button', {
      cls: 'message-copy-button',
      attr: { 'aria-label': 'Copy message' }
    });
    copyButton.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;
  }

  private setupMessageCopyButtons(wrapper: HTMLElement): void {
    const copyButton = wrapper.querySelector('.message-copy-button') as HTMLButtonElement;
    const messageContent = wrapper.querySelector('.message-content') as HTMLElement;

    if (copyButton && messageContent) {
      copyButton.addEventListener('click', async (e) => {
        e.stopPropagation();

        // Get a clone and remove the copy button from it to avoid copying button text
        const clone = messageContent.cloneNode(true) as HTMLElement;
        const buttonInClone = clone.querySelector('.message-copy-button');
        if (buttonInClone) {
          buttonInClone.remove();
        }

        // Extract text content (removes HTML tags)
        const textContent = clone.textContent || '';

        try {
          await navigator.clipboard.writeText(textContent);

          // Visual feedback - change to checkmark
          const originalHTML = copyButton.innerHTML;
          copyButton.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;

          setTimeout(() => {
            copyButton.innerHTML = originalHTML;
          }, 2000);
        } catch (err) {
          console.error('Failed to copy message:', err);
        }
      });
    }
  }

  private async handleClear(): Promise<void> {
    if (this.isStreaming) return;

    // Confirm before clearing
    const confirmed = await this.confirmClear();
    if (!confirmed) return;

    // Clear UI
    this.messagesContainer.empty();

    // Clear history
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

    // Group consecutive assistant/tool turns after each user message
    let i = 0;
    while (i < messages.length) {
      const msg = messages[i];
      if (msg.role === 'user') {
        this.addUserMessage(msg.content);
        i++;
      } else if (msg.role === 'assistant') {
        // Collect all assistant and tool messages until the next user message
        const group: ChatMessage[] = [];
        while (i < messages.length && messages[i].role !== 'user') {
          group.push(messages[i]);
          i++;
        }
        this.renderAssistantMessage(group, this.messagesContainer);
      } else {
        // Skip system or other message types
        i++;
      }
    }

    this.scrollToBottom();
  }

  /**
   * Renders an assistant message bubble with its tool executions bundled in a collapsible TUI terminal console block
   */
  private renderAssistantMessage(
    turnMessages: ChatMessage[],
    container: HTMLElement
  ): HTMLElement {
    const wrapper = container.createDiv('chat-message chat-message-assistant');

    // Avatar
    const avatarEl = wrapper.createDiv('message-avatar');
    setIcon(avatarEl, 'bot');

    const msgWrapper = wrapper.createDiv('message-wrapper');
    const roleEl = msgWrapper.createDiv('message-role');
    roleEl.setText('Assistant');

    const contentEl = msgWrapper.createDiv('message-content');

    const assistantMsgs = turnMessages.filter(m => m.role === 'assistant' && !m.metadata?.isSubagent);
    const lastAssistantMsg = assistantMsgs[assistantMsgs.length - 1];

    if (assistantMsgs.length === 0) return wrapper;

    const allToolCalls = assistantMsgs.reduce<ToolCall[]>((acc, m) => {
      if (m.tool_calls) {
        acc.push(...m.tool_calls);
      }
      return acc;
    }, []);

    // Check if interrupted (limit reached)
    const isInterrupted = !!(lastAssistantMsg && lastAssistantMsg.metadata?.isMaxTurnsReached);

    // 1. Build TUI Console for Tool Calls if any
    if (allToolCalls.length > 0) {
      const consoleEl = contentEl.createEl('details', { cls: 'tui-console' });
      
      // Render Summary Header
      const consoleSummary = consoleEl.createEl('summary', { cls: 'tui-console-summary' });
      const summaryTextEl = consoleSummary.createSpan({ cls: 'tui-console-status' });
      
      const totalTools = allToolCalls.length;
      
      // Determine if any of the tool calls had an error
      let hasError = false;
      const responses: { isSuccess: boolean; responseMsg?: ChatMessage }[] = [];
      for (const tc of allToolCalls) {
        const responseMsg = turnMessages.find(
          m => m.role === 'tool' && m.tool_call_id === tc.id
        );
        const isSuccess = responseMsg && !responseMsg.content.startsWith('Error:');
        if (responseMsg && !isSuccess) {
          hasError = true;
        }
        responses.push({ isSuccess: !!isSuccess, responseMsg });
      }
      
      let summaryText = '';
      if (isInterrupted) {
        summaryText = `⚠️ 运行中断 (已执行 ${totalTools} 个工具)...`;
      } else if (hasError) {
        summaryText = `✗ 任务完成，有工具调用错误 (共调用 ${totalTools} 个工具)`;
      } else {
        summaryText = `✔ 任务完成 (共调用 ${totalTools} 个工具)`;
      }
      summaryTextEl.setText(summaryText);
      
      const consoleBody = consoleEl.createDiv('tui-console-body');

      // Now, render the timeline chronologically!
      for (let index = 0; index < turnMessages.length; index++) {
        const turnMsg = turnMessages[index];
        
        if (turnMsg.role === 'assistant') {
          const isLastMsg = turnMsg === lastAssistantMsg;
          const showContentAsExplanation = turnMsg.content && (isInterrupted || !isLastMsg);
          
          if (showContentAsExplanation) {
            let rawContent = turnMsg.content || '';
            let explanationPart = rawContent;
            // 静态剥离最终答复部分，只在 timeline 审计折叠框里保留纯净的思维链
            if (rawContent.includes('<final_answer>')) {
              explanationPart = rawContent.split('<final_answer>')[0].trim();
            }
            const cleanExplanation = explanationPart;
            if (cleanExplanation.trim()) {
              const expDiv = consoleBody.createDiv('tui-explanation');
              expDiv.innerHTML = this.messageRenderer.render(cleanExplanation);
            }
          }
          
          if (turnMsg.tool_calls) {
            for (const tc of turnMsg.tool_calls) {
              const responseMsg = turnMessages.find(
                m => m.role === 'tool' && m.tool_call_id === tc.id
              );
              const isSuccess = responseMsg && !responseMsg.content.startsWith('Error:');
              
              let displayName = tc.name;
              if (tc.name === 'spec' || tc.name === 'invoke') {
                try {
                  const args = typeof tc.arguments === 'string' ? JSON.parse(tc.arguments) : tc.arguments;
                  const skillName = args.skill_name;
                  if (skillName) {
                    displayName = `${tc.name}:${skillName}`;
                  }
                } catch (e) {
                  // Keep original if parsing fails
                }
              }
              const shortName = displayName.split(':').pop() || displayName;
              
              // Create collapsible details block
              const details = consoleBody.createEl('details', { cls: 'tui-line-item' });
              const summary = details.createEl('summary', { cls: 'tui-line-summary' });
              
              // Status indicator icon
              const icon = isSuccess ? '✔' : (responseMsg ? '✗' : '⠋');
              const statusClass = isSuccess ? 'success' : (responseMsg ? 'error' : 'pending');
              
              summary.innerHTML = `<span class="tui-icon ${statusClass}">${icon}</span> <span class="tui-tool-name">${shortName}</span>`;
              
              const detailsBody = details.createDiv('tui-line-details');
              
              if (tc.arguments) {
                this.renderTruncatedText(
                  detailsBody,
                  'Parameters',
                  tc.arguments,
                  `${tc.id}-params`
                );
              }
              
              if (responseMsg) {
                this.renderTruncatedText(
                  detailsBody,
                  'Response',
                  responseMsg.content,
                  `${tc.id}-result`
                );
              }

              // Render subagent trace if present
              const subAgentMsgs = turnMessages.filter(m => m.metadata?.parentToolCallId === tc.id);
              if (subAgentMsgs.length > 0) {
                const subDetails = detailsBody.createEl('details', { cls: 'subagent-trace-console' });
                const subSummary = subDetails.createEl('summary', { cls: 'subagent-trace-summary' });
                subSummary.setText('🤖 查看子智能体运行明细...');
                const subBody = subDetails.createDiv('subagent-trace-body');
                
                subAgentMsgs.forEach(msg => {
                  const roleClass = msg.role === 'user' ? 'user' : (msg.role === 'assistant' ? 'assistant' : 'system');
                  const bubble = subBody.createDiv(`subagent-msg subagent-msg-${roleClass}`);
                  bubble.createDiv('subagent-msg-role').setText(msg.role.toUpperCase());
                  
                  if (msg.tool_calls && msg.tool_calls.length > 0) {
                    const toolInfo = bubble.createDiv('subagent-msg-tools');
                    msg.tool_calls.forEach(stc => {
                      const toolCallEl = toolInfo.createDiv('subagent-msg-tool-call');
                      toolCallEl.setText(`调用工具: ${stc.name}(${typeof stc.arguments === 'string' ? stc.arguments : JSON.stringify(stc.arguments)})`);
                    });
                  }
                  
                  if (msg.content) {
                    const contentDiv = bubble.createDiv('subagent-msg-content');
                    contentDiv.innerHTML = this.messageRenderer.render(msg.content);
                  }
                });
              }
            }
          }
        }
      }
    }

    // 2. Render Final Answer / Warning Callouts
    // 对最终静态气泡渲染中的最终回复做自适应标签剥离与清洗
    let rawContent = lastAssistantMsg.content || '';
    let parsedAnswer = rawContent;
    if (rawContent.includes('<final_answer>')) {
      const parts = rawContent.split('<final_answer>');
      let answerPart = parts[1] || '';
      if (answerPart.includes('</final_answer>')) {
        answerPart = answerPart.split('</final_answer>')[0];
      }
      parsedAnswer = answerPart.trim();
    }

    if (isInterrupted) {
      // Render warning card
      const warningDiv = contentEl.createDiv('chat-warning-callout');
      const warningHeader = warningDiv.createDiv('chat-warning-callout-header');
      const limit = this.plugin.settings.maxTurns || 20;
      warningHeader.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>
        已达到最大运行迭代次数限制 (${limit} 轮)
      `;
      const warningText = warningDiv.createDiv();
      warningText.setText('智能体已被系统强制挂起，以防陷入无限循环。如果任务还未完成，您可以发送指令“继续”让其继续执行。');
      
      // Render last partial text if any
      const cleanAnswer = parsedAnswer;
      if (cleanAnswer.trim()) {
        const answerEl = contentEl.createDiv('final-answer');
        answerEl.innerHTML = this.messageRenderer.render(cleanAnswer);
      }
    } else {
      const cleanAnswer = parsedAnswer;
      if (cleanAnswer.trim()) {
        const answerEl = contentEl.createDiv('final-answer');
        answerEl.innerHTML = this.messageRenderer.render(cleanAnswer);
      }
    }

    // Add copy buttons and setup
    this.addCopyButtonToMessage(contentEl);
    this.setupCodeCopyButtons(wrapper);
    this.setupMessageCopyButtons(msgWrapper);

    return wrapper;
  }



  /**
   * Helper to render a code block with smart click-to-expand truncation
   */
  private renderTruncatedText(
    container: HTMLElement,
    label: string,
    value: any,
    typeKey: string,
    onToggle?: () => void
  ): void {
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    const threshold = 500;

    const pre = container.createEl('pre');

    if (text.length <= threshold) {
      pre.createEl('code', { text: `${label}: ${text}` });
      return;
    }

    const code = pre.createEl('code');
    const isExpanded = this.expandedTaskOutputs.has(typeKey);

    if (isExpanded) {
      code.setText(`${label}: ${text}`);

      const toggleBtn = pre.createEl('a', {
        cls: 'tui-truncation-btn',
        text: ' [Collapse Content ▴]'
      });

      toggleBtn.addEventListener('click', (e) => {
        e.preventDefault();
        this.expandedTaskOutputs.delete(typeKey);
        if (onToggle) {
          onToggle();
        } else {
          // Re-render locally if no global stream redraw is provided
          pre.remove();
          this.renderTruncatedText(container, label, value, typeKey);
        }
      });
    } else {
      const truncated = text.slice(0, 400);
      code.setText(`${label}: ${truncated}...`);

      const toggleBtn = pre.createEl('a', {
        cls: 'tui-truncation-btn',
        text: ` [Show Full Content (${text.length} chars) ▾]`
      });

      toggleBtn.addEventListener('click', (e) => {
        e.preventDefault();
        this.expandedTaskOutputs.add(typeKey);
        if (onToggle) {
          onToggle();
        } else {
          // Re-render locally if no global stream redraw is provided
          pre.remove();
          this.renderTruncatedText(container, label, value, typeKey);
        }
      });
    }
  }

  /**
   * Live-updates the streaming assistant bubble with the real-time TUI terminal status and Markdown text chunks
   */
  private updateStreamingUI(
    statusMsg: string,
    activeTasks: ActiveTask[],
    fullResponse: string,
    currentTurnResponse: string = '',
    force: boolean = false
  ): void {
    if (!this.currentStreamingElement) return;

    const consoleContainer = this.currentStreamingElement.querySelector('.tui-console-container') as HTMLElement;
    const answerContainer = this.currentStreamingElement.querySelector('.final-answer-container') as HTMLElement;
    if (!consoleContainer || !answerContainer) return;

    // Check if we need to update the console (only when statusMsg, activeTasks, or currentTurnResponse change)
    const tasksJson = JSON.stringify(activeTasks);
    const cleanTurnResponse = currentTurnResponse.trim();
    const shouldUpdateConsole = force || 
      statusMsg !== this.lastRenderedStatus || 
      tasksJson !== this.lastRenderedTasksJson ||
      (cleanTurnResponse !== this.lastRenderedTurnResponse && activeTasks.length > 0);

    if (shouldUpdateConsole) {
      this.lastRenderedStatus = statusMsg;
      this.lastRenderedTasksJson = tasksJson;
      this.lastRenderedTurnResponse = cleanTurnResponse;

      // Check if details console was previously open
      const existingConsole = consoleContainer.querySelector('.tui-console') as HTMLDetailsElement | null;
      const wasConsoleOpen = existingConsole ? existingConsole.open : false;

      consoleContainer.empty();

      if (statusMsg || activeTasks.length > 0 || cleanTurnResponse) {
        const consoleEl = consoleContainer.createEl('details', { cls: 'tui-console' });
        if (wasConsoleOpen) {
          consoleEl.setAttribute('open', '');
        }

        // Render Summary Header
        const consoleSummary = consoleEl.createEl('summary', { cls: 'tui-console-summary' });
        const summaryTextEl = consoleSummary.createSpan({ cls: 'tui-console-status' });

        const totalTools = activeTasks.length;
        const runningTools = activeTasks.filter(t => t.status === 'executing' || t.status === 'pending').length;
        const failedTools = activeTasks.filter(t => t.status === 'error').length;

        let summaryText = '';
        const executingTask = activeTasks.find(t => t.status === 'executing');
        const confirmTask = activeTasks.find(t => t.status === 'confirm');

        if (confirmTask) {
          const shortName = confirmTask.name.split(':').pop() || confirmTask.name;
          summaryText = `⚠️ 等待授权 ⏳ : ${shortName}...`;
        } else if (executingTask) {
          const shortName = executingTask.name.split(':').pop() || executingTask.name;
          summaryText = `⠋ 正在运行 ⚙️ : 执行工具 ${shortName}...`;
        } else if (statusMsg) {
          summaryText = `⠋ 思考中 ↗ : ${statusMsg}`;
        } else if (cleanTurnResponse) {
          const cleanText = cleanTurnResponse.replace(/[\r\n]+/g, ' ');
          const stripped = cleanText;
          const truncated = stripped.length > 30 ? stripped.slice(-30) + '...' : stripped;
          summaryText = `⠋ 思考中 ↘ : ${truncated}`;
        } else if (runningTools > 0) {
          summaryText = `⠋ 正在运行 (已执行 ${totalTools} 个工具)...`;
        } else if (this.lastExecutedToolName) {
          if (this.lastExecutedToolStatus === 'success') {
            summaryText = `✔ 已完成 ⚙️ : 执行工具 ${this.lastExecutedToolName} (共调用 ${totalTools} 个工具)`;
          } else if (this.lastExecutedToolStatus === 'error') {
            summaryText = `✗ 失败 ⚙️ : 执行工具 ${this.lastExecutedToolName} (共调用 ${totalTools} 个工具)`;
          } else {
            summaryText = `✔ 任务完成 (共调用 ${totalTools} 个工具)`;
          }
        } else {
          if (failedTools > 0) {
            summaryText = `✗ 任务完成，有工具调用错误 (共调用 ${totalTools} 个工具)`;
          } else {
            summaryText = `✔ 任务完成 (共调用 ${totalTools} 个工具)`;
          }
        }
        summaryTextEl.setText(summaryText);

        const consoleBody = consoleEl.createDiv('tui-console-body');

        // Render chronological timeline of tasks and intermediate thoughts
        for (const task of activeTasks) {
          // Render explanation chronologically outside the tool block
          if (task.explanation) {
            const cleanExplanation = task.explanation;
            if (cleanExplanation.trim()) {
              const expDiv = consoleBody.createDiv('tui-explanation');
              expDiv.innerHTML = this.messageRenderer.render(cleanExplanation);
            }
          }

          const details = consoleBody.createEl('details', { cls: 'tui-line-item' });
          const summary = details.createEl('summary', { cls: 'tui-line-summary' });

          const shortName = task.name.split(':').pop() || task.name;

          let icon = '⠋';
          let statusClass = 'pending';
          if (task.status === 'executing') {
            icon = '⠋';
            statusClass = 'executing';
          } else if (task.status === 'success') {
            icon = '✔';
            statusClass = 'success';
          } else if (task.status === 'error') {
            icon = '✗';
            statusClass = 'error';
          } else if (task.status === 'confirm') {
            icon = '⚠️';
            statusClass = 'warning';
          }

          summary.innerHTML = `<span class="tui-icon ${statusClass}">${icon}</span> <span class="tui-tool-name">${shortName}</span>`;

          const detailsBody = details.createDiv('tui-line-details');

          if (task.params) {
            this.renderTruncatedText(
              detailsBody,
              'Parameters',
              task.params,
              `${task.id}-params`,
              () => this.updateStreamingUI(statusMsg, activeTasks, fullResponse, currentTurnResponse, true)
            );
          }

          if (task.result) {
            this.renderTruncatedText(
              detailsBody,
              'Response',
              task.result,
              `${task.id}-result`,
              () => this.updateStreamingUI(statusMsg, activeTasks, fullResponse, currentTurnResponse, true)
            );
          }
        }

        // Render current active streaming explanation at the bottom of the console timeline
        const cleanExplanationChunk = cleanTurnResponse;
        if (cleanExplanationChunk && activeTasks.length > 0 && !executingTask && !confirmTask) {
          const expDiv = consoleBody.createDiv('tui-explanation');
          expDiv.innerHTML = this.messageRenderer.render(cleanExplanationChunk) + '<span class="tui-spinner">⠋</span>';
        }
      }
    }

    // 2. Render Streaming Answer Content (Throttled for performance)
    const now = Date.now();
    const throttleInterval = 150; // ms rendering throttle to avoid UI lag

    const performRenderText = () => {
      if (!answerContainer) return;
      const cleanResponseText = fullResponse;
      if (cleanResponseText) {
        answerContainer.empty();
        const answerEl = answerContainer.createDiv('final-answer');
        answerEl.innerHTML = this.messageRenderer.render(cleanResponseText);
      } else {
        answerContainer.empty();
      }
      this.scrollToBottom();
    };

    if (force || shouldUpdateConsole || (now - this.lastRenderTime > throttleInterval)) {
      if (this.renderTimeout) {
        clearTimeout(this.renderTimeout);
        this.renderTimeout = null;
      }
      performRenderText();
      this.lastRenderTime = now;
    } else {
      if (!this.renderTimeout) {
        this.renderTimeout = setTimeout(() => {
          performRenderText();
          this.lastRenderTime = Date.now();
          this.renderTimeout = null;
        }, throttleInterval);
      }
    }
  }

  private getRawTextContent(): string {
    const clone = this.inputArea.cloneNode(true) as HTMLElement;
    const pills = clone.querySelectorAll('.mentat-doc-pill');
    pills.forEach(pill => pill.remove());
    return (clone.innerText || clone.textContent || '').trim();
  }

  private getContextPillPaths(): string[] {
    const paths: string[] = [];
    const pills = this.inputArea.querySelectorAll('.mentat-doc-pill');
    pills.forEach(pill => {
      const path = pill.getAttribute('data-path');
      if (path) paths.push(path);
    });
    return paths;
  }

  private triggerSuggest(type: 'slash' | 'mention', triggerIdx: number, query: string, node?: Node, rangeTrigger?: Range): void {
    this.activeSuggestType = type;
    this.suggestTriggerIdx = triggerIdx;
    this.suggestQuery = query.toLowerCase();
    this.suggestTriggerNode = node || null;
    this.suggestTriggerRange = rangeTrigger || null;
    
    this.updateSuggestDropdown();
  }

  private closeSuggest(): void {
    this.activeSuggestType = null;
    this.suggestTriggerIdx = -1;
    this.suggestQuery = '';
    this.suggestTriggerNode = null;
    this.suggestTriggerRange = null;
    
    if (this.suggestDropdown) {
      this.suggestDropdown.remove();
      this.suggestDropdown = null;
    }
  }

  private updateSuggestDropdown(): void {
    if (!this.suggestDropdown) {
      this.suggestDropdown = this.inputWrapper.createDiv('mentat-suggest-dropdown');
    }
    
    this.suggestDropdown.empty();
    
    if (this.activeSuggestType === 'slash') {
      const allCommands = [
        { name: '/clear', desc: '清空会话历史记录 (Clear history)' },
        { name: '/index', desc: '对指定文件重建向量索引 (Rebuild index)' },
        { name: '/settings', desc: '打开 Mentat 插件配置面板 (Open settings)' },
        { name: '/help', desc: '在对话框渲染常用帮助手册 (Show help guide)' }
      ];
      
      this.suggestFilteredItems = allCommands.filter(c => c.name.includes(this.suggestQuery));
    } else if (this.activeSuggestType === 'mention') {
      const allFiles = this.app.vault.getMarkdownFiles();
      const filtered = allFiles.filter(f => f.basename.toLowerCase().includes(this.suggestQuery));
      
      // Sort: starts with query first
      filtered.sort((a, b) => {
        const aStart = a.basename.toLowerCase().startsWith(this.suggestQuery);
        const bStart = b.basename.toLowerCase().startsWith(this.suggestQuery);
        if (aStart && !bStart) return -1;
        if (!aStart && bStart) return 1;
        return a.basename.localeCompare(b.basename);
      });
      
      this.suggestFilteredItems = filtered.slice(0, 10).map(f => ({
        name: f.basename,
        desc: f.path,
        file: f
      }));
    }
    
    if (this.suggestFilteredItems.length === 0) {
      this.closeSuggest();
      return;
    }
    
    // Normalize index
    if (this.suggestSelectedIndex >= this.suggestFilteredItems.length) {
      this.suggestSelectedIndex = 0;
    }
    
    this.renderSuggestDropdownItems();
  }

  private renderSuggestDropdownItems(): void {
    if (!this.suggestDropdown) return;
    this.suggestDropdown.empty();
    
    this.suggestFilteredItems.forEach((item, idx) => {
      const itemEl = this.suggestDropdown!.createDiv('mentat-suggest-item');
      if (idx === this.suggestSelectedIndex) {
        itemEl.addClass('is-selected');
      }
      
      const iconEl = itemEl.createSpan('mentat-suggest-item-icon');
      setIcon(iconEl, this.activeSuggestType === 'slash' ? 'terminal' : 'file-text');
      
      const nameEl = itemEl.createSpan('mentat-suggest-item-name');
      nameEl.setText(item.name);
      
      const descEl = itemEl.createSpan('mentat-suggest-item-desc');
      descEl.setText(item.desc);
      
      itemEl.addEventListener('mousedown', (e) => {
        e.preventDefault(); // Prevents inputArea from losing focus!
        e.stopPropagation();
        this.suggestSelectedIndex = idx;
        this.handleSuggestSelect();
      });
    });
  }

  private handleSuggestSelect(): void {
    const selected = this.suggestFilteredItems[this.suggestSelectedIndex];
    if (!selected) return;
    
    if (this.activeSuggestType === 'slash') {
      this.insertSlashCommand(selected.name);
    } else if (this.activeSuggestType === 'mention' && this.suggestTriggerNode && this.suggestTriggerRange) {
      this.insertPill(selected.name, selected.desc, this.suggestTriggerNode, this.suggestTriggerRange);
    }
  }

  private insertSlashCommand(command: string): void {
    if (this.suggestTriggerRange) {
      this.suggestTriggerRange.deleteContents();
      
      const cmdText = document.createTextNode(command + '\u00A0');
      this.suggestTriggerRange.insertNode(cmdText);
      
      // Move cursor after the slash command
      const range = document.createRange();
      range.setStartAfter(cmdText);
      range.collapse(true);
      const sel = window.getSelection();
      if (sel) {
        sel.removeAllRanges();
        sel.addRange(range);
      }
    } else {
      this.inputArea.innerHTML = `${command}&nbsp;`;
      // Move cursor to end
      const range = document.createRange();
      range.selectNodeContents(this.inputArea);
      range.collapse(false);
      const sel = window.getSelection();
      if (sel) {
        sel.removeAllRanges();
        sel.addRange(range);
      }
    }
    
    this.closeSuggest();
    this.updateInputInfoBar();
    this.saveDraftDebounced();
    this.inputArea.focus();
  }

  private insertPill(fileName: string, filePath: string, node: Node, rangeTrigger: Range): void {
    // Delete trigger character and the query text
    rangeTrigger.deleteContents();
    
    // Create the pill element
    const pill = document.createElement('span');
    pill.className = 'mentat-doc-pill';
    pill.setAttribute('contenteditable', 'false');
    pill.setAttribute('data-path', filePath);
    pill.innerHTML = `📄 ${fileName} <span class="remove-pill" aria-label="Remove document">×</span>`;
    
    rangeTrigger.insertNode(pill);
    
    // Insert a space after the pill to allow typing
    const space = document.createTextNode('\u00A0');
    rangeTrigger.setStartAfter(pill);
    rangeTrigger.collapse(true);
    rangeTrigger.insertNode(space);
    
    // Move selection caret after space
    const sel = window.getSelection();
    if (sel) {
      const nextRange = document.createRange();
      nextRange.setStartAfter(space);
      nextRange.collapse(true);
      sel.removeAllRanges();
      sel.addRange(nextRange);
    }
    
    this.closeSuggest();
    this.updateInputInfoBar();
    this.saveDraftDebounced();
    this.inputArea.focus();
  }

  private updateInputInfoBar(): void {
    if (!this.charCountEl || !this.badgesEl) return;
    
    const text = this.getRawTextContent();
    this.charCountEl.setText(`${text.length} 字`);
    
    this.badgesEl.empty();
    
    // Referenced documents count badge
    const filePaths = this.getContextPillPaths();
    if (filePaths.length > 0) {
      const badge = this.badgesEl.createDiv('chat-input-badge');
      badge.setText(`📎 ${filePaths.length}个文档`);
      badge.setAttribute('aria-label', `包含文档: ${filePaths.map(p => p.split('/').pop()).join(', ')}`);
    }
  }

  private saveDraftDebounced(): void {
    if (this.draftSaveTimeout) {
      clearTimeout(this.draftSaveTimeout);
    }
    
    this.draftSaveTimeout = setTimeout(async () => {
      const sessionInfo = this.chatManager.getSessionInfo();
      const sessionId = sessionInfo.sessionId;
      if (!sessionId) return;
      
      const htmlContent = this.inputArea.innerHTML;
      
      const pluginData = await this.plugin.loadData() || {};
      if (!pluginData.drafts) {
        pluginData.drafts = {};
      }
      
      // Save
      pluginData.drafts[sessionId] = htmlContent;
      await this.plugin.saveData(pluginData);
    }, 300);
  }

  private async restoreDraft(): Promise<void> {
    const sessionInfo = this.chatManager.getSessionInfo();
    const sessionId = sessionInfo.sessionId;
    if (!sessionId) return;
    
    const pluginData = await this.plugin.loadData();
    if (pluginData && pluginData.drafts && pluginData.drafts[sessionId]) {
      this.inputArea.innerHTML = pluginData.drafts[sessionId];
      
      // Move cursor to the end
      const range = document.createRange();
      range.selectNodeContents(this.inputArea);
      range.collapse(false);
      const sel = window.getSelection();
      if (sel) {
        sel.removeAllRanges();
        sel.addRange(range);
      }
      
      this.updateInputInfoBar();
    }
  }

  private async clearDraft(): Promise<void> {
    const sessionInfo = this.chatManager.getSessionInfo();
    const sessionId = sessionInfo.sessionId;
    if (!sessionId) return;
    
    const pluginData = await this.plugin.loadData();
    if (pluginData && pluginData.drafts && pluginData.drafts[sessionId]) {
      delete pluginData.drafts[sessionId];
      await this.plugin.saveData(pluginData);
    }
  }

  private renderSteerCard(message: string, container: HTMLElement): HTMLElement {
    const card = container.createDiv('chat-steer-card');
    
    const iconEl = card.createSpan('steer-card-icon');
    setIcon(iconEl, 'lightbulb');
    
    const contentEl = card.createDiv('steer-card-content');
    
    const titleEl = contentEl.createDiv('steer-card-title');
    titleEl.setText('人类动态引导');
    
    const textEl = contentEl.createDiv('steer-card-text');
    textEl.setText(message);
    
    return card;
  }

  async onClose(): Promise<void> {
    // Cleanup if needed
  }
}
