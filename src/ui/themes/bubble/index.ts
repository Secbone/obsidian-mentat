import { App } from 'obsidian';
import { MessageRenderer } from '../../message-renderer';
import { CardTheme } from '../../chat-cards/theme';

export class BubbleTheme extends CardTheme {
  constructor(app: App, renderer: MessageRenderer) { super('bubble',app,renderer); }
}
