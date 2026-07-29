// Provider Edit Modal - Configure AI provider settings

import { App, Modal, Setting, Notice } from 'obsidian';
import MentatPlugin from '../main';
import { AIProviderConfig } from './settings';
import { parseJson } from '../utils/json-healer';

export class ProviderEditModal extends Modal {
  private plugin: MentatPlugin;
  private provider: AIProviderConfig | null;
  private index: number;
  private tempConfig: Partial<AIProviderConfig>;
  private onSave: () => void;
  private fieldContainers: Map<string, HTMLElement>;

  constructor(
    app: App,
    plugin: MentatPlugin,
    provider: AIProviderConfig | null,
    index: number,
    onSave: () => void
  ) {
    super(app);
    this.plugin = plugin;
    this.provider = provider;
    this.index = index;
    this.onSave = onSave;
    this.fieldContainers = new Map();

    // Initialize tempConfig
    if (provider) {
      // Deep copy existing provider
      this.tempConfig = parseJson<AIProviderConfig>(JSON.stringify(provider));
    } else {
      // New provider with defaults
      this.tempConfig = {
        type: 'openai',
        enabled: true,
        supportsStreaming: true
      };
    }
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('provider-edit-modal');

    // Title
    contentEl.createDiv({ cls: 'modal-title', text: this.provider ? '编辑 AI Provider' : '添加 AI Provider' });

    // Create all form fields
    this.createFormFields();

    // Button container
    const buttonContainer = contentEl.createDiv('modal-button-container');

    // Cancel button
    const cancelButton = buttonContainer.createEl('button', { text: '取消' });
    cancelButton.addEventListener('click', () => this.close());

    // Save button
    const saveButton = buttonContainer.createEl('button', {
      text: '保存',
      cls: 'mod-cta'
    });
    saveButton.addEventListener('click', () => { void this.handleSave(); });
  }

  onClose(): void {
    const { contentEl } = this;
    contentEl.empty();
  }

  private createFormFields(): void {
    const { contentEl } = this;

    // Provider Name
    new Setting(contentEl)
      .setName('Provider名称')
      .setDesc('为此Provider指定一个易识别的名称')
      .addText(text => text
        .setPlaceholder('例如: My OpenAI')
        .setValue(this.tempConfig.name || '')
        .onChange(value => {
          this.tempConfig.name = value;
        }));

    // Provider Type
    new Setting(contentEl)
      .setName('Provider类型')
      .setDesc('选择AI服务提供商类型')
      .addDropdown(dropdown => {
        dropdown
          .addOption('openai', 'OpenAI / DeepSeek')
          .addOption('anthropic', 'Anthropic Claude')
          .addOption('ollama', 'Ollama (本地)')
          .setValue(this.tempConfig.type || 'openai')
          .onChange(value => {
            this.tempConfig.type = value as 'openai' | 'anthropic' | 'ollama';
            this.updateFieldVisibility();
          });
      });

    // Enabled Toggle
    new Setting(contentEl)
      .setName('启用')
      .setDesc('是否启用此Provider')
      .addToggle(toggle => toggle
        .setValue(this.tempConfig.enabled !== false)
        .onChange(value => {
          this.tempConfig.enabled = value;
        }));

    // Section: Connection Settings
    contentEl.createEl('h3', {
      text: '连接设置',
      cls: 'setting-item-heading'
    });

    // API Key (conditional)
    const apiKeyContainer = contentEl.createDiv();
    this.fieldContainers.set('apiKey', apiKeyContainer);
    new Setting(apiKeyContainer)
      .setName('API密钥')
      .setDesc('从Provider获取的API密钥')
      .addText(text => {
        text
          .setPlaceholder('sk-...')
          .setValue(this.tempConfig.apiKey || '')
          .onChange(value => {
            this.tempConfig.apiKey = value;
          });
        text.inputEl.type = 'password';
      });

    // Base URL (conditional)
    const baseURLContainer = contentEl.createDiv();
    this.fieldContainers.set('baseURL', baseURLContainer);
    new Setting(baseURLContainer)
      .setName('Base URL')
      .setDesc('API端点地址（可选）')
      .addText(text => text
        .setPlaceholder('https://api.openai.com/v1')
        .setValue(this.tempConfig.baseURL || '')
        .onChange(value => {
          this.tempConfig.baseURL = value;
        }));

    // Section: Model Configuration
    contentEl.createEl('h3', {
      text: '模型配置',
      cls: 'setting-item-heading'
    });

    // Model
    new Setting(contentEl)
      .setName('模型')
      .setDesc('使用的模型名称')
      .addText(text => text
        .setPlaceholder('gpt-4o-mini')
        .setValue(this.tempConfig.model || '')
        .onChange(value => {
          this.tempConfig.model = value;
        }));

    // Embedding Model (conditional)
    const embeddingModelContainer = contentEl.createDiv();
    this.fieldContainers.set('embeddingModel', embeddingModelContainer);
    new Setting(embeddingModelContainer)
      .setName('向量模型')
      .setDesc('用于生成向量嵌入的模型（可选）')
      .addText(text => text
        .setPlaceholder('text-embedding-3-small')
        .setValue(this.tempConfig.embeddingModel || '')
        .onChange(value => {
          this.tempConfig.embeddingModel = value;
        }));

    // Section: Advanced Options
    contentEl.createEl('h3', {
      text: '高级选项',
      cls: 'setting-item-heading'
    });

    // Temperature
    new Setting(contentEl)
      .setName('温度')
      .setDesc('控制输出的随机性 (0-2)')
      .addSlider(slider => slider
        .setLimits(0, 2, 0.1)
        .setValue(this.tempConfig.temperature ?? 0.7)

        .onChange(value => {
          this.tempConfig.temperature = value;
        }));

    // Max Tokens
    new Setting(contentEl)
      .setName('最大Tokens')
      .setDesc('单次响应的最大Token数')
      .addText(text => text
        .setPlaceholder('16384')
        .setValue(String(this.tempConfig.maxTokens || 16384))
        .onChange(value => {
          if (value === '') {
            this.tempConfig.maxTokens = undefined;
            return;
          }
          const num = parseInt(value);
          if (!isNaN(num)) {
            this.tempConfig.maxTokens = num;
          }
        }));

    // Context Window
    new Setting(contentEl)
      .setName('上下文窗口')
      .setDesc('模型上下文长度（tokens），留空自动检测')
      .addText(text => text
        .setPlaceholder('128000')
        .setValue(this.tempConfig.contextWindow ? String(this.tempConfig.contextWindow) : '')
        .onChange(value => {
          const num = parseInt(value);
          this.tempConfig.contextWindow = isNaN(num) ? undefined : num;
        }));

    // Compaction Threshold
    new Setting(contentEl)
      .setName('压缩阈值')
      .setDesc('上下文达到此比例时触发压缩 (0-1)，默认 0.8')
      .addText(text => text
        .setPlaceholder('0.8')
        .setValue(this.tempConfig.compactionThreshold ? String(this.tempConfig.compactionThreshold) : '')
        .onChange(value => {
          const num = parseFloat(value);
          this.tempConfig.compactionThreshold = (isNaN(num) || num <= 0 || num >= 1) ? undefined : num;
        }));

    // Initial field visibility update
    this.updateFieldVisibility();
  }

  private updateFieldVisibility(): void {
    const type = this.tempConfig.type;

    // API Key: Required for OpenAI and Anthropic, not for Ollama
    const apiKeyEl = this.fieldContainers.get('apiKey');
    if (type === 'ollama') {
      apiKeyEl?.hide();
      this.tempConfig.apiKey = undefined;
    } else {
      apiKeyEl?.show();
    }

    // Base URL: Required for Ollama and OpenAI, not for Anthropic
    const baseURLEl = this.fieldContainers.get('baseURL');
    if (type === 'anthropic') {
      baseURLEl?.hide();
      this.tempConfig.baseURL = undefined;
    } else {
      baseURLEl?.show();
      // Update placeholder
      const input = baseURLEl?.querySelector('input');
      if (input) {
        input.placeholder = type === 'ollama'
          ? 'http://localhost:11434'
          : 'https://api.openai.com/v1';
      }
    }

    // Embedding Model: Not supported for Anthropic
    const embeddingEl = this.fieldContainers.get('embeddingModel');
    if (type === 'anthropic') {
      embeddingEl?.hide();
      this.tempConfig.embeddingModel = undefined;
    } else {
      embeddingEl?.show();
      // Update placeholder
      const input = embeddingEl?.querySelector('input');
      if (input && type === 'ollama') {
        input.placeholder = 'nomic-embed-text';
      }
    }
  }

  private validateForm(): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    // Required: Name
    if (!this.tempConfig.name?.trim()) {
      errors.push('Provider名称不能为空');
    }

    // Required: Type
    if (!this.tempConfig.type) {
      errors.push('请选择Provider类型');
    }

    // Required: Model
    if (!this.tempConfig.model?.trim()) {
      errors.push('模型名称不能为空');
    }

    // Conditional: API Key
    if ((this.tempConfig.type === 'openai' || this.tempConfig.type === 'anthropic')
        && !this.tempConfig.apiKey?.trim()) {
      errors.push('此Provider类型需要API密钥');
    }

    // Conditional: Base URL for Ollama
    if (this.tempConfig.type === 'ollama' && !this.tempConfig.baseURL?.trim()) {
      errors.push('Ollama需要Base URL');
    }

    // URL format validation
    if (this.tempConfig.baseURL) {
      try {
        new URL(this.tempConfig.baseURL);
      } catch {
        errors.push('Base URL格式不正确');
      }
    }

    // Temperature range validation
    if (this.tempConfig.temperature !== undefined) {
      if (this.tempConfig.temperature < 0 || this.tempConfig.temperature > 2) {
        errors.push('温度必须在0-2之间');
      }
    }

    // MaxTokens validation
    if (this.tempConfig.maxTokens !== undefined && this.tempConfig.maxTokens < 1) {
      errors.push('最大Tokens必须大于0');
    }

    // Compaction threshold validation
    if (this.tempConfig.compactionThreshold !== undefined) {
      if (this.tempConfig.compactionThreshold <= 0 || this.tempConfig.compactionThreshold >= 1) {
        errors.push('压缩阈值必须在0到1之间');
      }
    }

    return { valid: errors.length === 0, errors };
  }

  private async handleSave(): Promise<void> {
    // 1. Validate
    const validation = this.validateForm();
    if (!validation.valid) {
      new Notice('配置验证失败：\n' + validation.errors.join('\n'));
      return;
    }

    // 2. Apply defaults and capabilities
    this.applyDefaults();

    // 3. Generate ID if new provider
    if (!this.tempConfig.id) {
      this.tempConfig.id = this.generateProviderId();
    }

    // 4. Update or add to settings
    const config = this.tempConfig as AIProviderConfig;
    if (this.index >= 0) {
      // Edit existing
      this.plugin.settings.aiProviders[this.index] = config;
    } else {
      // Add new
      this.plugin.settings.aiProviders.push(config);
    }

    // 5. Save settings (will auto-refresh AIRouter)
    await this.plugin.saveSettings();

    // 6. Callback to refresh settings page
    this.onSave();

    // 7. Show success notice
    new Notice(`Provider "${config.name}" 保存成功`);

    // 8. Close modal
    this.close();
  }

  private applyDefaults(): void {
    // Set defaults based on provider type
    switch (this.tempConfig.type) {
      case 'openai':
        if (!this.tempConfig.baseURL) {
          this.tempConfig.baseURL = 'https://api.openai.com/v1';
        }
        this.tempConfig.supportsEmbedding = !!this.tempConfig.embeddingModel;
        this.tempConfig.supportsStreaming = true;
        break;

      case 'anthropic':
        this.tempConfig.baseURL = undefined;
        this.tempConfig.embeddingModel = undefined;
        this.tempConfig.supportsEmbedding = false;
        this.tempConfig.supportsStreaming = true;
        break;

      case 'ollama':
        if (!this.tempConfig.baseURL) {
          this.tempConfig.baseURL = 'http://localhost:11434';
        }
        this.tempConfig.apiKey = undefined;
        this.tempConfig.supportsEmbedding = !!this.tempConfig.embeddingModel;
        this.tempConfig.supportsStreaming = true;
        break;
    }

    // Common defaults
    if (this.tempConfig.temperature === undefined) {
      this.tempConfig.temperature = 0.7;
    }
    if (this.tempConfig.maxTokens === undefined) {
      this.tempConfig.maxTokens = 16384;
    }
    if (this.tempConfig.enabled === undefined) {
      this.tempConfig.enabled = true;
    }
  }

  private generateProviderId(): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 8);
    return `${this.tempConfig.type}-${timestamp}-${random}`;
  }
}
