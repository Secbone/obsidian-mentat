import { Observer } from './observability/observer';
import { LogStore } from './observability/log-store';
import { RunInspectorModal } from './ui/run-inspector-modal';
import type { Command } from 'obsidian';
import { RunHistoryModal } from './ui/run-history-modal';
import { ChatManager } from './chat/chat-manager';
import { RunController } from './runtime/run-controller';
import { RunStore } from './runtime/run-store';
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
import { TaskType } from './types';
import { ObsidianAdapter } from './utils/obsidian-adapter';
import { DiagnosticsExporter } from './diagnostics/diagnostics-exporter';

export default class MentatPlugin extends Plugin {
  observer!: Observer;
  settings!: MentatSettings;
  aiRouter!: AIRouter;
  openCodeIntegration!: OpenCodeIntegration;
  indexManager!: IndexManager;
  chatOrchestrator!: ChatOrchestrator;
  chatManager!: ChatManager;
  runController!: RunController;
  agentManager!: AgentManager;
  platform!: ObsidianAdapter;
  extensionManager!: ExtensionManager;
  eventBus!: EventBus;

  // Track previous values for selective save-settings updates
  private prevTheme: string = '';
  private prevPreset: string = '';

  async onload() {
    this.platform = new ObsidianAdapter(this);
    this.observer = new Observer(new LogStore(this.app.vault.adapter, `${this.app.vault.configDir}/plugins/mentat/logs`), () => [
      ...(this.settings?.aiProviders || []).map(p => p.apiKey || ''), this.settings?.browserlessApiKey || '', this.settings?.braveSearchApiKey || '',
    ]);
    const belongsToPlugin = (value: unknown) => value instanceof Error && /(?:plugin:mentat|plugins\/mentat\/|plugin:obsidian-mentat)/.test(value.stack || '');
    this.registerDomEvent(window, 'error', event => {
      if (belongsToPlugin(event.error)) this.observer.error('global:error', event.error, { component: 'host' });
    });
    this.registerDomEvent(window, 'unhandledrejection', event => {
      if (belongsToPlugin(event.reason)) this.observer.error('global:unhandled_rejection', event.reason, { component: 'host' });
    });
    try { await this.observer.task('plugin:initialize', () => this.initializePlugin(), { component: 'plugin' }); }
    catch (error) { await this.observer.store.drain(); throw error; }
  }

  private async initializePlugin(): Promise<void> {

    // Load settings
    await this.loadSettings();

    // Initialize platform adapter
    const platform = this.platform;

    // Initialize AI Router
    this.aiRouter = new AIRouter(this.settings, this.observer);

    // Initialize Index Manager
    this.indexManager = new IndexManager(platform, () => this.aiRouter.getProvider(TaskType.EMBEDDING), this.observer);
    await this.observer.task('index:initialize', () => this.indexManager.initialize(), { component: 'index' });

    // Initialize EventBus (before ChatOrchestrator, for agent event streaming)
    this.eventBus = new EventBus((error, type) => this.observer.error('event:handler:failed', error, { component: 'events', attributes: { eventType: type } }));

    // Initialize Chat Orchestrator (may fail gracefully if no provider configured)
    this.chatOrchestrator = new ChatOrchestrator(platform, this.settings, this.aiRouter, this.indexManager, this.eventBus);
    try {
      await this.chatOrchestrator.initialize();
    } catch (error: unknown) {
      this.observer.error('chat:initialize:failed', error, { component: 'chat' });
      console.warn('Mentat: ChatOrchestrator initialization failed (will retry after provider config):', 
        error instanceof Error ? error.message : String(error));
      new Notice('Mentat: 未检测到 AI 服务商配置。请在设置中配置 API Key。No AI provider configured — add one in Mentat settings.');
    }

    this.chatManager = new ChatManager(this);
    await this.chatManager.getHistory();
    this.runController = new RunController(new RunStore(platform), this.eventBus, this.chatManager,
      (prompt, context) => this.chatOrchestrator.sendMessage(prompt, { context, enableSkills: context.metadata?.enableSkills as boolean | undefined }), this.observer);
    await this.runController.initialize();
    if (this.runController.store.warnings.length) {
      this.observer.event('storage:recovery:warning', { component: 'storage', level: 'warn', attributes: { warnings: this.runController.store.warnings } });
      new Notice('部分运行记录损坏，自动执行已暂停；请打开运行检查器查看。');
    }

    // Get AgentManager reference (for advanced usage)
    this.agentManager = this.chatOrchestrator.getAgentManager();

    // Initialize extension system (shares the global eventBus)
    this.extensionManager = new ExtensionManager(
      this.app,
      this.chatOrchestrator.getSkillRegistry(),
      this.chatOrchestrator.getSkillExecutor(),
      this.settings,
      this.eventBus,
    );
    this.extensionManager.loadAll();

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

    this.observer.event('plugin:ready', { component: 'plugin', attributes: { version: this.manifest.version } });
  }

  onunload(): void {
    this.observer?.event('plugin:unloading', { component: 'plugin' });
    void (async () => {
      try { await this.runController?.dispose(); }
      catch (error) { this.observer?.error('plugin:shutdown:failed', error, { component: 'plugin' }); }
      await this.observer?.store.drain();
    })();
    try {
      this.chatOrchestrator?.dispose();
    } catch (error: unknown) {
      this.observer?.error('plugin:dispose:failed', error, { component: 'plugin' });
      console.warn('Mentat: Error during dispose:', error instanceof Error ? error.message : String(error));
    }
    this.openCodeIntegration?.dispose();
  }

  private registerCommands(): void {
    const add = (command: Command) => {
      const callback = command.callback;
      this.addCommand({ ...command, callback: callback ? () => {
        void this.observer.task(`command:${command.id}`, async () => { await callback(); }, { component: 'ui' })
          .catch(error => new Notice(`Mentat：${error instanceof Error ? error.message : String(error)}`));
      } : undefined });
    };
    add({ id: 'inspect-runs', name: '打开运行检查器 / Open run inspector', callback: () => new RunInspectorModal(this).open() });
    add({ id: 'manage-runs', name: 'Open run history and recovery', callback: () => new RunHistoryModal(this).open() });
    // Chat command
    add({
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
    add({
      id: 'index-vault',
      name: 'Index all documents for RAG',
      callback: async () => {
        const notice = new Notice('Starting indexing...', 0);

        try {
          const files = this.app.vault.getMarkdownFiles();
          const results = await this.indexManager.indexFiles(
            files,
            (progress) => {
              notice.setMessage(
                `Indexing: ${progress.current}/${progress.total} - ${progress.currentFile}`
              );
            }
          );

          notice.hide();
          new Notice(`Indexed ${results.length}/${files.length} documents${results.length < files.length ? '；部分文档失败，请查看日志。' : ' successfully'}`);
        } catch (error: unknown) {
          notice.hide();
          new Notice(`✗ Indexing failed: ${error instanceof Error ? error.message : String(error)}`);
          this.observer.error('index:full:failed', error, { component: 'background' });
        }
      }
    });

    // Incremental index command
    add({
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
          this.observer.error('index:incremental:failed', error, { component: 'background' });
        }
      }
    });

    // Show index stats command
    add({
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
    add({
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
          this.observer.error('index:file:failed', error, { component: 'background' });
        }
      }
    });

    // Test AI providers command
    add({
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
    add({
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
          this.observer.error('skills:reload:failed', error, { component: 'background' });
        }
      }
    });

    // View diagnostics command
    add({
      id: 'view-diagnostics',
      name: 'Open Diagnostics and Debug Log',
      callback: async () => {
        await DiagnosticsExporter.generateAndOpenDiagnosticsLog(this);
      }
    });
  }

  async loadSettings() {
    const saved = await this.loadData() || {};
    this.settings = { ...DEFAULT_SETTINGS, ...saved, taskRouting: { ...DEFAULT_SETTINGS.taskRouting, ...saved.taskRouting } };
    // Older routing controls wrote these values at the root of data.json.
    for (const task of Object.values(TaskType)) {
      if (!this.settings.taskRouting[task] && typeof saved[task] === 'string') this.settings.taskRouting[task] = saved[task];
      delete (this.settings as unknown as Record<string, unknown>)[task];
    }
    this.prevTheme = this.settings.chatTheme || 'bubble';
    this.prevPreset = this.settings.terminalPreset || 'green';
  }

  async saveSettings() {
    await this.saveData(this.settings);

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
