// @vitest-environment jsdom
import { vi, describe, it, expect } from 'vitest';
vi.mock('obsidian');
import { ChatView } from '../../src/ui/chat-view';
import { MemoryPlatformAdapter } from '../utils/memory-platform-adapter';

describe('ChatView UI Smoke Test', () => {
  it('should initialize without throwing', async () => {
    const platform = new MemoryPlatformAdapter();
    
    const mockPlugin = {
      platform,
      extensionManager: {
        getEventBus: () => ({
          on: vi.fn(),
          emit: vi.fn(),
          off: vi.fn(),
          removeAll: vi.fn(),
        }),
      },
      settings: {
        chatTheme: 'bubble',
        chatEnabled: true,
        sendWithCmdEnter: false,
        skillInvocationMode: 'auto',
        skillsEnabled: true,
        maxTurns: 20,
        terminalPreset: 'green',
      },
      chatOrchestrator: {
        getSkillInvocationContext: () => null,
        getSkillRegistry: () => ({
          register: vi.fn(), registerBulk: vi.fn(), get: vi.fn(), getAll: () => [],
          getFullName: (ns: string, name: string) => `${ns}:${name}`,
          parseName: (fullName: string) => {
            const parts = fullName.split(':');
            return { namespace: parts[0], name: parts.slice(1).join(':') };
          },
        }),
        getSkillExecutor: vi.fn(),
      },
      loadData: async () => ({}),
      saveData: async () => {},
      manifest: { id: 'mentat' },
      app: {
        vault: { getMarkdownFiles: () => [], getAbstractFileByPath: () => null },
        setting: { open: vi.fn(), openTabById: vi.fn() },
        workspace: { getActiveFile: () => null },
      }
    } as any;

    const mockLeaf = { app: mockPlugin.app } as any;

    // Constructor should not throw
    expect(() => new ChatView(mockLeaf, mockPlugin)).not.toThrow();
  });
});
