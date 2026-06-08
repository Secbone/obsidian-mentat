// MCP Client - Implements Model Context Protocol client

import {
  MCPServerConfig,
  MCPClientState,
  MCPToolDefinition,
  MCPMessage,
  MCPInitializeRequest,
  MCPInitializeResponse,
  MCPToolsListRequest,
  MCPToolsListResponse,
  MCPToolCallRequest,
  MCPToolCallResponse,
  MCPConnectionStatus,
  MCPErrorCode,
  MCPTransport
} from './mcp-types';
import { createTransport } from './mcp-transport';
import { SkillDefinition } from '../skill-types';

/**
 * MCP Client - Connects to and communicates with MCP servers
 */
export class MCPClient {
  private transport: MCPTransport | null = null;
  private state: MCPClientState;
  private requestId = 1;

  constructor(private config: MCPServerConfig) {
    this.state = {
      status: 'disconnected',
      tools: []
    };
  }

  /**
   * Connect to the MCP server
   */
  async connect(): Promise<void> {
    if (this.state.status === 'connected') {
      return;
    }

    try {
      this.state.status = 'connecting';

      // Create transport
      this.transport = createTransport(this.config);
      await this.transport.connect();

      // Send initialize request
      const initRequest: MCPInitializeRequest = {
        jsonrpc: '2.0',
        id: this.nextId(),
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          clientInfo: {
            name: 'mentat',
            version: '0.1.0'
          },
          capabilities: {
            tools: true
          }
        }
      };

      const initResponse = await this.transport.send(initRequest) as MCPInitializeResponse;

      if (!initResponse || !initResponse.result) {
        throw new Error('Invalid initialize response');
      }

      this.state.serverInfo = initResponse.result.serverInfo;
      this.state.capabilities = {
        tools: !!initResponse.result.capabilities.tools,
        resources: !!initResponse.result.capabilities.resources,
        prompts: !!initResponse.result.capabilities.prompts
      };

      // Send initialized notification
      await this.transport.send({
        jsonrpc: '2.0',
        method: 'initialized'
      });

      // Discover tools
      await this.discoverTools();

      this.state.status = 'connected';
      console.log(`[MCP] Connected to ${this.config.name}, discovered ${this.state.tools.length} tools`);
    } catch (error) {
      console.error('[MCP] Connection failed:', error);
      this.state.status = 'error';
      this.state.error = (error as any).message;
      throw error;
    }
  }

  /**
   * Disconnect from the MCP server
   */
  async disconnect(): Promise<void> {
    if (this.transport) {
      await this.transport.close();
      this.transport = null;
    }
    this.state.status = 'disconnected';
    this.state.tools = [];
  }

  /**
   * Discover available tools
   */
  private async discoverTools(): Promise<void> {
    if (!this.transport) {
      throw new Error('Not connected');
    }

    try {
      const request: MCPToolsListRequest = {
        jsonrpc: '2.0',
        id: this.nextId(),
        method: 'tools/list'
      };

      const response = await this.transport.send(request) as MCPToolsListResponse;

      if (!response || !response.result) {
        throw new Error('Invalid tools/list response');
      }

      this.state.tools = response.result.tools;

      // Handle pagination if needed
      let nextCursor = response.result.nextCursor;
      while (nextCursor) {
        const paginatedRequest: MCPToolsListRequest = {
          jsonrpc: '2.0',
          id: this.nextId(),
          method: 'tools/list',
          params: { cursor: nextCursor }
        };

        const paginatedResponse = await this.transport.send(paginatedRequest) as MCPToolsListResponse;
        this.state.tools.push(...paginatedResponse.result.tools);
        nextCursor = paginatedResponse.result.nextCursor;
      }

      console.log(`[MCP] Discovered ${this.state.tools.length} tools from ${this.config.name}`);
    } catch (error) {
      console.error('[MCP] Failed to discover tools:', error);
      throw error;
    }
  }

  /**
   * Call a tool
   */
  async callTool(toolName: string, args: Record<string, any>): Promise<any> {
    if (!this.transport) {
      throw new Error('Not connected');
    }

    if (this.state.status !== 'connected') {
      throw new Error('Client not in connected state');
    }

    try {
      const request: MCPToolCallRequest = {
        jsonrpc: '2.0',
        id: this.nextId(),
        method: 'tools/call',
        params: {
          name: toolName,
          arguments: args
        }
      };

      const response = await this.transport.send(request) as MCPToolCallResponse;

      if (!response || !response.result) {
        throw new Error('Invalid tool call response');
      }

      if (response.result.isError) {
        throw new Error(`Tool execution error: ${JSON.stringify(response.result.content)}`);
      }

      return response.result.content;
    } catch (error) {
      console.error(`[MCP] Tool call failed (${toolName}):`, error);
      throw error;
    }
  }

  /**
   * Get current state
   */
  getState(): MCPClientState {
    return { ...this.state };
  }

  /**
   * Get discovered tools
   */
  getTools(): MCPToolDefinition[] {
    return [...this.state.tools];
  }

  /**
   * Convert MCP tools to Skill definitions
   */
  toSkillDefinitions(): SkillDefinition[] {
    return this.state.tools.map(tool => this.toolToSkill(tool));
  }

  /**
   * Convert a single MCP tool to Skill definition
   */
  private toolToSkill(tool: MCPToolDefinition): SkillDefinition {
    // For MCP tools, we can't directly use Zod schemas
    // We'll create a pass-through validator
    const schema = {
      parse: (input: any) => input, // Pass through
      _def: { typeName: 'ZodAny' }
    } as any;

    return {
      name: tool.name,
      namespace: 'mcp',
      description: `[MCP:${this.config.id}] ${tool.description}`,
      schema,
      execute: async (input: any) => {
        try {
          const content = await this.callTool(tool.name, input);
          return {
            success: true,
            data: content
          };
        } catch (error) {
          return {
            success: false,
            error: (error as any).message
          };
        }
      },
      metadata: {
        tags: ['mcp', this.config.id],
        version: '1.0.0'
      }
    };
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.state.status === 'connected';
  }

  /**
   * Get server info
   */
  getServerInfo() {
    return {
      config: this.config,
      state: this.state
    };
  }

  /**
   * Generate next request ID
   */
  private nextId(): number {
    return this.requestId++;
  }
}
