import type { CardAction, ChatCard, ChatViewState } from '../chat-cards/types';

export interface ChatTheme {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  mount(container: HTMLElement, callbacks: ThemeCallbacks): void;
  unmount(): void;
  render(state: ChatViewState): void;
  scrollToBottom(): void;
  getInputAreaElements(): InputAreaElements;
  updateInputState(state: InputState): void;
  getMessagesContainer(): HTMLElement;
  getInputArea(): HTMLDivElement;
  getSendButton(): HTMLButtonElement;
  updatePreset?(preset: string): void;
}
export interface ThemeCallbacks {
  onSend: () => void;
  onCancel: () => void;
  onClear: () => void;
  onAddDocument: () => void;
  onSettings: () => void;
  onInspect: () => void;
  onExportDiagnostics: () => void;
  onCardAction: (card: ChatCard, action: CardAction, answer?: string) => Promise<void>;
}
export interface InputAreaElements {
  container: HTMLElement;
  wrapper: HTMLElement;
  inputArea: HTMLDivElement;
  sendButton: HTMLButtonElement;
  charCountEl: HTMLElement;
  badgesEl: HTMLElement;
  documentPanel: HTMLElement;
  documentList: HTMLElement;
  addDocumentButton: HTMLButtonElement;
}
export interface InputState {
  mode: 'send' | 'steer' | 'blocked';
  charCount: number;
  documentCount: number;
}
