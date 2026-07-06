export class ReadTracker {
  private readFiles: Map<string, { timestamp: number; mtime: number }> = new Map();

  markRead(path: string, mtime: number): void {
    this.readFiles.set(path, {
      timestamp: Date.now(),
      mtime
    });
  }

  hasBeenRead(path: string): boolean {
    return this.readFiles.has(path);
  }

  getReadMtime(path: string): number | null {
    const entry = this.readFiles.get(path);
    return entry ? entry.mtime : null;
  }

  clear(): void {
    this.readFiles.clear();
  }
}
