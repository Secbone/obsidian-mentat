// MCP Manager - Manages multiple MCP server connections

import { MCPClient } from './mcp-client';
import { MCPServerConfig, MCPToolDefinition } from './mcp-types';
import { SkillRegistry } from '../core/skill-registry';
import { SkillDefinition } from '../skill-types';

/**
 * MCP Manager - Centralized management of MCP server connections
 */
export class MCPManager {
  private clients: Map<string, MCPClient> = new Map();
  private configs: Map<string, MCPServerConfig> = new Map();

  constructor(private skillRegistry?: SkillRegistry) {}

  /**
   * Add a server configuration
   */
  addServer(config: MCPServerConfig): void {
    this.configs.set(config.id, config);
    console.log(`[MCPManager] Added server config: ${config.name}`);
  }

  /**
   * Remove a server configuration
   */
  async removeServer(serverId: string): Promise<void> {
    const client = this.clients.get(serverId);
    if (client) {
      await client.disconnect();
      this.clients.delete(serverId);

      // Unregister skills from this server
      if (this.skillRegistry) {
        const skills = client.toSkillDefinitions();
        skills.forEach(skill => {
          this.skillRegistry!.unregister('mcp', skill.name);
        });
      }
    }
    this.configs.delete(serverId);
    console.log(`[MCPManager] Removed server: ${serverId}`);
  }

  /**
   * Connect to a server
   */
  async connect(serverId: string): Promise<void> {
    const config = this.configs.get(serverId);
    if (!config) {
      throw new Error(`Server config not found: ${serverId}`);
    }

    // Check if already connected
    const existingClient = this.clients.get(serverId);
    if (existingClient && existingClient.isConnected()) {
      console.log(`[MCPManager] Already connected to ${serverId}`);
      return;
    }

    try {
      const client = new MCPClient(config);
      await client.connect();

      this.clients.set(serverId, client);

      // Register skills with the registry
      if (this.skillRegistry) {
        const skills = client.toSkillDefinitions();
        skills.forEach(skill => {
          // Prefix skill name with server ID for uniqueness
          const prefixedSkill: SkillDefinition = {
            ...skill,
            name: `${serverId}:${skill.name}`
          };
          this.skillRegistry!.register(prefixedSkill);
        });
        console.log(`[MCPManager] Registered ${skills.length} skills from ${config.name}`);
      }
    } catch (error) {
      console.error(`[MCPManager] Failed to connect to ${serverId}:`, error);
      throw error;
    }
  }

  /**
   * Disconnect from a server
   */
  async disconnect(serverId: string): Promise<void> {
    const client = this.clients.get(serverId);
    if (client) {
      await client.disconnect();

      // Unregister skills
      if (this.skillRegistry) {
        const skills = client.toSkillDefinitions();
        skills.forEach((skill: SkillDefinition) => {
          this.skillRegistry!.unregister('mcp', `${serverId}:${skill.name}`);
        });
      }

      this.clients.delete(serverId);
      console.log(`[MCPManager] Disconnected from ${serverId}`);
    }
  }

  /**
   * Connect to all enabled servers with autoConnect
   */
  async connectAll(): Promise<void> {
    const connectPromises: Promise<void>[] = [];

    for (const [serverId, config] of this.configs.entries()) {
      if (config.enabled && config.autoConnect) {
        connectPromises.push(
          this.connect(serverId).catch((error: unknown) => {
            console.error(`[MCPManager] Auto-connect failed for ${serverId}:`, error);
          })
        );
      }
    }

    await Promise.all(connectPromises);
  }

  /**
   * Disconnect from all servers
   */
  async disconnectAll(): Promise<void> {
    const disconnectPromises = Array.from(this.clients.keys()).map(serverId =>
      this.disconnect(serverId)
    );
    await Promise.all(disconnectPromises);
  }

  /**
   * Get a client by server ID
   */
  getClient(serverId: string): MCPClient | undefined {
    return this.clients.get(serverId);
  }

  /**
   * Get all clients
   */
  getAllClients(): MCPClient[] {
    return Array.from(this.clients.values());
  }

  /**
   * Get all server configs
   */
  getAllConfigs(): MCPServerConfig[] {
    return Array.from(this.configs.values());
  }

  /**
   * Get server status
   */
  getServerStatus(serverId: string): {
    connected: boolean;
    toolCount: number;
    serverInfo?: any;
  } {
    const client = this.clients.get(serverId);
    if (!client) {
      return { connected: false, toolCount: 0 };
    }

    const state = client.getState();
    return {
      connected: client.isConnected(),
      toolCount: state.tools.length,
      serverInfo: state.serverInfo
    };
  }

  /**
   * Get all discovered tools across all servers
   */
  getAllTools(): Array<{ serverId: string; tool: MCPToolDefinition }> {
    const tools: Array<{ serverId: string; tool: MCPToolDefinition }> = [];

    for (const [serverId, client] of this.clients.entries()) {
      const clientTools = client.getTools();
      clientTools.forEach((tool: MCPToolDefinition) => {
        tools.push({ serverId, tool });
      });
    }

    return tools;
  }

  /**
   * Test connection to a server
   */
  async testConnection(serverId: string): Promise<{
    success: boolean;
    error?: string;
    toolCount?: number;
  }> {
    try {
      await this.connect(serverId);
      const client = this.clients.get(serverId);
      const toolCount = client ? client.getTools().length : 0;

      return { success: true, toolCount };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Reload a server (disconnect and reconnect)
   */
  async reloadServer(serverId: string): Promise<void> {
    await this.disconnect(serverId);
    await this.connect(serverId);
  }

  /**
   * Get statistics
   */
  getStats(): {
    totalServers: number;
    connectedServers: number;
    totalTools: number;
    serverStats: Array<{
      id: string;
      name: string;
      connected: boolean;
      toolCount: number;
    }>;
  } {
    const serverStats = Array.from(this.configs.values()).map(config => {
      const status = this.getServerStatus(config.id);
      return {
        id: config.id,
        name: config.name,
        connected: status.connected,
        toolCount: status.toolCount
      };
    });

    return {
      totalServers: this.configs.size,
      connectedServers: serverStats.filter(s => s.connected).length,
      totalTools: serverStats.reduce((sum, s) => sum + s.toolCount, 0),
      serverStats
    };
  }

  /**
   * Update server config
   */
  updateServerConfig(serverId: string, updates: Partial<MCPServerConfig>): void {
    const config = this.configs.get(serverId);
    if (!config) {
      throw new Error(`Server config not found: ${serverId}`);
    }

    Object.assign(config, updates);
    console.log(`[MCPManager] Updated config for ${serverId}`);
  }

  /**
   * Set skill registry
   */
  setSkillRegistry(registry: SkillRegistry): void {
    this.skillRegistry = registry;
  }
}
