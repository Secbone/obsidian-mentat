import { App, PluginSettingTab, Setting, Notice } from 'obsidian';
import PersonalAgentPlugin from '../main';
import { AIProviderConfig } from '../settings/settings';
import { ProviderEditModal } from './provider-edit-modal';

export class SettingsTab extends PluginSettingTab {
  plugin: PersonalAgentPlugin;

  constructor(app: App, plugin: PersonalAgentPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h1', { text: 'Personal Agent Settings' });

    // AI Providers Section
    this.displayAIProvidersSection(containerEl);

    // Task Routing Section
    this.displayTaskRoutingSection(containerEl);

    // Integration Section
    this.displayIntegrationSection(containerEl);

    // Feature Toggles Section
    this.displayFeatureTogglesSection(containerEl);

    // Performance Section
    this.displayPerformanceSection(containerEl);
  }

  displayAIProvidersSection(containerEl: HTMLElement): void {
    containerEl.createEl('h2', { text: 'AI Providers' });

    containerEl.createEl('p', {
      text: 'Configure AI providers for different tasks. Supports OpenAI-compatible APIs, Anthropic, and Ollama.',
      cls: 'setting-item-description'
    });

    // List existing providers
    this.plugin.settings.aiProviders.forEach((provider, index) => {
      const providerContainer = containerEl.createDiv('provider-config');

      new Setting(providerContainer)
        .setName(`Provider: ${provider.name}`)
        .setDesc(`Type: ${provider.type} | Model: ${provider.model}`)
        .addButton(button => button
          .setButtonText('Edit')
          .onClick(() => {
            this.showProviderEditModal(provider, index);
          }))
        .addButton(button => button
          .setButtonText('Remove')
          .setWarning()
          .onClick(async () => {
            this.plugin.settings.aiProviders.splice(index, 1);
            await this.plugin.saveSettings();
            this.display();
          }));
    });

    // Add new provider button
    new Setting(containerEl)
      .setName('Add AI Provider')
      .setDesc('Add a new AI provider configuration')
      .addButton(button => button
        .setButtonText('Add Provider')
        .onClick(() => {
          this.showProviderEditModal(null, -1);
        }));
  }

  displayTaskRoutingSection(containerEl: HTMLElement): void {
    containerEl.createEl('h2', { text: 'Task Routing' });

    containerEl.createEl('p', {
      text: 'Assign different AI providers to specific task types.',
      cls: 'setting-item-description'
    });

    const tasks = [
      { key: 'embedding', name: 'Embedding' },
      { key: 'classification', name: 'Classification' },
      { key: 'linking', name: 'Link Suggestion' },
      { key: 'chat', name: 'Chat' },
      { key: 'review', name: 'Review' }
    ];

    tasks.forEach(task => {
      new Setting(containerEl)
        .setName(task.name)
        .setDesc(`AI provider for ${task.name.toLowerCase()} tasks`)
        .addDropdown(dropdown => {
          dropdown.addOption('', 'Auto (default)');

          this.plugin.settings.aiProviders.forEach(provider => {
            dropdown.addOption(provider.id, provider.name);
          });

          dropdown
            .setValue(this.plugin.settings.taskRouting[task.key as keyof typeof this.plugin.settings.taskRouting] || '')
            .onChange(async (value) => {
              (this.plugin.settings.taskRouting as any)[task.key] = value;
              await this.plugin.saveSettings();
            });
        });
    });
  }

  displayIntegrationSection(containerEl: HTMLElement): void {
    containerEl.createEl('h2', { text: 'Integrations' });

    // OpenCode Integration
    new Setting(containerEl)
      .setName('Enable OpenCode Integration')
      .setDesc('Use OpenCode for advanced automation tasks (optional)')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.opencodeEnabled)
        .onChange(async (value) => {
          this.plugin.settings.opencodeEnabled = value;
          await this.plugin.saveSettings();
          this.display();
        }));

    if (this.plugin.settings.opencodeEnabled) {
      new Setting(containerEl)
        .setName('OpenCode API URL')
        .setDesc('URL for OpenCode API endpoint')
        .addText(text => text
          .setPlaceholder('http://localhost:8000')
          .setValue(this.plugin.settings.opencodeApiUrl)
          .onChange(async (value) => {
            this.plugin.settings.opencodeApiUrl = value;
            await this.plugin.saveSettings();
          }));

      new Setting(containerEl)
        .setName('OpenCode API Key')
        .setDesc('API key for OpenCode authentication')
        .addText(text => text
          .setPlaceholder('your-api-key')
          .setValue(this.plugin.settings.opencodeApiKey)
          .onChange(async (value) => {
            this.plugin.settings.opencodeApiKey = value;
            await this.plugin.saveSettings();
          }));
    }

    // Browserless API Key
    new Setting(containerEl)
      .setName('Browserless API Key')
      .setDesc('API key for Browserless service (used by web-fetch skill for JavaScript-heavy pages). Get your key at https://browserless.io')
      .addText(text => text
        .setPlaceholder('Enter your Browserless API key')
        .setValue(this.plugin.settings.browserlessApiKey)
        .onChange(async (value) => {
          this.plugin.settings.browserlessApiKey = value;
          await this.plugin.saveSettings();
        }));

    // Obsidian Skills Integration
    new Setting(containerEl)
      .setName('Enable Obsidian Skills Integration')
      .setDesc('Register and use Obsidian Skills commands')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.skillsEnabled)
        .onChange(async (value) => {
          this.plugin.settings.skillsEnabled = value;
          await this.plugin.saveSettings();
        }));
  }

  displayFeatureTogglesSection(containerEl: HTMLElement): void {
    containerEl.createEl('h2', { text: 'Features' });

    const features = [
      { key: 'autoClassificationEnabled', name: 'Auto Classification', desc: 'Automatically classify and tag notes' },
      { key: 'linkSuggestionEnabled', name: 'Link Suggestions', desc: 'Suggest links between related notes' },
      { key: 'chatEnabled', name: 'AI Chat', desc: 'Chat with your knowledge base' },
      { key: 'graphEnabled', name: 'Knowledge Graph', desc: 'Visualize note connections' },
      { key: 'reviewEnabled', name: 'Review System', desc: 'Spaced repetition for note review' }
    ];

    features.forEach(feature => {
      new Setting(containerEl)
        .setName(feature.name)
        .setDesc(feature.desc)
        .addToggle(toggle => toggle
          .setValue((this.plugin.settings as any)[feature.key])
          .onChange(async (value) => {
            (this.plugin.settings as any)[feature.key] = value;
            await this.plugin.saveSettings();
          }));
    });
  }

  displayPerformanceSection(containerEl: HTMLElement): void {
    containerEl.createEl('h2', { text: 'Performance' });

    new Setting(containerEl)
      .setName('Indexing Batch Size')
      .setDesc('Number of files to process at once (10-100)')
      .addSlider(slider => slider
        .setLimits(10, 100, 10)
        .setValue(this.plugin.settings.indexingBatchSize)
        .setDynamicTooltip()
        .onChange(async (value) => {
          this.plugin.settings.indexingBatchSize = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Cache Expiry (days)')
      .setDesc('How long to keep cached data (1-30 days)')
      .addSlider(slider => slider
        .setLimits(1, 30, 1)
        .setValue(this.plugin.settings.cacheExpiryDays)
        .setDynamicTooltip()
        .onChange(async (value) => {
          this.plugin.settings.cacheExpiryDays = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Review Interval (days)')
      .setDesc('Default interval between reviews (1-30 days)')
      .addSlider(slider => slider
        .setLimits(1, 30, 1)
        .setValue(this.plugin.settings.reviewIntervalDays)
        .setDynamicTooltip()
        .onChange(async (value) => {
          this.plugin.settings.reviewIntervalDays = value;
          await this.plugin.saveSettings();
        }));

    const maxTurnsSetting = new Setting(containerEl)
      .setName('Agent Max Turns')
      .setDesc('Maximum number of iterations the AI agent can perform when executing tasks (1-99). Default: 20. Higher values allow for more complex multi-step operations.');

    // Add text input for precise control
    maxTurnsSetting.addText(text => text
      .setPlaceholder('20')
      .setValue(String(this.plugin.settings.maxTurns))
      .onChange(async (value) => {
        const numValue = parseInt(value);
        if (!isNaN(numValue) && numValue >= 1 && numValue <= 99) {
          this.plugin.settings.maxTurns = numValue;
          await this.plugin.saveSettings();
        }
      }));

    // Add slider for quick adjustment
    maxTurnsSetting.addSlider(slider => slider
      .setLimits(1, 99, 1)
      .setValue(this.plugin.settings.maxTurns)
      .setDynamicTooltip()
      .onChange(async (value) => {
        this.plugin.settings.maxTurns = value;
        await this.plugin.saveSettings();
        // Update text input
        const textInput = containerEl.querySelector('.setting-item:last-child input[type="text"]') as HTMLInputElement;
        if (textInput) {
          textInput.value = String(value);
        }
      }));

    // Add reset button
    maxTurnsSetting.addExtraButton(button => button
      .setIcon('reset')
      .setTooltip('Reset to default (20)')
      .onClick(async () => {
        this.plugin.settings.maxTurns = 20;
        await this.plugin.saveSettings();
        this.display();
      }));
  }

  showProviderEditModal(provider: AIProviderConfig | null, index: number): void {
    new ProviderEditModal(
      this.app,
      this.plugin,
      provider,
      index,
      () => this.display()
    ).open();
  }
}
