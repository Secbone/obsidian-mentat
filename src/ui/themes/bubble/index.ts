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
import { parseFinalAnswer, resolveToolDisplayName, getToolShortName, truncateText, valueToString, BRAILLE_DOTS, getSpinnerChar, getSpinnerPrefix } from '../message-utils';
import { SmartScroller } from '../smart-scroller';
import { AnswerRenderer } from '../answer-renderer';

export class BubbleTheme implements ChatTheme {
  readonly id = 'bubble';
  readonly name = '经典气泡';
  readonly description = '传统聊天气泡式界面，左右分列，工具调用折叠展示';

  private messageRenderer: MessageRenderer;
  private callbacks: ThemeCallbacks | null = null;
  private app: App;
  private answerRenderer: AnswerRenderer | null = null;
  private component: Component | null = null;

  private messagesContainer: HTMLElement | null = null;
  private inputEls: InputAreaElements | null = null;
  private settingsButton: HTMLButtonElement | null = null;
  private clearButton: HTMLButtonElement | null = null;
  private exportDiagnosticsButton: HTMLButtonElement | null = null;
  private stopButton: HTMLButtonElement | null = null;

  private expandedTaskOutputs = new Set<string>();
  private lastRenderedStatus = '';
  private lastRenderedTasksJson = '';
  private lastRenderedTurnResponse = '';
  private lastRenderTime = 0;
  private renderTimeout: number | null = null;
  private smartScroller = new SmartScroller();

  constructor(app: App, messageRenderer: MessageRenderer) {
    this.app = app;
    this.messageRenderer = messageRenderer;
  }

  mount(container: HTMLElement, callbacks: ThemeCallbacks): void {
    this.callbacks = callbacks;

    const contentEl = container.children[1] as HTMLElement;
    contentEl.empty();
    contentEl.addClass('mentat-chat-view');
    contentEl.setAttribute('data-theme', 'bubble');

    this.component = new Component();
    this.component.load();
    this.answerRenderer = new AnswerRenderer(this.app, this.component);

    this.buildHeader(contentEl);
    this.buildDocumentPanel(contentEl);
    this.messagesContainer = contentEl.createDiv('chat-messages');
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
    this.messagesContainer = null;
    this.inputEls = null;
    this.settingsButton = null;
    this.clearButton = null;
    this.exportDiagnosticsButton = null;
    this.stopButton = null;
    this.callbacks = null;
    this.expandedTaskOutputs.clear();
  }

  renderUserMessage(content: string): HTMLElement {
    if (!this.messagesContainer) return document.createElement('div');

    if (content.startsWith('[HUMAN DYNAMIC INTERVENTION]:')) {
      const steerText = content.replace('[HUMAN DYNAMIC INTERVENTION]:', '').trim();
      const card = this.renderSteerCard(steerText);
      this.messagesContainer.appendChild(card);
      this.scrollToBottom();
      return card;
    }

    const wrapper = this.createMessageElement('user');
    const contentEl = wrapper.createDiv('message-content');
    contentEl.empty();
    contentEl.appendChild(sanitizeHTMLToDom(this.messageRenderer.render(content)));
    this.addCopyButtonToMessage(contentEl);
    this.setupCodeCopyButtons(wrapper);
    this.setupMessageCopyButtons(wrapper);
    this.scrollToBottom();
    return wrapper;
  }

  renderAssistantMessage(data: AssistantMessageData): HTMLElement {
    if (!this.messagesContainer) return document.createElement('div');

    const turnMessages = data.messages || [];
    const wrapper = this.messagesContainer.createDiv('chat-message chat-message-assistant');

    const avatarEl = wrapper.createDiv('message-avatar');
    setIcon(avatarEl, 'bot');

    const msgWrapper = wrapper.createDiv('message-wrapper');
    const roleEl = msgWrapper.createDiv('message-role');
    roleEl.setText('Assistant');

    const contentEl = msgWrapper.createDiv('message-content');

    const assistantMsgs = turnMessages.filter((m: ChatMessage) => m.role === 'assistant' && !m.metadata?.isSubagent);
    const lastAssistantMsg = assistantMsgs[assistantMsgs.length - 1];

    if (assistantMsgs.length === 0) return wrapper;

    const allToolCalls = assistantMsgs.reduce<ToolCall[]>((acc: ToolCall[], m: ChatMessage) => {
      if (m.tool_calls) {
        acc.push(...m.tool_calls);
      }
      return acc;
    }, []);

    const isInterrupted = !!(lastAssistantMsg && lastAssistantMsg.metadata?.isMaxTurnsReached);

    if (allToolCalls.length > 0) {
      const consoleEl = contentEl.createEl('details', { cls: 'tui-console' });

      const consoleSummary = consoleEl.createEl('summary', { cls: 'tui-console-summary' });
      const summaryTextEl = consoleSummary.createSpan({ cls: 'tui-console-status' });

      const totalTools = allToolCalls.length;

      let hasError = false;
      const responses: { isSuccess: boolean; responseMsg?: ChatMessage }[] = [];
      for (const tc of allToolCalls) {
        const responseMsg = turnMessages.find(
          (m: ChatMessage) => m.role === 'tool' && m.tool_call_id === tc.id
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
            const cleanExplanation = explanationPart;
            if (cleanExplanation.trim()) {
              const expDiv = consoleBody.createDiv('tui-explanation');
              expDiv.empty();
              expDiv.appendChild(sanitizeHTMLToDom(this.messageRenderer.render(cleanExplanation)));
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

              const details = consoleBody.createEl('details', { cls: 'tui-line-item' });
              const summary = details.createEl('summary', { cls: 'tui-line-summary' });

              const icon = isSuccess ? '✔' : (responseMsg ? '✗' : getSpinnerChar());
              const statusClass = isSuccess ? 'success' : (responseMsg ? 'error' : 'pending');

              summary.empty();
              summary.createSpan({ cls: `tui-icon ${statusClass}`, text: icon });
              summary.createSpan({ cls: 'tui-tool-name', text: shortName });

              const detailsBody = details.createDiv('tui-line-details');

              if (tc.arguments) {
                this.renderTruncatedText(detailsBody, 'Parameters', tc.arguments, `${tc.id}-params`);
              }

              if (responseMsg) {
                this.renderTruncatedText(detailsBody, 'Response', responseMsg.content, `${tc.id}-result`);
              }

              const subAgentMsgs = turnMessages.filter((m: ChatMessage) => m.metadata?.parentToolCallId === tc.id);
              if (subAgentMsgs.length > 0) {
                const subDetails = detailsBody.createEl('details', { cls: 'subagent-trace-console' });
                const subSummary = subDetails.createEl('summary', { cls: 'subagent-trace-summary' });
                subSummary.setText('🤖 查看子智能体运行明细...');
                const subBody = subDetails.createDiv('subagent-trace-body');

                subAgentMsgs.forEach((msg: ChatMessage) => {
                  const roleClass = msg.role === 'user' ? 'user' : (msg.role === 'assistant' ? 'assistant' : 'system');
                  const bubble = subBody.createDiv(`subagent-msg subagent-msg-${roleClass}`);
                  bubble.createDiv('subagent-msg-role').setText(msg.role.toUpperCase());

                  if (msg.tool_calls && msg.tool_calls.length > 0) {
                    const toolInfo = bubble.createDiv('subagent-msg-tools');
                    msg.tool_calls.forEach((stc: ToolCall) => {
                      const toolCallEl = toolInfo.createDiv('subagent-msg-tool-call');
                      toolCallEl.setText(`调用工具: ${stc.name}(${typeof stc.arguments === 'string' ? stc.arguments : JSON.stringify(stc.arguments)})`);
                    });
                  }

                  if (msg.content) {
                    const contentDiv = bubble.createDiv('subagent-msg-content');
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
      const warningDiv = contentEl.createDiv('chat-warning-callout');
      const warningHeader = warningDiv.createDiv('chat-warning-callout-header');
      warningHeader.appendChild(sanitizeHTMLToDom(`<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>`));
      warningHeader.appendText(' 已达到最大运行迭代次数限制 (20 轮)');
      const warningText = warningDiv.createDiv();
      warningText.setText('智能体已被系统强制挂起，以防陷入无限循环。如果任务还未完成，您可以发送指令"继续"让其继续执行。');
    }

    if (parsedAnswer.trim()) {
      const answerEl = contentEl.createDiv('final-answer');
      this.renderAnswer(parsedAnswer, answerEl);
    }

    this.addCopyButtonToMessage(contentEl);
    this.setupCodeCopyButtons(wrapper);
    this.setupMessageCopyButtons(msgWrapper);

    return wrapper;
  }

  createStreamingBubble(): StreamingBubble {
    if (!this.messagesContainer) {
      return { el: document.createElement('div'), consoleContainer: document.createElement('div'), answerContainer: document.createElement('div') };
    }

    const wrapper = this.createMessageElement('assistant');
    const el = wrapper.createDiv('message-content');
    el.addClass('streaming');

    const consoleContainer = el.createDiv('tui-console-container');
    const answerContainer = el.createDiv('final-answer-container');

    this.addCopyButtonToMessage(el);
    this.scrollToBottom();

    this.lastRenderedStatus = '';
    this.lastRenderedTasksJson = '';
    this.lastRenderedTurnResponse = '';

    return { el, consoleContainer, answerContainer };
  }

  updateStreamingUI(bubble: StreamingBubble, data: StreamingUpdateData): void {
    const { consoleContainer, answerContainer } = bubble;
    const { statusMessage, activeTasks, explanation, finalAnswer, force } = data;

    const tasksJson = JSON.stringify(activeTasks);
    const cleanTurnResponse = (explanation || '').trim();
    const shouldUpdateConsole = force ||
      statusMessage !== this.lastRenderedStatus ||
      tasksJson !== this.lastRenderedTasksJson ||
      (cleanTurnResponse !== this.lastRenderedTurnResponse && activeTasks.length > 0);

    if (shouldUpdateConsole) {
      this.lastRenderedStatus = statusMessage;
      this.lastRenderedTasksJson = tasksJson;
      this.lastRenderedTurnResponse = cleanTurnResponse;

      const existingConsole = consoleContainer.querySelector('.tui-console') as HTMLDetailsElement | null;
      const wasConsoleOpen = existingConsole ? existingConsole.open : false;

      consoleContainer.empty();

      if (statusMessage || activeTasks.length > 0 || cleanTurnResponse) {
        const consoleEl = consoleContainer.createEl('details', { cls: 'tui-console' });
        if (wasConsoleOpen) {
          consoleEl.setAttribute('open', '');
        }

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
          summaryText = `${getSpinnerPrefix()} 正在运行 ⚙️ : 执行工具 ${shortName}...`;
        } else if (statusMessage) {
          summaryText = `${getSpinnerPrefix()} 思考中 ↗ : ${statusMessage}`;
        } else if (cleanTurnResponse) {
          const cleanText = cleanTurnResponse.replace(/[\r\n]+/g, ' ');
          const truncated = cleanText.length > 30 ? cleanText.slice(-30) + '...' : cleanText;
          summaryText = `${getSpinnerPrefix()} 思考中 ↘ : ${truncated}`;
        } else if (runningTools > 0) {
          summaryText = `${getSpinnerPrefix()} 正在运行 (已执行 ${totalTools} 个工具)...`;
        } else if (data.lastToolStatus?.name) {
          if (data.lastToolStatus.status === 'success') {
            summaryText = `✔ 已完成 ⚙️ : 执行工具 ${data.lastToolStatus.name} (共调用 ${totalTools} 个工具)`;
          } else if (data.lastToolStatus.status === 'error') {
            summaryText = `✗ 失败 ⚙️ : 执行工具 ${data.lastToolStatus.name} (共调用 ${totalTools} 个工具)`;
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

        for (const task of activeTasks) {
          if (task.explanation) {
            const cleanExplanation = task.explanation;
            if (cleanExplanation.trim()) {
              const expDiv = consoleBody.createDiv('tui-explanation');
              expDiv.empty();
              expDiv.appendChild(sanitizeHTMLToDom(this.messageRenderer.render(cleanExplanation)));
            }
          }

          const details = consoleBody.createEl('details', { cls: 'tui-line-item' });
          const summary = details.createEl('summary', { cls: 'tui-line-summary' });

          const shortName = task.name.split(':').pop() || task.name;

          let icon = getSpinnerChar();
          let statusClass = 'pending';
          if (task.status === 'executing') {
            icon = getSpinnerChar();
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

          summary.empty();
          summary.createSpan({ cls: `tui-icon ${statusClass}`, text: icon });
          summary.createSpan({ cls: 'tui-tool-name', text: shortName });

          const detailsBody = details.createDiv('tui-line-details');

          if (task.params) {
            this.renderTruncatedText(detailsBody, 'Parameters', task.params, `${task.id}-params`);
          }

          if (task.result) {
            this.renderTruncatedText(detailsBody, 'Response', task.result, `${task.id}-result`);
          }
        }

        const cleanExplanationChunk = cleanTurnResponse;
        if (cleanExplanationChunk && activeTasks.length > 0 && !executingTask && !confirmTask) {
          const expDiv = consoleBody.createDiv('tui-explanation');
          expDiv.empty();
          expDiv.appendChild(sanitizeHTMLToDom(this.messageRenderer.render(cleanExplanationChunk) + `<span class="tui-spinner">${getSpinnerChar()}</span>`));
        }
      }
    }

    const now = Date.now();
    const throttleInterval = 150;

    const performRenderText = () => {
      if (!answerContainer) return;
      const cleanResponseText = finalAnswer || '';
      if (cleanResponseText) {
        answerContainer.empty();
        const answerEl = answerContainer.createDiv('final-answer');
        this.renderAnswer(cleanResponseText, answerEl);
      } else {
        answerContainer.empty();
      }
      this.scrollToBottom();
    };

    if (force || shouldUpdateConsole || (now - this.lastRenderTime > throttleInterval)) {
      if (this.renderTimeout) {
        window.clearTimeout(this.renderTimeout);
        this.renderTimeout = null;
      }
      performRenderText();
      this.lastRenderTime = now;
    } else {
      if (!this.renderTimeout) {
        this.renderTimeout = window.setTimeout(() => {
          performRenderText();
          this.lastRenderTime = Date.now();
          this.renderTimeout = null;
        }, throttleInterval);
      }
    }
  }

  finalizeStreaming(bubble: StreamingBubble, data: AssistantMessageData): HTMLElement {
    bubble.el.removeClass('streaming');
    if (this.messagesContainer && bubble.el.parentElement) {
      const wrapper = bubble.el.closest('.chat-message-assistant') as HTMLElement;
      if (wrapper) {
        wrapper.remove();
      }
    }
    return this.renderAssistantMessage(data);
  }

  renderSteerCard(message: string): HTMLElement {
    const targetContainer = this.messagesContainer || document.createElement('div');
    const card = targetContainer.createDiv('chat-steer-card');

    const iconEl = card.createSpan('steer-card-icon');
    setIcon(iconEl, 'lightbulb');

    const contentEl = card.createDiv('steer-card-content');

    const titleEl = contentEl.createDiv('steer-card-title');
    titleEl.setText('人类动态引导');

    const textEl = contentEl.createDiv('steer-card-text');
    textEl.setText(message);

    return card;
  }

  renderError(message: string): HTMLElement {
    const el = document.createElement('div');
    el.className = 'chat-error-banner';
    el.setText(`Error: ${message}`);
    return el;
  }

  renderInfoBanner(message: string): HTMLElement {
    const el = document.createElement('div');
    el.className = 'chat-info-banner';
    el.setText(message);
    return el;
  }

  renderConfirmRequest(data: ConfirmRequestData): HTMLElement {
    const el = document.createElement('div');
    el.className = 'tui-confirm-request';
    el.setText(`⚠️ 等待授权: ${data.skillName}`);

    const btnContainer = el.createDiv('tui-confirm-buttons');
    const approveBtn = btnContainer.createEl('button', { cls: 'tui-confirm-approve mod-cta', text: '允许' });
    const rejectBtn = btnContainer.createEl('button', { cls: 'tui-confirm-reject', text: '拒绝' });

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

  getInputAreaElements(): InputAreaElements {
    if (this.inputEls) return this.inputEls;
    throw new Error('InputArea not initialized — call mount() first');
  }

  updateInputState(state: InputState): void {
    if (!this.inputEls) return;

    if (state.isStreaming) {
      this.inputEls.wrapper.addClass('is-streaming');
      this.inputEls.inputArea.setAttribute('placeholder', '💡 智能体正在运行... 输入以动态引导其思考方向...');
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
    const header = contentEl.createDiv('chat-header');

    const titleContainer = header.createDiv('chat-header-title');
    const iconEl = titleContainer.createDiv('chat-header-icon');
    setIcon(iconEl, 'message-square');
    titleContainer.createEl('h4', { text: 'AI Chat' });

    const actionsContainer = header.createDiv('chat-header-actions');

    this.settingsButton = actionsContainer.createEl('button', { cls: 'chat-icon-button' });
    setIcon(this.settingsButton, 'settings');
    this.settingsButton.setAttribute('aria-label', 'Settings');
    this.settingsButton.addEventListener('click', () => {
      if (this.callbacks) this.callbacks.onSettings();
    });

    this.clearButton = actionsContainer.createEl('button', { cls: 'chat-icon-button' });
    setIcon(this.clearButton, 'trash-2');
    this.clearButton.setAttribute('aria-label', 'Clear chat');
    this.clearButton.addEventListener('click', () => {
      if (this.callbacks) this.callbacks.onClear();
    });

    this.exportDiagnosticsButton = actionsContainer.createEl('button', { cls: 'chat-icon-button' });
    setIcon(this.exportDiagnosticsButton, 'scroll');
    this.exportDiagnosticsButton.setAttribute('aria-label', 'Export Session Diagnostics');
    this.exportDiagnosticsButton.addEventListener('click', () => {
      if (this.callbacks) this.callbacks.onExportDiagnostics();
    });

    this.stopButton = actionsContainer.createEl('button', { cls: 'chat-icon-button' });
    setIcon(this.stopButton, 'square');
    this.stopButton.setAttribute('aria-label', 'Stop generation');
    this.stopButton.addEventListener('click', () => {
      if (this.callbacks) this.callbacks.onCancel();
    });
  }

  private buildDocumentPanel(contentEl: HTMLElement): void {
    const panel = contentEl.createDiv('document-panel');
    const header = panel.createDiv('document-panel-header');
    header.createEl('h5', { text: 'Context Documents' });

    const addBtn = header.createEl('button', {
      cls: 'chat-icon-button',
      attr: { 'aria-label': 'Add document' }
    });
    setIcon(addBtn, 'plus');
    addBtn.addEventListener('click', () => {
      if (this.callbacks) this.callbacks.onAddDocument();
    });

    const list = panel.createDiv('document-list');

    if (!this.inputEls) {
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
    } else {
      this.inputEls.documentPanel = panel;
      this.inputEls.documentList = list;
      this.inputEls.addDocumentButton = addBtn;
    }
  }

  private buildInputArea(contentEl: HTMLElement): void {
    const inputContainer = contentEl.createDiv('chat-input-container');
    const inputWrapper = inputContainer.createDiv('chat-input-wrapper');

    const inputArea = inputWrapper.createEl('div', {
      cls: 'chat-input',
      attr: {
        contenteditable: 'true',
        placeholder: 'Ask me anything...'
      }
    }) as HTMLDivElement;

    const sendButton = inputWrapper.createEl('button', { cls: 'chat-send-button' });
    setIcon(sendButton, 'send');
    sendButton.setAttribute('aria-label', 'Send message');

    const infoBar = inputContainer.createDiv('chat-input-info-bar');
    const charCountEl = infoBar.createDiv('chat-input-char-count');
    charCountEl.setText('0 字');
    const badgesEl = infoBar.createDiv('chat-input-badges');

    if (this.inputEls) {
      this.inputEls.container = inputContainer;
      this.inputEls.wrapper = inputWrapper;
      this.inputEls.inputArea = inputArea;
      this.inputEls.sendButton = sendButton;
      this.inputEls.charCountEl = charCountEl;
      this.inputEls.badgesEl = badgesEl;
    } else {
      this.inputEls = {
        container: inputContainer,
        wrapper: inputWrapper,
        inputArea,
        sendButton,
        charCountEl,
        badgesEl,
        documentPanel: document.createElement('div'),
        documentList: document.createElement('div'),
        addDocumentButton: document.createElement('button'),
      };
    }
  }

  private createMessageElement(role: 'user' | 'assistant'): HTMLElement {
    if (!this.messagesContainer) return document.createElement('div');

    const messageEl = this.messagesContainer.createDiv(`chat-message chat-message-${role}`);

    const avatarEl = messageEl.createDiv('message-avatar');
    setIcon(avatarEl, role === 'user' ? 'user' : 'bot');

    const wrapper = messageEl.createDiv('message-wrapper');

    const roleEl = wrapper.createDiv('message-role');
    roleEl.setText(role === 'user' ? 'You' : 'Assistant');

    return wrapper;
  }

  private renderTruncatedText(
    container: HTMLElement,
    label: string,
    value: unknown,
    typeKey: string,
    onToggle?: () => void
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
          pre.remove();
          this.renderTruncatedText(container, label, value, typeKey);
        }
      });
    } else {
      code.setText(`${label}: ${display}`);

      const toggleBtn = pre.createEl('a', {
        cls: 'tui-truncation-btn',
        text: ` [Show Full Content (${fullText.length} chars) ▾]`
      });

      toggleBtn.addEventListener('click', (e) => {
        e.preventDefault();
        this.expandedTaskOutputs.add(typeKey);
        if (onToggle) {
          onToggle();
        } else {
          pre.remove();
          this.renderTruncatedText(container, label, value, typeKey);
        }
      });
    }
  }

  private addCopyButtonToMessage(contentEl: HTMLElement): void {
    const copyButton = contentEl.createEl('button', {
      cls: 'message-copy-button',
      attr: { 'aria-label': 'Copy message' }
    });
    copyButton.empty();
    copyButton.appendChild(sanitizeHTMLToDom(`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`));
  }

  private setupCodeCopyButtons(messageEl: HTMLElement): void {
    const copyButtons = messageEl.querySelectorAll('.code-copy-button');
    copyButtons.forEach(button => {
      button.addEventListener('click', (e) => {
        void (async () => {
          const target = e.currentTarget as HTMLElement;
          const codeId = target.getAttribute('data-code-id');
          const codeEl = activeDocument.getElementById(codeId!);

          if (codeEl) {
            await navigator.clipboard.writeText(codeEl.textContent || '');
            const originalText = target.textContent;
            target.textContent = 'Copied!';
            window.setTimeout(() => {
              target.textContent = originalText;
            }, 2000);
          }
        })();
      });
    });
  }

  private setupMessageCopyButtons(wrapper: HTMLElement): void {
    const copyButton = wrapper.querySelector('.message-copy-button') as HTMLButtonElement;
    const messageContent = wrapper.querySelector('.message-content') as HTMLElement;

    if (copyButton && messageContent) {
      copyButton.addEventListener('click', async (e) => {
        e.stopPropagation();

        const clone = messageContent.cloneNode(true) as HTMLElement;
        const buttonInClone = clone.querySelector('.message-copy-button');
        if (buttonInClone) {
          buttonInClone.remove();
        }

        const textContent = clone.textContent || '';

        try {
          await navigator.clipboard.writeText(textContent);

          const originalHTML = copyButton.innerHTML;
          copyButton.empty();
          copyButton.appendChild(sanitizeHTMLToDom(`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`));

          window.setTimeout(() => {
            copyButton.empty();
            copyButton.appendChild(sanitizeHTMLToDom(originalHTML));
          }, 2000);
        } catch (_err) {
          // Silently fail
        }
      });
    }
  }
}
