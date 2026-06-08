import { describe, it, expect } from 'vitest';
import { AgentManager } from '../../src/agents/agent-manager';
import { BaseAgent } from '../../src/agents/base-agent';

describe('AgentManager Unit Tests', () => {
  it('should support agent registration and lookup', () => {
    const manager = new AgentManager();
    const mockAgent = {
      getId: () => 'agent-1',
      getName: () => 'Agent One',
    } as any as BaseAgent;

    expect(manager.getAgent('agent-1')).toBeUndefined();

    manager.registerAgent(mockAgent);
    expect(manager.getAgent('agent-1')).toBe(mockAgent);

    manager.unregisterAgent('agent-1');
    expect(manager.getAgent('agent-1')).toBeUndefined();
  });

  it('should manage current active agent selection', () => {
    const manager = new AgentManager();
    const mockAgent1 = {
      getId: () => 'agent-1',
      getName: () => 'Agent One',
    } as any as BaseAgent;
    const mockAgent2 = {
      getId: () => 'agent-2',
      getName: () => 'Agent Two',
    } as any as BaseAgent;

    manager.registerAgent(mockAgent1);
    manager.registerAgent(mockAgent2);

    expect(manager.getCurrentAgent()).toBeNull();

    manager.setCurrentAgent('agent-1');
    expect(manager.getCurrentAgent()).toBe(mockAgent1);

    manager.setCurrentAgent('agent-2');
    expect(manager.getCurrentAgent()).toBe(mockAgent2);
  });

  it('should throw error when setting current agent to unregistered ID', () => {
    const manager = new AgentManager();
    expect(() => manager.setCurrentAgent('non-existent')).toThrowError(/Agent not found: non-existent/);
  });

  it('should delegate execution to current active agent', async () => {
    const manager = new AgentManager();
    let executed = false;
    const mockAgent = {
      getId: () => 'agent-1',
      execute: async function* (prompt: string, context: any) {
        executed = true;
        yield { type: 'chunk', text: 'response' };
        return { content: 'response', messages: [] };
      }
    } as any as BaseAgent;

    manager.registerAgent(mockAgent);
    manager.setCurrentAgent('agent-1');

    const generator = manager.executeWithCurrentAgent('hello', {} as any);
    const events = [];
    for await (const event of generator) {
      events.push(event);
    }

    expect(executed).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('chunk');
  });
});
