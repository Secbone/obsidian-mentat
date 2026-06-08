// OpenCode Integration - Optional advanced automation

import PersonalAgentPlugin from '../main';

export interface OpenCodeTask {
  task: string;
  prompt: string;
  data?: any;
}

export interface OpenCodeResult {
  success: boolean;
  result?: any;
  error?: string;
}

export class OpenCodeIntegration {
  private plugin: PersonalAgentPlugin;
  private baseURL: string;
  private apiKey: string;

  constructor(plugin: PersonalAgentPlugin) {
    this.plugin = plugin;
    this.baseURL = plugin.settings.opencodeApiUrl;
    this.apiKey = plugin.settings.opencodeApiKey;
  }

  /**
   * Check if OpenCode is available
   */
  async isAvailable(): Promise<boolean> {
    if (!this.baseURL || !this.apiKey) {
      return false;
    }

    try {
      const response = await fetch(`${this.baseURL}/health`, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`
        }
      });
      return response.ok;
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
      const response = await fetch(`${this.baseURL}/execute`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`
        },
        body: JSON.stringify(task)
      });

      if (!response.ok) {
        throw new Error(`OpenCode API error: ${response.statusText}`);
      }

      const result = await response.json();
      return {
        success: true,
        result: result
      };
    } catch (error) {
      console.error('OpenCode execution error:', error);
      return {
        success: false,
        error: (error as any).message
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
  async batchExtract(notes: string[], schema: Record<string, any>): Promise<OpenCodeResult> {
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
