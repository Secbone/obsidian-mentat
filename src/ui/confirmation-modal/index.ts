// Confirmation Modal - Displays confirmation dialog for write operations

import { App, Modal } from 'obsidian';

export interface ConfirmationModalOptions {
  skillName: string;
  description: string;
  parameters: Record<string, any>;
  operationType: 'create' | 'update' | 'delete' | 'write';
}

export class ConfirmationModal extends Modal {
  private options: ConfirmationModalOptions;
  private onSubmit: (confirmed: boolean) => void;

  constructor(
    app: App,
    options: ConfirmationModalOptions,
    onSubmit: (confirmed: boolean) => void
  ) {
    super(app);
    this.options = options;
    this.onSubmit = onSubmit;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('confirmation-modal');

    // Title with operation type styling
    const titleContainer = contentEl.createDiv({ cls: 'confirmation-modal-title' });
    const icon = this.getOperationIcon(this.options.operationType);
    titleContainer.createEl('h2', {
      text: `${icon} Confirm ${this.capitalizeFirst(this.options.operationType)} Operation`
    });

    // Warning message for write operations
    const warningEl = contentEl.createDiv({ cls: 'confirmation-modal-warning' });
    warningEl.createEl('p', {
      text: 'The AI is requesting permission to perform a write operation on your vault.'
    });

    // Skill information
    const infoContainer = contentEl.createDiv({ cls: 'confirmation-modal-info' });

    // Skill name
    const skillNameEl = infoContainer.createDiv({ cls: 'confirmation-modal-field' });
    skillNameEl.createEl('strong', { text: 'Skill: ' });
    skillNameEl.createSpan({ text: this.options.skillName });

    // Description
    if (this.options.description) {
      const descEl = infoContainer.createDiv({ cls: 'confirmation-modal-field' });
      descEl.createEl('strong', { text: 'Description: ' });
      descEl.createSpan({ text: this.options.description });
    }

    // Operation type
    const opTypeEl = infoContainer.createDiv({ cls: 'confirmation-modal-field' });
    opTypeEl.createEl('strong', { text: 'Operation Type: ' });
    opTypeEl.createSpan({ text: this.capitalizeFirst(this.options.operationType) });

    // Parameters section
    if (this.options.parameters && Object.keys(this.options.parameters).length > 0) {
      const paramsContainer = contentEl.createDiv({ cls: 'confirmation-modal-params' });
      paramsContainer.createEl('h3', { text: 'Parameters' });

      const paramsContent = paramsContainer.createDiv({ cls: 'confirmation-modal-params-content' });
      this.renderParameters(paramsContent, this.options.parameters);
    }

    // Button container
    const buttonContainer = contentEl.createDiv({ cls: 'confirmation-modal-buttons' });

    // Cancel button (auto-focus for safety)
    const cancelBtn = buttonContainer.createEl('button', {
      text: 'Cancel',
      cls: 'confirmation-modal-button confirmation-modal-button-cancel'
    });
    cancelBtn.addEventListener('click', () => this.handleCancel());

    // Auto-focus cancel button for safety
    setTimeout(() => cancelBtn.focus(), 50);

    // Confirm button
    const confirmBtn = buttonContainer.createEl('button', {
      text: 'Confirm',
      cls: 'confirmation-modal-button confirmation-modal-button-confirm mod-cta mod-warning'
    });
    confirmBtn.addEventListener('click', () => this.handleConfirm());

    // Keyboard shortcuts
    this.scope.register([], 'Escape', () => {
      this.handleCancel();
      return false;
    });

    this.scope.register([], 'Enter', () => {
      this.handleConfirm();
      return false;
    });
  }

  private renderParameters(container: HTMLElement, params: Record<string, any>): void {
    for (const [key, value] of Object.entries(params)) {
      const paramRow = container.createDiv({ cls: 'confirmation-modal-param-row' });

      const paramKey = paramRow.createDiv({ cls: 'confirmation-modal-param-key' });
      paramKey.createEl('strong', { text: `${key}:` });

      const paramValue = paramRow.createDiv({ cls: 'confirmation-modal-param-value' });

      if (key === 'path') {
        // Highlight file paths prominently
        paramValue.createEl('code', { text: value, cls: 'confirmation-modal-path' });
      } else if (key === 'content' && typeof value === 'string') {
        // Truncate long content
        const preview = this.truncateContent(value, 200);
        const contentEl = paramValue.createDiv({ cls: 'confirmation-modal-content-preview' });
        contentEl.createEl('pre', { text: preview });

        if (preview.length < value.length) {
          contentEl.createDiv({
            text: `[+${value.length - preview.length} more characters]`,
            cls: 'confirmation-modal-content-more'
          });
        }
      } else if (typeof value === 'object' && value !== null) {
        // Format objects as JSON
        if (Array.isArray(value)) {
          paramValue.createEl('code', { text: `[${value.length} items]` });
          if (value.length > 0 && value.length <= 3) {
            const itemsPreview = paramValue.createDiv({ cls: 'confirmation-modal-array-preview' });
            itemsPreview.createEl('pre', { text: JSON.stringify(value, null, 2) });
          }
        } else {
          const jsonPreview = paramValue.createDiv({ cls: 'confirmation-modal-json-preview' });
          jsonPreview.createEl('pre', { text: JSON.stringify(value, null, 2) });
        }
      } else {
        // Simple values
        paramValue.createEl('code', { text: String(value) });
      }
    }
  }

  private truncateContent(content: string, maxLength: number): string {
    if (content.length <= maxLength) {
      return content;
    }
    return content.substring(0, maxLength) + '...';
  }

  private getOperationIcon(operationType: string): string {
    switch (operationType) {
      case 'create': return '✨';
      case 'update': return '✏️';
      case 'delete': return '🗑️';
      case 'write': return '📝';
      default: return '⚠️';
    }
  }

  private capitalizeFirst(text: string): string {
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  private handleConfirm(): void {
    this.onSubmit(true);
    this.close();
  }

  private handleCancel(): void {
    this.onSubmit(false);
    this.close();
  }

  onClose(): void {
    const { contentEl } = this;
    contentEl.empty();
  }
}
