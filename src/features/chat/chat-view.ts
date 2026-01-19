// Chat View - Main sidebar UI component

import { ItemView, WorkspaceLeaf, Modal, App, setIcon, TFile } from 'obsidian';
import PersonalAgentPlugin from '../../main';
import { ChatManager } from './chat-manager';
import { MessageRenderer } from './message-renderer';
import { RAGOrchestrator } from './rag-orchestrator';
import { FileSelectorModal } from '../../ui/components/file-selector-modal';
import { TaskType } from '../../types';

export const CHAT_VIEW_TYPE = 'personal-agent-chat';

export class ChatView extends ItemView {
  plugin: PersonalAgentPlugin;
  chatManager: ChatManager;
  messageRenderer: MessageRenderer;
  ragOrchestrator: RAGOrchestrator;

  // UI elements
  private chatContainer: HTMLElement;
  private messagesContainer: HTMLElement;
  private inputContainer: HTMLElement;
  private inputArea: HTMLTextAreaElement;
  private sendButton: HTMLButtonElement;
  private clearButton: HTMLButtonElement;
  private settingsButton: HTMLButtonElement;
  private documentPanel: HTMLElement;
  private documentList: HTMLElement;
  private addDocumentButton: HTMLButtonElement;

  // State
  private isStreaming: boolean = false;
  private currentStreamingElement: HTMLElement | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: PersonalAgentPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.chatManager = new ChatManager(plugin);
    this.messageRenderer = new MessageRenderer();
    this.ragOrchestrator = new RAGOrchestrator(plugin);
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
  }

  private async handleSend(): Promise<void> {
    const userMessage = this.inputArea.value.trim();
    if (!userMessage || this.isStreaming) return;

    // Clear input
    this.inputArea.value = '';
    this.autoResizeTextarea(); // Reset height

    // Add user message to UI and history
    this.addUserMessage(userMessage);
    await this.chatManager.addMessage('user', userMessage);

    // Prepare assistant message container
    const wrapper = this.createMessageElement('assistant');
    this.currentStreamingElement = wrapper.createDiv('message-content');
    this.currentStreamingElement.addClass('streaming');

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

      // Get conversation history for context
      const contextMessages = this.chatManager.getContextMessages(10);

      let fullResponse = '';

      if (selectedFiles.length > 0) {
        // Check if any documents are indexed
        const stats = this.plugin.indexManager.getStats();
        if (stats.totalChunks === 0) {
          // Display friendly help message
          const helpMessage = `⚠️ **尚未索引任何文档**

您选择了 ${selectedFiles.length} 个文档，但系统中还没有索引数据。

**快速开始**：
1. 按 Ctrl/Cmd+P 打开命令面板
2. 搜索并执行 "Index all documents for RAG"
3. 等待索引完成（会显示进度）
4. 重新发送您的问题

**提示**：首次使用需要为所有文档建立索引，这可能需要几分钟时间。`;

          this.currentStreamingElement!.innerHTML =
            this.messageRenderer.render(helpMessage);

          await this.chatManager.addMessage('assistant', helpMessage);

          // Re-enable input
          this.isStreaming = false;
          this.sendButton.disabled = false;
          this.inputArea.disabled = false;
          this.currentStreamingElement?.removeClass('streaming');
          this.currentStreamingElement = null;
          this.inputArea.focus();
          return;
        }

        // RAG mode - use selected documents with conversation history
        await this.ragOrchestrator.query(
          userMessage,
          selectedFiles,
          contextMessages,
          (chunk: string) => {
            fullResponse += chunk;
            this.currentStreamingElement!.innerHTML =
              this.messageRenderer.render(fullResponse);
            this.scrollToBottom();
          }
        );
      } else {
        // Normal chat mode with conversation history
        const provider = await this.plugin.aiRouter.getProvider(TaskType.CHAT);

        // Build system prompt with conversation history
        let systemPrompt = 'You are a helpful AI assistant.';
        if (contextMessages.length > 0) {
          systemPrompt += '\n\nConversation History:\n';
          for (const msg of contextMessages) {
            systemPrompt += `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}\n\n`;
          }
        }

        await provider.generateStream(
          userMessage,
          (chunk: string) => {
            fullResponse += chunk;
            this.currentStreamingElement!.innerHTML =
              this.messageRenderer.render(fullResponse);
            this.scrollToBottom();
          },
          {
            temperature: 0.7,
            maxTokens: 2048,
            systemPrompt
          }
        );
      }

      // Save assistant response to history
      await this.chatManager.addMessage('assistant', fullResponse);

      // Setup code copy buttons
      this.setupCodeCopyButtons(wrapper);

    } catch (error) {
      console.error('Chat error:', error);
      this.currentStreamingElement!.setText(
        `Error: ${error.message}. Please check your AI provider settings.`
      );
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
    this.setupCodeCopyButtons(wrapper);
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
      const modal = new ConfirmModal(
        this.app,
        'Clear Chat History',
        'Are you sure you want to clear all chat messages? This cannot be undone.',
        resolve
      );
      modal.open();
    });
  }

  private async loadHistory(): Promise<void> {
    const messages = await this.chatManager.getHistory();

    for (const msg of messages) {
      const wrapper = this.createMessageElement(msg.role);
      const contentEl = wrapper.createDiv('message-content');
      contentEl.innerHTML = this.messageRenderer.render(msg.content);
      this.setupCodeCopyButtons(wrapper);
    }

    this.scrollToBottom();
  }

  async onClose(): Promise<void> {
    // Cleanup if needed
  }
}

// Simple confirmation modal
class ConfirmModal extends Modal {
  constructor(
    app: App,
    private title: string,
    private message: string,
    private callback: (result: boolean) => void
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: this.title });
    contentEl.createEl('p', { text: this.message });

    const buttonContainer = contentEl.createDiv('modal-button-container');

    const cancelButton = buttonContainer.createEl('button', { text: 'Cancel' });
    cancelButton.addEventListener('click', () => {
      this.callback(false);
      this.close();
    });

    const confirmButton = buttonContainer.createEl('button', {
      text: 'Clear',
      cls: 'mod-warning'
    });
    confirmButton.addEventListener('click', () => {
      this.callback(true);
      this.close();
    });
  }

  onClose(): void {
    const { contentEl } = this;
    contentEl.empty();
  }
}
