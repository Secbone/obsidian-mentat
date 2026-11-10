export interface ObservationEvent {
  schemaVersion: 1;
  eventId: string;
  timestamp: number;
  processInstanceId: string;
  sequence: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  name: string;
  component: string;
  sessionId?: string;
  runId?: string;
  attemptId?: string;
  requestId?: string;
  operationId?: string;
  durationMs?: number;
  attributes?: Record<string, unknown>;
}
export type EventInput = Partial<Omit<ObservationEvent, 'schemaVersion' | 'processInstanceId' | 'sequence' | 'name'>>;
