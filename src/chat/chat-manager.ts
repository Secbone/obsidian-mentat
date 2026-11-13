// Chat Manager - Handles chat history persistence and management

import type { ChatMessage } from '../contracts/conversation';
import { Context, Message, ContextOptions } from '../context';
import { FileStorage } from '../utils/file-storage';
import { parseJson } from '../utils/json-healer';
import { IPlatformAdapter } from '../types/platform';
import type { RunRecord } from '../runtime/types';

interface ChatHistory {
  sessionId: string;
  messages: ChatMessage[];
  selectedFiles: string[]; // File paths of selected documents
  lastUpdated: number;
}

export class ChatManager {
  private plugin: { loadData: () => Promise<Record<string, unknown>>; saveData: (data: Record<string, unknown>) => Promise<void>; platform?: { getConfigDir: () => string; exists: (path: string) => Promise<boolean>; read: (path: string) => Promise<string>; write: (path: string, data: string) => Promise<void>; delete: (path: string) => Promise<void>; mkdir: (path: string) => Promise<void>; list: (path: string) => Promise<{ files: string[]; folders: string[] }> }; app?: { vault?: { configDir?: string } } };
  private storage: FileStorage;
  private history: ChatMessage[] = [];
  private selectedFiles: Set<string> = new Set(); // Selected document paths
  private sessionId: string;
  private initialized: Promise<void>;
  private readonly STORAGE_KEY = 'mentat-chat-history';
  private pendingWrite: Promise<void> = Promise.resolve();
  private runHistory?: (sessionId: string) => Promise<RunRecord | undefined>;
  private projectionRunId?: string;
  private projectionMode = false;
  readonly recoveryWarnings:string[]=[];

  constructor(plugin: ChatManager['plugin']) {
     this.plugin = plugin;
     // Fallback to a safe mock if platform is not yet initialized or present (e.g., in tests)
      const platform = (plugin.platform || {
        getConfigDir: () => plugin.app?.vault?.configDir || '',
        exists: async () => false,
        read: async () => '',
        write: async () => {},
        delete: async () => {},
        mkdir: async () => {},
        list: async () => ({ files: [], folders: [] }),
      }) as IPlatformAdapter;
     this.storage = new FileStorage(platform);
     this.sessionId = this.generateSessionId();
     this.initialized = (async()=>{
       let legacyError:unknown;
       try {await this.loadHistory();} catch(error) {legacyError=error;}
       let projected=false;
       try {projected=await this.loadProjection();}catch(error){this.recoveryWarnings.push(`会话显示索引损坏，保留原文件，可从运行记录重建：${String(error)}`);}
       if(legacyError && !projected) this.recoveryWarnings.push(`旧聊天记录无法读取，原文件已保留，请从运行记录恢复：${String(legacyError)}`);
     })();
   }

  /**
   * Add a message to history
   */
  async addMessage(role: 'user' | 'assistant', content: string): Promise<void> {
    await this.initialized;

    const message: ChatMessage = {
      role,
      content,
      timestamp: Date.now(),
      sources: [] // Not used for pure chat
    };

    this.history.push(message);

    await this.saveHistory();
  }

  /**
   * Replace history with new messages (for complete conversation with tool calls)
   * This replaces the old context messages with the new complete message array
   */
  async replaceMessages(messages: ChatMessage[]): Promise<void> {
    await this.initialized;

    this.history = [...messages];

    await this.saveHistory();
  }

  /**
   * Get all messages in current session
   */
  async getHistory(): Promise<ChatMessage[]> {
    await this.initialized;
    if(this.runHistory) {
      const record=await this.runHistory(this.sessionId);
      if(record) {this.history=structuredClone(record.messages);this.projectionRunId=record.id;}
    }
    return [...this.history];
  }

  /** Runtime journals own managed transcripts; this file only keeps a rebuildable cursor. */
  async bindRunHistory(reader: (sessionId:string)=>Promise<RunRecord|undefined>):Promise<void> {
    await this.initialized;this.runHistory=reader;this.projectionMode=true;await this.getHistory();
  }
  async projectRun(record:RunRecord):Promise<void> {
    await this.initialized;
    if(record.sessionId!==this.sessionId) return;
    const changed=this.projectionRunId!==record.id;
    this.history=structuredClone(record.messages);this.projectionRunId=record.id;this.projectionMode=true;
    if(changed) await this.saveHistory();
  }
  async openRun(record:RunRecord):Promise<void> {
    await this.initialized;this.sessionId=record.sessionId;this.history=structuredClone(record.messages);
    this.projectionRunId=record.id;this.projectionMode=true;this.selectedFiles.clear();await this.saveHistory();
  }

  /**
   * Clear all chat history
   */
  async clearHistory(): Promise<void> {
    await this.initialized;
    this.history = [];
    this.projectionRunId=undefined;
    this.sessionId = this.generateSessionId();
    await this.saveHistory();
  }

  async restoreSession(sessionId: string, messages: ChatMessage[]): Promise<void> {
    await this.initialized;
    this.sessionId = sessionId;
    this.projectionRunId=undefined;
    this.history = [...messages];
    this.selectedFiles.clear();
    await this.saveHistory();
  }

  /**
   * Get session information
   */
  getSessionInfo(): { sessionId: string; startTime?: number; lastUpdated?: number } {
    return {
      sessionId: this.sessionId,
      startTime: this.history[0]?.timestamp,
      lastUpdated: this.history[this.history.length - 1]?.timestamp
    };
  }

  /**
   * Create a Context object from current chat history
   */
  async createContext(): Promise<Context> {
    await this.initialized;

    // Convert ChatMessage[] to Message[]
    const messages = this.history.map(chatMsg => new Message({
      role: chatMsg.role,
      content: chatMsg.content,
      timestamp: chatMsg.timestamp,
      sources: chatMsg.sources,
      name: chatMsg.name,
      tool_call_id: chatMsg.tool_call_id,
      tool_calls: chatMsg.tool_calls
    }));

    return new Context(messages, {
      sessionId: this.sessionId,
      sessionStartTime: this.history[0]?.timestamp,
      lastUpdated: this.history[this.history.length - 1]?.timestamp
    });
  }

  /**
   * Get context optimized for LLM (convenience method)
   */
  async getContextForLLM(options?: ContextOptions): Promise<unknown[]> {
    const context = await this.createContext();
    return context.getContext('llm', options);
  }

  /**
   * Get context enhanced for display (convenience method)
   */
  async getContextForDisplay(options?: ContextOptions): Promise<unknown[]> {
    const context = await this.createContext();
    return context.getContext('display', options);
  }

  /**
   * Get raw context (convenience method)
   */
  async getRawContext(): Promise<unknown[]> {
    const context = await this.createContext();
    return context.getContext('raw');
  }

  /**
   * Save history to plugin storage
   */
  private async saveHistory(): Promise<void> {
    const data: ChatHistory = {
      sessionId: this.sessionId,
      messages: this.history,
      selectedFiles: Array.from(this.selectedFiles),
      lastUpdated: Date.now()
    };

    const projection=this.projectionMode;
    if(!projection && this.recoveryWarnings.length) throw new Error('旧聊天存储需要恢复，禁止覆盖原始记录');
    const snapshot = JSON.stringify(projection ? {version:1,sessionId:data.sessionId,runId:this.projectionRunId,selectedFiles:data.selectedFiles,
      lastUpdated:data.lastUpdated,...(!this.projectionRunId?{legacyMessages:data.messages}:{})}:data, null, 2);
    const filename=projection?'session_projection.json':'chat_history.json';
    const write = this.pendingWrite.catch(() => undefined).then(async () => {
      if (await this.storage.exists(filename)) {
        const previous = await this.storage.read(filename);
        try {JSON.parse(previous);await this.storage.write(`${filename}.bak`, previous);}
        catch(error) {
          if(!projection) throw error;
          await this.storage.write(`${filename}.corrupt-${Date.now()}`,previous);
        }
      }
      await this.storage.write(filename, snapshot);
    });
    this.pendingWrite = write;
    await write;
  }

  private async loadProjection():Promise<boolean> {
    const path='session_projection.json';
    if(!await this.storage.exists(path)) return false;
    const parse=(text:string)=>{
      const value=JSON.parse(text);
      if(value.version!==1 || typeof value.sessionId!=='string' || !Array.isArray(value.selectedFiles)
        || value.runId!==undefined && typeof value.runId!=='string' || value.legacyMessages!==undefined && !Array.isArray(value.legacyMessages)) throw new Error('Invalid session projection');
      return value;
    };
    let data;
    try {data=parse(await this.storage.read(path));}
    catch(error) {
      if(!await this.storage.exists(`${path}.bak`)) throw error;
      data=parse(await this.storage.read(`${path}.bak`));
      await this.storage.write(`session_projection.corrupt-${Date.now()}.json`,await this.storage.read(path));
      await this.storage.write(path,JSON.stringify(data));
    }
    const sameSession=this.sessionId===data.sessionId;
    this.sessionId=data.sessionId;this.selectedFiles=new Set(data.selectedFiles);this.projectionRunId=data.runId;this.projectionMode=true;
    this.history=data.legacyMessages || (!data.runId && sameSession?this.history:[]);
    return true;
  }

  /**
   * Load history from storage or migrate from legacy plugin data
   */
  private async loadHistory(): Promise<void> {
    try {
      if (await this.storage.exists('chat_history.json')) {
        const content = await this.storage.read('chat_history.json');
        const data = parseJson<ChatHistory>(content);

        if (data && Array.isArray(data.messages)) {
          this.history = data.messages || [];
          this.sessionId = data.sessionId || this.sessionId;
          this.selectedFiles = new Set(data.selectedFiles || []);
        }
      } else {
        // Migration from data.json
        const pluginData = await this.plugin.loadData();
        if (pluginData && pluginData[this.STORAGE_KEY]) {
          const data: ChatHistory = pluginData[this.STORAGE_KEY] as ChatHistory;
          if (data && Array.isArray(data.messages)) {
            this.history = data.messages || [];
            this.sessionId = data.sessionId || this.sessionId;
            this.selectedFiles = new Set(data.selectedFiles || []);
            await this.saveHistory(); // Save to new storage
          }
          // Remove old data to reduce data.json size
          delete pluginData[this.STORAGE_KEY];
          await this.plugin.saveData(pluginData);
        }
      }
    } catch (error) {
      console.error('Failed to load chat history:', error);
      if (await this.storage.exists('chat_history.json.bak')) {
        const backup = parseJson<ChatHistory>(await this.storage.read('chat_history.json.bak'));
        if (Array.isArray(backup.messages)) {
          this.history = backup.messages;
          this.sessionId = backup.sessionId;
          this.selectedFiles = new Set(backup.selectedFiles || []);
          // Keep the damaged original for diagnosis before restoring the valid backup.
          const original = await this.storage.read('chat_history.json');
          await this.storage.write(`chat_history.corrupt-${Date.now()}.json`, original);
          await this.storage.write('chat_history.json', JSON.stringify(backup));
          return;
        }
      }
      throw error;
    }
  }

  /**
   * Generate a unique session ID
   */
  private generateSessionId(): string {
    return `session-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
  }

  /**
   * Add a document to the selected files
   */
  async addDocument(filePath: string): Promise<void> {
    await this.initialized;
    this.selectedFiles.add(filePath);
    await this.saveHistory();
  }

  /**
   * Remove a document from the selected files
   */
  async removeDocument(filePath: string): Promise<void> {
    await this.initialized;
    this.selectedFiles.delete(filePath);
    await this.saveHistory();
  }

  /**
   * Get all selected file paths
   */
  async getSelectedFiles(): Promise<string[]> {
    await this.initialized;
    return Array.from(this.selectedFiles);
  }

  /**
   * Get all selected file paths synchronously
   * Note: Ensure initialization is complete before calling this (e.g., in UI rendering after loadHistory)
   */
  get selectedFilesList(): string[] {
    return Array.from(this.selectedFiles);
  }


  /**
   * Clear all selected documents
   */
  async clearDocuments(): Promise<void> {
    await this.initialized;
    this.selectedFiles.clear();
    await this.saveHistory();
  }

  /**
   * Export chat history as markdown
   */
  async exportAsMarkdown(): Promise<string> {
    await this.initialized;

    let markdown = `# Chat History\n\n`;
    markdown += `Session: ${this.sessionId}\n\n`;
    markdown += `---\n\n`;

    for (const msg of this.history) {
      const date = new Date(msg.timestamp).toLocaleString();
      markdown += `## ${msg.role === 'user' ? 'You' : 'Assistant'} - ${date}\n\n`;
      markdown += `${msg.content}\n\n`;
      markdown += `---\n\n`;
    }

    return markdown;
  }
}
