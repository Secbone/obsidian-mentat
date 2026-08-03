// OpenCode Integration - Optional advanced automation

import MentatPlugin from '../main';
import { requestUrl } from 'obsidian';

export interface OpenCodeTask {
  task: string;
  prompt: string;
  data?: unknown;
}

export interface OpenCodeResult {
  success: boolean;
  result?: unknown;
  error?: string;
}

export class OpenCodeIntegration {
  private baseURL: string;
  private apiKey: string;

  constructor(plugin: MentatPlugin) {
    this.baseURL = plugin.settings.opencodeApiUrl;
    this.apiKey = plugin.settings.opencodeApiKey;
  }

  dispose(): void {
    // No persistent resources to clean up
  }

  /**
   * Check if OpenCode is available
   */
  async isAvailable(): Promise<boolean> {
    if (!this.baseURL || !this.apiKey) {
      return false;
    }

    try {
      const response = await requestUrl({
        url: `${this.baseURL}/health`,
        headers: {
          'Authorization': `Bearer ${this.apiKey}`
        }
      });
      return response.status >= 200 && response.status < 300;
    } catch (error) {
      console.error('OpenCode availability check failed:', error);
      return false;
    }
  }

  /**
   * Execute an OpenCode task
   */
  async execute(task: OpenCodeTask): Promise<OpenCodeResult> {
    if (!this.baseURL || !this.apiKey) {
      throw new Error('OpenCode not configured');
    }

    try {
      const response = await requestUrl({
        url: `${this.baseURL}/execute`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`
        },
        body: JSON.stringify(task)
      });

      if (response.status < 200 || response.status >= 300) {
        throw new Error(`OpenCode API error: ${response.status}`);
      }

      const result = response.json;
      return {
        success: true,
        result: result
      };
    } catch (error) {
      console.error('OpenCode execution error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * Batch classify notes using OpenCode
   */
  async batchClassify(notes: string[]): Promise<OpenCodeResult> {
    return await this.execute({
      task: 'batch_classify_notes',
      prompt: '为以下笔记生成分类和标签。返回 JSON 数组，每个元素包含 categories 和 tags。',
      data: { notes }
    });
  }

  /**
   * Batch extract information using OpenCode
   */
  async batchExtract(notes: string[], schema: Record<string, unknown>): Promise<OpenCodeResult> {
    return await this.execute({
      task: 'batch_extract',
      prompt: '从以下笔记中提取结构化信息。',
      data: { notes, schema }
    });
  }

  /**
   * Generate code from notes using OpenCode
   */
  async generateCode(requirements: string, context: string[]): Promise<OpenCodeResult> {
    return await this.execute({
      task: 'generate_code',
      prompt: '根据需求笔记生成代码。',
      data: { requirements, context }
    });
  }

  /**
   * Analyze patterns across notes using OpenCode
   */
  async analyzePatterns(notes: string[]): Promise<OpenCodeResult> {
    return await this.execute({
      task: 'analyze_patterns',
      prompt: '分析笔记中的模式和主题。',
      data: { notes }
    });
  }
}
