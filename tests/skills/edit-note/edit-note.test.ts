import { describe, it, expect } from 'vitest';
import { NoteLinter } from '../../../src/utils/note-linter';
import { getHeadingPattern, insertAfterHeading, replaceSection, exactReplaceString } from '../../../src/utils/note-manipulator';

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
