import type { ChatMessage } from '../types';
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

  restore(messages: ChatMessage[]): void {
    const reads = new Set<string>();
    for (const message of messages) for (const call of message.tool_calls || []) {
      try {
        const args = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments;
        const name = call.name === 'invoke' ? args.skill_name : call.name.replace(/__/g, ':');
        if (name === 'obsidian:read_note') reads.add(call.id);
      } catch { /* Incomplete calls cannot establish read evidence. */ }
    }
    for (const message of messages) if (message.role === 'tool' && message.tool_call_id && reads.has(message.tool_call_id)) {
      try {
        const result = JSON.parse(message.content);
        if (typeof result.path === 'string' && typeof result.content === 'string') this.markRead(result.path, result.metadata?.modified || 0);
      } catch { /* Error results do not establish read evidence. */ }
    }
  }

  clear(): void {
    this.readFiles.clear();
  }
}
