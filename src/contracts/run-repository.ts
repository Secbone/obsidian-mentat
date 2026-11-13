import type { RunRecord } from '../runtime/types';

/** The execution journal is authoritative; log sinks and session projections are not. */
export interface RunRepository {
  readonly warnings: string[];
  readonly capabilities: { safeReplace: boolean; externalChangeDetection: boolean };
  load(id: string): Promise<RunRecord>;
  list(): Promise<RunRecord[]>;
  commit(record: RunRecord, expectedRevision: number): Promise<number>;
  flush(): Promise<void>;
}

export interface RunStorageIO {
  getConfigDir(): string;
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  read(path: string): Promise<string>;
  write(path: string, text: string): Promise<void>;
  list(path: string): Promise<{files:string[]}>;
  delete(path: string): Promise<void>;
  replaceFile?(temporaryPath: string, path: string): Promise<void>;
}
