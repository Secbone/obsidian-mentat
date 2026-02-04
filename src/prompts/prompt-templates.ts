// Prompt Templates - Constants and fallback prompts

/**
 * Prompt file paths relative to prompts/ directory
 */
export const PROMPT_PATHS = {
  SKILLS: 'system/skills.md',
  SYSTEM_PROMPT: 'system/system-prompt.md',
  NO_RESULTS_ERROR: 'messages/no-results-error.md'
} as const;

/**
 * Fallback prompts used when prompt files cannot be loaded
 * These match the content of the prompt files
 */
export const FALLBACK_PROMPTS = new Map<string, string>([
  [
    PROMPT_PATHS.SKILLS,
    `AVAILABLE SKILLS:
{{skillList}}

HOW TO USE SKILLS:
- Get skill spec first: spec("obsidian:query_notes")
- Invoke the skill: invoke("obsidian:query_notes", {"limit": 10})
- When uncertain about parameters: Call spec first to see detailed documentation
- When you know the parameters: Call invoke directly (skip spec)
- For vault operations: Use the skills proactively
- When blocked or uncertain: Use the ask_user skill for clarification

WORKFLOW EXAMPLES:
- Query notes (unknown parameters): spec("obsidian:query_notes") → review schema → invoke("obsidian:query_notes", {"query": "machine learning", "limit": 5})
- Read note (known parameters): invoke("obsidian:read_note", {"path": "Projects/MyNote.md"})
- Create or edit note: spec("obsidian:edit_note") → invoke("obsidian:edit_note", {"path": "Daily/2025-01-26.md", "content": "# Today's Notes\\n\\n..."})

Note: The skill list is dynamic. Use spec to discover additional skills or get updated information.`
  ],
  [
    PROMPT_PATHS.SYSTEM_PROMPT,
    `You are a helpful AI assistant for an Obsidian vault.

VAULT OVERVIEW:
- Total documents: {{totalFiles}}
- Main folders: {{topFolders}}
- Common tags: {{topTags}}

{{skillContent}}

RULES:
- Base answers on provided context documents
- When context is insufficient, use available skills to find more information
- Always mention which document information comes from
- Be concise but thorough
- When creating or editing Obsidian files, use proper Markdown syntax

Use your skills proactively to help the user manage their knowledge base.`
  ],
  [
    PROMPT_PATHS.NO_RESULTS_ERROR,
    `⚠️ **无法检索到文档内容**

可能的原因：
1. 📚 **文档尚未索引** - 请先执行 Ctrl/Cmd+P → "Index all documents for RAG"
2. 🔍 **文档内容与问题相关性较低** - 尝试更换文档或调整问题
3. ⚙️ **Embedding Provider 未配置** - 检查设置中的 AI Provider 配置

**下一步操作**：
1. 按 Ctrl/Cmd+P 打开命令面板
2. 搜索 "Index all documents"
3. 等待索引完成后重试`
  ]
]);

/**
 * Template variable names used in prompts
 */
export const TEMPLATE_VARS = {
  // Progressive disclosure variables
  SKILL_LIST: 'skillList',

  // Base system prompt variables
  TOTAL_FILES: 'totalFiles',
  TOP_FOLDERS: 'topFolders',
  TOP_TAGS: 'topTags',
  SKILL_CONTENT: 'skillContent'
} as const;
