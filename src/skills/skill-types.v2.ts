import type { DocumentStore, SearchCapability, GraphCapability } from '../platform/contracts';
import type { KnowledgeService } from '../knowledge/knowledge.service';
import type { SkillDefinition } from './skill-types';

/**
 * Host-agnostic skill context (L2.7). Replaces the Obsidian-typed fields
 * (vault/metadataCache/workspace/plugin) with injected platform services.
 * Optional capabilities are optional: a skill declaring graph stays pending
 * on a platform without it.
 */
export interface SkillContextV2 {
  documents: DocumentStore;
  search: SearchCapability;
  knowledge?: KnowledgeService;
  graph?: GraphCapability;
  readTracker?: { markRead(path: string, mtime: number): void; hasBeenRead(path: string): boolean };
}

export type { SkillDefinition };
export type { SkillResult } from './skill-types';
