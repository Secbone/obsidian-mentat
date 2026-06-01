import { App, PluginSettingTab, Setting, Notice, Modal, setIcon } from 'obsidian';
import PersonalAgentPlugin from '../main';
import { AIProviderConfig } from './settings';
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
        }))
      .addButton(button => button
        .setButtonText('Rebuild Knowledge Map')
        .setWarning()
        .onClick(() => {
          new RebuildConfirmModal(this.app, this.plugin).open();
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

    new Setting(containerEl)
      .setName('Use Cmd/Ctrl+Enter to Send')
      .setDesc('Requires pressing Cmd/Ctrl+Enter to send chat messages, making Enter insert a newline instead.')
      .addToggle(toggle => toggle
        .setValue(!!this.plugin.settings.sendWithCmdEnter)
        .onChange(async (value) => {
          this.plugin.settings.sendWithCmdEnter = value;
          await this.plugin.saveSettings();
        }));
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

    let textCtrl: any = null;
    let sliderCtrl: any = null;

    // Add text input for precise control
    maxTurnsSetting.addText(text => {
      textCtrl = text;
      text
        .setPlaceholder('20')
        .setValue(String(this.plugin.settings.maxTurns))
        .onChange(async (value) => {
          const numValue = parseInt(value);
          if (!isNaN(numValue) && numValue >= 1 && numValue <= 99) {
            this.plugin.settings.maxTurns = numValue;
            await this.plugin.saveSettings();
            if (sliderCtrl) {
              sliderCtrl.setValue(numValue);
            }
          }
        });
    });

    // Add slider for quick adjustment
    maxTurnsSetting.addSlider(slider => {
      sliderCtrl = slider;
      slider
        .setLimits(1, 99, 1)
        .setValue(this.plugin.settings.maxTurns)
        .setDynamicTooltip()
        .onChange(async (value) => {
          this.plugin.settings.maxTurns = value;
          await this.plugin.saveSettings();
          if (textCtrl) {
            textCtrl.setValue(String(value));
          }
        });
    });

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

class RebuildConfirmModal extends Modal {
  private plugin: PersonalAgentPlugin;
  private stage: 'confirm' | 'loading' | 'success' | 'error' = 'confirm';
  private progressVal: number = 0;
  private statusMsg: string = '';
  private errorMsg: string = '';
  private isCancelled: boolean = false;

  constructor(app: App, plugin: PersonalAgentPlugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen() {
    this.updateUI();
  }

  onClose() {
    this.contentEl.empty();
  }

  async runLocalRebuild() {
    try {
      this.isCancelled = false;
      this.stage = 'loading';
      this.progressVal = 20;
      this.statusMsg = '正在扫描本地库文件夹结构...';
      this.updateUI();

      const folderPath = this.plugin.settings.userConfigFolder || 'Mentat/Config';
      const mapPath = `${folderPath}/vault-map.md`;
      const vault = this.plugin.app.vault;

      if (this.isCancelled) return;

      // Ensure config folder exists
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

      if (this.isCancelled) return;
      this.progressVal = 50;
      this.statusMsg = '正在分析并统计最常使用的目录...';
      this.updateUI();

      const allFiles = vault.getMarkdownFiles();
      const folderCounts = new Map<string, number>();

      allFiles.forEach(file => {
        if (file.parent && file.parent.path !== '/' && file.parent.path !== '.') {
          const p = file.parent.path;
          folderCounts.set(p, (folderCounts.get(p) || 0) + 1);
        }
      });

      const topFolders = Array.from(folderCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([p]) => p);

      const folderGuidelines = topFolders.length > 0
        ? topFolders.map(folder => `- \`[[${folder}/]]\`: 描述此目录中应放置的笔记类型（例如：学术研究、活跃项目、每日日志等）。`).join('\n')
        : `- \`[[Research/]]\`: 用于深度探讨、学术论文和学习笔记。\n- \`[[Projects/]]\`: 用于正在进行的工作、跟踪目标和任务计划。\n- \`[[Inbox/]]\`: 用于存放原始想法、碎片化思考和未处理的输入。`;

      const defaultTemplate = `# 🗺️ 库知识结构地图 (Vault Knowledge Structure Map)

此文档定义了我的 Obsidian 库的高水平知识组织和目录角色。

> [!note]
> 请在下方编写您的文件夹描述、命名规则和分类工作流。Mentat 会动态读取此文件，以决定新文件的存储位置、概念关联方式以及优先查询哪些目录。

## 📁 核心文件夹指南
${folderGuidelines}

## 🏷️ 类别工作流与百科双链关联 (Category Workflows & Wiki-Linking)
- 清晰定义文件夹角色，使 AI 助手确切了解新文件归属。
- 记录命名约定（例如，将研究计划前缀命名为 \`Research_Plan_\`）。
- 规划关联关系（例如，\`Inbox/\` 中的粗糙笔记最终应整理并移至 \`Research/\` 或 \`Projects/\`）。
`;

      if (this.isCancelled) return;
      this.progressVal = 80;
      this.statusMsg = '正在将本地模板写入 vault-map.md...';
      this.updateUI();

      if (await vault.adapter.exists(mapPath)) {
        await vault.adapter.write(mapPath, defaultTemplate);
      } else {
        await vault.create(mapPath, defaultTemplate);
      }

      if (this.isCancelled) return;
      this.progressVal = 100;
      this.statusMsg = '本地快速重建完成！';
      this.stage = 'success';
      this.updateUI();
    } catch (err) {
      if (this.isCancelled) return;
      this.stage = 'error';
      this.errorMsg = `本地重建失败: ${err.message}`;
      this.updateUI();
    }
  }

  async runAIRebuild() {
    try {
      this.isCancelled = false;
      this.stage = 'loading';
      this.progressVal = 5;
      this.statusMsg = '正在启动 AI 智能重建分析器...';
      this.updateUI();

      await this.plugin.chatOrchestrator.aiRebuildVaultMap((stage, percent) => {
        if (this.isCancelled) return;
        this.progressVal = percent;
        this.statusMsg = stage;
        this.updateUI();
      });

      if (this.isCancelled) return;
      this.stage = 'success';
      this.progressVal = 100;
      this.updateUI();
    } catch (err) {
      if (this.isCancelled) return;
      this.stage = 'error';
      this.errorMsg = err.message || String(err);
      this.updateUI();
    }
  }

  cancelRebuild() {
    this.isCancelled = true;
    this.close();
  }

  async openVaultMapFile() {
    try {
      const folderPath = this.plugin.settings.userConfigFolder || 'Mentat/Config';
      const mapPath = `${folderPath}/vault-map.md`;
      const tFile = this.plugin.app.vault.getAbstractFileByPath(mapPath);
      if (tFile) {
        const leaf = this.plugin.app.workspace.getLeaf(false);
        await leaf.openFile(tFile as any);
        new Notice('🎉 已为您打开知识地图！');
      } else {
        new Notice('❌ 找不到重建后的知识地图文件');
      }
    } catch (e) {
      new Notice(`无法打开知识地图: ${e.message}`);
    }
  }

  updateUI() {
    const { contentEl } = this;
    contentEl.empty();

    // 动态更新 Obsidian 弹窗的标准标题，达到极致的内置原生体验
    let modalTitle = '🗺️ 重建知识地图';
    if (this.stage === 'loading') {
      modalTitle = '🗺️ 正在重建知识地图...';
    } else if (this.stage === 'success') {
      modalTitle = '🎉 知识地图重建成功';
    } else if (this.stage === 'error') {
      modalTitle = '❌ AI 智能重建失败';
    }
    this.titleEl.setText(modalTitle);

    // 弹窗基础布局容器
    const container = contentEl.createDiv({ cls: 'rebuild-modal-container' });
    container.style.display = 'flex';
    container.style.flexDirection = 'column';
    container.style.gap = '16px';
    container.style.padding = '5px 0';

    if (this.stage === 'confirm') {
      // 1. 确认阶段描述
      container.createEl('p', {
        text: '重建将深度分析您当前的文件夹结构、高频标签和最新笔记。AI 智能重建会利用 LLM 自动规划适合您知识库的定制化目录指南与命名工作流。',
        style: 'line-height: 1.6; color: var(--text-muted); font-size: 0.95em; margin: 0;'
      });
      
      // 完全使用 Obsidian 内置原生 Callout 结构，自动适配用户安装的任意第三方主题
      const callout = container.createDiv({ cls: 'callout' });
      callout.setAttribute('data-callout', 'warning');
      callout.style.margin = '0';
      callout.style.padding = '12px 16px';
      callout.style.borderRadius = 'var(--radius-s)';
      
      const calloutTitle = callout.createDiv({ cls: 'callout-title', style: 'display: flex; align-items: center; gap: 8px; font-weight: 600; margin-bottom: 6px;' });
      const calloutIcon = calloutTitle.createDiv({ cls: 'callout-icon', style: 'display: flex; align-items: center;' });
      setIcon(calloutIcon, 'alert-triangle'); // 完美地道地渲染原生图标
      calloutTitle.createDiv({ cls: 'callout-title-inner', text: '注意' });

      const calloutContent = callout.createDiv({ cls: 'callout-content', style: 'font-size: 0.9em; line-height: 1.5; color: var(--text-normal);' });
      calloutContent.createSpan({ text: '此操作将完全覆盖您目前在 ' });
      calloutContent.createEl('code', { text: 'vault-map.md' });
      calloutContent.createSpan({ text: ' 文件中手动修改或定制的所有内容，请在重建前做好备份。' });

      // 按钮区域：利用 Obsidian 原生 modal-button-container 自动排版
      const buttonContainer = container.createDiv({ cls: 'modal-button-container' });
      buttonContainer.style.display = 'flex';
      buttonContainer.style.justifyContent = 'flex-end';
      buttonContainer.style.gap = '10px';
      buttonContainer.style.marginTop = '10px';

      // ⚡ 快速本地重建按钮 (中性)
      const localButton = buttonContainer.createEl('button', {
        text: '⚡ 快速本地重建',
        cls: 'mod-neutral'
      });
      localButton.addEventListener('click', () => this.runLocalRebuild());

      // 🧠 AI 智能重建按钮 (推荐 CTA)
      const aiButton = buttonContainer.createEl('button', {
        text: '🧠 AI 智能重建 (推荐)',
        cls: 'mod-cta'
      });
      aiButton.addEventListener('click', () => this.runAIRebuild());

      // 取消按钮
      const cancelButton = buttonContainer.createEl('button', { text: '取消' });
      cancelButton.addEventListener('click', () => this.close());

    } else if (this.stage === 'loading') {
      // 2. 加载阶段
      container.createEl('p', {
        text: '我们正在分析您库中的笔记分布和组织结构，并为您量身定制最新的知识树规范与类别关联工作流。',
        style: 'color: var(--text-muted); font-size: 0.95em; line-height: 1.5; margin: 0;'
      });

      // 极细简约自定义进度条设计
      const progressWrapper = container.createDiv();
      progressWrapper.style.margin = '10px 0';
      progressWrapper.style.display = 'flex';
      progressWrapper.style.flexDirection = 'column';
      progressWrapper.style.gap = '8px';

      // 自定义极细进度条背景槽
      const progressContainer = progressWrapper.createDiv({
        style: 'width: 100%; height: 6px; background-color: var(--background-modifier-border); border-radius: 3px; overflow: hidden;'
      });

      // 动态平滑进度条
      progressContainer.createDiv({
        style: `width: ${this.progressVal}%; height: 100%; background-color: var(--interactive-accent); border-radius: 3px; transition: width 0.3s ease;`
      });

      const progressInfo = progressWrapper.createDiv({
        style: 'display: flex; justify-content: space-between; font-size: 0.85em; color: var(--text-muted); align-items: center;'
      });

      // 步骤文字
      progressInfo.createSpan({ text: this.statusMsg, style: 'font-weight: 500;' });
      // 百分比提示
      progressInfo.createSpan({ text: `${this.progressVal}%`, style: 'font-weight: 600; color: var(--interactive-accent);' });

      // 取消重建按钮容器
      const buttonContainer = container.createDiv({ cls: 'modal-button-container' });
      buttonContainer.style.display = 'flex';
      buttonContainer.style.justifyContent = 'flex-end';
      buttonContainer.style.marginTop = '10px';

      const cancelButton = buttonContainer.createEl('button', {
        text: '取消重建',
        cls: 'mod-warning'
      });
      cancelButton.addEventListener('click', () => this.cancelRebuild());

    } else if (this.stage === 'success') {
      // 3. 成功阶段
      // 内置原生绿色 Alert/Callout 卡片表示成功，完美而克制
      const callout = container.createDiv({ cls: 'callout' });
      callout.setAttribute('data-callout', 'success');
      callout.style.margin = '0';
      callout.style.padding = '12px 16px';
      callout.style.borderRadius = 'var(--radius-s)';
      
      const calloutTitle = callout.createDiv({ cls: 'callout-title', style: 'display: flex; align-items: center; gap: 8px; font-weight: 600; margin-bottom: 6px; color: var(--text-success);' });
      const calloutIcon = calloutTitle.createDiv({ cls: 'callout-icon', style: 'display: flex; align-items: center;' });
      setIcon(calloutIcon, 'check-circle');
      calloutTitle.createDiv({ cls: 'callout-title-inner', text: '重建成功！' });

      const calloutContent = callout.createDiv({ cls: 'callout-content', style: 'font-size: 0.9em; line-height: 1.5; color: var(--text-normal);' });
      calloutContent.createSpan({ text: 'Mentat 已经成功分析了您的整个知识库，并为您定制了最新的文件夹指南、命名规则和类别工作流。配置指南已保存在您的配置目录中。' });

      const buttonContainer = container.createDiv({ cls: 'modal-button-container' });
      buttonContainer.style.display = 'flex';
      buttonContainer.style.justifyContent = 'flex-end';
      buttonContainer.style.gap = '10px';
      buttonContainer.style.marginTop = '10px';

      // 👁️ 立即查看按钮
      const viewButton = buttonContainer.createEl('button', {
        text: '👁️ 立即查看',
        cls: 'mod-cta'
      });
      viewButton.addEventListener('click', async () => {
        await this.openVaultMapFile();
        this.close();
      });

      // 仅关闭按钮
      const closeButton = buttonContainer.createEl('button', {
        text: '仅关闭'
      });
      closeButton.addEventListener('click', () => this.close());

    } else if (this.stage === 'error') {
      // 4. 失败阶段
      const callout = container.createDiv({ cls: 'callout' });
      callout.setAttribute('data-callout', 'error');
      callout.style.margin = '0';
      callout.style.padding = '12px 16px';
      callout.style.borderRadius = 'var(--radius-s)';
      
      const calloutTitle = callout.createDiv({ cls: 'callout-title', style: 'display: flex; align-items: center; gap: 8px; font-weight: 600; margin-bottom: 6px; color: var(--text-error);' });
      const calloutIcon = calloutTitle.createDiv({ cls: 'callout-icon', style: 'display: flex; align-items: center;' });
      setIcon(calloutIcon, 'x-circle');
      calloutTitle.createDiv({ cls: 'callout-title-inner', text: 'AI 智能重建遇到异常' });

      const calloutContent = callout.createDiv({ cls: 'callout-content', style: 'font-size: 0.9em; line-height: 1.5; color: var(--text-normal);' });
      calloutContent.createSpan({ text: '在通过 AI 生成知识地图时遇到了异常。这通常是因为未配置 AI 服务商、网络连接超时或 API 额度不足。' });

      // 错误详情框
      const errorBox = container.createEl('pre', {
        style: 'background-color: var(--background-secondary); border: 1px solid var(--border-color); padding: 12px; border-radius: 4px; font-family: var(--font-monospace); font-size: 0.85em; color: var(--text-error); overflow-x: auto; max-height: 120px; white-space: pre-wrap; margin: 10px 0 0 0;'
      });
      errorBox.createSpan({ text: `错误详情：\n${this.errorMsg}` });

      const buttonContainer = container.createDiv({ cls: 'modal-button-container' });
      buttonContainer.style.display = 'flex';
      buttonContainer.style.justifyContent = 'flex-end';
      buttonContainer.style.gap = '10px';
      buttonContainer.style.marginTop = '10px';

      // ⚡ 切换本地重建按钮 (在左侧)
      const localButton = buttonContainer.createEl('button', {
        text: '⚡ 切换本地快速重建',
        cls: 'mod-neutral'
      });
      localButton.style.marginRight = 'auto'; // 按钮居左对齐
      localButton.addEventListener('click', () => this.runLocalRebuild());

      // 关闭按钮
      const closeButton = buttonContainer.createEl('button', {
        text: '关闭'
      });
      closeButton.addEventListener('click', () => this.close());
    }
  }
}
