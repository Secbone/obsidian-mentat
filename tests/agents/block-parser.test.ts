import { describe, it, expect } from 'vitest';
import { BaseAgent } from '../../src/agents/base-agent';

describe('Markdown Block Tool Calling (MBTC) Parser', () => {
  // Extract private parseBlockToolCalls for unit testing
  const parseBlockToolCalls = (BaseAgent.prototype as any).parseBlockToolCalls;

  it('should successfully parse obsidian:edit_note fenced block with double quotes', () => {
    const text = `
Here is my technical explanation:

\`\`\`obsidian:edit_note path="Research/KTO.md" heading="KTO (Kahneman-Tversky)"
受前景理论启发，只需要二元反馈（好/坏），无需配对数据：
$$\\mathcal{L}_{\\text{KTO}}(\\theta) = \\mathbb{E}_{(x, y)} [ w(y) \\cdot ( 1 - \\sigma(\\beta \\cdot (z_\\theta - z_{\\text{ref}})) ) ]$$
\`\`\`

Hope this is helpful!
`;

    const mockAgent = {};
    const calls = parseBlockToolCalls.call(mockAgent, text);

    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('obsidian:edit_note');
    expect(calls[0].id).toContain('block_call_');
    expect(calls[0].arguments).toEqual({
      path: 'Research/KTO.md',
      heading: 'KTO (Kahneman-Tversky)',
      content: '受前景理论启发，只需要二元反馈（好/坏），无需配对数据：\n$$\\mathcal{L}_{\\text{KTO}}(\\theta) = \\mathbb{E}_{(x, y)} [ w(y) \\cdot ( 1 - \\sigma(\\beta \\cdot (z_\\theta - z_{\\text{ref}})) ) ]$$'
    });
  });

  it('should successfully parse obsidian:create_note fenced block with single quotes and boolean attributes', () => {
    const text = `
\`\`\`obsidian:create_note path='Research/DPO.md' overwrite='true'
### DPO (Direct Preference Optimization)
Some math formulas here.
\`\`\`
`;

    const mockAgent = {};
    const calls = parseBlockToolCalls.call(mockAgent, text);

    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('obsidian:create_note');
    expect(calls[0].arguments).toEqual({
      path: 'Research/DPO.md',
      overwrite: true, // Extracted value as boolean
      content: '### DPO (Direct Preference Optimization)\nSome math formulas here.'
    });
  });

  it('should return empty list when no valid fenced block calls exist', () => {
    const text = `
Here is a normal code block which should not be matched:
\`\`\`typescript
const a = 5;
console.log(a);
\`\`\`
`;

    const mockAgent = {};
    const calls = parseBlockToolCalls.call(mockAgent, text);
    expect(calls).toHaveLength(0);
  });
});
