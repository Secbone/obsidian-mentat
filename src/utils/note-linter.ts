// Note Linter Utility
// Performs static syntax checks on Markdown notes to ensure strict format integrity

/**
 * Linter validation result
 */
export interface LinterResult {
  isValid: boolean;
  errors: string[];
}

export class NoteLinter {
  /**
   * Statically validate the Markdown content for syntax errors
   * @param content - Markdown content to validate
   * @returns Validation result with boolean status and error details
   */
  static validate(content: string): LinterResult {
    const errors: string[] = [];

    if (!content) {
      return { isValid: true, errors: [] };
    }

    // 1. Validate YAML Frontmatter
    this.validateFrontmatter(content, errors);

    // 2. Validate Markdown Code Blocks
    this.validateCodeBlocks(content, errors);

    // 3. Validate LaTeX Equations
    this.validateLaTeX(content, errors);

    // 4. Validate Obsidian Wikilinks
    this.validateWikilinks(content, errors);

    return {
      isValid: errors.length === 0,
      errors
    };
  }

  /**
   * Validate YAML Frontmatter structure
   */
  private static validateFrontmatter(content: string, errors: string[]): void {
    const trimmed = content.trim();
    if (trimmed.startsWith('---')) {
      // Find the closing frontmatter line
      const lines = content.split('\n');
      let closingIndex = -1;

      // Start search from line index 1 to bypass opening '---'
      for (let i = 1; i < lines.length; i++) {
        if (lines[i].trim() === '---') {
          closingIndex = i;
          break;
        }
      }

      if (closingIndex === -1) {
        errors.push("YAML Frontmatter is opened with '---' at the top but never closed with a matching '---' line.");
        return;
      }

      // Basic YAML syntax check for the extracted lines
      const yamlContent = lines.slice(1, closingIndex).join('\n');
      const yamlLines = yamlContent.split('\n');
      for (let i = 0; i < yamlLines.length; i++) {
        const line = yamlLines[i].trim();
        if (!line || line.startsWith('#')) {
          continue; // Skip comments and empty lines
        }

        // Check for basic key-value structure: "key: value" or list items "- item"
        if (!line.includes(':') && !line.startsWith('-')) {
          errors.push(`YAML Frontmatter syntax error at line ${i + 2}: Line is not a valid key-value pair or list item ("${line}").`);
        }
      }
    }
  }

  /**
   * Validate that Markdown Code Blocks are balanced
   */
  private static validateCodeBlocks(content: string, errors: string[]): void {
    const lines = content.split('\n');
    let codeBlockCount = 0;
    const openLines: number[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      // Check if line starts with exactly ``` (ignoring language extension like ```python)
      if (line.startsWith('```') && !line.startsWith('````')) {
        codeBlockCount++;
        if (openLines.length > 0 && line === '```') {
          // Found closing block
          openLines.pop();
        } else {
          // Found opening block
          openLines.push(i + 1);
        }
      }
    }

    if (codeBlockCount % 2 !== 0) {
      const lastOpenLine = openLines[openLines.length - 1] || 'unknown';
      errors.push(`Markdown code block is opened with \`\`\` (line ${lastOpenLine}) but never closed.`);
    }
  }

  /**
   * Validate LaTeX equations ($ and $$)
   */
  private static validateLaTeX(content: string, errors: string[]): void {
    // A. Block Equations ($$)
    // Count unescaped $$ occurrences
    const blockRegex = /(?<!\\)\$\$/g;
    const blockMatches = content.match(blockRegex);
    if (blockMatches && blockMatches.length % 2 !== 0) {
      errors.push("LaTeX block equation '$$' is opened but never closed.");
    }

    // B. Inline Equations ($)
    // Validate inline math equations on a per-paragraph basis, ignoring currency symbols (like $100)
    const paragraphs = content.split(/\n\s*\n/);
    
    for (let pIdx = 0; pIdx < paragraphs.length; pIdx++) {
      const para = paragraphs[pIdx];
      // Skip paragraphs that contain code blocks or frontmatter
      if (para.includes('```') || para.trim().startsWith('---')) {
        continue;
      }

      // Step 1: Strip block equations first
      let stripped = para.replace(blockRegex, '');

      // Step 2: Strip standard, valid inline math equations ($...$)
      // Ensures the opening $ is not followed by space, and closing $ is not preceded by space
      const validInlineMathRegex = /(?<!\\)\$(?!\s)[^$\n]+?(?<!\s)(?<!\\)\$/g;
      stripped = stripped.replace(validInlineMathRegex, '');

      // Step 3: Strip standard currency figures (e.g. $100, $0.05)
      const currencyRegex = /(?<!\\)\$(?=\d)/g;
      stripped = stripped.replace(currencyRegex, '');

      // Step 4: Count unescaped dollar signs left in the paragraph
      const unescapedDollarRegex = /(?<!\\)\$/g;
      const remainingMatches = stripped.match(unescapedDollarRegex);

      if (remainingMatches && remainingMatches.length > 0) {
        // Find line number context
        const lines = para.split('\n');
        const firstLine = lines[0] ? lines[0].substring(0, 40) + '...' : '';
        errors.push(`LaTeX inline equation '$' is unbalanced in paragraph starting with: "${firstLine}".`);
      }
    }
  }

  /**
   * Validate Obsidian Wikilinks [[Note]]
   */
  private static validateWikilinks(content: string, errors: string[]): void {
    const openMatches = content.match(/\[\[/g) || [];
    const closeMatches = content.match(/\]\]/g) || [];

    if (openMatches.length !== closeMatches.length) {
      errors.push(`Obsidian wikilinks are unbalanced: found ${openMatches.length} opening '[[' and ${closeMatches.length} closing ']]'.`);
    }
  }
}
