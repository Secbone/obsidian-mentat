// Skill Detail Generator - Generates detailed skill documentation

import { AnySkillDefinition, isExecutableSkill, SkillDefinition } from '../skill-types';
import zodToJsonSchema from 'zod-to-json-schema';

/**
 * Output format for skill details
 */
export type DetailFormat = 'markdown' | 'xml' | 'json';

/**
 * Generates detailed skill documentation for spec responses
 */
export class SkillDetailGenerator {
  /**
   * Generate detailed information about a skill
   */
  generateSkillDetails(skill: AnySkillDefinition, format: DetailFormat = 'markdown'): string {
    if (!isExecutableSkill(skill)) {
      return `Skill ${skill.name} is a documentation skill and cannot be executed.`;
    }

    const formatter = this.getFormatter(format);
    return formatter.format(skill);
  }

  private getFormatter(format: DetailFormat): SkillFormatter {
    switch (format) {
      case 'markdown':
        return new MarkdownFormatter();
      case 'xml':
        return new XMLFormatter();
      case 'json':
        return new JSONFormatter();
      default:
        return new MarkdownFormatter();
    }
  }
}

/**
 * Base formatter interface
 */
interface SkillFormatter {
  format(skill: SkillDefinition): string;
}

/**
 * Markdown formatter (default, most readable)
 */
class MarkdownFormatter implements SkillFormatter {
  format(skill: SkillDefinition): string {
    const fullName = `${skill.namespace}:${skill.name}`;
    let output = `# ${fullName}\n\n`;
    output += `${skill.description}\n\n`;

    // Parameters section
    output += '## Parameters\n\n';
    const schema = this.getSchemaInfo(skill);

    if (schema.properties && Object.keys(schema.properties).length > 0) {
      for (const [paramName, paramInfo] of Object.entries(schema.properties)) {
        const isRequired = schema.required?.includes(paramName) || false;
        const requiredTag = isRequired ? '**required**' : 'optional';
        const typeInfo = this.getTypeInfo(paramInfo);
        const description = (paramInfo as any).description || 'No description';

        output += `- \`${paramName}\` (${typeInfo}, ${requiredTag}): ${description}\n`;
      }
    } else {
      output += 'No parameters required.\n';
    }

    // Examples section
    if (skill.metadata?.examples && skill.metadata.examples.length > 0) {
      output += '\n## Examples\n\n';
      for (const example of skill.metadata.examples) {
        output += `**${example.description}**\n\`\`\`json\n`;
        output += JSON.stringify(example.input, null, 2);
        output += '\n```\n\n';
      }
    }

    // Additional metadata
    if (skill.metadata?.requiresConfirmation) {
      output += '\n**⚠️ Note:** This skill requires user confirmation before execution.\n';
    }

    if (skill.metadata?.tags && skill.metadata.tags.length > 0) {
      output += `\n**Tags:** ${skill.metadata.tags.join(', ')}\n`;
    }

    return output;
  }

  private getSchemaInfo(skill: SkillDefinition): any {
    const jsonSchema = zodToJsonSchema(skill.schema, { $refStrategy: 'none' }) as any;
    return jsonSchema;
  }

  private getTypeInfo(paramInfo: any): string {
    if (paramInfo.type) {
      if (paramInfo.type === 'array' && paramInfo.items) {
        const itemType = paramInfo.items.type || 'any';
        return `${itemType}[]`;
      }
      return paramInfo.type;
    }
    return 'any';
  }
}

/**
 * XML formatter (alternative format)
 */
class XMLFormatter implements SkillFormatter {
  format(skill: SkillDefinition): string {
    const fullName = `${skill.namespace}:${skill.name}`;
    const schema = zodToJsonSchema(skill.schema, { $refStrategy: 'none' }) as any;

    let output = `<skill>\n`;
    output += `  <name>${fullName}</name>\n`;
    output += `  <description>${this.escapeXml(skill.description)}</description>\n`;
    output += `  <parameters>\n`;

    if (schema.properties && Object.keys(schema.properties).length > 0) {
      for (const [paramName, paramInfo] of Object.entries(schema.properties)) {
        const isRequired = schema.required?.includes(paramName) || false;
        const typeInfo = (paramInfo as any).type || 'any';
        const description = (paramInfo as any).description || '';

        output += `    <parameter name="${paramName}" type="${typeInfo}" required="${isRequired}">\n`;
        output += `      ${this.escapeXml(description)}\n`;
        output += `    </parameter>\n`;
      }
    }

    output += `  </parameters>\n`;
    output += `</skill>\n`;

    return output;
  }

  private escapeXml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }
}

/**
 * JSON formatter (machine-readable)
 */
class JSONFormatter implements SkillFormatter {
  format(skill: SkillDefinition): string {
    const fullName = `${skill.namespace}:${skill.name}`;
    const schema = zodToJsonSchema(skill.schema, { $refStrategy: 'none' }) as any;

    const output = {
      name: fullName,
      description: skill.description,
      parameters: schema.properties || {},
      required: schema.required || [],
      examples: skill.metadata?.examples || [],
      metadata: {
        requiresConfirmation: skill.metadata?.requiresConfirmation || false,
        tags: skill.metadata?.tags || []
      }
    };

    return JSON.stringify(output, null, 2);
  }
}
