// Message Renderer - Converts markdown to HTML safely

export class MessageRenderer {
  /**
   * Render markdown content to HTML
   */
  render(content: string): string {
    // Check if content contains sources section
    const parts = content.split('---\n**Sources:**');

    if (parts.length === 2) {
      const mainContent = this.simpleMarkdownToHtml(parts[0]);
      const sources = this.renderSources(parts[1]);
      return mainContent + sources;
    }

    return this.simpleMarkdownToHtml(content);
  }

  /**
   * Render sources section with special styling
   */
  private renderSources(sourcesText: string): string {
    const sourcesHtml = this.simpleMarkdownToHtml(sourcesText);

    return `
      <div class="message-sources">
        <div class="sources-header">
          <span class="sources-icon">📚</span>
          <span class="sources-title">Sources</span>
        </div>
        <div class="sources-list">
          ${sourcesHtml}
        </div>
      </div>
    `.trim();
  }

  /**
   * Simple markdown to HTML converter
   * Handles: headers, bold, italic, code blocks, inline code, links, lists
   */
  private simpleMarkdownToHtml(text: string): string {
    // First escape HTML
    let html = this.escapeHtml(text);

    // Code blocks (must come before inline code)
    html = html.replace(/```(\w+)?\n([\s\S]*?)```/g, (match, lang, code) => {
      const language = lang || 'text';
      const codeId = `code-${Math.random().toString(36).substr(2, 9)}`;
      const escapedLang = this.escapeHtml(language);

      return `
        <div class="code-block-wrapper">
          <div class="code-block-header">
            <span class="code-block-language">${escapedLang}</span>
            <button class="code-copy-button" data-code-id="${codeId}" aria-label="Copy code">Copy</button>
          </div>
          <pre><code class="language-${escapedLang}" id="${codeId}">${code.trim()}</code></pre>
        </div>
      `.trim();
    });

    // Inline code
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Bold
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/__(.+?)__/g, '<strong>$1</strong>');

    // Italic
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
    html = html.replace(/_(.+?)_/g, '<em>$1</em>');

    // Links
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, text, url) => {
      return `<a href="${this.escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${text}</a>`;
    });

    // Headers
    html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

    // Unordered lists
    html = html.replace(/^[*-] (.+)$/gm, '<li>$1</li>');

    // Ordered lists
    html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');

    // Wrap consecutive <li> in <ul>
    html = html.replace(/(<li>.*?<\/li>\n?)+/g, '<ul>$&</ul>');

    // Paragraphs (lines separated by blank lines)
    const paragraphs = html.split('\n\n');
    html = paragraphs.map(para => {
      // Don't wrap if already wrapped in block element
      if (para.match(/^<(h[1-6]|pre|ul|ol|blockquote|div)/)) {
        return para;
      }
      // Replace single newlines with <br>
      return `<p>${para.replace(/\n/g, '<br>')}</p>`;
    }).join('\n');

    return html;
  }

  /**
   * Escape HTML entities to prevent XSS
   */
  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}
