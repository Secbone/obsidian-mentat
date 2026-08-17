// ExtensionManager - Register and manage extensions

import { App } from 'obsidian';
import { EventBus } from './event-bus';
import { ExtensionRegistration, ExtensionAPI } from './extension-api';
import { SkillRegistry } from '../skills/core/skill-registry';
import { SkillExecutor } from '../skills/core/skill-executor';
import { MentatSettings } from '../settings/settings';
import { SkillNamespace } from '../skills/skill-types';

export { EventBus } from './event-bus';
export type { EventHandler } from './event-bus';
export type { ExtensionAPI, ExtensionFactory, ExtensionContext, ExtensionRegistration } from './extension-api';

export class ExtensionManager {
  private extensions = new Map<string, ExtensionRegistration>();
  private loadedInstances = new Map<string, ExtensionAPI>();
  /** Cleanup disposers returned by extension factories (recovered on unload). */
  private disposers = new Map<string, () => void>();
  readonly eventBus = new EventBus();

  constructor(
    private app: App,
    private skillRegistry: SkillRegistry,
    private skillExecutor: SkillExecutor,
    private settings: MentatSettings,
    eventBus?: EventBus,
  ) {
    if (eventBus) this.eventBus = eventBus;
  }

  /**
   * Register an extension (does not load it — call loadAll() to activate).
   */
  register(registration: ExtensionRegistration): void {
    if (this.extensions.has(registration.id)) {
      console.warn(`[ExtensionManager] Overwriting extension: ${registration.id}`);
    }
    this.extensions.set(registration.id, registration);
  }

  /**
   * Unregister an extension and unload it if active.
   */
  unregister(id: string): void {
    this.unloadExtension(id);
    this.extensions.delete(id);
  }

  /**
   * Load all registered extensions that are not yet loaded.
   */
  async loadAll(): Promise<void> {
    for (const [id, reg] of this.extensions) {
      if (!this.loadedInstances.has(id)) {
        await this.loadExtension(reg);
      }
    }
  }

  /**
   * Unload all loaded extensions.
   */
  unloadAll(): void {
    for (const id of this.loadedInstances.keys()) {
      this.unloadExtension(id);
    }
  }

  /** Whether an extension instance is currently loaded. */
  hasLoaded(id: string): boolean {
    return this.loadedInstances.has(id);
  }

  /**
   * Get the event bus (for host code to emit events).
   */
  getEventBus(): EventBus {
    return this.eventBus;
  }

  /**
   * Get list of registered extension IDs.
   */
  list(): Array<{ id: string; name: string; description: string }> {
    return Array.from(this.extensions.values()).map(r => ({
      id: r.id,
      name: r.name,
      description: r.description,
    }));
  }

  private async loadExtension(reg: ExtensionRegistration): Promise<void> {
    const api: ExtensionAPI = {
      context: {
        id: reg.id,
        name: reg.name,
        description: reg.description,
      },
      registerSkill: (skill) => {
        this.skillRegistry.register(skill);
      },
      unregisterSkill: (namespace, name) => {
        this.skillRegistry.unregister(namespace as SkillNamespace, name);
      },
      on: (event, handler) => this.eventBus.on(event, handler),
      getSkillRegistry: () => this.skillRegistry,
      getSkillExecutor: () => this.skillExecutor,
      getSettings: () => this.settings,
      getApp: () => this.app,
    };

    try {
      const result = await reg.factory(api);
      if (typeof result === 'function') this.disposers.set(reg.id, result as () => void);
      this.loadedInstances.set(reg.id, api);
      console.log(`[ExtensionManager] Loaded extension: ${reg.id} (${reg.name})`);
    } catch (error) {
      console.error(`[ExtensionManager] Failed to load extension ${reg.id}:`, error);
    }
  }

  private unloadExtension(id: string): void {
    // Run the extension's cleanup disposer (revertible-effect discipline).
    const dispose = this.disposers.get(id);
    if (dispose) {
      try {
        dispose();
      } catch (error) {
        console.error(`[ExtensionManager] Extension ${id} dispose error:`, error);
      }
      this.disposers.delete(id);
    }
    this.loadedInstances.delete(id);
  }
}
