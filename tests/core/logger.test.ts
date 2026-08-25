import { describe, it, expect, vi } from 'vitest';
import { Context } from '../../src/core/cordis';
import { LoggerService, LoggerServicePlugin } from '../../src/logger/logger.service';
import { FileLogSink } from '../../src/logger/file-sink';
import type { LogMessage } from '../../src/logger/logger.service';

describe('LoggerService (exporter architecture)', () => {
  it('provides a named logger; error expands the cause chain', async () => {
    const ctx = new Context();
    await ctx.plugin(LoggerServicePlugin);
    const logger = ctx.get<LoggerService>('logger', false)!;
    const seen: LogMessage[] = [];
    logger.addExporter({ name: 'test', export: (m) => seen.push(m) });

    const err = new Error('Connection error.');
    (err as { cause?: unknown }).cause = new Error('connect ECONNREFUSED 1.2.3.4:443');
    logger.get('provider:deepseek').error(err);

    const msg = seen.find((m) => m.level === 'error')!;
    expect(msg).toBeTruthy();
    expect(msg.name).toBe('provider:deepseek');
    expect(msg.errorChain).toContain('ECONNREFUSED');
    expect(msg.errorChain).toContain('Connection error.');
  });

  it('honors per-name level overrides', () => {
    const logger = new LoggerService(new Context());
    const seen: string[] = [];
    logger.addExporter({ name: 'sink', levels: { 'provider:deepseek': 0 }, export: (m) => seen.push(m.level) });

    // provider:deepseek limited to error only -> debug is dropped.
    logger.get('provider:deepseek').debug('hidden');
    logger.get('provider:deepseek').error('shown');
    expect(seen).toEqual(['error']);
  });

  it('default ring buffer retains recent messages and supports filtering', () => {
    const ctx = new Context();
    const logger = new LoggerService(ctx);
    logger.get('a').info('one');
    logger.get('b').warn('two');
    const recent = logger.recent({ level: 'warn' });
    expect(recent.length).toBe(1);
    expect(recent[0].name).toBe('b');
    expect(recent[0].level).toBe('warn');
  });

  it('FileLogSink appends JSONL per day', async () => {
    const append = vi.fn(async () => {});
    const sink = new FileLogSink({ dir: '/cfg/.mentat/logs', append, staticContext: { plugin: 'mentat' } });
    await sink.export({ ts: Date.now(), iso: new Date().toISOString(), sn: 1, level: 'error', name: 'provider:x', args: ['boom'], context: { providerId: 'x' }, errorChain: 'boom ← root' } as never);
    expect(append).toHaveBeenCalledTimes(1);
    const [path, data] = append.mock.calls[0] as [string, string];
    expect(path).toMatch(/mentat-\d{4}-\d{2}-\d{2}\.jsonl/);
    const parsed = JSON.parse(data.trim());
    expect(parsed.level).toBe('error');
    expect(parsed.context.providerId).toBe('x');
    expect(parsed.errorChain).toContain('root');
  });
});
