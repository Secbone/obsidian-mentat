// Skill Registry - Centralized management of all skills

import zodToJsonSchema from 'zod-to-json-schema';
import {
  SkillDefinition,
  DocumentationSkillDefinition,
  AnySkillDefinition,
  OpenAIFunction,
  AnthropicTool,
  SkillNamespace,
  isDocumentationSkill,
  isExecutableSkill
} from '../skill-types';
import { SkillListGenerator } from '../generators/skill-list-generator';
import { SkillDetailGenerator } from '../generators/skill-detail-generator';

/**
 * SkillRegistry manages all registered skills and provides format conversion
 */
export class SkillRegistry {
  private skills: Map<string, AnySkillDefinition> = new Map();

  /**
   * Register a skill
   */
  register(skill: SkillDefinition): void {
    const fullName = this.getFullName(skill.namespace, skill.name);

    if (this.skills.has(fullName)) {
      console.warn(`[SkillRegistry] Overwriting existing skill: ${fullName}`);
    }

    this.skills.set(fullName, skill);
    console.log(`[SkillRegistry] Registered skill: ${fullName}`);
  }

  /**
   * Register multiple skills
   */
  registerBulk(skills: SkillDefinition[]): void {
    skills.forEach(skill => this.register(skill));
  }

  /**
   * Register a documentation skill
   */
  registerDocumentation(skill: DocumentationSkillDefinition): void {
    const fullName = this.getFullName(skill.namespace, skill.name);

    if (this.skills.has(fullName)) {
      console.warn(`[SkillRegistry] Overwriting existing skill: ${fullName}`);
    }

    this.skills.set(fullName, skill);
    console.log(`[SkillRegistry] Registered documentation skill: ${fullName}`);
  }

  /**
   * Register multiple documentation skills
   */
  registerDocumentationBulk(skills: DocumentationSkillDefinition[]): void {
    skills.forEach(skill => this.registerDocumentation(skill));
  }

  /**
   * Unregister a skill
   */
  unregister(namespace: SkillNamespace, name: string): boolean {
    const fullName = this.getFullName(namespace, name);
    const deleted = this.skills.delete(fullName);

    if (deleted) {
      console.log(`[SkillRegistry] Unregistered skill: ${fullName}`);
    }

    return deleted;
  }

  /**
   * Get a skill by full name or namespace + name
   */
  get(namespaceOrFullName: string, name?: string): AnySkillDefinition | undefined {
    if (name) {
      // Called with (namespace, name)
      const fullName = this.getFullName(namespaceOrFullName as SkillNamespace, name);
      return this.skills.get(fullName);
    } else {
      // Called with full name like "obsidian:query_notes"
      return this.skills.get(namespaceOrFullName);
    }
  }

  /**
   * Get all skills
   */
  getAll(): AnySkillDefinition[] {
    return Array.from(this.skills.values());
  }

  /**
   * Get skills by namespace
   */
  getByNamespace(namespace: SkillNamespace): AnySkillDefinition[] {
    return Array.from(this.skills.values()).filter(
      skill => skill.namespace === namespace
    );
  }

  /**
   * Check if a skill exists
   */
  has(namespace: SkillNamespace, name: string): boolean {
    return this.skills.has(this.getFullName(namespace, name));
  }

  /**
   * Get full skill name (namespace:name)
   */
  getFullName(namespace: SkillNamespace | (string & NonNullable<unknown>), name: string): string {
    return `${namespace}:${name}`;
  }

  /**
   * Parse full skill name into namespace and name
   */
  parseName(fullName: string): { namespace: string; name: string } {
    const parts = fullName.split(':');
    if (parts.length < 2) {
      throw new Error(`Invalid skill name format: ${fullName}`);
    }

    return {
      namespace: parts[0],
      name: parts.slice(1).join(':') // Handle names with colons (e.g., mcp:server:tool)
    };
  }

  /**
   * Convert all skills to OpenAI Functions format
   * Only converts executable skills, not documentation skills
   */
  toOpenAIFunctions(): OpenAIFunction[] {
    return this.getAll()
      .filter(isExecutableSkill)
      .map(skill => this.skillToOpenAIFunction(skill));
  }

  /**
   * Convert all skills to Anthropic Tools format
   * Only converts executable skills, not documentation skills
   */
  toAnthropicTools(): AnthropicTool[] {
    return this.getAll()
      .filter(isExecutableSkill)
      .map(skill => this.skillToAnthropicTool(skill));
  }

  /**
   * Convert a single skill to OpenAI Function format
   */
  skillToOpenAIFunction(skill: SkillDefinition): OpenAIFunction {
    const jsonSchema = zodToJsonSchema(skill.schema as any, {
      $refStrategy: 'none'
    }) as any;

    return {
      name: this.getFullName(skill.namespace, skill.name),
      description: skill.description,
      parameters: {
        type: 'object',
        properties: jsonSchema.properties || {},
        required: jsonSchema.required || []
      }
    };
  }

  /**
   * Convert a single skill to Anthropic Tool format
   */
  skillToAnthropicTool(skill: SkillDefinition): AnthropicTool {
    const jsonSchema = zodToJsonSchema(skill.schema as any, {
      $refStrategy: 'none'
    }) as any;

    return {
      name: this.getFullName(skill.namespace, skill.name),
      description: skill.description,
      input_schema: {
        type: 'object',
        properties: jsonSchema.properties || {},
        required: jsonSchema.required || []
      }
    };
  }

  /**
   * Get registry statistics
   */
  getStats(): {
    total: number;
    byNamespace: Record<string, number>;
  } {
    const skills = this.getAll();
    const byNamespace: Record<string, number> = {};

    skills.forEach(skill => {
      byNamespace[skill.namespace] = (byNamespace[skill.namespace] || 0) + 1;
    });

    return {
      total: skills.length,
      byNamespace
    };
  }

  /**
   * Clear all skills
   */
  clear(): void {
    this.skills.clear();
    console.log('[SkillRegistry] Cleared all skills');
  }

  /**
   * Get all documentation skills content for system prompt
   */
  getDocumentationContent(): string {
    const docSkills = this.getAll().filter(isDocumentationSkill);

    if (docSkills.length === 0) {
      return '';
    }

    let content = '\n\n## AVAILABLE DOCUMENTATION\n\n';
    content += 'The following documentation is available to help you:\n\n';

    for (const skill of docSkills) {
      content += `### ${skill.name}\n`;
      content += `${skill.description}\n\n`;
      content += `${skill.content}\n\n`;
      content += '---\n\n';
    }

    return content;
  }

  /**
   * Filter skills by metadata tags
   */
  filterByTags(tags: string[]): AnySkillDefinition[] {
    return this.getAll().filter(skill => {
      const skillTags = skill.metadata?.tags || [];
      return tags.some(tag => skillTags.includes(tag));
    });
  }

  /**
   * Search skills by description
   */
  search(query: string): AnySkillDefinition[] {
    const lowerQuery = query.toLowerCase();
    return this.getAll().filter(skill => {
      return (
        skill.name.toLowerCase().includes(lowerQuery) ||
        skill.description.toLowerCase().includes(lowerQuery)
      );
    });
  }

  /**
   * Get a concise skill list (for progressive disclosure)
   * Returns only skill names and brief descriptions
   */
  getSkillList(): string {
    const generator = new SkillListGenerator();
    return generator.generateSkillList(this.getAll());
  }

  /**
   * Get detailed information about a specific skill
   * Used by spec meta-tool
   */
  getSkillDetails(skillName: string, format: 'markdown' | 'xml' | 'json' = 'markdown'): string {
    const skill = this.get(skillName);

    if (!skill) {
      return `Error: Skill "${skillName}" not found. Use the skill list to see available skills.`;
    }

    const generator = new SkillDetailGenerator();
    return generator.generateSkillDetails(skill, format);
  }

  /**
   * Discover new skills dynamically (e.g., from MCP servers, plugins)
   * Returns newly discovered skills
   */
  async discoverSkills(pattern?: string): Promise<AnySkillDefinition[]> {
    // TODO: Implement dynamic skill discovery
    // This is a placeholder for future implementation
    // 1. Scan MCP servers
    // 2. Scan plugin directories
    // 3. Register new skills
    // 4. Return newly discovered skills

    console.log('[SkillRegistry] Dynamic skill discovery not yet implemented');
    return [];
  }
}
