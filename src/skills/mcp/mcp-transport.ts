// MCP Transport Layer - Handles stdio and HTTP communication

import {
  MCPTransport,
  MCPMessage,
  MCPServerConfig
} from './mcp-types';

/**
 * Stdio Transport - Communicates with MCP servers via stdio
 */
export class StdioTransport implements MCPTransport {
  private process: any = null;
  private messageQueue: MCPMessage[] = [];
  private responseHandlers: Map<string, (response: MCPMessage) => void> = new Map();
  private connected = false;
  private buffer = '';

  constructor(private config: MCPServerConfig) {
    if (config.type !== 'stdio') {
      throw new Error('StdioTransport requires type "stdio"');
    }
  }

  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }

    try {
      // Note: In Obsidian plugin environment, we need to use Node.js child_process
      // This will only work in desktop environments
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { spawn } = require('child_process');

      this.process = spawn(this.config.command!, this.config.args || [], {
        env: { ...process.env, ...this.config.env },
        stdio: ['pipe', 'pipe', 'pipe']
      });

      // Handle stdout (responses)
      this.process.stdout.on('data', (data: Buffer) => {
        this.handleData(data.toString());
      });

      // Handle stderr (errors)
      this.process.stderr.on('data', (data: Buffer) => {
        console.error(`[MCP Stdio] stderr: ${data.toString()}`);
      });

      // Handle process exit
      this.process.on('exit', (code: number) => {
        console.log(`[MCP Stdio] Process exited with code ${code}`);
        this.connected = false;
      });

      // Handle errors
      this.process.on('error', (error: Error) => {
        console.error('[MCP Stdio] Process error:', error);
        this.connected = false;
      });

      this.connected = true;
      console.log(`[MCP Stdio] Connected to ${this.config.name}`);
    } catch (error) {
      console.error('[MCP Stdio] Failed to connect:', error);
      throw error;
    }
  }

  async send(message: MCPMessage): Promise<any> {
    if (!this.connected || !this.process) {
      throw new Error('Not connected to MCP server');
    }

    const messageStr = JSON.stringify(message) + '\n';
    this.process.stdin.write(messageStr);

    // If message has an ID, wait for response
    if (message.id !== undefined) {
      return new Promise((resolve, reject) => {
        const timeout = window.setTimeout(() => {
          this.responseHandlers.delete(message.id!.toString());
          reject(new Error('Request timeout'));
        }, 30000); // 30s timeout

        this.responseHandlers.set(message.id!.toString(), (response) => {
          window.clearTimeout(timeout);
          if (response.error) {
            reject(new Error(response.error.message));
          } else {
            resolve(response);
          }
        });
      });
    }

    return undefined;
  }

  async receive(): Promise<any> {
    // Stdio transport uses event-driven model, not polling
    // This method is not used for stdio
    throw new Error('receive() not implemented for stdio transport');
  }

  async close(): Promise<void> {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  private handleData(data: string): void {
    this.buffer += data;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const message: MCPMessage = JSON.parse(line);
        this.handleMessage(message);
      } catch (error) {
        console.error('[MCP Stdio] Failed to parse message:', error, line);
      }
    }
  }

  private handleMessage(message: MCPMessage): void {
    // Check if this is a response to a request
    if (message.id !== undefined) {
      const handler = this.responseHandlers.get(message.id.toString());
      if (handler) {
        this.responseHandlers.delete(message.id.toString());
        handler(message);
        return;
      }
    }

    // Otherwise, queue the message
    this.messageQueue.push(message);
  }
}

/**
 * HTTP Transport - Communicates with MCP servers via HTTP
 */
export class HttpTransport implements MCPTransport {
  private connected = false;
  private sessionId?: string;

  constructor(private config: MCPServerConfig) {
    if (config.type !== 'http') {
      throw new Error('HttpTransport requires type "http"');
    }
  }

  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }

    try {
      // Test connection with a ping
      const response = await fetch(this.config.url!, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...this.config.headers
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'ping'
        })
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      this.connected = true;
      console.log(`[MCP HTTP] Connected to ${this.config.name}`);
    } catch (error) {
      console.error('[MCP HTTP] Failed to connect:', error);
      throw error;
    }
  }

  async send(message: MCPMessage): Promise<any> {
    if (!this.connected) {
      throw new Error('Not connected to MCP server');
    }

    try {
      const response = await fetch(this.config.url!, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...this.config.headers,
          ...(this.sessionId ? { 'X-Session-ID': this.sessionId } : {})
        },
        body: JSON.stringify(message)
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      // Check for session ID in response headers
      const sessionIdHeader = response.headers.get('X-Session-ID');
      if (sessionIdHeader) {
        this.sessionId = sessionIdHeader;
      }

      const responseData: MCPMessage = await response.json();

      if (responseData.error) {
        throw new Error(responseData.error.message);
      }

      return responseData;
    } catch (error) {
      console.error('[MCP HTTP] Request failed:', error);
      throw error;
    }
  }

  async receive(): Promise<any> {
    throw new Error('receive() not implemented for HTTP transport (request/response model)');
  }

  async close(): Promise<void> {
    this.connected = false;
    this.sessionId = undefined;
  }

  isConnected(): boolean {
    return this.connected;
  }
}

/**
 * Create appropriate transport for server config
 */
export function createTransport(config: MCPServerConfig): MCPTransport {
  switch (config.type) {
    case 'stdio':
      return new StdioTransport(config);
    case 'http':
      return new HttpTransport(config);
    default:
      throw new Error(`Unsupported transport type: ${config.type}`);
  }
}
