import { Plugin, Notice } from 'obsidian';
import { PersonalAgentSettings, DEFAULT_SETTINGS } from './settings/settings';
import { SettingsTab } from './settings/settings-tab';
import { AIRouter } from './providers/ai-router';
import { OpenCodeIntegration } from './providers/opencode-integration';
import { IndexManager } from './indexing/index-manager';
import { ChatView, CHAT_VIEW_TYPE } from './ui/chat-view';
import { ChatOrchestrator } from './chat/chat-orchestrator';
import { AgentManager } from './agents/agent-manager';

export default class PersonalAgentPlugin extends Plugin {
  settings: PersonalAgentSettings;
  aiRouter: AIRouter;
  openCodeIntegration: OpenCodeIntegration;
  indexManager: IndexManager;
  chatOrchestrator: ChatOrchestrator;
  agentManager: AgentManager;

  async onload() {
    console.log('Loading Personal Agent plugin');

    // Load settings
    await this.loadSettings();

    // Initialize AI Router
    this.aiRouter = new AIRouter(this.settings);

    // Initialize Index Manager
    this.indexManager = new IndexManager(this);
    await this.indexManager.initialize();

    // Initialize Chat Orchestrator
    this.chatOrchestrator = new ChatOrchestrator(this);
    await this.chatOrchestrator.initialize();

    // Get AgentManager reference (for advanced usage)
    this.agentManager = this.chatOrchestrator.getAgentManager();

    // Initialize integrations
    this.openCodeIntegration = new OpenCodeIntegration(this);

    // Register chat view
    this.registerView(
      CHAT_VIEW_TYPE,
      (leaf) => new ChatView(leaf, this)
    );

    // Add settings tab
    this.addSettingTab(new SettingsTab(this.app, this));

    // Add ribbon icon for quick access
    this.addRibbonIcon('brain', 'Personal Agent', async () => {
      await this.activateChatView();
    });

    // Register commands
    this.registerCommands();

    console.log('Personal Agent plugin loaded successfully');
  }

  async onunload() {
    console.log('Unloading Personal Agent plugin');

    // Detach chat views
    this.app.workspace.detachLeavesOfType(CHAT_VIEW_TYPE);
  }

  private registerCommands(): void {
    // Chat command
    this.addCommand({
      id: 'open-chat',
      name: 'Open AI Chat',
      callback: async () => {
        if (!this.settings.chatEnabled) {
          new Notice('Chat feature is disabled in settings');
          return;
        }
        await this.activateChatView();
      }
    });

    // Index all documents command
    this.addCommand({
      id: 'index-vault',
      name: 'Index all documents for RAG',
      callback: async () => {
        const notice = new Notice('Starting indexing...', 0);

        try {
          const files = this.app.vault.getMarkdownFiles();
          let processedCount = 0;

          await this.indexManager.indexFiles(
            files,
            (progress) => {
              processedCount = progress.current;
              notice.setMessage(
                `Indexing: ${progress.current}/${progress.total} - ${progress.currentFile}`
              );
            }
          );

          notice.hide();
          new Notice(`✓ Indexed ${processedCount} documents successfully`);
        } catch (error) {
          notice.hide();
          new Notice(`✗ Indexing failed: ${error.message}`);
          console.error('Indexing error:', error);
        }
      }
    });

    // Incremental index command
    this.addCommand({
      id: 'index-incremental',
      name: 'Update index (incremental)',
      callback: async () => {
        const notice = new Notice('Checking for updates...', 0);

        try {
          const updatedCount = await this.indexManager.incrementalIndex(
            (progress) => {
              notice.setMessage(
                `Updating: ${progress.current}/${progress.total} - ${progress.currentFile}`
              );
            }
          );

          notice.hide();
          if (updatedCount > 0) {
            new Notice(`✓ Updated ${updatedCount} documents`);
          } else {
            new Notice('✓ Index is up to date');
          }
        } catch (error) {
          notice.hide();
          new Notice(`✗ Update failed: ${error.message}`);
          console.error('Incremental indexing error:', error);
        }
      }
    });

    // Show index stats command
    this.addCommand({
      id: 'index-stats',
      name: 'Show index statistics',
      callback: () => {
        const stats = this.indexManager.getStats();
        const message = `Index Statistics:

Files indexed: ${stats.totalFiles}
Chunks: ${stats.totalChunks}
Avg chunks/file: ${(stats.totalChunks / Math.max(stats.totalFiles, 1)).toFixed(1)}`;

        new Notice(message, 5000);
      }
    });

    // Index current file command
    this.addCommand({
      id: 'index-current-file',
      name: 'Index current file',
      callback: async () => {
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile) {
          new Notice('No active file');
          return;
        }

        if (activeFile.extension !== 'md') {
          new Notice('Only markdown files can be indexed');
          return;
        }

        const notice = new Notice(`Indexing ${activeFile.basename}...`, 0);

        try {
          await this.indexManager.indexFile(activeFile);
          notice.hide();
          new Notice(`✓ Indexed ${activeFile.basename}`);
        } catch (error) {
          notice.hide();
          new Notice(`✗ Failed to index: ${error.message}`);
          console.error('File indexing error:', error);
        }
      }
    });

    // Classification command
    this.addCommand({
      id: 'classify-note',
      name: '[Coming Soon] Classify current note',
      callback: async () => {
        if (!this.settings.autoClassificationEnabled) {
          new Notice('Classification feature is disabled in settings');
          return;
        }
        new Notice('Classification feature coming soon!');
      }
    });

    // Link suggestion command
    this.addCommand({
      id: 'suggest-links',
      name: '[Coming Soon] Suggest links for current note',
      callback: () => {
        if (!this.settings.linkSuggestionEnabled) {
          new Notice('Link suggestion feature is disabled in settings');
          return;
        }
        new Notice('Link suggestion feature coming soon!');
      }
    });

    // Knowledge graph command
    this.addCommand({
      id: 'open-graph',
      name: '[Coming Soon] Open Knowledge Graph',
      callback: () => {
        if (!this.settings.graphEnabled) {
          new Notice('Graph feature is disabled in settings');
          return;
        }
        new Notice('Graph feature coming soon!');
      }
    });

    // Review command
    this.addCommand({
      id: 'start-review',
      name: '[Coming Soon] Start review session',
      callback: () => {
        if (!this.settings.reviewEnabled) {
          new Notice('Review feature is disabled in settings');
          return;
        }
        new Notice('Review feature coming soon!');
      }
    });

    // Test AI providers command
    this.addCommand({
      id: 'test-providers',
      name: 'Test AI Providers',
      callback: async () => {
        new Notice('Testing AI providers...');
        const results = await this.aiRouter.testAllProviders();

        let message = 'AI Provider Test Results:\n\n';
        for (const [id, available] of results.entries()) {
          message += `${id}: ${available ? '✓ Available' : '✗ Unavailable'}\n`;
        }

        new Notice(message);
      }
    });

    // Reload skills command
    this.addCommand({
      id: 'reload-skills',
      name: 'Reload all skills',
      callback: async () => {
        const notice = new Notice('Reloading all skills...', 0);

        try {
          await this.chatOrchestrator.reloadSkills();
          notice.hide();
          new Notice('✓ All skills reloaded');
        } catch (error) {
          notice.hide();
          new Notice(`✗ Failed to reload skills: ${error.message}`);
          console.error('Skill reload error:', error);
        }
      }
    });
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);

    // Refresh AI Router when settings change
    if (this.aiRouter) {
      this.aiRouter.refresh(this.settings);
    }

    // Refresh Skill Invocation Context when settings change
    if (this.chatOrchestrator) {
      const skillContext = this.chatOrchestrator.getSkillInvocationContext();
      if (skillContext) {
        skillContext.setMode(this.settings.skillInvocationMode || 'auto');
        if (this.settings.skillInvocationConfig?.directCallSkills) {
          skillContext.setDirectCallSkills(this.settings.skillInvocationConfig.directCallSkills);
        }
      }
    }
  }

  async activateChatView(): Promise<void> {
    const { workspace } = this.app;

    // Check if view is already open
    let leaf = workspace.getLeavesOfType(CHAT_VIEW_TYPE)[0];

    if (!leaf) {
      // Create new leaf in right sidebar
      const rightLeaf = workspace.getRightLeaf(false);
      if (rightLeaf) {
        await rightLeaf.setViewState({
          type: CHAT_VIEW_TYPE,
          active: true
        });
        leaf = rightLeaf;
      }
    }

    // Reveal the leaf
    if (leaf) {
      workspace.revealLeaf(leaf);
    }
  }
}
