import { describe, it, expect, beforeEach } from 'vitest';
import { ChatManager } from '../../src/chat/chat-manager';
import { MemoryPlatformAdapter } from '../utils/memory-platform-adapter';

describe('ChatManager Persistence and Barrier Tests', () => {
  let platform: MemoryPlatformAdapter;
  let mockPlugin: any;

  beforeEach(() => {
    platform = new MemoryPlatformAdapter();
    mockPlugin = {
      platform: platform,
      loadData: async () => platform.loadPluginData(),
      saveData: async (data: any) => platform.savePluginData(data)
    };
  });

  it('should initialize and load empty history when no files exist', async () => {
    const chatManager = new ChatManager(mockPlugin);
    const messages = await chatManager.getHistory();
    expect(messages).toEqual([]);
  });

  it('should handle barrier lock during concurrent initialization', async () => {
    // Write pre-existing history to config file with recent lastUpdated timestamp
    const initialHistory = {
      sessionId: 'session-123',
      messages: [
        { role: 'user', content: 'hello', timestamp: Date.now() - 10000 },
        { role: 'assistant', content: 'hi', timestamp: Date.now() - 5000 }
      ],
      selectedFiles: ['doc.md'],
      lastUpdated: Date.now()
    };
    
    await platform.write('.obsidian/plugins/obsidian-mentat/chat_history.json', JSON.stringify(initialHistory));
    
    const chatManager = new ChatManager(mockPlugin);
    
    // Concurrent call before full load resolved
    await chatManager.addMessage('user', 'new message');
    
    const messages = await chatManager.getHistory();
    expect(messages.length).toBe(3);
    expect(messages[0].content).toBe('hello');
    expect(messages[1].content).toBe('hi');
    expect(messages[2].content).toBe('new message');
  });

  it('should migrate legacy history data from plugin data json safely', async () => {
    // Setup legacy plugin loadData mock containing legacy chat history structure with recent timestamp
    const legacyHistory = {
      sessionId: 'legacy-session',
      messages: [
        { role: 'user', content: 'legacy-msg', timestamp: Date.now() - 10000 }
      ],
      selectedFiles: [],
      lastUpdated: Date.now()
    };

    platform.pluginData = {
      'mentat-chat-history': legacyHistory
    };

    const chatManager = new ChatManager(mockPlugin);
    const messages = await chatManager.getHistory();
    
    // Legacy migration successfully run
    expect(messages.length).toBe(1);
    expect(messages[0].content).toBe('legacy-msg');
    
    // Legacy key in raw data is deleted and config saved
    expect(platform.pluginData['mentat-chat-history']).toBeUndefined();
    
    // History is written into chat_history.json
    const historyFileWritten = await platform.exists('.obsidian/plugins/obsidian-mentat/chat_history.json');
    expect(historyFileWritten).toBe(true);
  });

  it('should clear history and selection correctly', async () => {
    const chatManager = new ChatManager(mockPlugin);
    await chatManager.addMessage('user', 'msg1');
    await chatManager.addDocument('test.md');
    
    expect(await chatManager.getSelectedFiles()).toEqual(['test.md']);
    
    await chatManager.clearHistory();
    expect(await chatManager.getHistory()).toEqual([]);
    
    await chatManager.clearDocuments();
    expect(await chatManager.getSelectedFiles()).toEqual([]);
  });

  it('should enforce MAX_HISTORY_SIZE limits', async () => {
    const chatManager = new ChatManager(mockPlugin);
    
    // Push 105 messages
    for (let i = 0; i < 105; i++) {
      await chatManager.addMessage('user', `msg-${i}`);
    }
    
    const messages = await chatManager.getHistory();
    expect(messages.length).toBe(100);
    // Oldest 5 are discarded
    expect(messages[0].content).toBe('msg-5');
    expect(messages[99].content).toBe('msg-104');
  });
});
