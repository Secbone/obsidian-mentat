// Skill Loader
// Loads all skills from the skills/ directory according to Agent Skills specification

import { z } from 'zod';
import { App } from 'obsidian';
import { SkillContext, AnySkillDefinition, SkillDefinition, DocumentationSkillDefinition, SkillResult } from '../skill-types';

// Import all skill implementations (compile-time imports for TypeScript)
import * as QueryNotesImpl from '../../../skills/query-notes/scripts';
import * as ReadNoteImpl from '../../../skills/read-note/scripts';
import * as EditNoteImpl from '../../../skills/edit-note/scripts';
import * as BatchOperationImpl from '../../../skills/batch-operation/scripts';
import * as ListNotesImpl from '../../../skills/list-notes/scripts';
import * as AskUserImpl from '../../../skills/ask-user/scripts';
import * as WebFetchImpl from '../../../skills/web-fetch/scripts';
import * as WebSearchImpl from '../../../skills/web-search/scripts';
import * as RunCommandImpl from '../../../skills/run-command/scripts';
import * as WriteNoteImpl from '../../../skills/write-note/scripts';
import * as MoveNoteImpl from '../../../skills/move-note/scripts';

/**
 * Skill metadata from SKILL.md frontmatter
 */
interface SkillMetadata {
  name: string;
  description: string;
  metadata?: {
    version?: string;
    author?: string;
    tags?: string[];
    executable?: boolean;
    implementation?: string;
    requiresConfirmation?: boolean;
  };
  content: string; // Markdown body
}

/**
 * Skill Loader
 *
 * Loads skills from the skills/ directory following Agent Skills specification.
 * Each skill is a directory containing:
 * - SKILL.md: Metadata (YAML frontmatter) and documentation (Markdown)
 * - scripts/ (optional): Implementation code for executable skills
 */
export class SkillLoader {
  private skillsBasePath: string;
  private implementationMap: Map<string, unknown>;

  constructor(
    private app: App,
    private pluginId: string = 'mentat'
  ) {
    // Construct path to skills directory in plugin folder
    this.skillsBasePath = `${app.vault.configDir}/plugins/${pluginId}/skills`;

    // Map skill names to their implementations (compile-time mapping)
    this.implementationMap = new Map<string, unknown>([
      ['query_notes', QueryNotesImpl],
      ['read_note', ReadNoteImpl],
      ['edit_note', EditNoteImpl],
      ['batch_operation', BatchOperationImpl],
      ['list_notes', ListNotesImpl],
      ['ask_user', AskUserImpl],
      ['web_fetch', WebFetchImpl],
      ['web_search', WebSearchImpl],
      ['run_command', RunCommandImpl],
      ['write_note', WriteNoteImpl],
      ['move_note', MoveNoteImpl]
    ]);
  }

  /**
   * Load all skills from the skills directory
   */
  async loadAllSkills(context: SkillContext): Promise<AnySkillDefinition[]> {
    const skills: AnySkillDefinition[] = [];

    try {
      // Get skill directories
      const skillDirs = await this.scanSkillDirectories();

      console.log(`[SkillLoader] Found ${skillDirs.length} skill directories:`, skillDirs);

      // Load each skill
      for (const skillDir of skillDirs) {
        try {
          const skill = await this.loadSkill(skillDir, context);
          if (skill) {
            skills.push(skill);
            console.log(`[SkillLoader] Loaded skill: ${skill.name}`);
          }
        } catch (error) {
          console.error(`[SkillLoader] Failed to load skill from ${skillDir}:`, error);
        }
      }

      console.log(`[SkillLoader] Successfully loaded ${skills.length} skills`);
      return skills;
    } catch (error) {
      console.error('[SkillLoader] Error loading skills:', error);
      return [];
    }
  }

  /**
   * Scan skills directory for skill subdirectories
   */
  private async scanSkillDirectories(): Promise<string[]> {
    const adapter = this.app.vault.adapter;

    try {
      const skillsPath = this.skillsBasePath;
      if (!(await adapter.exists(skillsPath))) {
        console.warn(`[SkillLoader] Skills directory not found: ${skillsPath}`);
        return [];
      }
      const listing = await adapter.list(skillsPath);
      const skillDirs: string[] = [];
      for (const folder of listing.folders) {
        const folderName = folder.split('/').pop() || folder;
        const skillMdPath = `${skillsPath}/${folderName}/SKILL.md`;
        if (await adapter.exists(skillMdPath)) {
          skillDirs.push(folderName);
        }
      }
      return skillDirs;
    } catch (error) {
      console.error('[SkillLoader] Error scanning skills directory:', error);
      return [];
    }
  }

  /**
   * Load a single skill from a directory
   */
  private async loadSkill(
    skillDirName: string,
    context: SkillContext
  ): Promise<AnySkillDefinition | null> {
    // Read SKILL.md
    const skillMdPath = `${this.skillsBasePath}/${skillDirName}/SKILL.md`;
    const metadata = await this.readSkillMetadata(skillMdPath);

    if (!metadata) {
      console.error(`[SkillLoader] Failed to read SKILL.md for ${skillDirName}`);
      return null;
    }

    const isExecutable = metadata.metadata?.executable !== false;

    if (isExecutable) {
      // Executable skill - load implementation
      return await this.loadExecutableSkill(metadata, skillDirName, context);
    } else {
      // Documentation skill - return as-is
      return this.loadDocumentationSkill(metadata);
    }
  }

  /**
   * Read and parse SKILL.md metadata
   */
  private async readSkillMetadata(skillMdPath: string): Promise<SkillMetadata | null> {
    const adapter = this.app.vault.adapter;

    try {
      const fullPath = `${skillMdPath}`;
      if (!(await adapter.exists(fullPath))) {
        console.error(`[SkillLoader] SKILL.md not found: ${fullPath}`);
        return null;
      }

      const content = await adapter.read(fullPath);

      // Parse frontmatter
      const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);

      if (!frontmatterMatch) {
        console.error(`[SkillLoader] No frontmatter found in ${skillMdPath}`);
        return null;
      }

      const frontmatterText = frontmatterMatch[1];
      const bodyContent = frontmatterMatch[2];

      // Simple YAML parsing for frontmatter
      const frontmatter = this.parseFrontmatter(frontmatterText);

      return {
        name: frontmatter.name as string,
        description: frontmatter.description as string,
        metadata: frontmatter.metadata as Record<string, unknown>,
        content: bodyContent.trim()
      };
    } catch (error) {
      console.error(`[SkillLoader] Error reading ${skillMdPath}:`, error);
      return null;
    }
  }

  /**
   * Load an executable skill
   */
  private async loadExecutableSkill(
    metadata: SkillMetadata,
    skillDirName: string,
    context: SkillContext
  ): Promise<SkillDefinition | null> {
    // Get implementation from map (compile-time imports for built-in skills)
    const impl = this.implementationMap.get(metadata.name) as { createSkill: (context: SkillContext) => { schema: import('zod').ZodTypeAny; execute: (input: unknown) => Promise<import('../skill-types').SkillResult<unknown>> } } | undefined;

    if (impl) {
      // Built-in skill: use compile-time import
      const skillImpl = impl.createSkill(context);
      return {
        name: metadata.name,
        namespace: 'obsidian',
        description: metadata.description,
        schema: skillImpl.schema,
        execute: skillImpl.execute,
        metadata: {
          version: metadata.metadata?.version || '1.0.0',
          tags: metadata.metadata?.tags || [],
          requiresConfirmation: metadata.metadata?.requiresConfirmation || false,
          documentation: metadata.content
        }
      };
    }

    // Custom skill: try loading implementation.js
    return this.loadCustomSkill(metadata, skillDirName, context);
  }

  /**
   * Load a custom skill from implementation.js
   */
  private async loadCustomSkill(
    metadata: SkillMetadata,
    skillDirName: string,
    context: SkillContext
  ): Promise<SkillDefinition | null> {
    try {
      const implPath = `${this.skillsBasePath}/${skillDirName}/implementation.js`;
      const adapter = context.vault.adapter;
      if (!(await adapter.exists(implPath))) {
        console.warn(`[SkillLoader] No implementation.js found for custom skill "${metadata.name}" at ${implPath}`);
        return null;
      }
      const code = await adapter.read(implPath);

      // Wrap user code in an execute function
      const userExecute = new Function(
        'input',
        `
          "use strict";
          ${code}
          if (typeof execute !== 'function') {
            throw new Error("implementation.js must define a function named 'execute'");
          }
          return execute(input);
        `
      );

      const wrappedExecute = async (input: unknown): Promise<SkillResult> => {
        try {
          const result = userExecute(input);
          const finalResult = result instanceof Promise ? await result : result;
          if (finalResult && typeof finalResult === 'object' && 'success' in finalResult) {
            return finalResult as SkillResult;
          }
          return { success: true, data: finalResult };
        } catch (error) {
          return {
            success: false,
            error: error instanceof Error ? error.message : String(error)
          };
        }
      };

      return {
        name: metadata.name,
        namespace: 'custom',
        description: metadata.description,
        schema: z.any(),
        execute: wrappedExecute,
        metadata: {
          version: (metadata.metadata?.version as string) || '1.0.0',
          tags: (metadata.metadata?.tags as string[]) || ['custom'],
          requiresConfirmation: (metadata.metadata?.requiresConfirmation as boolean) || false,
          documentation: metadata.content
        }
      };
    } catch (error) {
      console.error(`[SkillLoader] Failed to load custom skill "${metadata.name}":`, error);
      return null;
    }
  }

  /**
   * Load a documentation skill
   */
  private loadDocumentationSkill(metadata: SkillMetadata): DocumentationSkillDefinition {
    return {
      name: metadata.name,
      namespace: 'obsidian',
      description: metadata.description,
      content: metadata.content,
      metadata: {
        version: metadata.metadata?.version || '1.0.0',
        tags: metadata.metadata?.tags || []
      }
    };
  }

  /**
   * Simple YAML frontmatter parser
   */
  private parseFrontmatter(frontmatterText: string): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    const lines = frontmatterText.split('\n');
    let currentKey: string | null = null;
    let currentArray: unknown[] | null = null;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Detect indentation
      const leadingSpaces = line.match(/^(\s*)/)?.[1]?.length || 0;

      // Array item
      if (trimmed.startsWith('- ')) {
        const value = trimmed.substring(2).trim();
        if (currentArray) {
          currentArray.push(value);
        }
        continue;
      }

      // Key-value pair
      const colonIndex = trimmed.indexOf(':');
      if (colonIndex > 0) {
        const key = trimmed.substring(0, colonIndex).trim();
        const value = trimmed.substring(colonIndex + 1).trim();

        if (leadingSpaces === 0) {
          // Top-level key
          currentKey = key;

          if (value === '') {
            // Start of nested structure
            currentArray = [];
          } else {
            // Simple value
            result[key] = value;
            currentArray = null;
          }
        } else {
          // Nested key (inside metadata, etc.)
          if (currentKey && !currentArray) {
            if (!result[currentKey] || typeof result[currentKey] !== 'object') {
              result[currentKey] = {};
            }
            const nested = result[currentKey] as Record<string, unknown>;

            if (value === '') {
              // Start of array
              currentArray = [];
              nested[key] = currentArray;
            } else if (value.startsWith('[') && value.endsWith(']')) {
              // Inline array
              const items = value.slice(1, -1).split(',').map(s => s.trim());
              nested[key] = items;
              currentArray = null;
            } else if (value === 'true') {
              nested[key] = true;
            } else if (value === 'false') {
              nested[key] = false;
            } else {
              nested[key] = value;
            }
          }
        }
      }
    }

    return result;
  }
}


