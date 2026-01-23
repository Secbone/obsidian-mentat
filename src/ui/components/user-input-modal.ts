// User Input Modal - Displays a question and collects user input

import { App, Modal } from 'obsidian';

export interface UserInputResult {
  cancelled: boolean;
  answer: string;
}

export class UserInputModal extends Modal {
  private question: string;
  private context?: string;
  private options?: string[];
  private defaultValue?: string;
  private requiresInput: boolean;
  private onSubmit: (result: UserInputResult) => void;
  private selectedOption?: string;
  private textInput?: HTMLTextAreaElement;

  constructor(
    app: App,
    question: string,
    context: string | undefined,
    options: string[] | undefined,
    defaultValue: string | undefined,
    requiresInput: boolean,
    onSubmit: (result: UserInputResult) => void
  ) {
    super(app);
    this.question = question;
    this.context = context;
    this.options = options;
    this.defaultValue = defaultValue;
    this.requiresInput = requiresInput;
    this.onSubmit = onSubmit;
    this.selectedOption = options?.[0]; // Default to first option if options provided
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('user-input-modal');

    // Title
    contentEl.createEl('h2', { text: 'AI needs your guidance' });

    // Context (if provided)
    if (this.context) {
      const contextEl = contentEl.createDiv({ cls: 'user-input-context' });
      contextEl.createEl('p', { text: this.context });
    }

    // Question
    const questionEl = contentEl.createDiv({ cls: 'user-input-question' });
    questionEl.createEl('p', { text: this.question });

    // Input area
    const inputContainer = contentEl.createDiv({ cls: 'user-input-container' });

    if (this.options && this.options.length > 0) {
      // Option selection mode (radio buttons)
      this.options.forEach((option, index) => {
        const optionContainer = inputContainer.createDiv({ cls: 'user-input-option' });

        const radio = optionContainer.createEl('input', {
          type: 'radio',
          attr: {
            name: 'user-input-option',
            id: `option-${index}`,
            value: option
          }
        });

        if (index === 0) {
          radio.checked = true;
        }

        radio.addEventListener('change', () => {
          this.selectedOption = option;
        });

        const label = optionContainer.createEl('label', {
          text: option,
          attr: { for: `option-${index}` }
        });
      });
    } else {
      // Free text input mode (textarea)
      this.textInput = inputContainer.createEl('textarea', {
        cls: 'user-input-textarea',
        attr: {
          placeholder: 'Enter your answer...',
          rows: '4'
        }
      });

      if (this.defaultValue) {
        this.textInput.value = this.defaultValue;
      }

      // Auto-focus the textarea
      setTimeout(() => this.textInput?.focus(), 50);

      // Handle Enter key (Ctrl+Enter or Cmd+Enter to submit)
      this.textInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          this.handleSubmit();
        }
      });
    }

    // Button container
    const buttonContainer = contentEl.createDiv({ cls: 'user-input-buttons' });

    // Cancel button
    const cancelBtn = buttonContainer.createEl('button', {
      text: 'Cancel',
      cls: 'user-input-button user-input-button-cancel'
    });
    cancelBtn.addEventListener('click', () => this.handleCancel());

    // Submit button
    const submitBtn = buttonContainer.createEl('button', {
      text: 'Submit',
      cls: 'user-input-button user-input-button-submit mod-cta'
    });
    submitBtn.addEventListener('click', () => this.handleSubmit());

    // Validation for submit button
    if (this.requiresInput && !this.options) {
      const validateInput = () => {
        const hasValue = this.textInput && this.textInput.value.trim().length > 0;
        submitBtn.disabled = !hasValue;
      };

      this.textInput?.addEventListener('input', validateInput);
      validateInput(); // Initial validation
    }
  }

  private handleSubmit(): void {
    let answer: string;

    if (this.options) {
      // Option selection mode
      answer = this.selectedOption || this.options[0];
    } else {
      // Free text mode
      answer = this.textInput?.value.trim() || '';

      if (this.requiresInput && !answer) {
        return; // Don't submit if input is required but empty
      }
    }

    this.onSubmit({
      cancelled: false,
      answer
    });

    this.close();
  }

  private handleCancel(): void {
    this.onSubmit({
      cancelled: true,
      answer: ''
    });

    this.close();
  }

  onClose(): void {
    const { contentEl } = this;
    contentEl.empty();
  }
}
