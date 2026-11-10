import type { InteractionRequest, RunStatus } from '../../runtime/types';

export type CardKind = 'user' | 'activity' | 'process' | 'tool' | 'interaction' | 'reply' | 'artifact' | 'system';
export type CardStatus = 'running' | 'pending' | 'waiting' | 'completed' | 'failed' | 'cancelled' | 'unknown' | 'interrupted';
export interface ChatCard {
  id: string;
  kind: CardKind;
  title: string;
  timestamp: number;
  status?: CardStatus;
  text?: string;
  detail?: string;
  durationMs?: number;
  streaming?: boolean;
  runId?: string;
  operationId?: string;
  interaction?: InteractionRequest;
  path?: string;
  canResume?: boolean;
  canReconcile?: boolean;
}
export interface ChatViewState {
  cards: ChatCard[];
  runId?: string;
  runStatus?: RunStatus;
  label: string;
  startedAt?: number;
  busy: boolean;
  inputMode: 'send' | 'steer' | 'blocked';
  canCancel: boolean;
  cancelling: boolean;
}
export type CardAction = 'approve' | 'reject' | 'answer' | 'resume' | 'reconcile' | 'inspect' | 'open';
