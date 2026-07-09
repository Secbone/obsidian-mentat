import { ChatMessage } from '../../types';

export interface ChatTheme {
  readonly id: string;
  readonly name: string;
  readonly description: string;

  mount(container: HTMLElement, callbacks: ThemeCallbacks): void;
  unmount(): void;

  renderUserMessage(content: string): HTMLElement;
  renderAssistantMessage(data: AssistantMessageData): HTMLElement;

  createStreamingBubble(): StreamingBubble;
  updateStreamingUI(bubble: StreamingBubble, data: StreamingUpdateData): void;
  finalizeStreaming(bubble: StreamingBubble, data: AssistantMessageData): HTMLElement;

  renderSteerCard(message: string): HTMLElement;
  renderError(message: string): HTMLElement;
  renderInfoBanner(message: string): HTMLElement;
  renderConfirmRequest(data: ConfirmRequestData): HTMLElement;

  scrollToBottom(): void;

  createInputArea(): InputAreaElements;
  updateInputState(state: InputState): void;

  getMessagesContainer(): HTMLElement;
  getInputArea(): HTMLDivElement;
  getSendButton(): HTMLButtonElement;
  updatePreset?(preset: string): void;
}

export interface ThemeCallbacks {
  onSend: (text: string, contextPaths: string[]) => void;
  onSteer: (text: string) => void;
  onCancel: () => void;
  onClear: () => void;
  onConfirmApprove: (taskId: string) => void;
  onConfirmReject: (taskId: string) => void;
  onAddDocument: () => void;
  onRemoveDocument: (path: string) => void;
  onSettings: () => void;
  onExportDiagnostics: () => void;
  onToggleOutput: (typeKey: string) => void;
}

export interface AssistantMessageData {
  toolCalls?: ToolCallRender[];
  explanation?: string;
  finalAnswer?: string;
  interrupted?: boolean;
  subagentTraces?: SubagentTrace[];
  messages?: ChatMessage[];
}

export interface ToolCallRender {
  id: string;
  name: string;
  status: 'pending' | 'executing' | 'success' | 'error' | 'confirm';
  params?: Record<string, unknown>;
  result?: unknown;
  error?: string;
  explanation?: string;
}

export interface ConfirmRequestData {
  taskId: string;
  skillName: string;
  description: string;
  parameters: Record<string, unknown>;
  operationType: 'create' | 'update' | 'delete' | 'write';
}

export interface StreamingBubble {
  el: HTMLElement;
  consoleContainer: HTMLElement;
  answerContainer: HTMLElement;
}

export interface StreamingUpdateData {
  statusMessage: string;
  activeTasks: ToolCallRender[];
  explanation?: string;
  finalAnswer?: string;
  force?: boolean;
  lastToolStatus?: { name: string; status: 'success' | 'error' | 'pending' };
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
  isStreaming: boolean;
  charCount: number;
  documentCount: number;
}

export interface SubagentTrace {
  role: string;
  content: string;
  toolCalls?: Array<{ name: string; status: string; result?: unknown }>;
}

export interface DocumentItem {
  path: string;
  basename: string;
  extension: string;
  indexed: boolean;
}
