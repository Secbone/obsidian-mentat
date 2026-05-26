import { describe, it, expect } from 'vitest';
import { BaseAgent } from '../../src/agents/base-agent';

describe('JSON Repair Scanner & Truncation Self-Healing', () => {
  const repair = (BaseAgent.prototype as any).repairTruncatedJson;

  it('should successfully repair simple unterminated string inside object', () => {
    const truncated = '{"query": "machine learning';
    const repaired = repair(truncated);
    expect(repaired).toBe('{"query": "machine learning"}');
    expect(JSON.parse(repaired)).toEqual({ query: 'machine learning' });
  });

  it('should successfully repair nested objects truncated inside string value', () => {
    const truncated = '{"skill_name": "invoke", "params": {"content": "Hello world';
    const repaired = repair(truncated);
    expect(repaired).toBe('{"skill_name": "invoke", "params": {"content": "Hello world"}}');
    expect(JSON.parse(repaired)).toEqual({
      skill_name: 'invoke',
      params: { content: 'Hello world' }
    });
  });

  it('should successfully repair truncated arrays', () => {
    const truncated = '{"items": ["apple", "banana';
    const repaired = repair(truncated);
    expect(repaired).toBe('{"items": ["apple", "banana"]}');
    expect(JSON.parse(repaired)).toEqual({ items: ['apple', 'banana'] });
  });

  it('should handle escape backslashes gracefully at truncation boundary', () => {
    // Case 1: Trailing single backslash (escaped state, should slice off)
    const truncated1 = '{"path": "Folder\\';
    const repaired1 = repair(truncated1);
    expect(repaired1).toBe('{"path": "Folder"}');
    expect(JSON.parse(repaired1)).toEqual({ path: 'Folder' });

    // Case 2: Trailing double backslashes (literal backslash, should terminate string)
    const truncated2 = '{"path": "Folder\\\\';
    const repaired2 = repair(truncated2);
    expect(repaired2).toBe('{"path": "Folder\\\\"}');
    expect(JSON.parse(repaired2)).toEqual({ path: 'Folder\\' });
  });
});
