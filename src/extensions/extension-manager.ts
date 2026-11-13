// ExtensionManager - Register and manage extensions

import { App } from 'obsidian';
import { EventBus } from './event-bus';
import { ExtensionRegistration, ExtensionAPI } from './extension-api';
import { SkillRegistry } from '../skills/core/skill-registry';
import { SkillExecutor } from '../skills/core/skill-executor';
import { MentatSettings } from '../settings/settings';
import { SkillDefinition, SkillNamespace } from '../skills/skill-types';

export { EventBus } from './event-bus';
export type { EventHandler } from './event-bus';
export type { ExtensionAPI, ExtensionFactory, ExtensionContext, ExtensionRegistration } from './extension-api';

export class ExtensionManager {
  private extensions = new Map<string, ExtensionRegistration>();
  private loadedInstances = new Map<string, ExtensionAPI>();
  readonly eventBus = new EventBus();
  private declaredSkills = new Map<string, Map<string, SkillDefinition>>();
  private subscriptions = new Map<string, Set<() => void>>();
  private catalogRevision = 0;

  constructor(
    private app: App,
    private skillRegistry: SkillRegistry,
    private skillExecutor: SkillExecutor,
    private settings: MentatSettings,
    eventBus?: EventBus,
    private graph?: () => { skillRegistry: SkillRegistry; skillExecutor: SkillExecutor },
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

  /** Copy declarations without re-running factories or duplicating event listeners. */
  copySkillsTo(registry: SkillRegistry): () => void {
    const revision = this.catalogRevision;
    for (const declarations of this.declaredSkills.values()) for (const [id, skill] of declarations) {
      if (registry.get(id)) throw new Error(`Extension skill conflicts with candidate catalog: ${id}`);
      registry.register(skill);
    }
    return () => {
      if (revision !== this.catalogRevision) throw new Error('扩展技能在重新配置期间发生变化，请重试');
    };
  }

  private get liveRegistry(): SkillRegistry { return this.graph?.().skillRegistry || this.skillRegistry; }
  private get liveExecutor(): SkillExecutor { return this.graph?.().skillExecutor || this.skillExecutor; }

  private async loadExtension(reg: ExtensionRegistration): Promise<void> {
    const declarations = new Map<string, SkillDefinition>();
    const subscriptions = new Set<() => void>();
    this.declaredSkills.set(reg.id, declarations);
    this.subscriptions.set(reg.id, subscriptions);
    const api: ExtensionAPI = {
      context: {
        id: reg.id,
        name: reg.name,
        description: reg.description,
      },
      registerSkill: (skill) => {
        const id = `${skill.namespace}:${skill.name}`, existing = this.liveRegistry.get(id);
        if (existing && existing !== declarations.get(id)) throw new Error(`Extension skill conflicts with existing catalog: ${id}`);
        this.liveRegistry.register(skill);
        declarations.set(id, skill); this.catalogRevision++;
      },
      unregisterSkill: (namespace, name) => {
        const id = `${namespace}:${name}`, declared = declarations.get(id);
        if (!declared) return;
        if (this.liveRegistry.get(id) === declared) this.liveRegistry.unregister(namespace as SkillNamespace, name);
        declarations.delete(id); this.catalogRevision++;
      },
      on: (event, handler) => {
        const off = this.eventBus.on(event, handler); subscriptions.add(off);
        return () => { off(); subscriptions.delete(off); };
      },
      getSkillRegistry: () => this.liveRegistry,
      getSkillExecutor: () => this.liveExecutor,
      getSettings: () => this.settings,
      getApp: () => this.app,
    };

    try {
      await reg.factory(api);
      this.loadedInstances.set(reg.id, api);
      console.log(`[ExtensionManager] Loaded extension: ${reg.id} (${reg.name})`);
    } catch (error) {
      this.unloadExtension(reg.id);
      console.error(`[ExtensionManager] Failed to load extension ${reg.id}:`, error);
    }
  }

  private unloadExtension(id: string): void {
    for (const [key, skill] of this.declaredSkills.get(id) || []) {
      if (this.liveRegistry.get(key) === skill) this.liveRegistry.unregister(skill.namespace, skill.name);
    }
    this.declaredSkills.delete(id); this.catalogRevision++;
    for (const off of this.subscriptions.get(id) || []) off();
    this.subscriptions.delete(id);
    this.loadedInstances.delete(id);
  }
}
