import { IPlatformAdapter, IPlatformFile } from '../types/platform';
import { AIRouter } from '../providers/ai-router';
import { TaskType } from '../types';

export class VaultMapRebuilder {
  constructor(
    private platform: IPlatformAdapter,
    private settings: { userConfigFolder?: string; skillInvocationConfig?: { directCallSkills?: string[] } },
    private aiRouter: AIRouter
  ) {}

  /**
   * Premium AI-Assisted Vault-Map Generation
   * Scans vault directories, collects note counts, popular tags, and recent file names,
   * then feeds this structural context to the active LLM to generate highly personalized guidelines.
   */
  async aiRebuildVaultMap(onProgress?: (stage: string, percent: number) => void): Promise<void> {
    const configFolder = this.settings.userConfigFolder || 'Mentat/Config';
    const mapPath = `${configFolder}/vault-map.md`;

    // 1. Gather all files in the vault to analyze folder structures, file names, and tag frequencies
    onProgress?.('正在扫描库中的文件夹与笔记结构...', 15);
    const allFiles = this.platform.getMarkdownFiles();
    const folderStats = new Map<string, { noteCount: number; files: { name: string; mtime: number }[]; tags: Map<string, number> }>();

    allFiles.forEach(file => {
      if (file.parent && file.parent.path !== '/' && file.parent.path !== '.') {
        const folder = file.parent.path;
        if (!folderStats.has(folder)) {
          folderStats.set(folder, {
            noteCount: 0,
            files: [],
            tags: new Map<string, number>()
          });
        }

        const stat = folderStats.get(folder)!;
        stat.noteCount += 1;
        stat.files.push({ name: file.name, mtime: file.stat.mtime });

        // Extract tags for tag frequency mapping
        const tags = VaultMapRebuilder.getFileTags(file, this.platform);
        tags.forEach((tag: string) => {
          stat.tags.set(tag, (stat.tags.get(tag) || 0) + 1);
        });
      }
    });

    // Process the stats to compile structured metadata for the LLM
    onProgress?.('正在整理并分析热门标签与最新笔记样本...', 35);
    const analyzedFolders: Record<string, unknown>[] = [];
    folderStats.forEach((stat, folder) => {
      // Sort files by modification time descending and pick top 5
      const recentFiles = stat.files
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, 5)
        .map(f => f.name);

      // Sort tags by frequency descending and pick top 3
      const topTags = Array.from(stat.tags.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([tag]) => tag);

      analyzedFolders.push({
        folder: `${folder}/`,
        totalNoteCount: stat.noteCount,
        recentSampleFiles: recentFiles,
        topFrequentTags: topTags
      });
    });

    // 2. Fetch the active AI provider
    const provider = await this.aiRouter.getProvider(TaskType.CHAT);
    if (!provider) {
      throw new Error('未配置或未启用任何 AI 服务商，请先在设置中配置 API Key。 (No active AI provider configured)');
    }

    // 3. Format prompting with actual vault statistics
    const vaultDataStr = JSON.stringify(analyzedFolders, null, 2);
    const prompt = `You are a professional knowledge management expert specializing in Obsidian vaults.
Analyze the following folder structure, sample filenames, and tag distributions in the user's vault to draft a customized, highly comprehensive vault-map guidelines file.

Vault Structure Data:
${vaultDataStr}

Guidelines for generating the "vault-map.md" file:
1. Provide a beautiful title: "# 🗺️ Vault Knowledge Structure Map".
2. Create a "## 📁 Core Folder Guidelines" section. For EACH folder listed in the data, write a detailed, highly accurate description (in Chinese) of what kind of notes belong there based on the sample files and popular tags found. Format the folder names as double-bracket wiki-links (e.g. "- \`[[Research/ML/]]\`: 用于存放机器学习、最优化损失函数及研究计划 of 笔记与推导。").
3. Create a "## 🏷️ Category Workflows & Wiki-Linking" section. Under it:
   - Identify naming conventions (e.g., prefixing, suffixing, or case formats) you detect from note titles in each directory.
   - Outline suggested workflows and relationships between these folders (e.g., rough notes and captured inputs in Inbox should be polished and moved to Research or Projects).
4. Strictly return ONLY the raw Markdown content. Do not include any HTML script tags, dynamic canvas elements, markdown block wrappers (\`\`\`), or conversational preamble.

Return the finalized markdown content:`;

    // 4. Call LLM to generate the content
    onProgress?.('正在调用 AI 智能服务商规划知识库结构指南 (大约需要 5-10 秒)...', 65);
    const response = await provider.generate(prompt);
    if (!response || !response.trim()) {
      throw new Error('AI 生成了空内容，请重试。 (AI returned empty response)');
    }

    const cleanMarkdown = response.replace(/^```markdown\n/i, '').replace(/```$/i, '').trim();

    // 5. Ensure config folder exists
    onProgress?.('正在保存并写入本地地图配置文件...', 90);
    if (!(await this.platform.exists(configFolder))) {
      await this.platform.mkdir(configFolder);
    }

    // 6. Overwrite or create file
    await this.platform.write(mapPath, cleanMarkdown);
  }

  /**
   * Helper to extract tags safely from metadata cache of a single file
   */
  static getFileTags(file: IPlatformFile, platform: IPlatformAdapter): string[] {
    const cache = platform.getFileCache(file);
    const fileTags = cache?.tags?.map((t: unknown) => (t as { tag: string }).tag.replace('#', '')) || [];
    const frontmatterTagsRaw = cache?.frontmatter?.tags;
    let frontmatterTags: string[] = [];
    if (Array.isArray(frontmatterTagsRaw)) {
      frontmatterTags = frontmatterTagsRaw.map(t => typeof t === 'string' ? t : String(t));
    } else if (typeof frontmatterTagsRaw === 'string') {
      frontmatterTags = frontmatterTagsRaw.split(',').map(t => t.trim());
    }
    const normalizedTags: string[] = [];
    [...fileTags, ...frontmatterTags].forEach((tag: string) => {
      if (!tag) return;
      const tagStr = typeof tag === 'string' ? tag : String(tag);
      const cleanTag = tagStr.replace('#', '').trim();
      if (cleanTag) {
        normalizedTags.push(cleanTag);
      }
    });
    return Array.from(new Set(normalizedTags));
  }
}
