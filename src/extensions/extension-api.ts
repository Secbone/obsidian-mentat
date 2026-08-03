// ExtensionAPI - Interface and types for extensions

import { App } from 'obsidian';
import { SkillRegistry } from '../skills/core/skill-registry';
import { SkillExecutor } from '../skills/core/skill-executor';
import { MentatSettings } from '../settings/settings';
import { SkillDefinition } from '../skills/skill-types';
import { SkillNamespace } from '../skills/skill-types';
import { AgentEvent } from '../agents/agent-types';

/**
 * Extension context — what extensions see when they're loaded.
 */
export interface ExtensionContext {
  id: string;
  name: string;
  description: string;
}

/**
 * ExtensionAPI — the API surface available to an extension.
 */
export interface ExtensionAPI {
  readonly context: ExtensionContext;

  /** Register a skill */
  registerSkill(skill: SkillDefinition): void;

  /** Unregister a skill */
  unregisterSkill(namespace: SkillNamespace, name: string): void;

  /** Subscribe to lifecycle events */
  on(event: string, handler: (event: AgentEvent) => void): () => void;

  /** Access services */
  getSkillRegistry(): SkillRegistry;
  getSkillExecutor(): SkillExecutor;
  getSettings(): MentatSettings;
  getApp(): App;
}

/**
 * Extension factory — the function that creates an extension.
 * Receives an ExtensionAPI and can use it to register hooks.
 */
export type ExtensionFactory = (api: ExtensionAPI) => void | Promise<void>;

/**
 * Extension registration metadata.
 */
export interface ExtensionRegistration {
  id: string;
  name: string;
  description: string;
  factory: ExtensionFactory;
}
