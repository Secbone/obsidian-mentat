import { sanitizeHTMLToDom, setIcon, App, Component } from 'obsidian';
import { MessageRenderer } from '../../message-renderer';
import { ChatMessage, ToolCall } from '../../../types';
import {
  ChatTheme,
  ThemeCallbacks,
  AssistantMessageData,
  ConfirmRequestData,
  StreamingBubble,
  StreamingUpdateData,
  InputAreaElements,
  InputState,
} from '../types';
import { parseFinalAnswer, resolveToolDisplayName, getToolShortName, truncateText, valueToString, BRAILLE_DOTS, getSpinnerChar } from '../message-utils';
import { SmartScroller } from '../smart-scroller';
import { AnswerRenderer } from '../answer-renderer';

export class TerminalTheme implements ChatTheme {
  readonly id = 'terminal';
  readonly name = '终端式';
  readonly description = '终端时间线式界面，等宽工具区 + 比例字体回答区，内嵌确认按钮';

  private messageRenderer: MessageRenderer;
  private callbacks: ThemeCallbacks | null = null;
  private app: App;
  private answerRenderer: AnswerRenderer | null = null;
  private component: Component | null = null;
  private terminalPreset: string;

  private messagesContainer: HTMLElement | null = null;
  private inputEls: InputAreaElements | null = null;
  private settingsButton: HTMLButtonElement | null = null;
  private clearButton: HTMLButtonElement | null = null;
  private exportDiagnosticsButton: HTMLButtonElement | null = null;
  private stopButton: HTMLButtonElement | null = null;

  private contentEl: HTMLElement | null = null;

  private expandedTaskOutputs = new Set<string>();
  private lastRenderTime = 0;
  private lastAnswerRenderTime = 0;

  // Console dedup tracking
  private lastConsoleStatus = '';
  private lastConsoleTasksJson = '';
  private lastConsoleExplanation = '';
  private renderTimeout: number | null = null;
  private smartScroller = new SmartScroller();

  constructor(app: App, messageRenderer: MessageRenderer, terminalPreset: string = 'green') {
    this.app = app;
    this.messageRenderer = messageRenderer;
    this.terminalPreset = terminalPreset;
  }

  mount(container: HTMLElement, callbacks: ThemeCallbacks): void {
    this.callbacks = callbacks;

    const contentEl = container.children[1] as HTMLElement;
    this.contentEl = contentEl;
    contentEl.empty();
    contentEl.addClass('mentat-chat-view');
    contentEl.setAttribute('data-theme', 'terminal');
    if (this.terminalPreset && this.terminalPreset !== 'green') {
      contentEl.setAttribute('data-terminal-preset', this.terminalPreset);
    }

    this.component = new Component();
    this.component.load();
    this.answerRenderer = new AnswerRenderer(this.app, this.component);

    this.buildHeader(contentEl);
    this.buildDocumentPanel(contentEl);
    this.messagesContainer = contentEl.createDiv('term-messages');
    this.smartScroller.attach(this.messagesContainer, () => this.scrollToBottom());
    this.buildInputArea(contentEl);
  }

  unmount(): void {
    this.smartScroller.detach();
    if (this.component) {
      this.component.unload();
      this.component = null;
    }
    this.answerRenderer = null;
    if (this.renderTimeout) {
      window.clearTimeout(this.renderTimeout);
      this.renderTimeout = null;
    }
    this.contentEl = null;
    this.messagesContainer = null;
    this.inputEls = null;
    this.settingsButton = null;
    this.clearButton = null;
    this.exportDiagnosticsButton = null;
    this.stopButton = null;
    this.callbacks = null;
    this.expandedTaskOutputs.clear();
    this.lastRenderTime = 0;
    this.lastAnswerRenderTime = 0;
    this.lastConsoleStatus = '';
    this.lastConsoleTasksJson = '';
    this.lastConsoleExplanation = '';
  }

  renderUserMessage(content: string): HTMLElement {
    if (!this.messagesContainer) return document.createElement('div');

    if (content.startsWith('[HUMAN DYNAMIC INTERVENTION]:')) {
      const steerText = content.replace('[HUMAN DYNAMIC INTERVENTION]:', '').trim();
      return this.renderSteerCard(steerText);
    }

    const line = this.messagesContainer.createDiv('term-line term-line-user');
    const text = line.createSpan('term-user-text');
    text.setText(content);
    this.addCopyButtonToMessage(line);
    this.setupMessageCopyButtons(line);
    this.scrollToBottom();
    return line;
  }

  renderAssistantMessage(data: AssistantMessageData): HTMLElement {
    if (!this.messagesContainer) return document.createElement('div');

    const turnMessages = data.messages || [];
    const block = this.messagesContainer.createDiv('term-block term-block-assistant');

    block.createDiv('term-separator');

    const assistantMsgs = turnMessages.filter((m: ChatMessage) => m.role === 'assistant' && !m.metadata?.isSubagent);
    const lastAssistantMsg = assistantMsgs[assistantMsgs.length - 1];

    if (assistantMsgs.length === 0) return block;

    const allToolCalls = assistantMsgs.reduce<ToolCall[]>((acc: ToolCall[], m: ChatMessage) => {
      if (m.tool_calls) acc.push(...m.tool_calls);
      return acc;
    }, []);

    const isInterrupted = !!(lastAssistantMsg && lastAssistantMsg.metadata?.isMaxTurnsReached);

    if (allToolCalls.length > 0) {
      const timeline = block.createDiv('term-timeline');

      for (let index = 0; index < turnMessages.length; index++) {
        const turnMsg = turnMessages[index];

        if (turnMsg.role === 'assistant') {
          const isLastMsg = turnMsg === lastAssistantMsg;
          const showContentAsExplanation = turnMsg.content && (isInterrupted || !isLastMsg);

          if (showContentAsExplanation) {
            const rawContent = turnMsg.content || '';
            let explanationPart = rawContent;
            if (rawContent.includes('<final_answer>')) {
              explanationPart = rawContent.split('<final_answer>')[0].trim();
            }
            if (explanationPart.trim()) {
              const expLine = timeline.createDiv('term-timeline-item term-timeline-explanation');
              expLine.empty();
              expLine.appendChild(sanitizeHTMLToDom(this.messageRenderer.render(explanationPart)));
            }
          }

          if (turnMsg.tool_calls) {
            for (const tc of turnMsg.tool_calls) {
              const responseMsg = turnMessages.find(
                (m: ChatMessage) => m.role === 'tool' && m.tool_call_id === tc.id
              );
              const isSuccess = responseMsg && !responseMsg.content.startsWith('Error:');

              const displayName = resolveToolDisplayName(tc.name, tc.arguments);
              const shortName = getToolShortName(displayName);

              const details = timeline.createEl('details', { cls: 'term-timeline-item term-tool-details' });
              const summary = details.createEl('summary', { cls: 'term-tool-header' });

              const iconSpan = summary.createSpan('term-tool-icon');
              iconSpan.setText(isSuccess ? '✔' : (responseMsg ? '✗' : getSpinnerChar()));
              iconSpan.addClass(isSuccess ? 'term-icon-success' : (responseMsg ? 'term-icon-error' : 'term-icon-pending'));

              summary.createSpan('term-tool-name').setText(shortName);

              const detailsBody = details.createDiv('term-tool-body');

              if (tc.arguments) {
                this.renderTruncatedText(detailsBody, 'Parameters', tc.arguments, `${tc.id}-params`);
              }
              if (responseMsg) {
                this.renderTruncatedText(detailsBody, 'Response', responseMsg.content, `${tc.id}-result`);
              }

              const subAgentMsgs = turnMessages.filter((m: ChatMessage) => m.metadata?.parentToolCallId === tc.id);
              if (subAgentMsgs.length > 0) {
                const subDetails = detailsBody.createEl('details', { cls: 'term-subagent' });
                subDetails.createEl('summary', { cls: 'term-subagent-summary', text: '🤖 子智能体明细' });
                const subBody = subDetails.createDiv('term-subagent-body');
                subAgentMsgs.forEach((msg: ChatMessage) => {
                  const subLine = subBody.createDiv(`term-subagent-msg term-subagent-${msg.role}`);
                  subLine.createSpan('term-subagent-role').setText(msg.role.toUpperCase());
                  if (msg.content) {
                    const contentDiv = subLine.createDiv('term-subagent-content');
                    contentDiv.empty();
                    contentDiv.appendChild(sanitizeHTMLToDom(this.messageRenderer.render(msg.content)));
                  }
                });
              }
            }
          }
        }
      }
    }

    const rawContent = lastAssistantMsg?.content || '';
    const { answer: parsedAnswer } = parseFinalAnswer(rawContent);

    if (isInterrupted) {
      const warning = block.createDiv('term-warning');
      warning.setText('⚠️ 已达到最大运行迭代次数限制。可发送"继续"让其继续执行。');
    }

    if (parsedAnswer.trim()) {
      const answerEl = block.createDiv('term-answer');
      this.renderAnswer(parsedAnswer, answerEl);
      this.addCopyButtonToMessage(block);
      this.setupMessageCopyButtons(block);
    }

    this.scrollToBottom();
    return block;
  }

  createStreamingBubble(): StreamingBubble {
    if (!this.messagesContainer) {
      return { el: document.createElement('div'), consoleContainer: document.createElement('div'), answerContainer: document.createElement('div') };
    }

    const block = this.messagesContainer.createDiv('term-block term-block-assistant term-block-streaming');
    block.createDiv('term-separator');

    const consoleContainer = block.createDiv('term-timeline');
    const answerContainer = block.createDiv('term-answer-container');

    this.scrollToBottom();
    return { el: block, consoleContainer, answerContainer };
  }

  updateStreamingUI(bubble: StreamingBubble, data: StreamingUpdateData): void {
    const { consoleContainer, answerContainer } = bubble;
    const { statusMessage, activeTasks, explanation, finalAnswer, force } = data;

    const now = Date.now();
    const tasksJson = JSON.stringify(activeTasks);
    const cleanExplanation = (explanation || '').trim();
    const shouldUpdateConsole = force ||
      statusMessage !== this.lastConsoleStatus ||
      tasksJson !== this.lastConsoleTasksJson ||
      (cleanExplanation !== this.lastConsoleExplanation && activeTasks.length > 0);

    if (shouldUpdateConsole) {
      this.lastConsoleStatus = statusMessage;
      this.lastConsoleTasksJson = tasksJson;
      this.lastConsoleExplanation = cleanExplanation;
      this.lastRenderTime = now;
      consoleContainer.empty();

      if (statusMessage || activeTasks.length > 0) {
        const statusLine = consoleContainer.createDiv('term-timeline-item term-status-line');
        const spinner = statusLine.createSpan('term-spinner');
        spinner.setText(getSpinnerChar());
        statusLine.createSpan('term-status-text').setText(statusMessage || '思考中...');
      }

      for (const task of activeTasks) {
        if (task.explanation?.trim()) {
          const expLine = consoleContainer.createDiv('term-timeline-item term-timeline-explanation');
          expLine.empty();
          expLine.appendChild(sanitizeHTMLToDom(this.messageRenderer.render(task.explanation)));
        }

        const details = consoleContainer.createEl('details', { cls: 'term-timeline-item term-tool-details' });
        const summary = details.createEl('summary', { cls: 'term-tool-header' });

        const iconSpan = summary.createSpan('term-tool-icon');
        let icon = getSpinnerChar();
        let iconClass = 'term-icon-pending';
        if (task.status === 'executing') { icon = getSpinnerChar(); iconClass = 'term-icon-executing'; }
        else if (task.status === 'success') { icon = '✔'; iconClass = 'term-icon-success'; }
        else if (task.status === 'error') { icon = '✗'; iconClass = 'term-icon-error'; }
        else if (task.status === 'confirm') { icon = '⚠️'; iconClass = 'term-icon-warning'; }
        iconSpan.setText(icon);
        iconSpan.addClass(iconClass);

        const shortName = task.name.split(':').pop() || task.name;
        summary.createSpan('term-tool-name').setText(shortName);

        if (task.params || task.result) {
          const detailsBody = details.createDiv('term-tool-body');
          if (task.params) {
            this.renderTruncatedText(detailsBody, 'Parameters', task.params, `${task.id}-params`);
          }
          if (task.result) {
            const result = task.result as { success?: boolean; data?: unknown; error?: string; metadata?: { diff?: unknown } };
            const diff = result.metadata?.diff;
            if (diff && Array.isArray(diff)) {
              const diffEl = detailsBody.createDiv('term-diff');
              for (const line of diff as Array<{ type: string; content: string; oldLineNum?: number; newLineNum?: number }>) {
                const lineEl = diffEl.createDiv(
                  line.type === 'add' ? 'term-diff-add' : line.type === 'remove' ? 'term-diff-remove' : 'term-diff-keep'
                );
                const num = line.type === 'add'
                  ? String(line.newLineNum ?? '').padStart(3)
                  : String(line.oldLineNum ?? '').padStart(3);
                const prefix = line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' ';
                lineEl.setText(`${num} ${prefix}  ${line.content}`);
              }
            }
            if (result.data !== undefined || result.error) {
              const cleanResult = result.error && result.data === undefined ? result.error : result.data;
              this.renderTruncatedText(detailsBody, 'Response', cleanResult, `${task.id}-result`);
            }
          }
        }

        if (task.status === 'confirm') {
          const btnContainer = details.createDiv('term-confirm-buttons');
          const approveBtn = btnContainer.createEl('button', { cls: 'term-confirm-approve mod-cta', text: '允许 [Y]' });
          const rejectBtn = btnContainer.createEl('button', { cls: 'term-confirm-reject', text: '拒绝 [N]' });
          approveBtn.addEventListener('click', () => {
            if (this.callbacks) this.callbacks.onConfirmApprove(task.id);
          });
          rejectBtn.addEventListener('click', () => {
            if (this.callbacks) this.callbacks.onConfirmReject(task.id);
          });
        }
      }

      if (cleanExplanation && activeTasks.length > 0) {
        const expLine = consoleContainer.createDiv('term-timeline-item term-timeline-explanation');
        expLine.empty();
        expLine.appendChild(sanitizeHTMLToDom(this.messageRenderer.render(cleanExplanation) + `<span class="term-spinner">${getSpinnerChar()}</span>`));
      }
    }

    // Answer text: 150ms throttle (independent from console)
    const performRenderText = () => {
      if (!answerContainer) return;
      const text = finalAnswer || '';
      if (text) {
        answerContainer.empty();
        const answerEl = answerContainer.createDiv('term-answer');
        this.renderAnswer(text, answerEl);
      } else {
        answerContainer.empty();
      }
      this.scrollToBottom();
    };

    if (force || shouldUpdateConsole || (now - this.lastAnswerRenderTime > 150)) {
      if (this.renderTimeout) {
        window.clearTimeout(this.renderTimeout);
        this.renderTimeout = null;
      }
      performRenderText();
      this.lastAnswerRenderTime = now;
    } else if (!this.renderTimeout) {
      this.renderTimeout = window.setTimeout(() => {
        performRenderText();
        this.lastAnswerRenderTime = Date.now();
        this.renderTimeout = null;
      }, 150);
    }
  }

  finalizeStreaming(bubble: StreamingBubble, data: AssistantMessageData): HTMLElement {
    bubble.el.removeClass('term-block-streaming');
    if (this.messagesContainer && bubble.el.parentElement) {
      bubble.el.remove();
    }
    return this.renderAssistantMessage(data);
  }

  renderSteerCard(message: string): HTMLElement {
    const targetContainer = this.messagesContainer || document.createElement('div');
    const card = targetContainer.createDiv('term-steer-card');
    card.createSpan('term-steer-icon').setText('💡');
    card.createDiv('term-steer-title').setText('人类动态引导');
    card.createDiv('term-steer-text').setText(message);
    return card;
  }

  renderError(message: string): HTMLElement {
    const el = document.createElement('div');
    el.className = 'term-error';
    el.setText(`✗ Error: ${message}`);
    return el;
  }

  renderInfoBanner(message: string): HTMLElement {
    const el = document.createElement('div');
    el.className = 'term-info';
    el.setText(`ℹ ${message}`);
    return el;
  }

  renderConfirmRequest(data: ConfirmRequestData): HTMLElement {
    const el = document.createElement('div');
    el.className = 'term-confirm-request';
    el.setText(`⚠️ 等待授权: ${data.skillName}`);

    const btnContainer = el.createDiv('term-confirm-buttons');
    const approveBtn = btnContainer.createEl('button', { cls: 'term-confirm-approve mod-cta', text: '允许 [Y]' });
    const rejectBtn = btnContainer.createEl('button', { cls: 'term-confirm-reject', text: '拒绝 [N]' });

    approveBtn.addEventListener('click', () => {
      if (this.callbacks) this.callbacks.onConfirmApprove(data.taskId);
      el.remove();
    });
    rejectBtn.addEventListener('click', () => {
      if (this.callbacks) this.callbacks.onConfirmReject(data.taskId);
      el.remove();
    });

    return el;
  }

  scrollToBottom(): void {
    this.smartScroller.scrollToBottom();
  }

  updatePreset(preset: string): void {
    this.terminalPreset = preset;
    if (!this.contentEl) return;
    if (preset && preset !== 'green') {
      this.contentEl.setAttribute('data-terminal-preset', preset);
    } else {
      this.contentEl.removeAttribute('data-terminal-preset');
    }
  }

  getInputAreaElements(): InputAreaElements {
    if (this.inputEls) return this.inputEls;
    throw new Error('InputArea not initialized — call mount() first');
  }

  updateInputState(state: InputState): void {
    if (!this.inputEls) return;

    if (state.isStreaming) {
      this.inputEls.wrapper.addClass('is-streaming');
      this.inputEls.inputArea.setAttribute('placeholder', '💡 输入以动态引导...');
      this.inputEls.sendButton.addClass('is-steer-mode');
      setIcon(this.inputEls.sendButton, 'lightbulb');
      this.inputEls.sendButton.setAttribute('aria-label', 'Steer agent');
    } else {
      this.inputEls.wrapper.removeClass('is-streaming');
      this.inputEls.inputArea.setAttribute('placeholder', 'Ask me anything...');
      this.inputEls.sendButton.removeClass('is-steer-mode');
      setIcon(this.inputEls.sendButton, 'send');
      this.inputEls.sendButton.setAttribute('aria-label', 'Send message');
    }

    this.inputEls.charCountEl.setText(`${state.charCount} 字`);
    this.inputEls.badgesEl.empty();
    if (state.documentCount > 0) {
      const badge = this.inputEls.badgesEl.createDiv('chat-input-badge');
      badge.setText(`📎 ${state.documentCount}个文档`);
    }
  }

  getMessagesContainer(): HTMLElement {
    return this.messagesContainer || document.createElement('div');
  }

  getInputArea(): HTMLDivElement {
    return this.inputEls?.inputArea || document.createElement('div');
  }

  getSendButton(): HTMLButtonElement {
    return this.inputEls?.sendButton || document.createElement('button');
  }

  // --- Private helpers ---

  private renderAnswer(markdown: string, container: HTMLElement): void {
    if (this.answerRenderer) {
      void this.answerRenderer.renderFinalAnswer(markdown, container);
    } else {
      container.empty();
      container.appendChild(sanitizeHTMLToDom(this.messageRenderer.render(markdown)));
    }
  }

  private buildHeader(contentEl: HTMLElement): void {
    const header = contentEl.createDiv('term-header');

    const titleContainer = header.createDiv('term-header-title');
    const iconEl = titleContainer.createDiv('term-header-icon');
    setIcon(iconEl, 'terminal');
    titleContainer.createEl('h4', { text: 'Mentat' });

    const actionsContainer = header.createDiv('term-header-actions');

    this.settingsButton = actionsContainer.createEl('button', { cls: 'term-icon-button' });
    setIcon(this.settingsButton, 'settings');
    this.settingsButton.setAttribute('aria-label', 'Settings');
    this.settingsButton.addEventListener('click', () => { if (this.callbacks) this.callbacks.onSettings(); });

    this.clearButton = actionsContainer.createEl('button', { cls: 'term-icon-button' });
    setIcon(this.clearButton, 'trash-2');
    this.clearButton.setAttribute('aria-label', 'Clear chat');
    this.clearButton.addEventListener('click', () => { if (this.callbacks) this.callbacks.onClear(); });

    this.exportDiagnosticsButton = actionsContainer.createEl('button', { cls: 'term-icon-button' });
    setIcon(this.exportDiagnosticsButton, 'scroll');
    this.exportDiagnosticsButton.setAttribute('aria-label', 'Export Session Diagnostics');
    this.exportDiagnosticsButton.addEventListener('click', () => { if (this.callbacks) this.callbacks.onExportDiagnostics(); });

    this.stopButton = actionsContainer.createEl('button', { cls: 'term-icon-button' });
    setIcon(this.stopButton, 'square');
    this.stopButton.setAttribute('aria-label', 'Stop generation');
    this.stopButton.addEventListener('click', () => { if (this.callbacks) this.callbacks.onCancel(); });
  }

  private buildDocumentPanel(contentEl: HTMLElement): void {
    const panel = contentEl.createDiv('term-document-panel');
    const header = panel.createDiv('term-document-panel-header');
    header.createEl('h5', { text: 'Context' });

    const addBtn = header.createEl('button', {
      cls: 'term-icon-button',
      attr: { 'aria-label': 'Add document' }
    });
    setIcon(addBtn, 'plus');
    addBtn.addEventListener('click', () => { if (this.callbacks) this.callbacks.onAddDocument(); });

    const list = panel.createDiv('term-document-list');

    this.inputEls = {
      container: document.createElement('div'),
      wrapper: document.createElement('div'),
      inputArea: document.createElement('div') as HTMLDivElement,
      sendButton: document.createElement('button'),
      charCountEl: document.createElement('div'),
      badgesEl: document.createElement('div'),
      documentPanel: panel,
      documentList: list,
      addDocumentButton: addBtn,
    };
  }

  private buildInputArea(contentEl: HTMLElement): void {
    const inputContainer = contentEl.createDiv('term-input-container');
    const inputWrapper = inputContainer.createDiv('term-input-wrapper');

    const promptSpan = inputWrapper.createSpan('term-input-prompt');
    promptSpan.setText('❯');

    const inputArea = inputWrapper.createEl('div', {
      cls: 'term-input',
      attr: { contenteditable: 'true', placeholder: 'Ask me anything...' }
    }) as HTMLDivElement;

    const sendButton = inputWrapper.createEl('button', { cls: 'term-send-button' });
    setIcon(sendButton, 'send');
    sendButton.setAttribute('aria-label', 'Send message');

    const infoBar = inputContainer.createDiv('term-input-info-bar');
    const charCountEl = infoBar.createDiv('term-input-char-count');
    charCountEl.setText('0 字');
    const badgesEl = infoBar.createDiv('term-input-badges');

    if (this.inputEls) {
      this.inputEls.container = inputContainer;
      this.inputEls.wrapper = inputWrapper;
      this.inputEls.inputArea = inputArea;
      this.inputEls.sendButton = sendButton;
      this.inputEls.charCountEl = charCountEl;
      this.inputEls.badgesEl = badgesEl;
    }
  }

  private renderTruncatedText(
    container: HTMLElement,
    label: string,
    value: unknown,
    typeKey: string,
  ): void {
    const text = valueToString(value);
    const { display, isTruncated, fullText } = truncateText(text);

    const pre = container.createEl('pre');

    if (!isTruncated) {
      pre.createEl('code', { text: `${label}: ${display}` });
      return;
    }

    const code = pre.createEl('code');
    const isExpanded = this.expandedTaskOutputs.has(typeKey);

    if (isExpanded) {
      code.setText(`${label}: ${fullText}`);
      const toggleBtn = pre.createEl('a', { cls: 'term-truncation-btn', text: ' [Collapse ▴]' });
      toggleBtn.addEventListener('click', (e) => {
        e.preventDefault();
        this.expandedTaskOutputs.delete(typeKey);
        pre.remove();
        this.renderTruncatedText(container, label, value, typeKey);
      });
    } else {
      code.setText(`${label}: ${display}`);
      const toggleBtn = pre.createEl('a', { cls: 'term-truncation-btn', text: ` [Show All (${fullText.length} chars) ▾]` });
      toggleBtn.addEventListener('click', (e) => {
        e.preventDefault();
        this.expandedTaskOutputs.add(typeKey);
        pre.remove();
        this.renderTruncatedText(container, label, value, typeKey);
      });
    }
  }

  private addCopyButtonToMessage(messageEl: HTMLElement): void {
    const btn = messageEl.createEl('button', { cls: 'term-copy-button' });
    btn.setAttribute('aria-label', '复制消息');
    setIcon(btn, 'copy');
  }

  private setupCodeCopyButtons(messageEl: HTMLElement): void {
    const codeCopyButtons = messageEl.findAll('.code-copy-button');
    codeCopyButtons.forEach(button => {
      button.addEventListener('click', (e) => {
        void (async () => {
          const target = e.currentTarget as HTMLElement;
          const codeId = target.getAttribute('data-code-id');
          const codeEl = activeDocument.getElementById(codeId!);
          if (codeEl) {
            await navigator.clipboard.writeText(codeEl.textContent || '');
            const originalText = target.textContent;
            target.textContent = '已复制!';
            window.setTimeout(() => {
              target.textContent = originalText;
            }, 2000);
          }
        })();
      });
    });
  }

  private setupMessageCopyButtons(wrapper: HTMLElement): void {
    const copyButton = wrapper.querySelector('.term-copy-button') as HTMLButtonElement;
    const messageContent = wrapper.querySelector('.term-answer, .term-user-text') as HTMLElement;

    if (copyButton && messageContent) {
      copyButton.addEventListener('click', async (e) => {
        e.stopPropagation();
        const textContent = messageContent.textContent || '';
        try {
          await navigator.clipboard.writeText(textContent);
          copyButton.setText('✓');
          window.setTimeout(() => {
            copyButton.setText('📋');
          }, 2000);
        } catch {
          // clipboard not available
        }
      });
    }
  }
}
