import type { ObservationEvent } from '../observability/types';

export interface ObservationFilter {
  runId?: string;
  sessionId?: string;
  includeUnscoped?: boolean;
  errorsOnly?: boolean;
  search?: string;
  since?: number;
  until?: number;
}
export interface ObservationPage {
  events: ObservationEvent[]; // Newest first, sanitized and detached.
  total: number;
  nextCursor?: string;
}
export interface ObservationSummary {
  attempts: number;
  modelMs: number;
  toolMs: number;
  waitingMs: number;
  incomplete: number;
  failures: number;
}
export interface ObservationModelRequest { request: ObservationEvent; finish?: ObservationEvent }
export interface ObservationHealth {
  writeError: string;
  readError: string;
  dropped: number;
  malformed: number;
  legacyReadError?: string;
  legacyMalformed?: number;
}
export interface ObservationSource {
  readonly store: { readonly folder: string; readonly health: ObservationHealth };
  sanitize(event: ObservationEvent): ObservationEvent;
  snapshot(): ObservationEvent[];
  query(): Promise<ObservationEvent[]>;
  subscribe(listener: (event: ObservationEvent) => void): () => void;
}
/** UI and reports share one read model; bulk reads are explicit export operations. */
export interface ObservationQuery {
  readonly folder: string;
  readonly health: ObservationHealth;
  readonly warnings: string[];
  page(filter?: ObservationFilter, limit?: number, cursor?: string): ObservationPage;
  all(filter?: ObservationFilter): ObservationEvent[];
  summary(runId: string): ObservationSummary | undefined;
  modelRequests(runId: string): ObservationModelRequest[];
  refresh(): Promise<void>;
  subscribe(listener: () => void): () => void;
  dispose(): void;
}
