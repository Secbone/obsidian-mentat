import { describe, it, expect } from 'vitest';
import { Context } from '../../src/core/cordis';
describe('construct probe', () => {
  it('constructs Context', () => {
    const ctx = new Context();
    expect(ctx).toBeTruthy();
  });
  it('provide/get', () => {
    const ctx = new Context();
    ctx.provide('a', 1);
    expect(ctx.get('a')).toBe(1);
  });
});
