import { describe, it, expect } from 'vitest';
import { safeParseJson } from '../../src/utils/json-healer';

describe('JSON Healer safeParseJson Parsing', () => {
  it('should successfully parse valid JSON', () => {
    const jsonStr = '{"key": "value"}';
    const parsed = safeParseJson(jsonStr);
    expect(parsed).toEqual({ key: 'value' });
  });

  it('should throw an error on malformed JSON and call onFailed callback', () => {
    let logged = false;
    const jsonStr = '{"key": "value';
    
    expect(() => safeParseJson(
      jsonStr,
      undefined,
      (errorMsg) => {
        logged = true;
      }
    )).toThrowError(/Failed to parse JSON/);
    expect(logged).toBe(true);
  });

  it('should successfully heal raw LaTeX backslashes inside JSON tool arguments and call onHealed callback', () => {
    let logged = false;
    const jsonStr = '{"content": "LaTeX formula \\lambda and \\sigma in \\mathcal{L}"}';

    const parsed = safeParseJson(
      jsonStr,
      (healedStr, errorMsg) => {
        logged = true;
      }
    );
    expect(parsed).toEqual({
      content: 'LaTeX formula \\lambda and \\sigma in \\mathcal{L}'
    });
    expect(logged).toBe(true);
  });
});
