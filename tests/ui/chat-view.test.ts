// @vitest-environment jsdom
import { vi, describe, it, expect } from 'vitest';
import { ChatView } from '../../src/ui/chat-view';
import { MemoryPlatformAdapter } from '../utils/memory-platform-adapter';
import { WorkspaceLeaf } from 'obsidian';

describe('ChatView UI Smoke Test', () => {
  it('should initialize and run onOpen without throwing error', async () => {
    const platform = new MemoryPlatformAdapter();
    
    // Create a robust Mock MentatPlugin
    const mockPlugin = {
      platform: platform,
      settings: {
        chatEnabled: true,
        sendWithCmdEnter: false,
        sendWithCmdEnterOnly: false,
        skillInvocationMode: 'auto',
      },
      chatOrchestrator: {
        getSkillInvocationContext: () => null,
      },
      loadData: async () => ({}),
      saveData: async () => {},
      manifest: { id: 'mentat' },
      app: {
        vault: {
          getMarkdownFiles: () => [],
          getAbstractFileByPath: () => null,
        },
        setting: {
          open: vi.fn(),
          openTabById: vi.fn(),
        },
        workspace: {
          getActiveFile: () => null,
        }
      }
    } as any;

    const mockLeaf = {
      app: mockPlugin.app
    } as any;
    const view = new ChatView(mockLeaf, mockPlugin);

    // Call onOpen to simulate Obsidian mounting the view
    await expect(view.onOpen()).resolves.not.toThrow();

    // Verify elements are created in container
    const container = view.containerEl.children[1];
    expect(container).toBeDefined();

    // Verify DOM items are created
    const header = container.querySelector('.chat-header');
    expect(header).toBeDefined();

    const inputArea = container.querySelector('.chat-input');
    expect(inputArea).toBeDefined();
    expect(inputArea?.getAttribute('contenteditable')).toBe('true');

    // Confirm that event listeners setup worked by checking settings button action
    const settingsBtn = container.querySelector('[aria-label="Settings"]');
    expect(settingsBtn).toBeDefined();
    
    // Trigger action to see if the mock setting window responds (confirms setupEventListeners executed)
    if (settingsBtn) {
      (settingsBtn as HTMLElement).click();
      expect(mockPlugin.app.setting.open).toHaveBeenCalled();
    }
  });
});
