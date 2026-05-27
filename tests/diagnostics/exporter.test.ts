import { describe, it, expect } from 'vitest';
import { DiagnosticsExporter } from '../../src/diagnostics/diagnostics-exporter';
import { ChatMessage } from '../../src/types';

describe('DiagnosticsExporter', () => {
  const generateMermaid = (DiagnosticsExporter as any).generateMermaidDiagram;
  const generateJson = (DiagnosticsExporter as any).generateJsonPayload;
  const escapeMermaid = (DiagnosticsExporter as any).escapeMermaidText;

  describe('escapeMermaidText', () => {
    it('should strip special characters and replace double quotes to avoid Mermaid parser crash', () => {
      const input = 'Read note "Daily Log" (containing special [brackets] & <arrows>)';
      const output = escapeMermaid(input);
      expect(output).toBe("Read note 'Daily Log'  containing special  brackets  &  arrows");
    });

    it('should limit string length and replace newlines', () => {
      const input = 'First line\nSecond line exceeding details limit and very long...'.repeat(5);
      const output = escapeMermaid(input);
      expect(output.length).toBeLessThanOrEqual(80);
      expect(output).not.toContain('\n');
    });
  });

  describe('generateMermaidDiagram', () => {
    it('should build a valid sequence diagram from multi-turn chat history', () => {
      const history: ChatMessage[] = [
        { role: 'user', content: 'Get tomorrow schedule', timestamp: 1000 },
        {
          role: 'assistant',
          content: 'I will list notes',
          timestamp: 2000,
          tool_calls: [
            { id: 'call_1', name: 'obsidian:list_notes', arguments: '{"folder": "Daily"}' }
          ]
        },
        {
          role: 'tool',
          content: '["Daily/2026-05-27.md"]',
          timestamp: 3000,
          tool_call_id: 'call_1',
          name: 'obsidian:list_notes'
        },
        { role: 'assistant', content: 'Tomorrow note found.', timestamp: 4000 }
      ];

      const diagram = generateMermaid(history);
      expect(diagram).toContain('sequenceDiagram');
      expect(diagram).toContain('autonumber');
      expect(diagram).toContain('User->>Agent: "Get tomorrow schedule"');
      expect(diagram).toContain('Agent->>Skill: list_notes (folder=Daily)');
      expect(diagram).toContain("Skill-->>Agent: [Success] \"'Daily/2026-05-27.md'\"");
      expect(diagram).toContain('Agent->>User: "Tomorrow note found."');
    });

    it('should cleanly unpack nested object parameters in Mermaid output', () => {
      const history: ChatMessage[] = [
        {
          role: 'assistant',
          content: 'Invoking meta tool',
          timestamp: 2000,
          tool_calls: [
            {
              id: 'call_meta',
              name: 'invoke',
              arguments: '{"skill_name": "obsidian:edit_note", "params": {"path": "Research/AI.md", "content": "Hi"}}'
            }
          ]
        }
      ];

      const diagram = generateMermaid(history);
      expect(diagram).toContain("Agent->>Skill: edit_note (params.path='AI.md')");
      expect(diagram).not.toContain('object Object');
    });
  });

  describe('generateJsonPayload', () => {
    it('should format message history into a compliant API message array', () => {
      const history: ChatMessage[] = [
        { role: 'user', content: 'Hi', timestamp: 1000 },
        {
          role: 'assistant',
          content: 'Hello',
          timestamp: 2000,
          tool_calls: [
            { id: 'call_2', name: 'obsidian:ask_user', arguments: '{"message": "Ready?"}' }
          ]
        }
      ];

      const jsonStr = generateJson(history);
      const parsed = JSON.parse(jsonStr);

      expect(parsed).toHaveLength(2);
      expect(parsed[0].role).toBe('user');
      expect(parsed[0].content).toBe('Hi');
      expect(parsed[1].role).toBe('assistant');
      expect(parsed[1].tool_calls).toHaveLength(1);
      expect(parsed[1].tool_calls[0].type).toBe('function');
      expect(parsed[1].tool_calls[0].function.name).toBe('obsidian:ask_user');
      expect(parsed[1].tool_calls[0].function.arguments).toBe('{"message": "Ready?"}');
    });
  });
});
