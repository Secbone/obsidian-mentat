import { describe, it, expect, vi } from 'vitest';
import { Context } from '../../src/core/cordis';
import { ExtensionManager, EventBus } from '../../src/extensions';
import { SkillRegistry } from '../../src/skills/core/skill-registry';
import { SkillExecutor } from '../../src/skills/core/skill-executor';
import type { SkillContext } from '../../src/skills/skill-types';
import { DEFAULT_SETTINGS } from '../../src/settings/settings';

function createFakeDeps() {
  const skillContext = { plugin: {} } as unknown as SkillContext;
  const skillRegistry = new SkillRegistry();
  const skillExecutor = new SkillExecutor(skillRegistry, skillContext);
  const eventBus = new EventBus();
  return { skillRegistry, skillExecutor, eventBus, settings: structuredClone(DEFAULT_SETTINGS) };
}

describe('Cleanup audit (M5)', () => {
  it('unloadAll runs extension factory cleanup disposers', async () => {
    const { skillRegistry, skillExecutor, eventBus, settings } = createFakeDeps();
    const em = new ExtensionManager({} as never, skillRegistry, skillExecutor, settings, eventBus);

    const cleanup = vi.fn();
    em.register({
      id: 'mock-ext',
      name: 'Mock',
      description: '',
      factory: () => cleanup,
    });
    await em.loadAll();

    expect(em.hasLoaded('mock-ext')).toBe(true);
    em.unloadAll();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('unloading the context recovers the extensions service (incl. extensions)', async () => {
    const ctx = new Context();
    const { skillRegistry, skillExecutor, eventBus, settings } = createFakeDeps();

    // Mount a minimal chat stand-in + the extensions service.
    ctx.provide('chat', {
      getSkillRegistry: () => skillRegistry,
      getSkillExecutor: () => skillExecutor,
    } as never);
    ctx.provide('settings', settings);
    ctx.provide('eventBus', eventBus);
    ctx.provide('mentatPlugin', { app: {} });

    const { ExtensionsService } = await import('../../src/extensions/extensions.service');
    await ctx.plugin(ExtensionsService);
    const em = ctx.get<ExtensionManager>('extensions', false)!;
    const cleanup = vi.fn();
    em.register({ id: 'e2', name: 'E2', description: '', factory: () => cleanup });
    await em.loadAll();
    expect(em.hasLoaded('e2')).toBe(true);

    await ctx.fiber.dispose();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(ctx.get('extensions', false)).toBeUndefined();
  });
});
