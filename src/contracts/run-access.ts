import type { RunRecord, RunLiveState, InteractionRequest } from '../runtime/types';
import type { ChatMessage } from '../types';
import type { SkillResult } from '../skills/skill-types';

export interface RunStartOptions {
  sessionId: string;
  messages: ChatMessage[];
  maxTurns: number;
  enableSkills: boolean;
  providerId?: string;
}

/** Application commands; implementations retain ownership of all mutable execution state. */
export interface RunCommands {
  start(prompt: string, options: RunStartOptions): Promise<string>;
  open(id: string): Promise<void>;
  resume(id: string): Promise<void>;
  cancel(id: string, reason?: string): Promise<void>;
  steer(id: string, text: string): Promise<boolean>;
  respond(id: string, interactionId: string, outcome: NonNullable<InteractionRequest['outcome']>): Promise<void>;
  reconcile(id: string, operationId: string, result: SkillResult | null): Promise<void>;
}

/** Query results are detached snapshots, never controller-owned records or contexts. */
export interface RunQueries {
  list(sessionId?: string): RunRecord[];
  get(id: string): RunRecord | undefined;
  getLiveState(id: string): RunLiveState | undefined;
  getDisplayMessages(id: string): ChatMessage[];
  getWarnings(): string[];
  hasUnsettledWork(): boolean;
}

export interface RunAccess extends RunCommands, RunQueries {}
