// MCP Protocol Types - Type definitions for Model Context Protocol

/**
 * MCP Server configuration
 */
export interface MCPServerConfig {
  id: string;
  name: string;
  type: 'stdio' | 'http';

  // For stdio transport
  command?: string;
  args?: string[];
  env?: Record<string, string>;

  // For HTTP transport
  url?: string;
  headers?: Record<string, string>;

  enabled: boolean;
  autoConnect: boolean;
}

/**
 * MCP Transport interface
 */
export interface MCPTransport {
  connect(): Promise<void>;
  send(message: MCPMessage): Promise<unknown>;
  receive(): Promise<MCPMessage>;
  close(): Promise<void>;
  isConnected(): boolean;
}

/**
 * MCP Message types
 */
export type MCPMessageType =
  | 'initialize'
  | 'initialized'
  | 'tools/list'
  | 'tools/call'
  | 'ping'
  | 'pong'
  | 'error';

/**
 * Base MCP Message
 */
export interface MCPMessage {
  jsonrpc: '2.0';
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: MCPError;
}

/**
 * MCP Error
 */
export interface MCPError {
  code: number;
  message: string;
  data?: unknown;
}

/**
 * MCP Initialize Request
 */
export interface MCPInitializeRequest extends MCPMessage {
  method: 'initialize';
  params: {
    protocolVersion: string;
    clientInfo: {
      name: string;
      version: string;
    };
    capabilities?: {
      tools?: boolean;
      resources?: boolean;
      prompts?: boolean;
    };
  };
}

/**
 * MCP Initialize Response
 */
export interface MCPInitializeResponse extends MCPMessage {
  result: {
    protocolVersion: string;
    serverInfo: {
      name: string;
      version: string;
    };
    capabilities: {
      tools?: {
        listChanged?: boolean;
      };
      resources?: {
        subscribe?: boolean;
        listChanged?: boolean;
      };
      prompts?: {
        listChanged?: boolean;
      };
    };
  };
}

/**
 * MCP Tools List Request
 */
export interface MCPToolsListRequest extends MCPMessage {
  method: 'tools/list';
  params?: {
    cursor?: string;
  };
}

/**
 * MCP Tool Definition
 */
export interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown;
  };
}

/**
 * MCP Tools List Response
 */
export interface MCPToolsListResponse extends MCPMessage {
  result: {
    tools: MCPToolDefinition[];
    nextCursor?: string;
  };
}

/**
 * MCP Tool Call Request
 */
export interface MCPToolCallRequest extends MCPMessage {
  method: 'tools/call';
  params: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

/**
 * MCP Tool Call Response
 */
export interface MCPToolCallResponse extends MCPMessage {
  result: {
    content: Array<{
      type: 'text' | 'image' | 'resource';
      text?: string;
      data?: string;
      mimeType?: string;
    }>;
    isError?: boolean;
  };
}

/**
 * MCP Connection Status
 */
export type MCPConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'error';

/**
 * MCP Client State
 */
export interface MCPClientState {
  status: MCPConnectionStatus;
  serverInfo?: {
    name: string;
    version: string;
  };
  capabilities?: {
    tools?: boolean;
    resources?: boolean;
    prompts?: boolean;
  };
  tools: MCPToolDefinition[];
  error?: string;
}

/**
 * MCP Error Codes (JSON-RPC 2.0 standard + custom)
 */
export enum MCPErrorCode {
  PARSE_ERROR = -32700,
  INVALID_REQUEST = -32600,
  METHOD_NOT_FOUND = -32601,
  INVALID_PARAMS = -32602,
  INTERNAL_ERROR = -32603,

  // Custom MCP errors
  CONNECTION_ERROR = -32000,
  TIMEOUT_ERROR = -32001,
  TOOL_NOT_FOUND = -32002,
  TOOL_EXECUTION_ERROR = -32003
}
