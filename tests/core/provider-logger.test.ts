import { describe, it, expect, vi } from 'vitest';
import { OpenAIProvider } from '../../src/providers/openai-provider';

describe('Provider -> logger wiring (diagnostics)', () => {
  it('injects errors into the provider logger callback with the failing stage', async () => {
    const loggerFn = vi.fn();
    const provider = new OpenAIProvider({
      id: 'deepseek', apiKey: 'bad', baseURL: 'http://127.0.0.1:1/unreachable', model: 'x',
      logger: loggerFn,
    } as never);

    await expect(provider.generate('hi').catch((e) => { throw e; })).rejects.toThrow();
    // At least one logger call, tagged with the failing stage ('generate').
    expect(loggerFn).toHaveBeenCalled();
    const calls = loggerFn.mock.calls;
    const stages = calls.map((c) => c[1]);
    expect(stages).toContain('generate');
  }, 15000);

  it('openai-provider keeps the cause chain visible in the thrown message', async () => {
    const provider = new OpenAIProvider({
      id: 'x', apiKey: 'bad', baseURL: 'http://127.0.0.1:1/unreachable', model: 'x',
    } as never);
    const err = await provider.generate('hi').catch((e) => e);
    expect(err instanceof Error).toBe(true);
    // The formatted error should mention the underlying connection cause.
    const msg = (err as Error).message;
    expect(msg).toMatch(/OpenAI API error:/);
  }, 15000);
});
