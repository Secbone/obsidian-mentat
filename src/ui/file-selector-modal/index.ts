// File Selector Modal - Fuzzy search interface for selecting documents

import { SuggestModal, TFile, App } from 'obsidian';
import Fuse from 'fuse.js';

export class FileSelectorModal extends SuggestModal<TFile> {
  private files: TFile[];
  private fuse: Fuse<TFile>;
  private onSelect: (file: TFile) => void;

  constructor(
    plugin: { app: App },
    onSelect: (file: TFile) => void
  ) {
    super(plugin.app);
    this.files = plugin.app.vault.getMarkdownFiles();
    this.onSelect = onSelect;

    // Initialize Fuse.js for fuzzy search
    this.fuse = new Fuse(this.files, {
      keys: ['path', 'name', 'basename'],
      threshold: 0.4,
      includeScore: true
    });

    this.setPlaceholder('Search for a document to add to context...');
  }

  getSuggestions(query: string): TFile[] {
    if (!query) {
      // No query - return recently modified files
      return this.files
        .sort((a, b) => b.stat.mtime - a.stat.mtime)
        .slice(0, 10);
    }

    // Use Fuse.js for fuzzy search
    const results = this.fuse.search(query);
    return results.map(r => r.item).slice(0, 10);
  }

  renderSuggestion(file: TFile, el: HTMLElement): void {
    const container = el.createDiv({ cls: 'file-suggestion' });

    // File name
    container.createDiv({
      cls: 'file-suggestion-name',
      text: file.basename
    });

    // Path
    container.createDiv({
      cls: 'file-suggestion-path',
      text: file.path
    });

    // Modification time
    const mtime = new Date(file.stat.mtime);
    container.createDiv({
      cls: 'file-suggestion-time',
      text: this.formatTime(mtime)
    });
  }

  onChooseSuggestion(file: TFile, _evt: MouseEvent | KeyboardEvent): void {
    this.onSelect(file);
  }

  private formatTime(date: Date): string {
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));

    if (days === 0) return 'Today';
    if (days === 1) return 'Yesterday';
    if (days < 7) return `${days} days ago`;
    return date.toLocaleDateString();
  }
}
