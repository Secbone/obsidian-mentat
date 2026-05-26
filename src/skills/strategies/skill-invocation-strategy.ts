// Skill Invocation Strategy - Abstract strategy pattern for skill invocation

import { App } from 'obsidian';
import { AnySkillDefinition, OpenAIFunction, AnthropicTool, isExecutableSkill } from '../skill-types';
import { SkillRegistry } from '../core/skill-registry';
import { SkillListGenerator } from '../generators/skill-list-generator';
import { SkillDetailGenerator } from '../generators/skill-detail-generator';
import { getSpecTool, getInvokeTool } from '../meta-tools';
import { PromptLoader } from '../../prompts/prompt-loader';
import { PROMPT_PATHS, FALLBACK_PROMPTS, TEMPLATE_VARS } from '../../prompts/prompt-templates';

/**
 * Skill invocation mode
 */
export type SkillInvocationMode = 'progressive' | 'native' | 'auto';

/**
 * Skill invocation strategy interface
 */
export interface SkillInvocationStrategy {
  /**
   * Prepare system prompt content for the LLM
   */
  prepareSystemPrompt(registry: SkillRegistry): string;

  /**
   * Get the tool/function definitions to send to the LLM
   */
  getToolDefinitions(registry: SkillRegistry, format: 'openai' | 'anthropic'): any[];

  /**
   * Check if this is a meta-tool call (spec or invoke)
   */
  isMetaToolCall(toolName: string): boolean;

  /**
   * Get the actual skill name from a tool call
   */
  getSkillName(toolName: string): string;
}

/**
 * Native Function Calling Strategy
 * Uses the original approach - all skills as individual function calls
 */
export class NativeFunctionCallingStrategy implements SkillInvocationStrategy {
  prepareSystemPrompt(registry: SkillRegistry): string {
    // Include documentation skills in system prompt
    return registry.getDocumentationContent();
  }

  getToolDefinitions(registry: SkillRegistry, format: 'openai' | 'anthropic'): any[] {
    if (format === 'openai') {
      return registry.toOpenAIFunctions();
    } else {
      return registry.toAnthropicTools();
    }
  }

  isMetaToolCall(toolName: string): boolean {
    return false; // No meta-tools in native mode
  }

  getSkillName(toolName: string): string {
    return toolName; // Direct mapping
  }
}

/**
 * Progressive Disclosure Strategy
 * Uses spec and invoke meta-tools for on-demand loading
 */
export class ProgressiveDisclosureStrategy implements SkillInvocationStrategy {
  private listGenerator = new SkillListGenerator();
  private detailGenerator = new SkillDetailGenerator();
  private promptLoader: PromptLoader | null = null;

  constructor(private app?: App) {
    if (app) {
      this.promptLoader = new PromptLoader(app, FALLBACK_PROMPTS);
    }
  }

  prepareSystemPrompt(registry: SkillRegistry): string {
    let content = '';

    // Include documentation skills
    content += registry.getDocumentationContent();

    // Filter enabled skills
    const plugin = this.app ? (this.app as any).plugins?.plugins?.['personal-agent'] : null;
    const configurations = plugin?.settings?.skillConfigurations || {};
    const enabledSkills = registry.getAll().filter(s => {
      const fullName = registry.getFullName(s.namespace, s.name);
      return configurations[fullName]?.enabled !== false;
    });

    // Generate skill list
    const skillList = this.listGenerator.generateSkillList(enabledSkills);

    // Load progressive disclosure prompt template
    if (this.promptLoader) {
      // Try to load from file asynchronously, but return synchronously
      // Note: This uses a synchronous approach for now to maintain backward compatibility
      try {
        const progressivePrompt = this.loadProgressivePromptSync(skillList);
        content += '\n\n' + progressivePrompt;
      } catch (error) {
        console.error('[ProgressiveDisclosureStrategy] Error loading prompt, using fallback:', error);
        content += '\n\n' + this.getFallbackPrompt(skillList);
      }
    } else {
      // No app instance, use fallback
      content += '\n\n' + this.getFallbackPrompt(skillList);
    }

    return content;
  }

  /**
   * Load progressive disclosure prompt synchronously
   * Uses the embedded fallback and replaces variables
   */
  private loadProgressivePromptSync(skillList: string): string {
    if (!this.promptLoader) {
      return this.getFallbackPrompt(skillList);
    }

    // For now, use synchronous loading with fallback
    // In the future, this could be enhanced to load asynchronously during initialization
    const fallback = FALLBACK_PROMPTS.get(PROMPT_PATHS.SKILLS) || '';
    return this.promptLoader.replaceVariables(fallback, {
      [TEMPLATE_VARS.SKILL_LIST]: skillList
    });
  }

  /**
   * Get fallback prompt with variable replacement
   */
  private getFallbackPrompt(skillList: string): string {
    let content = '## AVAILABLE SKILLS\n\n';
    content += 'You have access to specialized skills through a two-step process:\n\n';
    content += '**IMPORTANT: How to Use Skills**\n';
    content += '1. **Get skill spec first:** Call `spec` with the skill name to get parameter information\n';
    content += '   Example: spec("obsidian:query_notes")\n\n';
    content += '2. **Invoke the skill:** Call `invoke` with the skill name and required parameters\n';
    content += '   Example: invoke("obsidian:query_notes", {"limit": 10})\n\n';
    content += '**Available Skills:**\n';
    content += skillList;
    content += '\n\n';
    content += '**Workflow:**\n';
    content += '- When uncertain about parameters: Call `spec` first to see detailed documentation\n';
    content += '- When you know the parameters: You can call `invoke` directly (skip spec)\n';
    content += '- For vault operations: Use the skills above proactively\n';
    content += '- When blocked or uncertain: Use the `ask_user` skill for clarification\n\n';
    content += '**Example Workflows:**\n\n';
    content += '*Query notes (if you don\'t know parameters):*\n';
    content += '→ spec("obsidian:query_notes")\n';
    content += '→ [Review the returned parameter schema]\n';
    content += '→ invoke("obsidian:query_notes", {"query": "machine learning", "limit": 5})\n\n';
    content += '*Read a note (if you already know parameters):*\n';
    content += '→ invoke("obsidian:read_note", {"path": "Projects/MyNote.md"})\n\n';
    content += '*Create or edit a note:*\n';
    content += '→ spec("obsidian:edit_note")\n';
    content += '→ invoke("obsidian:edit_note", {"path": "Daily/2025-01-26.md", "content": "# Today\'s Notes\\n\\n..."})\n\n';
    content += '**Note:** The skill list may be dynamic. Use `spec` to discover additional skills or get updated information.\n';

    return content;
  }

  getToolDefinitions(registry: SkillRegistry, format: 'openai' | 'anthropic'): any[] {
    // Return only the two meta-tools
    if (format === 'openai') {
      return [
        getSpecTool('openai') as OpenAIFunction,
        getInvokeTool('openai') as OpenAIFunction
      ];
    } else {
      return [
        getSpecTool('anthropic') as AnthropicTool,
        getInvokeTool('anthropic') as AnthropicTool
      ];
    }
  }

  isMetaToolCall(toolName: string): boolean {
    return toolName === 'spec' || toolName === 'invoke';
  }

  getSkillName(toolName: string): string {
    // In progressive mode, the actual skill name is in the parameters
    return toolName;
  }

  /**
   * Generate skill details for spec response
   */
  generateSkillDetails(skill: AnySkillDefinition, format: 'markdown' | 'xml' | 'json' = 'markdown'): string {
    return this.detailGenerator.generateSkillDetails(skill, format);
  }
}

/**
 * Hybrid Skill Invocation Strategy (Auto Mode)
 * Exposes core, high-frequency skills directly to the LLM as native tools,
 * while keeping all other skills progressive (accessed via spec and invoke)
 * to maintain prompt efficiency.
 */
export class HybridSkillInvocationStrategy implements SkillInvocationStrategy {
  private listGenerator = new SkillListGenerator();
  private detailGenerator = new SkillDetailGenerator();
  private progressiveStrategy: ProgressiveDisclosureStrategy;

  constructor(private app?: App, directCallSkills?: string[]) {
    this.progressiveStrategy = new ProgressiveDisclosureStrategy(app);
  }

  private getCoreSkillsSet(): Set<string> {
    const coreSkills = new Set<string>();
    
    // Default core skills list
    const defaultCore = [
      'obsidian:read_note',
      'obsidian:query_notes',
      'obsidian:edit_note',
      'obsidian:web_search',
      'obsidian:ask_user',
      'obsidian:list_notes',
      'obsidian:web_fetch'
    ];
    
    const plugin = this.app ? (this.app as any).plugins?.plugins?.['personal-agent'] : null;
    const configurations = plugin?.settings?.skillConfigurations || {};
    
    // Base defaults
    for (const name of defaultCore) {
      if (configurations[name]?.directCall !== false) {
        coreSkills.add(name);
      }
    }
    
    // Apply dynamic overrides
    for (const [name, config] of Object.entries(configurations)) {
      if (config.directCall === true) {
        coreSkills.add(name);
      } else if (config.directCall === false) {
        coreSkills.delete(name);
      }
    }

    return coreSkills;
  }

  prepareSystemPrompt(registry: SkillRegistry): string {
    let content = '';

    // Include documentation skills
    content += registry.getDocumentationContent();

    // Filter enabled skills
    const plugin = this.app ? (this.app as any).plugins?.plugins?.['personal-agent'] : null;
    const configurations = plugin?.settings?.skillConfigurations || {};
    const enabledSkills = registry.getAll().filter(s => {
      const fullName = registry.getFullName(s.namespace, s.name);
      return configurations[fullName]?.enabled !== false;
    });

    const coreSkillsSet = this.getCoreSkillsSet();

    // Separate skills into core and progressive
    const coreSkillDefs = enabledSkills.filter(s => coreSkillsSet.has(registry.getFullName(s.namespace, s.name)));
    const progressiveSkills = enabledSkills.filter(s => !coreSkillsSet.has(registry.getFullName(s.namespace, s.name)));

    // Generate progressive skill list
    const progressiveSkillList = this.listGenerator.generateSkillList(progressiveSkills);

    // Hybrid prompt instructions
    content += '\n\n## SYSTEM TOOLS\n';
    content += 'You have direct, instant access to core system tools. You can invoke these directly in a single turn without using `spec` or `invoke`:\n';
    for (const skill of coreSkillDefs) {
      const fullName = registry.getFullName(skill.namespace, skill.name);
      content += `- \`${fullName}\`: ${skill.description}\n`;
    }
    content += '\n';

    content += '## DYNAMIC SKILLS\n';
    content += 'You also have access to advanced/dynamic skills. To use these, you MUST use a two-step process:\n';
    content += '1. **Get skill spec first:** Call `spec` with the skill name to get its exact parameters and description.\n';
    content += '   Example: spec("obsidian:web_fetch")\n';
    content += '2. **Invoke the skill:** Call `invoke` with the skill name and required parameters.\n';
    content += '   Example: invoke("obsidian:web_fetch", {"url": "https://..."})\n\n';
    
    if (progressiveSkillList && progressiveSkillList.trim()) {
      content += '**Available Dynamic Skills:**\n';
      content += progressiveSkillList;
      content += '\n\n';
    }

    content += '**Workflows:**\n';
    content += '- Core tools: Call directly (e.g. obsidian:web_search)\n';
    content += '- Dynamic tools: Call `spec` first, then call `invoke`\n';
    content += '- If in doubt about a core tool\'s parameters: You can call `spec` on it too!\n';

    return content;
  }

  getToolDefinitions(registry: SkillRegistry, format: 'openai' | 'anthropic'): any[] {
    const tools: any[] = [];

    // Filter enabled skills
    const plugin = this.app ? (this.app as any).plugins?.plugins?.['personal-agent'] : null;
    const configurations = plugin?.settings?.skillConfigurations || {};
    const enabledSkills = registry.getAll().filter(s => {
      const fullName = registry.getFullName(s.namespace, s.name);
      return configurations[fullName]?.enabled !== false;
    });

    const coreSkillsSet = this.getCoreSkillsSet();

    // 1. Expose core skills directly as native tools
    const coreSkillDefs = enabledSkills.filter(s => coreSkillsSet.has(registry.getFullName(s.namespace, s.name)));

    if (format === 'openai') {
      for (const skill of coreSkillDefs) {
        if (isExecutableSkill(skill)) {
          tools.push(registry.skillToOpenAIFunction(skill));
        }
      }
      tools.push(getSpecTool('openai') as OpenAIFunction);
      tools.push(getInvokeTool('openai') as OpenAIFunction);
    } else {
      for (const skill of coreSkillDefs) {
        if (isExecutableSkill(skill)) {
          tools.push(registry.skillToAnthropicTool(skill));
        }
      }
      tools.push(getSpecTool('anthropic') as AnthropicTool);
      tools.push(getInvokeTool('anthropic') as AnthropicTool);
    }

    return tools;
  }

  isMetaToolCall(toolName: string): boolean {
    return toolName === 'spec' || toolName === 'invoke';
  }

  getSkillName(toolName: string): string {
    return toolName;
  }
}

/**
 * Skill Invocation Context - manages strategy and state
 */
export class SkillInvocationContext {
  private strategy: SkillInvocationStrategy;
  private mode: SkillInvocationMode;
  private app?: App;
  private directCallSkills?: string[];

  constructor(mode: SkillInvocationMode = 'progressive', app?: App, directCallSkills?: string[]) {
    this.mode = mode;
    this.app = app;
    this.directCallSkills = directCallSkills;
    this.strategy = this.createStrategy(mode);
  }

  private createStrategy(mode: SkillInvocationMode): SkillInvocationStrategy {
    switch (mode) {
      case 'native':
        return new NativeFunctionCallingStrategy();
      case 'progressive':
        return new ProgressiveDisclosureStrategy(this.app);
      case 'auto':
        return new HybridSkillInvocationStrategy(this.app, this.directCallSkills);
      default:
        return new HybridSkillInvocationStrategy(this.app, this.directCallSkills);
    }
  }

  /**
   * Switch strategy at runtime
   */
  setMode(mode: SkillInvocationMode): void {
    this.mode = mode;
    this.strategy = this.createStrategy(mode);
  }

  setDirectCallSkills(skills: string[]): void {
    this.directCallSkills = skills;
    if (this.mode === 'auto') {
      this.strategy = this.createStrategy(this.mode);
    }
  }

  getMode(): SkillInvocationMode {
    return this.mode;
  }

  getStrategy(): SkillInvocationStrategy {
    return this.strategy;
  }

  /**
   * Prepare system prompt using current strategy
   */
  prepareSystemPrompt(registry: SkillRegistry): string {
    return this.strategy.prepareSystemPrompt(registry);
  }

  /**
   * Get tool definitions using current strategy
   */
  getToolDefinitions(registry: SkillRegistry, format: 'openai' | 'anthropic'): any[] {
    return this.strategy.getToolDefinitions(registry, format);
  }

  /**
   * Check if tool call is a meta-tool
   */
  isMetaToolCall(toolName: string): boolean {
    return this.strategy.isMetaToolCall(toolName);
  }

  /**
   * Get skill name from tool call
   */
  getSkillName(toolName: string): string {
    return this.strategy.getSkillName(toolName);
  }
}
