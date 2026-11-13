// Skill Loader
// Loads all skills from the skills/ directory according to Agent Skills specification

import { z } from 'zod';
import { App, parseYaml } from 'obsidian';
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

const skillManifestSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string().trim().min(1),
  metadata: z.object({
    version: z.string().optional(),
    author: z.string().optional(),
    tags: z.array(z.string()).optional(),
    executable: z.boolean().optional(),
    implementation: z.string().optional(),
    requiresConfirmation: z.boolean().optional(),
  }).passthrough().nullish().transform(value => value ?? undefined),
}).passthrough();

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
    pluginId: string = 'mentat'
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
  async loadAllSkills(context: SkillContext, options: { strict?: boolean } = {}): Promise<AnySkillDefinition[]> {
    const skills: AnySkillDefinition[] = [];

    try {
      // Get skill directories
      const skillDirs = await this.scanSkillDirectories(!!options.strict);

      console.log(`[SkillLoader] Found ${skillDirs.length} skill directories:`, skillDirs);

      // Load each skill
      for (const skillDir of skillDirs) {
        try {
          const skill = await this.loadSkill(skillDir, context);
          if (!skill && options.strict) throw new Error(`Cannot load skill: ${skillDir}`);
          if (skill) {
            skills.push(skill);
            console.log(`[SkillLoader] Loaded skill: ${skill.name}`);
          }
        } catch (error) {
          console.error(`[SkillLoader] Failed to load skill from ${skillDir}:`, error);
          if (options.strict) throw error;
        }
      }

      console.log(`[SkillLoader] Successfully loaded ${skills.length} skills`);
      return skills;
    } catch (error) {
      console.error('[SkillLoader] Error loading skills:', error);
      if (options.strict) throw error;
      return [];
    }
  }

  /**
   * Scan skills directory for skill subdirectories
   */
  private async scanSkillDirectories(strict = false): Promise<string[]> {
    const adapter = this.app.vault.adapter;

    try {
      const skillsPath = this.skillsBasePath;
      if (!(await adapter.exists(skillsPath))) {
        if (strict) throw new Error(`Skills directory not found: ${skillsPath}`);
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
      if (strict) throw error;
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
      const frontmatterMatch = /^\uFEFF?---[ \t]*\r?\n/.test(content)
        ? content.match(/^\uFEFF?---[ \t]*\r?\n([\s\S]*?)^---[ \t]*(?:\r?\n|$)([\s\S]*)$/m) : null;

      if (!frontmatterMatch) {
        console.error(`[SkillLoader] No frontmatter found in ${skillMdPath}`);
        return null;
      }

      const frontmatterText = frontmatterMatch[1];
      const bodyContent = frontmatterMatch[2];

      const frontmatter = skillManifestSchema.parse(parseYaml(frontmatterText));

      return {
        name: frontmatter.name,
        description: frontmatter.description,
        metadata: frontmatter.metadata,
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
    const impl = this.implementationMap.get(metadata.name) as { metadata?: SkillDefinition['metadata']; schema?: import('zod').ZodTypeAny; execute?: (input: unknown, context: SkillContext) => Promise<SkillResult>; createSkill?: (context: SkillContext) => { schema: import('zod').ZodTypeAny; execute: (input: unknown) => Promise<SkillResult> } } | undefined;

    if (impl) {
      // Built-in skill: use compile-time import
      const skillImpl = impl.createSkill?.(context);
      return {
        name: metadata.name,
        namespace: 'obsidian',
        description: metadata.description,
        schema: skillImpl?.schema || impl.schema!,
        execute: (input, options) => {
          const runContext = { ...context, abortSignal: options?.abortSignal, runtime: options?.runtime, operationId: options?.operationId };
          return impl.createSkill ? impl.createSkill(runContext).execute(input) : impl.execute!(input, runContext);
        },
        metadata: {
          ...impl.metadata,
          version: metadata.metadata?.version || '1.0.0',
          tags: metadata.metadata?.tags || [],
          requiresConfirmation: metadata.metadata?.requiresConfirmation ?? impl.metadata?.requiresConfirmation ?? false,
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
          requiresConfirmation: metadata.metadata?.requiresConfirmation ?? true,
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

}
