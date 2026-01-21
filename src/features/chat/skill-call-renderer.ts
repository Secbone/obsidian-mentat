// Skill Call Renderer - Renders skill execution status in chat

import { SkillCall } from '../../skills/skill-types';

export class SkillCallRenderer {
  /**
   * Render a skill call as HTML
   */
  static render(skillCall: SkillCall): HTMLElement {
    const container = document.createElement('div');
    container.className = `skill-call skill-call-${skillCall.status}`;

    // Header
    const header = container.createDiv({ cls: 'skill-call-header' });

    const icon = header.createSpan({ cls: 'skill-call-icon' });
    icon.textContent = this.getStatusIcon(skillCall.status);

    const title = header.createSpan({ cls: 'skill-call-title' });
    title.textContent = `${skillCall.namespace}:${skillCall.skillName}`;

    const status = header.createSpan({ cls: 'skill-call-status' });
    status.textContent = this.getStatusText(skillCall.status);

    // Parameters (collapsible)
    if (Object.keys(skillCall.parameters).length > 0) {
      const paramsSection = container.createDiv({ cls: 'skill-call-section' });
      const paramsHeader = paramsSection.createDiv({ cls: 'skill-call-section-header' });
      paramsHeader.textContent = '📋 Parameters';

      const paramsContent = paramsSection.createDiv({ cls: 'skill-call-section-content' });
      paramsContent.createEl('pre', {
        text: JSON.stringify(skillCall.parameters, null, 2)
      });
    }

    // Result
    if (skillCall.result) {
      const resultSection = container.createDiv({ cls: 'skill-call-section' });
      const resultHeader = resultSection.createDiv({ cls: 'skill-call-section-header' });
      resultHeader.textContent = skillCall.result.success ? '✅ Result' : '❌ Error';

      const resultContent = resultSection.createDiv({ cls: 'skill-call-section-content' });

      if (skillCall.result.success && skillCall.result.data) {
        resultContent.createEl('pre', {
          text: JSON.stringify(skillCall.result.data, null, 2)
        });
      } else if (skillCall.result.error) {
        resultContent.createEl('div', {
          cls: 'skill-call-error',
          text: skillCall.result.error
        });
      }

      // Metadata
      if (skillCall.result.metadata) {
        const meta = skillCall.result.metadata;
        const metaDiv = resultContent.createDiv({ cls: 'skill-call-metadata' });

        if (meta.executionTime) {
          metaDiv.createSpan({ text: `⏱️ ${meta.executionTime}ms` });
        }

        if (meta.filesModified && meta.filesModified.length > 0) {
          metaDiv.createSpan({ text: `📝 Modified: ${meta.filesModified.length} files` });
        }

        if (meta.filesCreated && meta.filesCreated.length > 0) {
          metaDiv.createSpan({ text: `➕ Created: ${meta.filesCreated.length} files` });
        }
      }
    }

    return container;
  }

  /**
   * Get status icon
   */
  private static getStatusIcon(status: string): string {
    switch (status) {
      case 'pending':
        return '⏳';
      case 'executing':
        return '⚙️';
      case 'success':
        return '✅';
      case 'error':
        return '❌';
      default:
        return '❓';
    }
  }

  /**
   * Get status text
   */
  private static getStatusText(status: string): string {
    switch (status) {
      case 'pending':
        return 'Pending';
      case 'executing':
        return 'Executing...';
      case 'success':
        return 'Success';
      case 'error':
        return 'Error';
      default:
        return 'Unknown';
    }
  }

  /**
   * Update an existing skill call element
   */
  static update(element: HTMLElement, skillCall: SkillCall): void {
    // Update status class
    element.className = `skill-call skill-call-${skillCall.status}`;

    // Update status text
    const statusEl = element.querySelector('.skill-call-status');
    if (statusEl) {
      statusEl.textContent = this.getStatusText(skillCall.status);
    }

    // Update icon
    const iconEl = element.querySelector('.skill-call-icon');
    if (iconEl) {
      iconEl.textContent = this.getStatusIcon(skillCall.status);
    }

    // Add result if completed
    if (skillCall.result && !element.querySelector('.skill-call-section')) {
      const resultSection = element.createDiv({ cls: 'skill-call-section' });
      const resultHeader = resultSection.createDiv({ cls: 'skill-call-section-header' });
      resultHeader.textContent = skillCall.result.success ? '✅ Result' : '❌ Error';

      const resultContent = resultSection.createDiv({ cls: 'skill-call-section-content' });

      if (skillCall.result.success && skillCall.result.data) {
        resultContent.createEl('pre', {
          text: JSON.stringify(skillCall.result.data, null, 2)
        });
      } else if (skillCall.result.error) {
        resultContent.createEl('div', {
          cls: 'skill-call-error',
          text: skillCall.result.error
        });
      }
    }
  }
}
