// Chat View - Main sidebar UI component

import { ItemView, WorkspaceLeaf, Modal, App, setIcon, TFile } from 'obsidian';
import PersonalAgentPlugin from '../main';
import { ChatManager } from './chat-manager';
import { MessageRenderer } from './message-renderer';
import { RAGOrchestrator } from './rag-orchestrator';
import { FileSelectorModal } from '../ui/components/file-selector-modal';
import { TaskType } from '../types';

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
    // Use shared RAGOrchestrator instance from plugin
    this.ragOrchestrator = plugin.ragOrchestrator;
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

    // Add user message to UI only (not to history yet)
    this.addUserMessage(userMessage);

    // Prepare assistant message container
    const wrapper = this.createMessageElement('assistant');
    this.currentStreamingElement = wrapper.createDiv('message-content');
    this.currentStreamingElement.addClass('streaming');

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
      const contextMessages = this.chatManager.getContextMessages();

      let fullResponse = '';

      // Always use RAG orchestrator for skill support
      // If no files selected, RAG will handle it gracefully
      const result = await this.ragOrchestrator.query(
        userMessage,
        selectedFiles,
        contextMessages,
        (chunk: string) => {
          fullResponse += chunk;
          this.currentStreamingElement!.innerHTML =
            this.messageRenderer.render(fullResponse);
          this.scrollToBottom();
        },
        {
          enableSkills: this.plugin.settings.skillsEnabled
        }
      );

      // Replace history with complete messages (includes context + new messages with tool calls)
      await this.chatManager.replaceMessages(result.messages);

      // Setup code copy buttons
      this.setupCodeCopyButtons(wrapper);
      // Setup message copy button
      this.setupMessageCopyButtons(wrapper);

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

      // Add copy button to message
      this.addCopyButtonToMessage(contentEl);

      this.setupCodeCopyButtons(wrapper);
      this.setupMessageCopyButtons(wrapper);
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
