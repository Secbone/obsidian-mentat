// Skill List Generator - Generates concise skill lists for system prompts

import { AnySkillDefinition, isExecutableSkill } from '../skill-types';

/**
 * Generates concise skill lists for progressive disclosure
 */
export class SkillListGenerator {
  /**
   * Generate a concise skill list with only names and brief descriptions
   * Designed to minimize token usage in system prompts
   */
  generateSkillList(skills: AnySkillDefinition[]): string {
    // Filter to only executable skills (exclude documentation skills)
    const executableSkills = skills.filter(isExecutableSkill);

    if (executableSkills.length === 0) {
      return '(No skills available)\n';
    }

    let list = '';
    for (const skill of executableSkills) {
      const fullName = `${skill.namespace}:${skill.name}`;
      const summary = this.formatSkillSummary(skill);
      list += `- \`${fullName}\` - ${summary}\n`;
    }

    return list;
  }

  /**
   * Format a single skill as a one-line summary
   * Extracts the first sentence or truncates to ~80 characters
   */
  formatSkillSummary(skill: AnySkillDefinition): string {
    const description = skill.description.trim();

    // Extract first sentence
    const firstSentence = description.split(/[.!?]\s/)[0];

    // If first sentence is too long, truncate
    if (firstSentence.length > 100) {
      return firstSentence.substring(0, 97) + '...';
    }

    // Add period if missing
    if (!firstSentence.match(/[.!?]$/)) {
      return firstSentence + '.';
    }

    return firstSentence;
  }

  /**
   * Generate a grouped skill list organized by namespace
   */
  generateGroupedSkillList(skills: AnySkillDefinition[]): string {
    const executableSkills = skills.filter(isExecutableSkill);

    if (executableSkills.length === 0) {
      return '(No skills available)\n';
    }

    // Group by namespace
    const grouped = new Map<string, AnySkillDefinition[]>();
    for (const skill of executableSkills) {
      const namespace = skill.namespace;
      if (!grouped.has(namespace)) {
        grouped.set(namespace, []);
      }
      grouped.get(namespace)!.push(skill);
    }

    // Format grouped list
    let list = '';
    for (const [namespace, namespaceSkills] of grouped.entries()) {
      list += `\n**${namespace}:**\n`;
      for (const skill of namespaceSkills) {
        const fullName = `${skill.namespace}:${skill.name}`;
        const summary = this.formatSkillSummary(skill);
        list += `  - \`${fullName}\` - ${summary}\n`;
      }
    }

    return list;
  }

  /**
   * Generate a compact skill list (just names, no descriptions)
   * Useful when token budget is extremely tight
   */
  generateCompactSkillList(skills: AnySkillDefinition[]): string {
    const executableSkills = skills.filter(isExecutableSkill);

    if (executableSkills.length === 0) {
      return '(No skills available)\n';
    }

    const skillNames = executableSkills.map(s => `${s.namespace}:${s.name}`);
    return skillNames.map(name => `- \`${name}\``).join('\n') + '\n';
  }
}
