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

    // View diagnostics command
    this.addCommand({
      id: 'view-diagnostics',
      name: 'Open Diagnostics and Debug Log',
      callback: async () => {
        const adapter = this.app.vault.adapter;
        const logPath = '.personal-agent/diagnostics.jsonl';
        
        if (!(await adapter.exists(logPath))) {
          new Notice('No diagnostics logs found. Everything is running smoothly!');
          return;
        }
        
        try {
          const content = await adapter.read(logPath);
          const debugNotePath = 'Personal Agent Debug Log.md';
          
          // Calculate 7-Day Performance & Failure Analytics
          const allLines = content.trim().split('\n');
          const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
          
          let totalIncidents = 0;
          const toolFailures: Record<string, number> = {};
          const dailyIncidents: Record<string, number> = {};
          
          // Prepopulate daily dates for the last 7 days
          for (let i = 6; i >= 0; i--) {
            const dateKey = new Date(Date.now() - i * 24 * 60 * 60 * 1000).toLocaleDateString();
            dailyIncidents[dateKey] = 0;
          }
          
          allLines.forEach(line => {
            if (!line.trim()) return;
            try {
              const entry = JSON.parse(line);
              if (entry.timestamp >= sevenDaysAgo) {
                totalIncidents++;
                toolFailures[entry.toolName] = (toolFailures[entry.toolName] || 0) + 1;
                const dateKey = new Date(entry.timestamp).toLocaleDateString();
                if (dailyIncidents[dateKey] !== undefined) {
                  dailyIncidents[dateKey]++;
                }
              }
            } catch (e) {
              // Ignore malformed
            }
          });
          
          const sortedFailures = Object.entries(toolFailures)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5);

          const lines = content.trim().split('\n').reverse().slice(0, 50); // Get latest 50 incidents
          let markdownContent = `# Personal Agent Diagnostics & Debug Log\n\n`;
          
          // Render 7-Day Cross-Run Performance Analytics Card
          markdownContent += `## 📊 7天系统异常走势与工具故障分析 (7-Day Cross-Run Analytics)\n\n`;
          markdownContent += `> [!IMPORTANT]\n`;
          markdownContent += `> 以下是过去 7 天内智能体自动捕获的运行时解析异常与工具报错分析。这可帮助您找出故障率最高的技能，进而优化配置。\n\n`;
          
          markdownContent += `| 诊断指标 | 7天累计统计值 |\n`;
          markdownContent += `| :--- | :--- |\n`;
          markdownContent += `| **7天内累计解析异常 (Total Incidents)** | \`${totalIncidents} 次报错\` |\n`;
          markdownContent += `| **首要故障技能 (Top Failure Tool)** | \`${sortedFailures[0] ? `${sortedFailures[0][0]} (${sortedFailures[0][1]}次)` : '无'}\` |\n\n`;
          
          if (sortedFailures.length > 0) {
            markdownContent += `### 🚨 工具故障频次排名前五 (Top 5 Failed Tools)\n`;
            sortedFailures.forEach(([tool, count]) => {
              markdownContent += `* **\`${tool}\`**: \`${count} 次报错\`\n`;
            });
            markdownContent += `\n`;
          }
          
          markdownContent += `### 📈 每日解析异常发生趋势 (Daily Incidents Trend)\n`;
          markdownContent += `| 日期 | 解析异常频次 |\n`;
          markdownContent += `| :--- | :--- |\n`;
          Object.entries(dailyIncidents).forEach(([date, count]) => {
            markdownContent += `| ${date} | \`${count} 次\` |\n`;
          });
          markdownContent += `\n---\n\n`;
          
          markdownContent += `## 💬 最新事件日志明细 (Latest Incidents)\n\n`;
          markdownContent += `Showing the latest ${lines.length} incidents (newest first). The complete log is saved at \`${logPath}\`.\n\n`;
          
          if (lines.length === 0 || (lines.length === 1 && lines[0] === '')) {
            markdownContent += `✓ No incident records found. All processes parsed cleanly!\n`;
          } else {
            lines.forEach((line, index) => {
              try {
                const entry = JSON.parse(line);
                const timeStr = new Date(entry.timestamp).toLocaleString();
                markdownContent += `## Incident #${lines.length - index} [${timeStr}]\n`;
                markdownContent += `- **Tool / Skill**: \`${entry.toolName}\`\n`;
                markdownContent += `- **Error Message**: *${entry.errorMessage}*\n`;
                markdownContent += `- **Recovery Strategy**: *${entry.strategy}*\n`;
                markdownContent += `\n### Original Arguments (Unparsed)\n\`\`\`json\n${entry.originalArgs}\n\`\`\`\n`;
                if (entry.repairedArgs) {
                  markdownContent += `\n### Repaired & Recovered Arguments\n\`\`\`json\n${entry.repairedArgs}\n\`\`\`\n`;
                }
                markdownContent += `\n---\n\n`;
              } catch {
                // Ignore malformed lines
              }
            });
          }

          // Write to a temporary markdown file
          await adapter.write(debugNotePath, markdownContent);
          
          // Open the note in workspace
          const tFile = this.app.vault.getAbstractFileByPath(debugNotePath);
          if (tFile) {
            await this.app.workspace.getLeaf().openFile(tFile as any);
            new Notice('Diagnostics Log opened successfully');
          } else {
            new Notice('Log compiled. Please open "Personal Agent Debug Log.md" in your vault root.');
          }
        } catch (err) {
          new Notice(`Failed to load diagnostics: ${err.message}`);
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
