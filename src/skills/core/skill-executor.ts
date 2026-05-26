// Skill Executor - Handles skill execution with validation and error handling

import { z } from 'zod';
import { SkillRegistry } from './skill-registry';
import {
  SkillResult,
  SkillCall,
  ToolCall,
  SkillStatus,
  SkillContext,
  SkillDefinition,
  SkillNamespace,
  AnySkillDefinition,
  isDocumentationSkill,
  isExecutableSkill
} from '../skill-types';
import { ConfirmationModal, ConfirmationModalOptions } from '../../ui/confirmation-modal';

/**
 * Skill execution options
 */
export interface ExecutionOptions {
  dryRun?: boolean;           // If true, validate but don't execute
  timeout?: number;            // Execution timeout in ms
  skipConfirmation?: boolean;  // Skip user confirmation even if required
}

/**
 * SkillExecutor handles validation and execution of skills
 */
export class SkillExecutor {
  private executionHistory: SkillCall[] = [];
  private maxHistorySize = 100;

  constructor(
    private registry: SkillRegistry,
    private context: SkillContext
  ) {}

  /**
   * Execute a skill by name
   */
  async execute(
    namespace: SkillNamespace | string,
    name: string,
    parameters: Record,
    options: ExecutionOptions = {}
  ): Promise<SkillResult> {
    const startTime = Date.now();
    const callId = this.generateCallId();

    // Create skill call record
    const skillCall: SkillCall = {
      id: callId,
      skillName: name,
      namespace: this.parseNamespace(namespace),
      parameters,
      status: 'pending',
      timestamp: startTime
    };

    this.addToHistory(skillCall);

    try {
      // Update status to executing
      skillCall.status = 'executing';

      // Get skill definition
      const fullName = typeof namespace === 'string' && namespace.includes(':')
        ? namespace
        : this.registry.getFullName(namespace as SkillNamespace, name);

      const skill = this.registry.get(fullName);

      if (!skill) {
        throw new Error(`Skill not found: ${fullName}`);
      }

      // Handle documentation skills - return content immediately
      if (isDocumentationSkill(skill)) {
        const result: SkillResult = {
          success: true,
          data: {
            type: 'documentation',
            content: skill.content,
            description: skill.description
          },
          metadata: { executionTime: Date.now() - startTime }
        };
        skillCall.result = result;
        skillCall.status = 'success';
        skillCall.executionTime = Date.now() - startTime;
        console.log(`[SkillExecutor] Retrieved documentation: ${fullName}`);
        return result;
      }

      // From here, we know it's an executable skill
      if (!isExecutableSkill(skill)) {
        throw new Error(`Invalid skill type: ${fullName}`);
      }

      // Validate input
      const validatedInput = this.validateInput(skill, parameters);

      // Check if confirmation is required (settings override takes precedence)
      const skillConfig = this.context.plugin?.settings?.skillConfigurations?.[fullName];
      const requiresConfirmation = skillConfig?.requireConfirmation !== undefined
        ? skillConfig.requireConfirmation
        : !!skill.metadata?.requiresConfirmation;

      if (requiresConfirmation && !options.skipConfirmation) {
        const confirmed = await this.requestConfirmation(skill, validatedInput);
        if (!confirmed) {
          const result: SkillResult = {
            success: false,
            error: 'Operation cancelled by user',
            metadata: { executionTime: Date.now() - startTime }
          };
          skillCall.result = result;
          skillCall.status = 'error';
          return result;
        }
      }

      // Check if dry run
      if (options.dryRun) {
        const result: SkillResult = {
          success: true,
          data: { dryRun: true, validatedInput },
          metadata: { executionTime: Date.now() - startTime }
        };
        skillCall.result = result;
        skillCall.status = 'success';
        return result;
      }

      // Execute with timeout
      const timeoutMs = options.timeout || 30000; // Default 30s
      const result = await this.executeWithTimeout(
        skill,
        validatedInput,
        timeoutMs
      );

      // Update call record
      skillCall.result = result;
      skillCall.status = result.success ? 'success' : 'error';
      skillCall.executionTime = Date.now() - startTime;

      console.log(`[SkillExecutor] Executed ${fullName} in ${skillCall.executionTime}ms`);

      return result;
    } catch (error) {
      console.error(`[SkillExecutor] Error executing skill:`, error);

      const result: SkillResult = {
        success: false,
        error: error.message || 'Unknown error',
        metadata: { executionTime: Date.now() - startTime }
      };

      skillCall.result = result;
      skillCall.status = 'error';
      skillCall.executionTime = Date.now() - startTime;

      return result;
    }
  }

  /**
   * Helper: Truncate string at a valid UTF-8 boundary
   */
  private truncateAtValidUtf8(str: string, maxPos: number): string {
    // Ensure we don't cut in the middle of a multi-byte UTF-8 sequence
    // UTF-8 continuation bytes have the pattern 10xxxxxx (0x80-0xBF)
    while (maxPos > 0 && (str.charCodeAt(maxPos) & 0xC0) === 0x80) {
      maxPos--;
    }
    return str.substring(0, maxPos);
  }

  /**
   * Safely parse tool call arguments with recovery strategies
   */
  private safeParseToolArguments(toolCall: ToolCall): Record<string, any> | null {
    if (typeof toolCall.arguments !== 'string') {
      return toolCall.arguments;
    }

    const argsString = toolCall.arguments as string;

    // Try normal parsing first
    try {
      return JSON.parse(argsString);
    } catch (error: any) {
      console.error('[SkillExecutor] JSON parse failed, attempting recovery...');
      console.error('[SkillExecutor] Tool:', toolCall.name, 'Error:', error.message);
      console.error('[SkillExecutor] String length:', argsString.length);
      console.error('[SkillExecutor] First 500 chars:', argsString.substring(0, 500));
      console.error('[SkillExecutor] Last 500 chars:', argsString.substring(Math.max(0, argsString.length - 500)));

      // Extract error position if available
      const posMatch = error.message.match(/position (\d+)/);
      if (posMatch) {
        const pos = parseInt(posMatch[1]);
        console.error('[SkillExecutor] Context around position:', pos,
          argsString.substring(Math.max(0, pos - 100), Math.min(argsString.length, pos + 100)));
      }

      // Recovery Strategy 1: Try to fix unterminated strings
      if (error.message.includes('Unterminated string')) {
        try {
          const fixed = argsString + '"}';
          console.log('[SkillExecutor] Attempting to fix with closing quote and brace...');
          return JSON.parse(fixed);
        } catch {
          // Failed, continue to next strategy
        }
      }

      // Recovery Strategy 2: Try to extract valid JSON prefix with UTF-8 safe truncation
      try {
        let lastValidPos = argsString.lastIndexOf('}');
        if (lastValidPos > 0) {
          const truncated = this.truncateAtValidUtf8(argsString, lastValidPos + 1);
          console.log('[SkillExecutor] Attempting to parse truncated JSON (', truncated.length, 'chars)...');
          return JSON.parse(truncated);
        }
      } catch {
        // Failed, continue
      }

      // All recovery strategies failed
      return null;
    }
  }

  /**
   * Execute a skill from a ToolCall (from AI provider)
   */
  async executeFromToolCall(
    toolCall: ToolCall,
    options: ExecutionOptions = {}
  ): Promise<SkillResult> {
    // Parse parameters with recovery strategies
    const parameters = this.safeParseToolArguments(toolCall);

    if (parameters === null) {
      return {
        success: false,
        error: `Failed to parse tool arguments for ${toolCall.name}. All recovery strategies failed.`
      };
    }

    // Parse skill name
    const { namespace, name } = this.registry.parseName(toolCall.name);

    // Route to appropriate executor
    if (namespace.startsWith('mcp:')) {
      // MCP skill - will be handled by MCP client
      return this.executeMCPSkill(toolCall.name, parameters, options);
    } else {
      // Built-in skill
      return this.execute(namespace, name, parameters, options);
    }
  }

  /**
   * Execute multiple skills in parallel
   */
  async executeBatch(
    calls: Array<{
      namespace: SkillNamespace;
      name: string;
      parameters: Record;
    }>,
    options: ExecutionOptions = {}
  ): Promise<SkillResult[]> {
    const promises = calls.map(call =>
      this.execute(call.namespace, call.name, call.parameters, options)
    );

    return Promise.all(promises);
  }

  /**
   * Validate skill input against schema
   */
  private validateInput(skill: SkillDefinition, input: Record): any {
    try {
      return skill.schema.parse(input);
    } catch (error) {
      if (error instanceof z.ZodError) {
        const issues = error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`);
        throw new Error(`Validation failed: ${issues.join(', ')}`);
      }
      throw error;
    }
  }

  /**
   * Execute skill with timeout
   */
  private async executeWithTimeout(
    skill: SkillDefinition,
    input: any,
    timeoutMs: number
  ): Promise<SkillResult> {
    return Promise.race([
      skill.execute(input),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Skill execution timeout')), timeoutMs)
      )
    ]);
  }

  /**
   * Execute MCP skill (placeholder - will be implemented by MCP client)
   */
  private async executeMCPSkill(
    fullName: string,
    parameters: Record,
    options: ExecutionOptions
  ): Promise<SkillResult> {
    // This will be implemented when MCP client is integrated
    return {
      success: false,
      error: 'MCP skill execution not yet implemented'
    };
  }

  /**
   * Get execution history
   */
  getHistory(limit?: number): SkillCall[] {
    if (limit) {
      return this.executionHistory.slice(-limit);
    }
    return [...this.executionHistory];
  }

  /**
   * Get recent successful executions
   */
  getSuccessfulCalls(limit: number = 10): SkillCall[] {
    return this.executionHistory
      .filter(call => call.status === 'success')
      .slice(-limit);
  }

  /**
   * Get recent failed executions
   */
  getFailedCalls(limit: number = 10): SkillCall[] {
    return this.executionHistory
      .filter(call => call.status === 'error')
      .slice(-limit);
  }

  /**
   * Clear execution history
   */
  clearHistory(): void {
    this.executionHistory = [];
  }

  /**
   * Get statistics
   */
  getStats(): {
    totalCalls: number;
    successRate: number;
    averageExecutionTime: number;
    bySkill: Record;
  } {
    const total = this.executionHistory.length;
    const successful = this.executionHistory.filter(call => call.status === 'success').length;
    const avgTime = this.executionHistory.reduce((sum, call) => sum + (call.executionTime || 0), 0) / total;

    const bySkill: Record = {};
    this.executionHistory.forEach(call => {
      const fullName = `${call.namespace}:${call.skillName}`;
      if (!bySkill[fullName]) {
        bySkill[fullName] = { total: 0, success: 0, failed: 0 };
      }
      bySkill[fullName].total++;
      if (call.status === 'success') {
        bySkill[fullName].success++;
      } else if (call.status === 'error') {
        bySkill[fullName].failed++;
      }
    });

    return {
      totalCalls: total,
      successRate: total > 0 ? successful / total : 0,
      averageExecutionTime: avgTime || 0,
      bySkill
    };
  }

  /**
   * Add call to history (with size limit)
   */
  private addToHistory(call: SkillCall): void {
    this.executionHistory.push(call);

    // Maintain max history size
    if (this.executionHistory.length > this.maxHistorySize) {
      this.executionHistory.shift();
    }
  }

  /**
   * Generate unique call ID
   */
  private generateCallId(): string {
    return `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Parse namespace from string
   */
  private parseNamespace(namespace: string): SkillNamespace {
    if (namespace === 'obsidian') return 'obsidian';
    if (namespace === 'mcp' || namespace.startsWith('mcp:')) return 'mcp';
    return 'obsidian'; // Default
  }

  /**
   * Get execution context
   */
  getContext(): SkillContext {
    return this.context;
  }

  /**
   * Update execution context
   */
  updateContext(updates: Partial): void {
    Object.assign(this.context, updates);
  }

  /**
   * Request user confirmation for a skill execution
   */
  private async requestConfirmation(
    skill: SkillDefinition,
    parameters: Record<string, any>
  ): Promise<boolean> {
    // Determine operation type from skill name
    const operationType = this.getOperationType(skill.name);

    // Show confirmation modal
    return new Promise<boolean>((resolve) => {
      const modal = new ConfirmationModal(
        this.context.plugin.app,
        {
          skillName: skill.name,
          description: skill.description,
          parameters,
          operationType
        },
        (confirmed) => resolve(confirmed)
      );
      modal.open();
    });
  }

  /**
   * Determine operation type from skill name
   */
  private getOperationType(skillName: string): 'create' | 'update' | 'delete' | 'write' {
    const lowerName = skillName.toLowerCase();
    if (lowerName.includes('create')) return 'create';
    if (lowerName.includes('update')) return 'update';
    if (lowerName.includes('delete')) return 'delete';
    return 'write';
  }
}
