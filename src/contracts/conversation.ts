export interface ToolCall {
  id: string;
  name: string;
  arguments: string | Record<string, unknown>;
}

/** Only the named adapter may interpret payload. No vendor-specific state enters core contracts. */
export interface ProtocolState {
  adapterId: string;
  codecVersion: number;
  configFingerprint: string;
  payload: unknown;
  estimatedTokens?: number;
}

export interface FileReference { path: string; name?: string; }
export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool' | 'function';
  content: string;
  timestamp: number;
  sources?: FileReference[];
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
  metadata?: { isSubagent?: boolean; agentId?: string; parentMessageId?: string; [key: string]: unknown };
}
