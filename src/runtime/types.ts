import type { ChatMessage, GenerateResponse } from '../types';
import type { SkillResult } from '../skills/skill-types';

export type RunStatus = 'running' | 'waiting_for_user' | 'waiting_for_approval' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export type OutcomeKind = 'success' | 'input_error' | 'denied' | 'expired' | 'cancelled' | 'timeout' | 'unknown' | 'failure';
export interface InteractionRequest {
  id: string;
  operationId: string;
  kind: 'question' | 'approval';
  question: string;
  context?: string;
  options?: string[];
  requiresInput?: boolean;
  fingerprint?: string;
  outcome?: { kind: 'answered' | 'approved' | 'rejected' | 'cancelled' | 'expired'; answer?: string };
}
export interface OperationRecord {
  id: string;
  name: string;
  category: string;
  status: 'planned' | 'running' | 'finished' | 'unknown';
  result?: SkillResult;
}
export interface RunEvent {
  id: string;
  sequence: number;
  timestamp: number;
  type: string;
  operationId?: string;
  details?: Record<string, unknown>;
}
export interface RunRecord {
  version: 1;
  id: string;
  sessionId: string;
  prompt: string;
  agentId: string;
  providerId?: string;
  maxTurns: number;
  enableSkills: boolean;
  status: RunStatus;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
  baseMessageCount: number;
  children?: Record<string, ChatMessage[]>;
  childPartials?: Record<string, string>;
  operations: Record<string, OperationRecord>;
  interactions: Record<string, InteractionRequest>;
  events: RunEvent[];
  error?: string;
  partial?: string;
}
export interface RunRuntime {
  readonly runId: string;
  readonly sessionId: string;
  readonly scope?: string;
  child(id: string): { runtime: RunRuntime; messages: ChatMessage[]; checkpoint: (messages: ChatMessage[]) => Promise<void> };
  partial(text: string): Promise<void>;
  observe?(type: string, details?: Record<string, unknown>): void;
  record(type: string, details?: Record<string, unknown>, operationId?: string): Promise<void>;
  getOperation(id: string): OperationRecord | undefined;
  setOperation(operation: OperationRecord): Promise<void>;
  interact(request: InteractionRequest): Promise<NonNullable<InteractionRequest['outcome']>>;
  modelResult(result: GenerateResponse): Promise<void>;
}
export class RunSuspended extends Error {
  constructor(public interaction: InteractionRequest) { super('等待用户操作'); this.name = 'RunSuspended'; }
}
export class RunBlocked extends Error {
  constructor(message: string) { super(message); this.name = 'RunBlocked'; }
}

/** Ephemeral presentation data; execution and recovery still use RunRecord. */
export interface RunLiveState {
  phase?: string;
  phaseStartedAt?: number;
  message?: { index: number; content: string; startedAt: number; complete: boolean };
  cancelling?: boolean;
}
