import { TFile, Notice } from 'obsidian';
import PersonalAgentPlugin from '../main';
import { ChatManager } from '../chat/chat-manager';
import { ChatMessage } from '../types';

export class DiagnosticsExporter {
  /**
   * Export the current active chat session to a premium Markdown note inside the user's vault.
   */
  static async exportSession(
    plugin: PersonalAgentPlugin,
    chatManager: ChatManager
  ): Promise<string | null> {
    try {
      const history = await chatManager.getHistory();
      if (history.length === 0) {
        new Notice('❌ 无法导出诊断报告：当前会话没有消息历史。');
        return null;
      }

      const sessionInfo = chatManager.getSessionInfo();
      const sessionId = sessionInfo.sessionId;
      const startTime = sessionInfo.startTime || 0;
      const endTime = sessionInfo.lastUpdated || Date.now();

      // Gather environment settings
      const settings = plugin.settings;
      const providerId = settings.taskRouting?.chat || settings.defaultProvider;
      const activeProvider = settings.aiProviders.find(p => p.id === providerId);
      const modelName = activeProvider ? activeProvider.model : '未知大模型';
      const providerType = activeProvider ? activeProvider.type : '未知';
      const skillsEnabled = settings.skillsEnabled ? '开启' : '关闭';
      const maxTurns = settings.maxTurns || 20;
      const invocationMode = settings.skillInvocationMode || 'auto';
      const activeSkillsList = settings.allowedSkills && settings.allowedSkills.length > 0 
        ? settings.allowedSkills.join(', ')
        : '全部内置及 MCP 技能已激活';
      
      const directCallSkills = settings.skillInvocationConfig?.directCallSkills || [];
      const directCallCount = directCallSkills.length;

      // 1. Resolve and parse diagnostic logs (.mentat/diagnostics.jsonl)
      const logs = await DiagnosticsExporter.retrieveIncidentLogs(plugin, startTime, endTime);

      // 2. Generate Mermaid Sequence Diagram
      const mermaidDiagram = DiagnosticsExporter.generateMermaidDiagram(history);

      // 3. Construct Compliant JSON messages array for API debugging
      const cleanJsonHistory = DiagnosticsExporter.generateJsonPayload(history);

      // 4. Render Markdown Document Content
      const dateStr = new Date(endTime).toLocaleString();
      const fileTimestamp = new Date(endTime).toISOString().replace(/:/g, '-').split('.')[0];
      const filename = `Session_Diagnostics_${sessionId}_${fileTimestamp}.md`;

      const folderPath = settings.diagnosticsFolder?.trim() || 'Mentat/Diagnostics';

      let markdownContent = `# 🛠️ AI 会话诊断与分析报告\n\n`;
      
      markdownContent += `> [!NOTE]\n`;
      markdownContent += `> 此诊断报告由 Mentat 一键自动生成。您可将此文件直接投喂给更大、更高级的模型（如 Claude 3.5 Sonnet / GPT-4o），帮助其精准诊断、反思和优化当前智能体的运行逻辑及工具调用参数。\n\n`;

      // 📌 Metadata section
      markdownContent += `## 📌 元数据与环境信息\n\n`;
      markdownContent += `| 属性 | 配置值 |\n`;
      markdownContent += `| :--- | :--- |\n`;
      markdownContent += `| **会话 ID (Session ID)** | \`${sessionId}\` |\n`;
      markdownContent += `| **导出时间 (Export Time)** | \`${dateStr}\` |\n`;
      markdownContent += `| **大模型提供商 (Provider)** | \`${providerType}\` (ID: \`${providerId}\`) |\n`;
      markdownContent += `| **当前聊天模型 (Model)** | \`${modelName}\` |\n`;
      markdownContent += `| **技能系统 (Skills System)** | \`${skillsEnabled}\` (轮次上限: \`${maxTurns}\` 轮) |\n`;
      markdownContent += `| **技能唤起模式 (Invocation Mode)** | \`${invocationMode}\` (直调工具数: \`${directCallCount}\` 个) |\n`;
      markdownContent += `| **激活的技能列表 (Active Skills)** | \`${activeSkillsList}\` |\n`;
      markdownContent += `| **本次会话轮次 (Elapsed Turns)** | \`${history.filter(m => m.role === 'user').length} 轮交互\` |\n\n`;

      markdownContent += `---\n\n`;

      // 📊 Mermaid Sequence Flow
      markdownContent += `## 📊 会话调用流可视化 (Mermaid 时序图)\n\n`;
      markdownContent += `> [!TIP]\n`;
      markdownContent += `> 这是一个自动生成的 Mermaid 序列图。在 Obsidian 预览模式下将自动渲染为清晰的多轮交互时序图。\n\n`;
      markdownContent += `<details open>\n`;
      markdownContent += `<summary>展开会话流程图</summary>\n\n`;
      markdownContent += `\`\`\`mermaid\n`;
      markdownContent += `${mermaidDiagram}`;
      markdownContent += `\`\`\`\n\n`;
      markdownContent += `</details>\n\n`;

      markdownContent += `---\n\n`;

      // ⚠️ Diagnostics logs section
      markdownContent += `## ⚠️ 语法解析与执行错误日志 (故障排查)\n\n`;
      if (logs.length === 0) {
        markdownContent += `> [!SUCCESS]\n`;
        markdownContent += `> **本会话期间未捕获到任何 JSON 语法解析失败或工具运行异常记录！** 所有的工具解析及执行调用全部运作正常。\n\n`;
      } else {
        markdownContent += `> [!IMPORTANT]\n`;
        markdownContent += `> 以下是本会话期间捕获的运行时报错及参数解析失败数据。这些信息有助于大模型精准定位并修正 JSON 参数错误。\n\n`;

        logs.forEach((log, idx) => {
          markdownContent += `### 🚨 事件 ${idx + 1}: ${log.toolName} 调用异常\n`;
          markdownContent += `* **触发时间**: \`${new Date(log.timestamp).toLocaleString()}\`\n`;
          markdownContent += `* **应用策略**: \`${log.strategy || 'Strict'}\`\n`;
          markdownContent += `* **异常信息**: \`${log.errorMessage}\`\n`;
          markdownContent += `* **原始模型返回参数 (Malformed String)**:\n`;
          markdownContent += `\`\`\`json\n`;
          markdownContent += `${log.originalArgs}\n`;
          markdownContent += `\`\`\`\n\n`;
          if (log.repairedArgs) {
            markdownContent += `* **历史尝试修复参数 (Repaired Backup)**:\n`;
            markdownContent += `\`\`\`json\n`;
            markdownContent += `${log.repairedArgs}\n`;
            markdownContent += `\`\`\`\n\n`;
          }
        });
      }

      markdownContent += `---\n\n`;

      // 💬 Interactive Trace (readable history)
      markdownContent += `## 💬 完整会话轨迹明细 (Trace Details)\n\n`;
      
      let turnIdx = 1;
      for (const msg of history) {
        const timeFormatted = new Date(msg.timestamp || Date.now()).toLocaleTimeString();
        if (msg.role === 'user') {
          markdownContent += `### 👤 交互轮 ${turnIdx++} - 用户 (User) [${timeFormatted}]\n`;
          markdownContent += `> ${msg.content.replace(/\n/g, '\n> ')}\n\n`;
        } else if (msg.role === 'assistant') {
          markdownContent += `### 🤖 智能体响应 (Assistant) [${timeFormatted}]\n`;
          
          if (msg.tool_calls && msg.tool_calls.length > 0) {
            markdownContent += `> **[申请工具调用]**:\n`;
            msg.tool_calls.forEach(tc => {
              markdownContent += `> * **工具 ID**: \`${tc.id}\`\n`;
              markdownContent += `> * **工具名称**: \`${tc.name}\`\n`;
              markdownContent += `> * **工具入参**:\n`;
              markdownContent += `> \`\`\`json\n`;
              markdownContent += `> ${typeof tc.arguments === 'string' ? tc.arguments.replace(/\n/g, '\n> ') : JSON.stringify(tc.arguments, null, 2).replace(/\n/g, '\n> ')}\n`;
              markdownContent += `> \`\`\`\n`;
            });
            markdownContent += `\n`;
          }
          
          if (msg.content && msg.content.trim()) {
            markdownContent += `> **[流式生成答复]**:\n`;
            markdownContent += `> ${msg.content.replace(/\n/g, '\n> ')}\n\n`;
          }
        } else if (msg.role === 'tool') {
          const isErr = msg.content.startsWith('Error:') || msg.content.startsWith('Failed:');
          const statusIcon = isErr ? '❌' : '✅';
          markdownContent += `### ${statusIcon} 工具执行结果 [${timeFormatted}]\n`;
          markdownContent += `* **关联工具名**: \`${msg.name || '未知'}\`\n`;
          markdownContent += `* **工具调用 ID**: \`${msg.tool_call_id || '无'}\`\n`;
          markdownContent += `* **工具输出**:\n`;
          markdownContent += `\`\`\`json\n`;
          markdownContent += `${msg.content}\n`;
          markdownContent += `\`\`\`\n\n`;
        }
      }

      markdownContent += `---\n\n`;

      // 📦 Collapsible copyable API payload
      markdownContent += `## 📦 API Compliant Messages (用于大模型离线微调或 API 调试)\n\n`;
      markdownContent += `> [!TIP]\n`;
      markdownContent += `> 以下是一个完全符合 OpenAI / Anthropic 格式要求的 Messages 消息数组。你可以随时一键复制代码块，直接粘给外部模型或 API 测试脚本中进行复现诊断。\n\n`;
      markdownContent += `<details>\n`;
      markdownContent += `<summary>点击展开完整的 API Payload</summary>\n\n`;
      markdownContent += `\`\`\`json\n`;
      markdownContent += `${cleanJsonHistory}\n`;
      markdownContent += `\`\`\`\n\n`;
      markdownContent += `</details>\n\n`;

      // Estimate msg tokens helper
      const estimateMsgTokens = (msg: ChatMessage): number => {
        let totalChars = msg.content.length + 10;
        if (msg.tool_calls) {
          totalChars += JSON.stringify(msg.tool_calls).length;
        }
        return Math.ceil(totalChars / 4);
      };

      // Calculate turn-by-turn metrics
      const getModelContextLimit = (model: string): number => {
        const m = model.toLowerCase();
        if (m.includes('claude-3-5') || m.includes('claude-3.5')) return 200000;
        if (m.includes('gpt-4o') || m.includes('gpt-4-turbo')) return 128000;
        if (m.includes('deepseek')) return 64000;
        if (m.includes('llama3') || m.includes('qwen')) return 32000;
        return 8000; // standard fallback limit
      };
      const contextLimit = getModelContextLimit(modelName);

      const turnsData: Array<{ turn: number; tokens: number; saturation: number; cacheHit: number }> = [];
      let cumulativeTokens = 0;
      let turnCounter = 1;

      // Group history into turns (each user message begins a turn)
      interface TurnGroup {
        userMsg: ChatMessage;
        assistantMsgs: ChatMessage[];
      }
      const turnGroups: TurnGroup[] = [];
      let currentGroup: TurnGroup | null = null;

      for (const msg of history) {
        if (msg.role === 'user') {
          if (currentGroup) {
            turnGroups.push(currentGroup);
          }
          currentGroup = { userMsg: msg, assistantMsgs: [] };
        } else if (msg.role === 'assistant' && currentGroup) {
          currentGroup.assistantMsgs.push(msg);
        }
      }
      if (currentGroup) {
        turnGroups.push(currentGroup);
      }

      for (const group of turnGroups) {
        let turnPromptTokens = 0;
        let turnCacheReadTokens = 0;
        let turnTotalTokens = 0;
        let hasRealUsage = false;

        // Sum up real usage
        for (const assistantMsg of group.assistantMsgs) {
          if (assistantMsg.metadata?.usage) {
            const usage = assistantMsg.metadata.usage;
            turnPromptTokens += usage.promptTokens;
            turnCacheReadTokens += usage.cacheReadTokens ?? 0;
            turnTotalTokens += usage.totalTokens;
            hasRealUsage = true;
          }
        }

        if (!hasRealUsage) {
          // Fallback to estimation
          const userEstimate = estimateMsgTokens(group.userMsg);
          let assistantEstimate = 0;
          for (const assistantMsg of group.assistantMsgs) {
            assistantEstimate += estimateMsgTokens(assistantMsg);
          }
          turnPromptTokens = userEstimate;
          turnCacheReadTokens = 0;
          turnTotalTokens = userEstimate + assistantEstimate;
        }

        cumulativeTokens += turnTotalTokens;
        const saturation = parseFloat(((cumulativeTokens / contextLimit) * 100).toFixed(2));
        const cacheHit = turnPromptTokens > 0
          ? parseFloat(((turnCacheReadTokens / turnPromptTokens) * 100).toFixed(2))
          : 0;

        turnsData.push({
          turn: turnCounter++,
          tokens: cumulativeTokens,
          saturation,
          cacheHit
        });
      }

      const lastSaturation = turnsData.length > 0 ? turnsData[turnsData.length - 1].saturation : 0;
      const averageCacheHit = turnsData.length > 0
        ? parseFloat((turnsData.reduce((sum, t) => sum + t.cacheHit, 0) / turnsData.length).toFixed(2))
        : 0;

      // 4.5. Render Runtime Health & Performance Dashboard
      markdownContent += `---\n\n`;
      markdownContent += `## 🚀 运行期性能与上下文健康度看板 (Session Health Dashboard)\n\n`;
      markdownContent += `> [!TIP]\n`;
      markdownContent += `> 此看板动态追踪并反馈当前会话的上下文饱和度以及智能体提示词缓存命中率。这可帮助您直观掌握大模型的运行效能与防范过载。\n\n`;

      markdownContent += `<div style="display: flex; gap: 20px; flex-wrap: wrap; margin: 20px 0;">\n`;
      markdownContent += `  <div style="flex: 1; min-width: 250px; border: 1px solid var(--border-color); border-radius: 8px; padding: 15px; background: var(--background-primary-alt);">\n`;
      markdownContent += `    <h4 style="margin: 0 0 10px 0; font-size: 1.1em;">📊 运行期上下文饱和度 (Context Saturation)</h4>\n`;
      markdownContent += `    <div style="height: 12px; background: var(--background-modifier-border); border-radius: 6px; overflow: hidden;">\n`;
      markdownContent += `      <div style="height: 100%; width: ${lastSaturation}%; background: ${lastSaturation > 80 ? 'var(--text-error)' : lastSaturation > 50 ? 'var(--text-accent)' : 'var(--text-success)'}; border-radius: 6px;"></div>\n`;
      markdownContent += `    </div>\n`;
      markdownContent += `    <div style="display: flex; justify-content: space-between; font-size: 0.85em; margin-top: 5px; color: var(--text-muted);">\n`;
      markdownContent += `      <span>当前: ${lastSaturation}%</span>\n`;
      markdownContent += `      <span>上限: 200,000 Tokens</span>\n`;
      markdownContent += `    </div>\n`;
      markdownContent += `  </div>\n`;
      markdownContent += `  <div style="flex: 1; min-width: 250px; border: 1px solid var(--border-color); border-radius: 8px; padding: 15px; background: var(--background-primary-alt);">\n`;
      markdownContent += `    <h4 style="margin: 0 0 10px 0; font-size: 1.1em;">⚡ 提示词缓存命中率 (Prompt Cache Hit Ratio)</h4>\n`;
      markdownContent += `    <div style="height: 12px; background: var(--background-modifier-border); border-radius: 6px; overflow: hidden;">\n`;
      markdownContent += `      <div style="height: 100%; width: ${averageCacheHit}%; background: var(--text-success); border-radius: 6px;"></div>\n`;
      markdownContent += `    </div>\n`;
      markdownContent += `    <div style="display: flex; justify-content: space-between; font-size: 0.85em; margin-top: 5px; color: var(--text-muted);">\n`;
      markdownContent += `      <span>平均缓存命中: ${averageCacheHit}%</span>\n`;
      markdownContent += `      <span>节约成本: ~${(averageCacheHit * 0.75).toFixed(1)}%</span>\n`;
      markdownContent += `    </div>\n`;
      markdownContent += `  </div>\n`;
      markdownContent += `</div>\n\n`;

      if (turnsData.length > 0) {
        markdownContent += `| 交互轮次 | 累计 Token 数 | 上下文饱和度 | 提示词缓存命中率 |\n`;
        markdownContent += `| :--- | :--- | :--- | :--- |\n`;
        turnsData.forEach(t => {
          markdownContent += `| 交互 ${t.turn} | \`${t.tokens.toLocaleString()}\` | \`${t.saturation}%\` | \`${t.cacheHit}%\` |\n`;
        });
        markdownContent += `\n`;

        markdownContent += `### 📈 运行期性能分析曲线图\n\n`;
        markdownContent += `\`\`\`mermaid\n`;
        markdownContent += `xychart-beta\n`;
        markdownContent += `    title "上下文饱和度与缓存命中率变化趋势"\n`;
        markdownContent += `    x-axis [${turnsData.map(t => `"轮次 ${t.turn}"`).join(', ')}]\n`;
        markdownContent += `    y-axis "百分比 (%)" 0 --> 100\n`;
        markdownContent += `    line [${turnsData.map(t => t.saturation).join(', ')}]\n`;
        markdownContent += `    line [${turnsData.map(t => t.cacheHit).join(', ')}]\n`;
        markdownContent += `\`\`\`\n\n`;
      }

      // 5. Write diagnostics markdown note
      const vault = plugin.app.vault;
      
      // Auto-create folder paths if they do not exist
      if (!(await vault.adapter.exists(folderPath))) {
        // Recursive folder creation
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

      const fileFullPath = `${folderPath}/${filename}`;
      const file = await vault.create(fileFullPath, markdownContent);

      new Notice(`✅ 诊断报告导出成功！保存在 \`${fileFullPath}\``);

      // Open the file inside Obsidian Workspace
      const leaf = plugin.app.workspace.getLeaf(false);
      await leaf.openFile(file);

      return fileFullPath;
    } catch (err: any) {
      console.error('[DiagnosticsExporter] Failed to export session:', err);
      new Notice(`❌ 导出诊断报告异常：${err.message}`);
      return null;
    }
  }

  /**
   * Reads the diagnostics.jsonl file inside the vault, parses entries, 
   * and extracts logs whose timestamps fall within the session.
   */
  private static async retrieveIncidentLogs(
    plugin: PersonalAgentPlugin,
    startTime: number,
    endTime: number
  ): Promise<any[]> {
    const logs: any[] = [];
    try {
      const adapter = plugin.app.vault.adapter;
      const logPath = '.mentat/diagnostics.jsonl';
      
      if (await adapter.exists(logPath)) {
        const rawContent = await adapter.read(logPath);
        const lines = rawContent.split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            // Fallback: if startTime is 0 (first message not tracked), retrieve recent log incidents of this hour
            const startLimit = startTime > 0 ? startTime : Date.now() - 3600000;
            if (entry.timestamp >= startLimit && entry.timestamp <= endTime) {
              logs.push(entry);
            }
          } catch {
            // Ignore parse errors on individual broken jsonl lines
          }
        }
      }
    } catch (e) {
      console.warn('[DiagnosticsExporter] Failed to retrieve incident logs:', e);
    }
    return logs;
  }

  /**
   * Generates a Mermaid sequence diagram string from conversation history.
   */
  private static generateMermaidDiagram(messages: ChatMessage[]): string {
    let diagram = 'sequenceDiagram\n';
    diagram += '    autonumber\n';
    diagram += '    actor User as 用户 (User)\n';
    diagram += '    participant Agent as 智能体 (Agent)\n';
    diagram += '    participant Skill as 运行工具 (Skills)\n\n';

    for (const msg of messages) {
      if (msg.role === 'user') {
        const cleaned = DiagnosticsExporter.escapeMermaidText(msg.content);
        diagram += `    User->>Agent: "${cleaned}"\n`;
      } else if (msg.role === 'assistant') {
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          for (const tc of msg.tool_calls) {
            let displayName = tc.name;
            let displayParams = '';
            try {
              const args = typeof tc.arguments === 'string' ? JSON.parse(tc.arguments) : tc.arguments;
              if (tc.name === 'spec' || tc.name === 'invoke') {
                const skillName = args.skill_name;
                if (skillName) displayName = `${tc.name}:${skillName}`;
              }
              const keys = Object.keys(args).filter(k => k !== 'skill_name');
              if (keys.length > 0) {
                displayParams = keys.map(k => {
                  const val = args[k];
                  if (typeof val === 'object' && val !== null) {
                    if (val.path) return `${k}.path="${String(val.path).split('/').pop()}"`;
                    if (val.query) return `${k}.query="${String(val.query).substring(0, 15)}"`;
                    const subKeys = Object.keys(val);
                    return `${k}={${subKeys.slice(0, 2).join(', ')}}`;
                  }
                  return `${k}=${String(val)}`;
                }).join(', ');
              }
            } catch (e) {
              // Keep original displayName
            }
            const cleanName = displayName.split(':').pop() || displayName;
            const paramStr = displayParams ? ` (${DiagnosticsExporter.escapeMermaidText(displayParams)})` : '';
            diagram += `    Agent->>Skill: ${cleanName}${paramStr}\n`;
          }
        }
        if (msg.content && msg.content.trim()) {
          const cleaned = DiagnosticsExporter.escapeMermaidText(msg.content);
          diagram += `    Agent->>User: "${cleaned}"\n`;
        }
      } else if (msg.role === 'tool') {
        let isSuccess = !msg.content.startsWith('Error:') && !msg.content.startsWith('Failed:');
        let status = isSuccess ? 'Success' : 'Error';
        let text = msg.content.substring(0, 60);
        if (!isSuccess) {
          text = msg.content.substring(0, 100);
        }
        const cleaned = DiagnosticsExporter.escapeMermaidText(text);
        diagram += `    Skill-->>Agent: [${status}] "${cleaned}"\n`;
      }
    }
    return diagram;
  }

  /**
   * Sanitizes strings to prevent syntax parsing violations inside Mermaid sequence charts.
   */
  private static escapeMermaidText(text: string): string {
    if (!text) return '';
    return text
      .replace(/"/g, "'") // Replace inner double quotes with single quotes to keep valid string boundaries
      .replace(/\n/g, ' ')
      .replace(/[\r]/g, '')
      .replace(/[\[\]\(\)\{\}<>]/g, ' ') // Clean up special Mermaid delimiters to protect diagram compilation
      .substring(0, 80)
      .trim();
  }

  /**
   * Formats the conversation history array into standard copyable JSON payloads.
   */
  private static generateJsonPayload(messages: ChatMessage[]): string {
    try {
      const cleanArray = messages.map(m => {
        const entry: Record<string, any> = {
          role: m.role,
          content: m.content
        };
        if (m.name) entry.name = m.name;
        if (m.tool_call_id) entry.tool_call_id = m.tool_call_id;
        if (m.tool_calls) {
          entry.tool_calls = m.tool_calls.map(tc => ({
            id: tc.id,
            type: 'function',
            function: {
              name: tc.name,
              arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments)
            }
          }));
        }
        return entry;
      });
      return JSON.stringify(cleanArray, null, 2);
    } catch (e) {
      return '[]';
    }
  }
}
