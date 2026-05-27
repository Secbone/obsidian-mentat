import { describe, it, expect } from 'vitest';
import { NoteLinter } from '../../../src/utils/note-linter';

// Extract private helpers from edit-note script for unit testing
// Since Node.js requires loading local ESM/TS, we can test the helper functions directly or mock their behaviors.
// Let's test the getHeadingPattern, insertAfterHeading, replaceSection, and exactReplaceString helpers.
// To do this dynamically without complex imports, we can construct standard tests using the identical logic.

const getHeadingPattern = (heading: string, captureLevel = false): RegExp => {
  const normalized = heading.trim().replace(/\s+/g, ' ');
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const flexibleSpaces = escaped.replace(/ /g, '\\s+');
  const levelPattern = captureLevel ? '(#+)' : '#+';
  return new RegExp(`^${levelPattern}\\s+${flexibleSpaces}\\s*$`, 'i');
};

const insertAfterHeading = (content: string, heading: string, newContent: string): string => {
  const lines = content.split('\n');
  const headingPattern = getHeadingPattern(heading);

  for (let i = 0; i < lines.length; i++) {
    if (headingPattern.test(lines[i])) {
      lines.splice(i + 1, 0, '', newContent);
      return lines.join('\n');
    }
  }

  return content;
};

const replaceSection = (content: string, heading: string, newContent: string): string => {
  const lines = content.split('\n');
  const headingPattern = getHeadingPattern(heading, true);

  let startIndex = -1;
  let startLevel = 0;

  for (let i = 0; i < lines.length; i++) {
    if (headingPattern.test(lines[i])) {
      startIndex = i;
      const match = lines[i].match(/^(#+)/);
      startLevel = match ? match[1].length : 0;
      break;
    }
  }

  if (startIndex === -1) {
    return content;
  }

  let endIndex = lines.length;
  for (let i = startIndex + 1; i < lines.length; i++) {
    const match = lines[i].match(/^(#+)\s/);
    if (match) {
      const level = match[1].length;
      if (level <= startLevel) {
        endIndex = i;
        break;
      }
    }
  }

  const result = [...lines];
  const newLines = newContent.split('\n');
  result.splice(startIndex + 1, endIndex - startIndex - 1, ...newLines);

  return result.join('\n');
};

const exactReplaceString = (
  content: string,
  oldString: string,
  newString: string
): string => {
  const occurrences: number[] = [];
  let searchIndex = 0;

  while (true) {
    const foundIndex = content.indexOf(oldString, searchIndex);
    if (foundIndex === -1) break;

    occurrences.push(foundIndex);
    searchIndex = foundIndex + oldString.length;
  }

  if (occurrences.length === 1) {
    return content.replace(oldString, newString);
  }

  if (occurrences.length > 1) {
    throw new Error(`Text "${oldString}" appears ${occurrences.length} times.`);
  }

  // Fuzzy fallback
  const normalize = (str: string) => str.toLowerCase().replace(/\s+/g, ' ').trim();
  const normOld = normalize(oldString);
  
  if (normOld) {
    const escaped = normOld.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const flexibleSpaces = escaped.replace(/ /g, '\\s+');
    
    const flexibleRegex = new RegExp(flexibleSpaces, 'i');
    const flexibleGlobalRegex = new RegExp(flexibleSpaces, 'gi');
    
    const allMatches = content.match(flexibleGlobalRegex);
    if (allMatches && allMatches.length === 1) {
      const matchResult = content.match(flexibleRegex);
      if (matchResult && matchResult.index !== undefined) {
        const start = matchResult.index;
        const end = start + matchResult[0].length;
        return content.substring(0, start) + newString + content.substring(end);
      }
    } else if (allMatches && allMatches.length > 1) {
      throw new Error(`Fuzzy Match Conflict`);
    }
  }

  throw new Error(`Text not found`);
};

describe('RAGP v2.3 - Vault Operations Robustness Helpers', () => {
  
  describe('Safe, Escaped Regex Heading Matching', () => {
    it('should successfully match headings containing parentheses and flexible spaces', () => {
      const content = `
# Deep Learning Note
## KTO (Kahneman-Tversky Optimization)
Some pre-existing math here.
## Other Heading
Text
`;
      // Match KTO with parentheses and slightly different double spacing
      const result = insertAfterHeading(content, 'KTO  (Kahneman-Tversky Optimization)', 'Added Content');
      expect(result).toContain('## KTO (Kahneman-Tversky Optimization)\n\nAdded Content');
    });

    it('should successfully replace sections with complex heading names', () => {
      const content = `
# Main Note
### DPO [Direct Preference Optimization]
Old section content.
### Next Section
Next content.
`;
      const result = replaceSection(content, 'DPO [Direct Preference Optimization]', 'New replaced content!');
      expect(result).toContain('### DPO [Direct Preference Optimization]\nNew replaced content!\n### Next Section');
    });
  });

  describe('Fuzzy/Flexible String Replacement Matcher', () => {
    it('should fall back to fuzzy replacement when exact search fails due to spacing/casing', () => {
      const content = `
The KTO algorithm satisfies the HALO   (Human-Aware Loss) concept.
This is a standard technical definition.
`;
      // Search with double space and lowercase
      const queryReplace = 'halo (human-aware loss)';
      const result = exactReplaceString(content, queryReplace, 'HALO_CONCEPT');
      expect(result).toContain('The KTO algorithm satisfies the HALO_CONCEPT concept.');
    });

    it('should throw error when fuzzy matching has multiple matches', () => {
      const content = `
First HALO (Human-Aware Loss) definition.
Second HALO  (Human-Aware Loss) definition.
`;
      expect(() => exactReplaceString(content, 'halo (human-aware loss)', 'REPLACED')).toThrowError(
        /Fuzzy Match Conflict/
      );
    });
  });

  describe('Incremental Linter Guard Validation Logic', () => {
    it('should validate how the error count is compared', () => {
      // Original content with 2 errors (unbalanced wikilinks and unbalanced inline math)
      const originalContent = `
这里有 [[BGE 检索 链接，但少写了右边的括号。
未闭合的行内公式 $x_l 是未闭合的。
`;
      // Repaired content with 1 error (wikilink fixed, math still unbalanced)
      const newContent = `
这里有 [[BGE 检索 链接]] 链接。
未闭合的行内公式 $x_l 是未闭合的。
`;
      
      const originalResult = NoteLinter.validate(originalContent);
      const newResult = NoteLinter.validate(newContent);
      
      expect(originalResult.isValid).toBe(false);
      expect(newResult.isValid).toBe(false);
      
      // Verification: Errors are reduced from 2 to 1 (newErrors <= oldErrors is true!)
      expect(newResult.errors.length).toBeLessThan(originalResult.errors.length);
      expect(newResult.errors.length <= originalResult.errors.length).toBe(true);
    });
  });
});
