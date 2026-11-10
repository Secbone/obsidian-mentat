import { App } from 'obsidian';
import { MessageRenderer } from '../../message-renderer';
import { CardTheme } from '../../chat-cards/theme';

export class TerminalTheme extends CardTheme {
  constructor(app: App, renderer: MessageRenderer, preset = 'green') { super('terminal',app,renderer,preset); }
}
