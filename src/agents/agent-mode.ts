import type { Context } from '../core/cordis';
import type { AgentBackend } from './agent-backend';

/** Context handed to a mode's backend factory. */
export interface ModeContext {
  ctx: Context;
  sessionId?: string;
}

/**
 * A composable agent mode (RFC §3.3): how a session gets its backend.
 * Third parties may register custom modes; sessions resolve their `modeId`
 * through the registry.
 */
export interface AgentModeDescriptor {
  id: string;
  displayName: string;
  description: string;
  /** Whether the mode needs the vault exposed over MCP (delegated modes). */
  requiresVaultServer?: boolean;
  createBackend(ctx: ModeContext): AgentBackend;
}

/**
 * Registry of agent modes. Registration is reversible (returns an
 * unregister function); mounting this as a context service lets sessions and
 * settings enumerate the available modes.
 */
export class AgentModeRegistry {
  private modes = new Map<string, AgentModeDescriptor>();

  register(descriptor: AgentModeDescriptor): () => void {
    if (this.modes.has(descriptor.id)) {
      throw new Error(`agent mode "${descriptor.id}" is already registered`);
    }
    this.modes.set(descriptor.id, descriptor);
    return () => this.modes.delete(descriptor.id);
  }

  unregister(id: string): void {
    this.modes.delete(id);
  }

  get(id: string): AgentModeDescriptor | undefined {
    return this.modes.get(id);
  }

  list(): AgentModeDescriptor[] {
    return [...this.modes.values()];
  }

  has(id: string): boolean {
    return this.modes.has(id);
  }
}

/** The built-in embedded mode id. */
export const EMBEDDED_MODE = 'embedded';
