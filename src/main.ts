import { Plugin, Notice } from 'obsidian';
import { MentatSettings, DEFAULT_SETTINGS } from './settings/settings';
import { SettingsTab } from './settings/settings-tab';
import { AIRouter } from './providers/ai-router';
import { OpenCodeIntegration } from './providers/opencode-integration';
import { IndexManager } from './indexing/index-manager';
import { ChatView, CHAT_VIEW_TYPE } from './ui/chat-view';
import { ChatOrchestrator } from './chat/chat-orchestrator';
import { AgentManager } from './agents/agent-manager';
import { ExtensionManager, EventBus } from './extensions';
import { DiagnosticsExporter } from './diagnostics/diagnostics-exporter';
import { Context } from './core/cordis';
import { MentatRoot } from './root';

export default class MentatPlugin extends Plugin {
  /** The unified Cordis context; all subsystems are registered services on it. */
  ctx!: Context;

  settings!: MentatSettings;
  aiRouter!: AIRouter;
  openCodeIntegration!: OpenCodeIntegration;
  indexManager!: IndexManager;
  chatOrchestrator!: ChatOrchestrator;
  agentManager!: AgentManager;
  platform!: import('./utils/obsidian-adapter').ObsidianAdapter;
  extensionManager!: ExtensionManager;
  eventBus!: EventBus;

  // Track previous values for selective save-settings updates
  private prevTheme: string = '';
  private prevPreset: string = '';

  async onload() {
    console.log('Loading Mentat plugin');

    // Load settings (needed before the host assembly reads them).
    await this.loadSettings();

    // Host assembly: mount the MentatRoot component, which initializes every
    // subsystem as a service on the unified context (see src/root.ts).
    this.ctx = new Context();
    await this.ctx.plugin(MentatRoot, { plugin: this });

    // UI plane (Obsidian-managed, not Cordis-managed):
    // register chat view
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
    // Recover every registration made by the host assembly in LIFO order
    // (chat orchestrator, integrations, ...), replacing the manual dispose.
    void this.ctx?.fiber.dispose();
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

    // Export recent structured logs (diagnostics troubleshooting)
    this.addCommand({
      id: 'export-diagnostics',
      name: 'Export recent diagnostics (logs)',
      callback: async () => {
        const ctx = this.ctx;
        const logger = ctx?.get<{ recent: (f?: { level?: string }) => Array<{ iso: string; level: string; name: string; message: string; errorChain?: string }> }>('logger', false);
        if (!logger) {
          new Notice('Mentat: logger not available');
          return;
        }
        const path = `${this.app.vault.configDir}/plugins/mentat/logs/diagnostics-export.txt`;
        try {
          const entries = logger.recent();
          const lines = entries.map((e) => `[${e.iso}] ${e.level.toUpperCase()} ${e.name}: ${e.message}${e.errorChain ? ` (${e.errorChain})` : ''}`);
          const text = lines.join('\n') || '(no logs)';
          const vault = this.app.vault;
          const logDir = `${vault.configDir}/plugins/mentat/logs`.replace(/\\/g, '/');
          await vault.adapter.mkdir(logDir).catch(() => {});   // ensure dir exists
          await vault.adapter.write(path, text);
          new Notice(`✓ Exported ${entries.length} log entries to ${path}`);
        } catch (error) {
          new Notice(`✗ Export failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    });
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.prevTheme = this.settings.chatTheme || 'bubble';
    this.prevPreset = this.settings.terminalPreset || 'green';
  }

  async saveSettings() {
    await this.saveData(this.settings);
    // Emit on the kernel context so L2+ services (llm, etc.) can react.
    this.ctx?.emit('settings:update', this.settings);

    // Refresh AI Router when settings change
    if (this.aiRouter) {
      this.aiRouter.refresh(this.settings);
    }

    // Re-create default agent if provider was just configured (no restart needed)
    if (this.chatOrchestrator) {
      await this.chatOrchestrator.refreshProvider();

      // Refresh Skill Invocation Context
      const skillContext = this.chatOrchestrator.getSkillInvocationContext();
      if (skillContext) {
        skillContext.setMode(this.settings.skillInvocationMode || 'auto');
      }
    }

    // Notify ChatView of theme/preset change (only if actually changed)
    const newTheme = this.settings.chatTheme || 'bubble';
    const newPreset = this.settings.terminalPreset || 'green';

    if (newTheme !== this.prevTheme || newPreset !== this.prevPreset) {
      const chatLeaf = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)[0];
      if (chatLeaf) {
        const chatView = chatLeaf.view as ChatView;
        if (chatView) {
          void chatView.switchTheme(newTheme);
          if (newTheme === 'terminal') {
            chatView.updateTerminalPreset(newPreset);
          }
        }
      }
      this.prevTheme = newTheme;
      this.prevPreset = newPreset;
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
