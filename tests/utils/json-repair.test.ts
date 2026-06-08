import { describe, it, expect } from 'vitest';
import { BaseAgent } from '../../src/agents/base-agent';


describe('BaseAgent Strict JSON Parsing', () => {
  const safeParse = (BaseAgent.prototype as any).safeParseToolArguments;

  it('should successfully parse valid JSON', () => {
    const mockContext = {
      logDiagnosticIncident: () => Promise.resolve()
    };
    const toolCall = {
      id: '1',
      name: 'test',
      arguments: '{"key": "value"}'
    };
    const parsed = safeParse.call(mockContext, toolCall);
    expect(parsed).toEqual({ key: 'value' });
  });

  it('should throw an error on malformed JSON without trying recovery', () => {
    let logged = false;
    const mockContext = {
      logDiagnosticIncident: (toolName: string, originalArgs: string, errMsg: string, strategy: string) => {
        logged = true;
        expect(toolName).toBe('test');
        expect(originalArgs).toBe('{"key": "value');
        expect(strategy).toBe('Failed (Strict Parsing)');
        return Promise.resolve();
      },
      escapeLoneBackslashes: (jsonStr: string) => jsonStr
    };
    const toolCall = {
      id: '1',
      name: 'test',
      arguments: '{"key": "value'
    };
    
    expect(() => safeParse.call(mockContext, toolCall)).toThrowError(
      /Failed to parse tool call arguments for test:/
    );
    expect(logged).toBe(true);
  });

  it('should successfully heal raw LaTeX backslashes inside JSON tool arguments', () => {
    let logged = false;
    const mockContext = {
      logDiagnosticIncident: (toolName: string, originalArgs: string, errMsg: string, strategy: string) => {
        logged = true;
        expect(toolName).toBe('test');
        expect(strategy).toBe('Healed (JSON Preprocessor)');
        return Promise.resolve();
      },
      // Mock escapeLoneBackslashes since it is called on BaseAgent
      escapeLoneBackslashes: (BaseAgent.prototype as any).escapeLoneBackslashes
    };
    
    const toolCall = {
      id: '2',
      name: 'test',
      arguments: '{"content": "LaTeX formula \\lambda and \\sigma in \\mathcal{L}"}'
    };

    const parsed = safeParse.call(mockContext, toolCall);
    expect(parsed).toEqual({
      content: 'LaTeX formula \\lambda and \\sigma in \\mathcal{L}'
    });
    expect(logged).toBe(true);
  });
});
