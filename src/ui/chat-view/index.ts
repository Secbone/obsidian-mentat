// Chat View - Main sidebar UI component

import { ItemView, WorkspaceLeaf, setIcon, TFile } from 'obsidian';
import PersonalAgentPlugin from '../../main';
import { DiagnosticsExporter } from '../../diagnostics/diagnostics-exporter';
import { ChatManager } from '../../chat/chat-manager';
import { MessageRenderer } from '../message-renderer';
import { ChatOrchestrator, ChatQueryResult } from '../../chat/chat-orchestrator';
import { FileSelectorModal } from '../file-selector-modal';
import { ConfirmationModal } from '../confirmation-modal';
import { TaskType, ChatMessage, ToolCall } from '../../types';
import { AgentEvent } from '../../agents/agent-types';

export const CHAT_VIEW_TYPE = 'personal-agent-chat';

interface ActiveTask {
  id: string;
  name: string;
  status: 'pending' | 'executing' | 'success' | 'error' | 'confirm';
  params?: any;
  result?: any;
  explanation?: string;
}

export class ChatView extends ItemView {
  plugin: PersonalAgentPlugin;
  chatManager: ChatManager;
  messageRenderer: MessageRenderer;
  chatOrchestrator: ChatOrchestrator;

  // UI elements
  private chatContainer: HTMLElement;
  private messagesContainer: HTMLElement;
  private inputContainer: HTMLElement;
  private inputArea: HTMLTextAreaElement;
  private sendButton: HTMLButtonElement;
  private clearButton: HTMLButtonElement;
  private settingsButton: HTMLButtonElement;
  private exportDiagnosticsButton: HTMLButtonElement;
  private documentPanel: HTMLElement;
  private documentList: HTMLElement;
  private addDocumentButton: HTMLButtonElement;

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

  constructor(leaf: WorkspaceLeaf, plugin: PersonalAgentPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.chatManager = new ChatManager(plugin, plugin.settings.contextManager);
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
  }

  private buildUI(): void {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass('personal-agent-chat-view');

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

    // Document panel (between header and messages)
    this.documentPanel = container.createDiv('document-panel');
    this.buildDocumentPanel();

    // Messages container with scrolling
    this.messagesContainer = container.createDiv('chat-messages');

    // Input container at bottom
    this.inputContainer = container.createDiv('chat-input-container');

    // Input wrapper (contains textarea + send button)
    const inputWrapper = this.inputContainer.createDiv('chat-input-wrapper');

    this.inputArea = inputWrapper.createEl('textarea', {
      cls: 'chat-input',
      attr: {
        placeholder: 'Ask me anything...',
        rows: '1'
      }
    });

    // Send button (positioned inside input via CSS)
    this.sendButton = inputWrapper.createEl('button', { cls: 'chat-send-button' });
    setIcon(this.sendButton, 'send');
    this.sendButton.setAttribute('aria-label', 'Send message');
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

    const selectedPaths = this.chatManager.getSelectedFiles();
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
    this.sendButton.addEventListener('click', () => this.handleSend());

    // Send on Enter (Shift+Enter for newline)
    this.inputArea.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.handleSend();
      }
    });

    // Auto-resize textarea as user types
    this.inputArea.addEventListener('input', () => {
      this.autoResizeTextarea();
    });

    // Settings button
    this.settingsButton.addEventListener('click', () => {
      this.app.setting.open();
      this.app.setting.openTabById(this.plugin.manifest.id);
    });

    // Clear conversation
    this.clearButton.addEventListener('click', () => this.handleClear());

    // Export Session Diagnostics
    this.exportDiagnosticsButton.addEventListener('click', () => {
      DiagnosticsExporter.exportSession(this.plugin, this.chatManager);
    });
  }

  private async handleSend(): Promise<void> {
    const userMessage = this.inputArea.value.trim();
    if (!userMessage || this.isStreaming) return;

    // Clear input
    this.inputArea.value = '';
    this.autoResizeTextarea(); // Reset height

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

    // Disable input during streaming
    this.isStreaming = true;
    this.sendButton.disabled = true;
    this.inputArea.disabled = true;

    try {
      const selectedPaths = this.chatManager.getSelectedFiles();
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

      // Use ChatOrchestrator for skill support - RAGP event generator loop
      const stream = this.chatOrchestrator.query(
        userMessage,
        {
          enableSkills: this.plugin.settings.skillsEnabled,
          contextMessages: contextMessages,
          maxTurns: this.plugin.settings.maxTurns || 20
        }
      );

      let currentTurnResponse = ''; // Tracks text streamed inside the current turn
      let finalAnswer = ''; // Accumulates clean final answer text
      let current = await stream.next();

      while (!current.done) {
        const event = current.value as AgentEvent;

        if (event.type === 'status') {
          currentStatus = event.message;
          this.updateStreamingUI(currentStatus, activeTasks, finalAnswer, currentTurnResponse);
        } else if (event.type === 'chunk') {
          currentTurnResponse += event.text;
          // If we haven't run any tools yet, stream it in final answer so the user sees real-time progress.
          // Otherwise, it is intermediate explanation text and will be shown inside the TUI console.
          if (activeTasks.length === 0) {
            this.updateStreamingUI(currentStatus, activeTasks, currentTurnResponse, currentTurnResponse);
          } else {
            this.updateStreamingUI(currentStatus, activeTasks, finalAnswer, currentTurnResponse);
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
              `Approve tool execution: ${event.skillName}`,
              event.message,
              () => resolve(true),
              () => resolve(false)
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
          current = await stream.next({ approved });
          continue;
        }

        current = await stream.next();
      }

      // End of streaming loop: consolidate final answer
      if (currentTurnResponse) {
        finalAnswer = finalAnswer ? `${finalAnswer}\n\n${currentTurnResponse}` : currentTurnResponse;
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
      if (this.currentStreamingElement) {
        const answerContainer = this.currentStreamingElement.querySelector('.final-answer-container') as HTMLElement;
        if (answerContainer) {
          const errorDiv = answerContainer.createDiv({ cls: 'chat-error-banner' });
          errorDiv.setText(`Error: ${error.message}. Please check your AI provider settings.`);
          errorDiv.style.color = 'var(--text-error)';
          errorDiv.style.marginTop = '10px';
          errorDiv.style.padding = '8px';
          errorDiv.style.borderRadius = '4px';
          errorDiv.style.backgroundColor = 'var(--background-modifier-error)';
          errorDiv.style.fontSize = 'var(--font-smaller)';
          errorDiv.style.borderLeft = '3px solid var(--text-error)';
        } else {
          this.currentStreamingElement.setText(
            `Error: ${error.message}. Please check your AI provider settings.`
          );
        }
      }
    } finally {
      // Remove streaming indicator
      this.currentStreamingElement?.removeClass('streaming');

      // Re-enable input
      this.isStreaming = false;
      this.sendButton.disabled = false;
      this.inputArea.disabled = false;
      this.currentStreamingElement = null;
      this.inputArea.focus();
    }
  }

  private addUserMessage(content: string): void {
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
    this.messagesContainer.scrollTo({
      top: this.messagesContainer.scrollHeight,
      behavior: 'smooth'
    });
  }

  private autoResizeTextarea(): void {
    this.inputArea.style.height = 'auto';
    const newHeight = Math.min(this.inputArea.scrollHeight, 150);
    this.inputArea.style.height = newHeight + 'px';
  }

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

    const assistantMsgs = turnMessages.filter(m => m.role === 'assistant');
    const lastAssistantMsg = assistantMsgs[assistantMsgs.length - 1];

    if (assistantMsgs.length === 0) return wrapper;

    const allToolCalls = assistantMsgs.reduce<ToolCall[]>((acc, m) => {
      if (m.tool_calls) {
        acc.push(...m.tool_calls);
      }
      return acc;
    }, []);

    // Check if interrupted (limit reached)
    const endedWithToolCalls = lastAssistantMsg && lastAssistantMsg.tool_calls && lastAssistantMsg.tool_calls.length > 0;
    const hasUnrespondedToolCall = allToolCalls.some(tc => 
      !turnMessages.some(m => m.role === 'tool' && m.tool_call_id === tc.id)
    );
    const isInterrupted = endedWithToolCalls || hasUnrespondedToolCall;

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
            const cleanExplanation = this.stripBlockToolCalls(turnMsg.content);
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
            }
          }
        }
      }
    }

    // 2. Render Final Answer / Warning Callouts
    if (isInterrupted) {
      // Render warning card
      const warningDiv = contentEl.createDiv('chat-warning-callout');
      const warningHeader = warningDiv.createDiv('chat-warning-callout-header');
      warningHeader.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>
        已达到最大运行迭代次数限制 (20 轮)
      `;
      const warningText = warningDiv.createDiv();
      warningText.setText('智能体已被系统强制挂起，以防陷入无限循环。如果任务还未完成，您可以发送指令“继续”让其继续执行。');
      
      // Render last partial text if any
      const cleanAnswer = this.stripBlockToolCalls(lastAssistantMsg.content);
      if (cleanAnswer.trim()) {
        const answerEl = contentEl.createDiv('final-answer');
        answerEl.innerHTML = this.messageRenderer.render(cleanAnswer);
      }
    } else {
      const cleanAnswer = this.stripBlockToolCalls(lastAssistantMsg.content);
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
   * Strips large fenced markdown block tool calls (MBTC) from text explanations.
   */
  private stripBlockToolCalls(text: string): string {
    if (!text) return '';
    return text.replace(/```(?:obsidian:edit_note|obsidian:editnote|obsidian:create_note|obsidian:createnote)\s*[^\n]*\n[\s\S]*?```/g, '').trim();
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
          const stripped = this.stripBlockToolCalls(cleanText);
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
            const cleanExplanation = this.stripBlockToolCalls(task.explanation);
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
        const cleanExplanationChunk = this.stripBlockToolCalls(cleanTurnResponse);
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
      const cleanResponseText = this.stripBlockToolCalls(fullResponse);
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

  async onClose(): Promise<void> {
    // Cleanup if needed
  }
}
