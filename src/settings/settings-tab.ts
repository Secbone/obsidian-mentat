import { App, PluginSettingTab, Setting, Notice } from 'obsidian';
import PersonalAgentPlugin from '../main';
import { AIProviderConfig } from '../settings/settings';
import { ProviderEditModal } from './provider-edit-modal';

export class SettingsTab extends PluginSettingTab {
  plugin: PersonalAgentPlugin;
  private activeTab: 'general' | 'skills' = 'general';
  private searchQuery: string = '';

  constructor(app: App, plugin: PersonalAgentPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h1', { text: 'Mentat Settings' });

    // Render tab bar
    const tabBar = containerEl.createDiv({ cls: 'setting-tab-bar' });
    tabBar.style.display = 'flex';
    tabBar.style.gap = '10px';
    tabBar.style.marginBottom = '20px';
    tabBar.style.borderBottom = '1px solid var(--border-color)';
    tabBar.style.paddingBottom = '10px';

    const generalTabButton = tabBar.createEl('button', { text: 'General Configuration' });
    const skillsTabButton = tabBar.createEl('button', { text: 'Skills & Tools Manager' });

    // Style buttons based on active tab
    const activeStyle = (btn: HTMLButtonElement) => {
      btn.style.backgroundColor = 'var(--interactive-accent)';
      btn.style.color = 'var(--text-on-accent)';
      btn.style.fontWeight = 'bold';
    };
    const inactiveStyle = (btn: HTMLButtonElement) => {
      btn.style.backgroundColor = 'var(--button-background)';
      btn.style.color = 'var(--text-normal)';
      btn.style.fontWeight = 'normal';
    };

    if (this.activeTab === 'general') {
      activeStyle(generalTabButton);
      inactiveStyle(skillsTabButton);
    } else {
      inactiveStyle(generalTabButton);
      activeStyle(skillsTabButton);
    }

    generalTabButton.addEventListener('click', () => {
      this.activeTab = 'general';
      this.display();
    });

    skillsTabButton.addEventListener('click', () => {
      this.activeTab = 'skills';
      this.display();
    });

    if (this.activeTab === 'general') {
      // AI Providers Section
      this.displayAIProvidersSection(containerEl);

      // Task Routing Section
      this.displayTaskRoutingSection(containerEl);

      // Integration Section
      this.displayIntegrationSection(containerEl);

      // User Prompt Preferences Section
      this.displayUserPreferencesSection(containerEl);

      // Feature Toggles Section
      this.displayFeatureTogglesSection(containerEl);

      // Skills Section
      this.displaySkillsSection(containerEl);

      // Performance Section
      this.displayPerformanceSection(containerEl);

      // Diagnostics Section
      this.displayDiagnosticsSection(containerEl);
    } else {
      // Skills & Tools Manager Section
      this.displaySkillsManagerSection(containerEl);
    }
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

    // Brave Search API Key
    new Setting(containerEl)
      .setName('Brave Search API Key')
      .setDesc('API key for Brave Search (used by web-search skill). Get your free key at https://brave.com/search/api/')
      .addText(text => text
        .setPlaceholder('Enter your Brave Search API key')
        .setValue(this.plugin.settings.braveSearchApiKey)
        .onChange(async (value) => {
          this.plugin.settings.braveSearchApiKey = value;
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

  displayUserPreferencesSection(containerEl: HTMLElement): void {
    containerEl.createEl('h2', { text: 'User Prompt Preferences' });

    containerEl.createEl('p', {
      text: 'Customize writing styles, formatting rules, and notes compared to your manual style. These preferences are stored directly in your vault as a markdown note, providing a spacious and customizable editing experience. Changes are injected dynamically into the AI system prompt.',
      cls: 'setting-item-description'
    });

    new Setting(containerEl)
      .setName('Configuration Folder')
      .setDesc('Vault folder path where Mentat looks for the user-preferences.md file.')
      .addText(text => text
        .setPlaceholder('Mentat/Config')
        .setValue(this.plugin.settings.userConfigFolder || 'Mentat/Config')
        .onChange(async (value) => {
          this.plugin.settings.userConfigFolder = value.trim() || 'Mentat/Config';
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Custom Preferences Note')
      .setDesc('Create or open the user-preferences.md note directly in Obsidian to customize your writing preferences.')
      .addButton(button => button
        .setButtonText('Open Preferences Note')
        .setCta()
        .onClick(async () => {
          try {
            const folderPath = this.plugin.settings.userConfigFolder || 'Mentat/Config';
            const preferencesPath = `${folderPath}/user-preferences.md`;
            const vault = this.plugin.app.vault;

            // Auto-create folder paths if they do not exist
            if (!(await vault.adapter.exists(folderPath))) {
              const folders = folderPath.split('/');
              let currentFolder = '';
              for (const folder of folders) {
                if (!folder) continue;
                currentFolder = currentFolder ? `${currentFolder}/${folder}` : folder;
                if (!(await vault.adapter.exists(currentFolder))) {
                  await vault.createFolder(currentFolder);
                }
              }
            }

            // Create default template if file does not exist
            if (!(await vault.adapter.exists(preferencesPath))) {
              const defaultTemplate = `# User Prompt Preferences

Write your custom style instructions and preferences here. This file is dynamically read by Mentat and injected directly into the AI system prompt to guide its behavior and output style.

## Instructions
- These settings apply to all chat and research sessions.
- You can modify this file at any time. Changes are loaded dynamically when a new session starts.
- Because this note is parsed safely as raw text, you can write anything here without worrying about crashing the plugin.

## Your Custom Preferences
(Write your rules below, for example: "Do not use emojis in headings", "Use high-density bullet points", "Compare outputs with my personal notes style")

- 
`;
              await vault.create(preferencesPath, defaultTemplate);
            }

            // Open the file in active editor pane
            const tFile = vault.getAbstractFileByPath(preferencesPath);
            if (tFile) {
              const leaf = this.app.workspace.getLeaf(false);
              await leaf.openFile(tFile as any);
              new Notice('Opened user-preferences.md in editor');
            } else {
              new Notice('Failed to locate preferences file in vault');
            }
          } catch (err) {
            new Notice(`Failed to open/create preferences: ${err.message}`);
          }
        }));

    new Setting(containerEl)
      .setName('Vault Knowledge Map')
      .setDesc('Create or open the vault-map.md note directly in Obsidian to customize your vault structure guidelines and folder rules.')
      .addButton(button => button
        .setButtonText('Open Knowledge Map')
        .setCta()
        .onClick(async () => {
          try {
            const folderPath = this.plugin.settings.userConfigFolder || 'Mentat/Config';
            const mapPath = `${folderPath}/vault-map.md`;
            const vault = this.plugin.app.vault;

            // Auto-create folder paths if they do not exist
            if (!(await vault.adapter.exists(folderPath))) {
              const folders = folderPath.split('/');
              let currentFolder = '';
              for (const folder of folders) {
                if (!folder) continue;
                currentFolder = currentFolder ? `${currentFolder}/${folder}` : folder;
                if (!(await vault.adapter.exists(currentFolder))) {
                  await vault.createFolder(currentFolder);
                }
              }
            }

            // Create default template if file does not exist
            if (!(await vault.adapter.exists(mapPath))) {
              // Proactively scan actual folders in the vault to identify top largest directories
              const allFiles = vault.getMarkdownFiles();
              const folderCounts = new Map<string, number>();
              
              allFiles.forEach(file => {
                if (file.parent && file.parent.path !== '/' && file.parent.path !== '.') {
                  const p = file.parent.path;
                  folderCounts.set(p, (folderCounts.get(p) || 0) + 1);
                }
              });

              // Sort and pick top 3 largest folders
              const topFolders = Array.from(folderCounts.entries())
                .sort((a, b) => b[1] - a[1])
                .slice(0, 3)
                .map(([p]) => p);

              // If no folders found, fallback to standard guidelines
              const folderGuidelines = topFolders.length > 0
                ? topFolders.map(folder => `- \`[[${folder}/]]\`: Describe what kind of notes should go here (e.g., academic research, active projects, daily journals).`).join('\n')
                : `- \`[[Research/]]\`: Used for deep-dives, academic papers, and study notes.\n- \`[[Projects/]]\`: Used for active work, tracking goals, and task plans.\n- \`[[Inbox/]]\`: Place for raw ideas, quick thoughts, and unprocessed inputs.`;

              const defaultTemplate = `# 🗺️ Vault Knowledge Structure Map

This document defines the high-level knowledge organization and directory roles of my Obsidian vault.

> [!note]
> Write your folder descriptions, naming rules, and category workflows below. Mentat dynamically reads this file to decide where to store new files, how concepts relate, and which directories to query first.

## 📁 Core Folder Guidelines
${folderGuidelines}

## 🏷️ Category Workflows & Wiki-Linking
- Define folder roles clearly so the agent knows exactly where new files belong.
- Document naming conventions (e.g., prefixing research plans with \`Research_Plan_\`).
- Outline relationships (e.g., notes in \`Inbox/\` should eventually be polished and moved to \`Research/\`).
`;
              await vault.create(mapPath, defaultTemplate);
            }

            // Open the file in active editor pane
            const tFile = vault.getAbstractFileByPath(mapPath);
            if (tFile) {
              const leaf = this.app.workspace.getLeaf(false);
              await leaf.openFile(tFile as any);
              new Notice('Opened vault-map.md in editor');
            } else {
              new Notice('Failed to locate vault map file');
            }
          } catch (err) {
            new Notice(`Failed to open/create vault map: ${err.message}`);
          }
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

  displaySkillsSection(containerEl: HTMLElement): void {
    containerEl.createEl('h2', { text: 'Skill System & Tools' });

    new Setting(containerEl)
      .setName('Skill Invocation Mode')
      .setDesc('Choose how skills are exposed to the AI model')
      .addDropdown(dropdown => dropdown
        .addOption('auto', 'Hybrid Auto-Strategy (Recommended)')
        .addOption('progressive', 'Progressive Disclosure (Token Saver)')
        .addOption('native', 'Native Function Calling')
        .setValue(this.plugin.settings.skillInvocationMode || 'auto')
        .onChange(async (value) => {
          this.plugin.settings.skillInvocationMode = value as 'auto' | 'progressive' | 'native';
          if (!this.plugin.settings.skillInvocationConfig) {
            this.plugin.settings.skillInvocationConfig = { mode: value as any };
          } else {
            this.plugin.settings.skillInvocationConfig.mode = value as any;
          }
          await this.plugin.saveSettings();
          this.display(); // Redraw to show/hide dynamic fields
        }));

    if (this.plugin.settings.skillInvocationMode === 'auto') {
      const config = this.plugin.settings.skillInvocationConfig || {};
      const directSkills = config.directCallSkills || [
        'obsidian:read_note',
        'obsidian:query_notes',
        'obsidian:edit_note',
        'obsidian:web_search',
        'obsidian:ask_user',
        'obsidian:list_notes',
        'obsidian:web_fetch'
      ];

      new Setting(containerEl)
        .setName('Direct-Call Skills')
        .setDesc('Enter full names of skills that the agent should call directly (separated by commas or newlines)')
        .addTextArea(text => text
          .setPlaceholder('obsidian:read_note, obsidian:query_notes, ...')
          .setValue(directSkills.join(',\n'))
          .onChange(async (value) => {
            const skills = value
              .split(/[\n,]+/)
              .map(s => s.trim())
              .filter(s => s.length > 0);
            
            if (!this.plugin.settings.skillInvocationConfig) {
              this.plugin.settings.skillInvocationConfig = {
                mode: 'auto',
                directCallSkills: skills
              };
            } else {
              this.plugin.settings.skillInvocationConfig.directCallSkills = skills;
            }
            await this.plugin.saveSettings();
          }));
    }
  }

  displaySkillsManagerSection(containerEl: HTMLElement): void {
    containerEl.createEl('h2', { text: 'Skills & Tools Manager' });
    containerEl.createEl('p', {
      text: 'Manage and configure individual capabilities and tools recognized by Mentat.',
      cls: 'setting-item-description'
    });

    const registry = this.plugin.chatOrchestrator?.getSkillRegistry();
    if (!registry) {
      containerEl.createEl('p', { text: 'Skill registry is not initialized yet.' });
      return;
    }
    const allSkills = registry.getAll();

    // Search input
    const searchContainer = containerEl.createDiv();
    searchContainer.style.marginBottom = '20px';
    searchContainer.style.display = 'flex';
    searchContainer.style.gap = '10px';

    const searchInput = searchContainer.createEl('input', {
      type: 'text',
      placeholder: 'Search skills (e.g. read_note)...'
    });
    searchInput.style.flex = '1';
    searchInput.value = this.searchQuery;
    searchInput.addEventListener('input', (e) => {
      this.searchQuery = (e.target as HTMLInputElement).value;
      const cards = containerEl.querySelectorAll('.skill-card');
      const query = this.searchQuery.toLowerCase();
      cards.forEach((card: any) => {
        const skillName = card.dataset.skillName.toLowerCase();
        const description = card.dataset.description.toLowerCase();
        if (skillName.includes(query) || description.includes(query)) {
          card.style.display = 'block';
        } else {
          card.style.display = 'none';
        }
      });
    });

    const listContainer = containerEl.createDiv({ cls: 'skills-list-container' });
    listContainer.style.display = 'flex';
    listContainer.style.flexDirection = 'column';
    listContainer.style.gap = '15px';

    const sortedSkills = [...allSkills].sort((a, b) => {
      const nameA = registry.getFullName(a.namespace, a.name);
      const nameB = registry.getFullName(b.namespace, b.name);
      return nameA.localeCompare(nameB);
    });

    sortedSkills.forEach(skill => {
      const fullName = registry.getFullName(skill.namespace, skill.name);
      
      // Get existing config or initialize default values
      if (!this.plugin.settings.skillConfigurations) {
        this.plugin.settings.skillConfigurations = {};
      }
      const skillConfig = this.plugin.settings.skillConfigurations[fullName] || {};
      
      const card = listContainer.createDiv({ cls: 'skill-card' });
      card.dataset.skillName = fullName;
      card.dataset.description = skill.description || '';
      
      card.style.border = '1px solid var(--border-color)';
      card.style.borderRadius = '6px';
      card.style.padding = '15px';
      card.style.backgroundColor = 'var(--background-primary-alt)';
      
      // 1. Title and Badge
      const header = card.createDiv();
      header.style.display = 'flex';
      header.style.justifyContent = 'space-between';
      header.style.alignItems = 'center';
      header.style.marginBottom = '10px';
      
      const title = header.createEl('h3', { text: fullName });
      title.style.margin = '0';
      title.style.fontSize = '1.1em';
      
      const badge = header.createSpan({ text: skill.namespace.toUpperCase() });
      badge.style.fontSize = '0.8em';
      badge.style.padding = '2px 8px';
      badge.style.borderRadius = '10px';
      badge.style.backgroundColor = skill.namespace === 'obsidian' ? 'var(--interactive-accent)' : 'var(--background-modifier-border)';
      badge.style.color = 'var(--text-on-accent)';
      
      // 2. Description
      const desc = card.createDiv({ text: skill.description });
      desc.style.color = 'var(--text-muted)';
      desc.style.fontSize = '0.9em';
      desc.style.marginBottom = '15px';
      
      // 3. Toggles/Controls Row
      const controls = card.createDiv();
      controls.style.display = 'flex';
      controls.style.flexWrap = 'wrap';
      controls.style.gap = '20px';
      controls.style.paddingTop = '10px';
      controls.style.borderTop = '1px solid var(--border-color)';
      
      // Toggle 1: Enabled
      const enabledSetting = new Setting(controls)
        .setName('Allowed')
        .setDesc('AI can use this tool')
        .addToggle(toggle => toggle
          .setValue(skillConfig.enabled !== false)
          .onChange(async (val) => {
            if (!this.plugin.settings.skillConfigurations) {
              this.plugin.settings.skillConfigurations = {};
            }
            if (!this.plugin.settings.skillConfigurations[fullName]) {
              this.plugin.settings.skillConfigurations[fullName] = {};
            }
            this.plugin.settings.skillConfigurations[fullName].enabled = val;
            await this.plugin.saveSettings();
          }));
      enabledSetting.settingEl.style.border = 'none';
      enabledSetting.settingEl.style.padding = '0';
      enabledSetting.settingEl.style.flex = '1';
      enabledSetting.settingEl.style.minWidth = '150px';
      
      // Toggle 2: Direct Call
      const defaultCore = [
        'obsidian:read_note',
        'obsidian:query_notes',
        'obsidian:edit_note',
        'obsidian:web_search',
        'obsidian:ask_user',
        'obsidian:list_notes',
        'obsidian:web_fetch'
      ];
      const defaultDirect = defaultCore.includes(fullName);
      const directCallValue = skillConfig.directCall !== undefined ? skillConfig.directCall : defaultDirect;
      
      const directSetting = new Setting(controls)
        .setName('Direct-Call')
        .setDesc('Call directly (no spec)')
        .addToggle(toggle => toggle
          .setValue(directCallValue)
          .onChange(async (val) => {
            if (!this.plugin.settings.skillConfigurations) {
              this.plugin.settings.skillConfigurations = {};
            }
            if (!this.plugin.settings.skillConfigurations[fullName]) {
              this.plugin.settings.skillConfigurations[fullName] = {};
            }
            this.plugin.settings.skillConfigurations[fullName].directCall = val;
            await this.plugin.saveSettings();
          }));
      directSetting.settingEl.style.border = 'none';
      directSetting.settingEl.style.padding = '0';
      directSetting.settingEl.style.flex = '1';
      directSetting.settingEl.style.minWidth = '150px';

      // Toggle 3: Require Confirmation
      const defaultConfirm = !!skill.metadata?.requiresConfirmation;
      const confirmValue = skillConfig.requireConfirmation !== undefined ? skillConfig.requireConfirmation : defaultConfirm;
      
      const confirmSetting = new Setting(controls)
        .setName('Confirm First')
        .setDesc('Requires permission')
        .addToggle(toggle => toggle
          .setValue(confirmValue)
          .onChange(async (val) => {
            if (!this.plugin.settings.skillConfigurations) {
              this.plugin.settings.skillConfigurations = {};
            }
            if (!this.plugin.settings.skillConfigurations[fullName]) {
              this.plugin.settings.skillConfigurations[fullName] = {};
            }
            this.plugin.settings.skillConfigurations[fullName].requireConfirmation = val;
            await this.plugin.saveSettings();
          }));
      confirmSetting.settingEl.style.border = 'none';
      confirmSetting.settingEl.style.padding = '0';
      confirmSetting.settingEl.style.flex = '1';
      confirmSetting.settingEl.style.minWidth = '150px';
    });
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

  displayDiagnosticsSection(containerEl: HTMLElement): void {
    containerEl.createEl('h2', { text: 'Diagnostics & Troubleshooting' });

    new Setting(containerEl)
      .setName('Diagnostics Export Folder')
      .setDesc('Folder where session diagnostics reports are exported (relative to vault root)')
      .addText(text => text
        .setPlaceholder('Mentat/Diagnostics')
        .setValue(this.plugin.settings.diagnosticsFolder || 'Mentat/Diagnostics')
        .onChange(async (value) => {
          this.plugin.settings.diagnosticsFolder = value.trim() || 'Mentat/Diagnostics';
          await this.plugin.saveSettings();
        }));
  }
}
