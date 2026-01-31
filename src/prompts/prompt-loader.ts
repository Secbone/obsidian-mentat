// Prompt Loader - Loads and processes prompt templates from the prompts/ directory

import { App, FileSystemAdapter } from 'obsidian';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Template variable replacement options
 */
export interface PromptVariables {
  [key: string]: string | number;
}

/**
 * Prompt Loader
 *
 * Loads prompt templates from the prompts/ directory and replaces template variables.
 * Falls back to embedded defaults if files cannot be loaded.
 */
export class PromptLoader {
  private promptsBasePath: string;
  private cache: Map<string, string> = new Map();
  private useCache: boolean = true;

  constructor(
    private app: App,
    private fallbackPrompts: Map<string, string>
  ) {
    // Get the base path for prompts directory
    const adapter = this.app.vault.adapter as FileSystemAdapter;
    const basePath = adapter.getBasePath();
    this.promptsBasePath = path.join(basePath, 'prompts');
  }

  /**
   * Load a prompt template from file
   * @param promptPath - Relative path from prompts/ directory (e.g., 'system/system-prompt.md')
   * @param variables - Template variables to replace
   * @param useFallback - Whether to use fallback if file not found
   * @returns Processed prompt string
   */
  async loadPrompt(
    promptPath: string,
    variables: PromptVariables = {},
    useFallback: boolean = true
  ): Promise<string> {
    try {
      // Check cache first
      const cacheKey = promptPath;
      if (this.useCache && this.cache.has(cacheKey)) {
        const template = this.cache.get(cacheKey)!;
        return this.replaceVariables(template, variables);
      }

      // Construct full file path
      const fullPath = path.join(this.promptsBasePath, promptPath);

      // Check if file exists
      if (!fs.existsSync(fullPath)) {
        if (useFallback) {
          console.warn(`[PromptLoader] Prompt file not found: ${fullPath}, using fallback`);
          return this.loadFallback(promptPath, variables);
        } else {
          throw new Error(`Prompt file not found: ${fullPath}`);
        }
      }

      // Read file content
      const content = fs.readFileSync(fullPath, 'utf-8');

      // Cache the template
      if (this.useCache) {
        this.cache.set(cacheKey, content);
      }

      // Replace variables and return
      return this.replaceVariables(content, variables);
    } catch (error) {
      console.error('[PromptLoader] Error loading prompt:', error);

      if (useFallback) {
        return this.loadFallback(promptPath, variables);
      } else {
        throw error;
      }
    }
  }

  /**
   * Load fallback prompt from embedded defaults
   */
  private loadFallback(promptPath: string, variables: PromptVariables): string {
    const fallback = this.fallbackPrompts.get(promptPath);

    if (!fallback) {
      console.error(`[PromptLoader] No fallback found for: ${promptPath}`);
      return '';
    }

    return this.replaceVariables(fallback, variables);
  }

  /**
   * Replace template variables in a string
   * Variables use {{variableName}} syntax
   */
  replaceVariables(template: string, variables: PromptVariables): string {
    let result = template;

    // Replace each variable
    for (const [key, value] of Object.entries(variables)) {
      const placeholder = `{{${key}}}`;
      const replacement = String(value);
      result = result.split(placeholder).join(replacement);
    }

    return result;
  }

  /**
   * Clear the prompt cache
   * Useful for reloading prompts after changes
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Enable or disable caching
   */
  setCacheEnabled(enabled: boolean): void {
    this.useCache = enabled;
    if (!enabled) {
      this.clearCache();
    }
  }

  /**
   * Check if a prompt file exists
   */
  promptExists(promptPath: string): boolean {
    const fullPath = path.join(this.promptsBasePath, promptPath);
    return fs.existsSync(fullPath);
  }

  /**
   * Get the full path to a prompt file
   */
  getPromptPath(promptPath: string): string {
    return path.join(this.promptsBasePath, promptPath);
  }

  /**
   * Reload a specific prompt from file (bypass cache)
   */
  async reloadPrompt(promptPath: string, variables: PromptVariables = {}): Promise<string> {
    this.cache.delete(promptPath);
    return this.loadPrompt(promptPath, variables);
  }
}
