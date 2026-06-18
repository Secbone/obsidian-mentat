import { Plugin, Notice } from 'obsidian';
import { MentatSettings, DEFAULT_SETTINGS } from './settings/settings';
import { SettingsTab } from './settings/settings-tab';
import { AIRouter } from './providers/ai-router';
import { OpenCodeIntegration } from './providers/opencode-integration';
import { IndexManager } from './indexing/index-manager';
import { ChatView, CHAT_VIEW_TYPE } from './ui/chat-view';
import { ChatOrchestrator } from './chat/chat-orchestrator';
import { AgentManager } from './agents/agent-manager';
import { TaskType } from './types';
import { ObsidianAdapter } from './utils/obsidian-adapter';
import { DiagnosticsExporter } from './diagnostics/diagnostics-exporter';

export default class MentatPlugin extends Plugin {
  settings: MentatSettings;
  aiRouter: AIRouter;
  openCodeIntegration: OpenCodeIntegration;
  indexManager: IndexManager;
  chatOrchestrator: ChatOrchestrator;
  agentManager: AgentManager;
  platform: ObsidianAdapter;

  async onload() {
    console.log('Loading Mentat plugin');

    // Load settings
    await this.loadSettings();

    // Initialize platform adapter
    this.platform = new ObsidianAdapter(this);
    const platform = this.platform;

    // Initialize AI Router
    this.aiRouter = new AIRouter(this.settings);

    // Initialize Index Manager
    this.indexManager = new IndexManager(platform, () => this.aiRouter.getProvider(TaskType.EMBEDDING));
    await this.indexManager.initialize();

    // Initialize Chat Orchestrator
    this.chatOrchestrator = new ChatOrchestrator(platform, this.settings, this.aiRouter, this.indexManager);
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
    this.addRibbonIcon('brain', 'Mentat', async () => {
      await this.activateChatView();
    });

    // Register commands
    this.registerCommands();

    console.log('Mentat plugin loaded successfully');
  }

  onunload(): void {
    console.log('Unloading Mentat plugin');
    this.chatOrchestrator?.dispose();
    this.openCodeIntegration?.dispose();
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
        } catch (error: unknown) {
          notice.hide();
          new Notice(`✗ Indexing failed: ${error instanceof Error ? error.message : String(error)}`);
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
        } catch (error: unknown) {
          notice.hide();
          new Notice(`✗ Update failed: ${error instanceof Error ? error.message : String(error)}`);
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
        } catch (error: unknown) {
          notice.hide();
          new Notice(`✗ Failed to index: ${error instanceof Error ? error.message : String(error)}`);
          console.error('File indexing error:', error);
        }
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
        } catch (error: unknown) {
          notice.hide();
          new Notice(`✗ Failed to reload skills: ${error instanceof Error ? error.message : String(error)}`);
          console.error('Skill reload error:', error);
        }
      }
    });

    // View diagnostics command
    this.addCommand({
      id: 'view-diagnostics',
      name: 'Open Diagnostics and Debug Log',
      callback: async () => {
        await DiagnosticsExporter.generateAndOpenDiagnosticsLog(this);
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
      void workspace.revealLeaf(leaf);
    }
  }
}
