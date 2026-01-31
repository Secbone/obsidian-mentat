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
import { ConfirmationModal, ConfirmationModalOptions } from '../../ui/components/confirmation-modal';

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

      // Check if confirmation is required
      if (skill.metadata?.requiresConfirmation && !options.skipConfirmation) {
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
   * Execute a skill from a ToolCall (from AI provider)
   */
  async executeFromToolCall(
    toolCall: ToolCall,
    options: ExecutionOptions = {}
  ): Promise<SkillResult> {
    // Parse parameters
    let parameters: Record;
    if (typeof toolCall.arguments === 'string') {
      try {
        parameters = JSON.parse(toolCall.arguments);
      } catch (error) {
        return {
          success: false,
          error: `Invalid JSON in tool arguments: ${error.message}`
        };
      }
    } else {
      parameters = toolCall.arguments;
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
