import { sanitizeHTMLToDom, setIcon, TFile } from 'obsidian';
import { InputAreaElements } from '../themes/types';

interface SuggestItem {
  name: string;
  desc: string;
  file?: TFile;
}

export interface InputHandlerCallbacks {
  onSend: () => void;
  onSteer: () => void;
  getIsStreaming: () => boolean;
  getSendWithCmdEnter: () => boolean;
  getVaultMarkdownFiles: () => TFile[];
  updateInputInfoBar: () => void;
  saveSessionDraft: (html: string) => void;
  loadSessionDraft: () => Promise<string | null>;
  clearSessionDraft: () => void;
}

export class InputHandler {
  private inputArea: HTMLDivElement;
  private sendButton: HTMLButtonElement;
  private inputEls: InputAreaElements;
  private callbacks: InputHandlerCallbacks;

  private activeSuggestType: 'slash' | 'mention' | null = null;
  private suggestDropdown: HTMLDivElement | null = null;
  private suggestSelectedIndex: number = 0;
  private suggestFilteredItems: SuggestItem[] = [];
  private suggestQuery: string = '';
  private suggestTriggerNode: Node | null = null;
  private suggestTriggerRange: Range | null = null;
  private draftSaveTimeout: number | null = null;

  constructor(
    inputArea: HTMLDivElement,
    sendButton: HTMLButtonElement,
    inputEls: InputAreaElements,
    callbacks: InputHandlerCallbacks,
  ) {
    this.inputArea = inputArea;
    this.sendButton = sendButton;
    this.inputEls = inputEls;
    this.callbacks = callbacks;
  }

  setupListeners(): void {
    this.sendButton.addEventListener('click', () => {
      if (this.callbacks.getIsStreaming()) {
        this.callbacks.onSteer();
      } else {
        this.callbacks.onSend();
      }
    });

    this.inputArea.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (target.hasClass('remove-pill')) {
        const pill = target.closest('.mentat-doc-pill');
        if (pill) {
          pill.remove();
          this.callbacks.updateInputInfoBar();
          this.saveDraftDebounced();
        }
      }
    });

    this.inputArea.addEventListener('keydown', (e: KeyboardEvent) => {
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

      if (e.key === 'Escape' && !this.activeSuggestType) {
        const rawText = this.getRawTextContent();
        if (rawText || this.inputArea.querySelectorAll('.mentat-doc-pill').length > 0) {
          e.preventDefault();
          this.inputArea.empty(); this.inputArea.appendChild(sanitizeHTMLToDom(''));
          this.callbacks.updateInputInfoBar();
          this.saveDraftDebounced();
          return;
        }
      }

      if (e.key === 'Enter') {
        const sendWithCmdEnter = this.callbacks.getSendWithCmdEnter();
        const isSendKey = sendWithCmdEnter ? (e.metaKey || e.ctrlKey) : !e.shiftKey;

        if (isSendKey) {
          e.preventDefault();
          if (this.callbacks.getIsStreaming()) {
            this.callbacks.onSteer();
          } else {
            this.callbacks.onSend();
          }
        }
      }
    });

    this.inputArea.addEventListener('input', () => {
      this.callbacks.updateInputInfoBar();
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

        const fullText = this.getRawTextContent().trim();
        if (fullText.startsWith('/') && !fullText.includes('\n')) {
          const query = fullText.slice(1);
          const rangeTrigger = activeDocument.createRange();
          rangeTrigger.setStart(this.inputArea.firstChild || node, 0);
          rangeTrigger.setEnd(node, offset);
          this.triggerSuggest('slash', 0, query, this.inputArea.firstChild || node, rangeTrigger);
          return;
        }

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
  }

  getRawTextContent(): string {
    const clone = this.inputArea.cloneNode(true) as HTMLElement;
    const pills = clone.querySelectorAll('.mentat-doc-pill');
    pills.forEach(pill => pill.remove());
    return (clone.innerText || clone.textContent || '').trim();
  }

  getContextPillPaths(): string[] {
    const paths: string[] = [];
    const pills = this.inputArea.querySelectorAll('.mentat-doc-pill');
    pills.forEach(pill => {
      const path = pill.getAttribute('data-path');
      if (path) paths.push(path);
    });
    return paths;
  }

  clearInput(): void {
    this.inputArea.empty(); this.inputArea.appendChild(sanitizeHTMLToDom(''));
    this.callbacks.updateInputInfoBar();
    this.callbacks.clearSessionDraft();
  }

  focusInput(): void {
    this.inputArea.focus();
  }

  saveDraftDebounced(): void {
    if (this.draftSaveTimeout) {
      window.clearTimeout(this.draftSaveTimeout);
    }

    this.draftSaveTimeout = window.setTimeout(() => {
      const htmlContent = this.inputArea.innerHTML;
      this.callbacks.saveSessionDraft(htmlContent);
    }, 300);
  }

  async restoreDraft(): Promise<void> {
    const htmlContent = await this.callbacks.loadSessionDraft();
    if (htmlContent) {
      this.inputArea.empty(); this.inputArea.appendChild(sanitizeHTMLToDom(htmlContent));

      const range = activeDocument.createRange();
      range.selectNodeContents(this.inputArea);
      range.collapse(false);
      const sel = window.getSelection();
      if (sel) {
        sel.removeAllRanges();
        sel.addRange(range);
      }

      this.callbacks.updateInputInfoBar();
    }
  }

  updateElements(inputArea: HTMLDivElement, sendButton: HTMLButtonElement, inputEls: InputAreaElements): void {
    this.inputArea = inputArea;
    this.sendButton = sendButton;
    this.inputEls = inputEls;
  }

  private triggerSuggest(type: 'slash' | 'mention', _triggerIdx: number, query: string, node?: Node, rangeTrigger?: Range): void {
    this.activeSuggestType = type;
    this.suggestQuery = query.toLowerCase();
    this.suggestTriggerNode = node || null;
    this.suggestTriggerRange = rangeTrigger || null;
    this.updateSuggestDropdown();
  }

  private closeSuggest(): void {
    this.activeSuggestType = null;
    this.suggestQuery = '';
    this.suggestTriggerNode = null;
    this.suggestTriggerRange = null;

    if (this.suggestDropdown) {
      this.suggestDropdown.remove();
      this.suggestDropdown = null;
    }
  }

  private updateSuggestDropdown(): void {
    const wrapper = this.inputEls.wrapper;
    if (!this.suggestDropdown) {
      this.suggestDropdown = wrapper.createDiv('mentat-suggest-dropdown');
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
      const allFiles = this.callbacks.getVaultMarkdownFiles();
      const filtered = allFiles.filter(f => f.basename.toLowerCase().includes(this.suggestQuery));

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
        e.preventDefault();
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

      const cmdText = activeDocument.createTextNode(command + '\u00A0');
      this.suggestTriggerRange.insertNode(cmdText);

      const range = activeDocument.createRange();
      range.setStartAfter(cmdText);
      range.collapse(true);
      const sel = window.getSelection();
      if (sel) {
        sel.removeAllRanges();
        sel.addRange(range);
      }
    } else {
      this.inputArea.empty();
      this.inputArea.appendText(command + '\u00A0');
      const range = activeDocument.createRange();
      range.selectNodeContents(this.inputArea);
      range.collapse(false);
      const sel = window.getSelection();
      if (sel) {
        sel.removeAllRanges();
        sel.addRange(range);
      }
    }

    this.closeSuggest();
    this.callbacks.updateInputInfoBar();
    this.saveDraftDebounced();
    this.inputArea.focus();
  }

  private insertPill(fileName: string, filePath: string, _node: Node, rangeTrigger: Range): void {
    rangeTrigger.deleteContents();

    const pill = activeDocument.createElement('span');
    pill.className = 'mentat-doc-pill';
    pill.setAttribute('contenteditable', 'false');
    pill.setAttribute('data-path', filePath);
    pill.empty();
    pill.appendText(`📄 ${fileName}\u00A0`);
    const removeSpan = pill.createSpan({ cls: 'remove-pill' });
    removeSpan.setAttribute('aria-label', 'Remove document');
    removeSpan.setText('×');

    rangeTrigger.insertNode(pill);

    const space = activeDocument.createTextNode('\u00A0');
    rangeTrigger.setStartAfter(pill);
    rangeTrigger.collapse(true);
    rangeTrigger.insertNode(space);

    const sel = window.getSelection();
    if (sel) {
      const nextRange = activeDocument.createRange();
      nextRange.setStartAfter(space);
      nextRange.collapse(true);
      sel.removeAllRanges();
      sel.addRange(nextRange);
    }

    this.closeSuggest();
    this.callbacks.updateInputInfoBar();
    this.saveDraftDebounced();
    this.inputArea.focus();
  }
}
