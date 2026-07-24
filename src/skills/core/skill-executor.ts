// Skill Executor - Handles skill execution with validation and error handling

import { z } from 'zod';
import { SkillRegistry } from './skill-registry';
import {
  SkillResult,
  SkillCall,
  ToolCall,
  SkillContext,
  SkillDefinition,
  SkillNamespace,
  isDocumentationSkill,
  isExecutableSkill
} from '../skill-types';
import { safeParseJson } from '../../utils/json-healer';
import { EventBus } from '../../extensions/event-bus';
import { AgentEvent } from '../../agents/agent-types';

/**
 * Skill execution options
 */
export interface ExecutionOptions {
  dryRun?: boolean;           // If true, validate but don't execute
  timeout?: number;            // Execution timeout in ms
  skipConfirmation?: boolean;  // Skip user confirmation even if required
  abortSignal?: AbortSignal;   // Abort signal for execution cancellation
}

export interface SkillStats {
  total: number;
  success: number;
  failed: number;
}

/**
 * SkillExecutor handles validation and execution of skills
 */
export class SkillExecutor {
  private executionHistory: SkillCall[] = [];
  private maxHistorySize = 100;

  constructor(
    private registry: SkillRegistry,
    private context: SkillContext,
    private eventBus?: EventBus,
  ) {}

  /**
   * Execute a skill by name
   */
  async execute(
    namespace: SkillNamespace | (string & NonNullable<unknown>),
    name: string,
    parameters: Record<string, unknown>,
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

      // Check permissions (skills declare required permissions, user settings can restrict)
      const declaredPermissions = skill.metadata?.permissions;
      if (declaredPermissions && declaredPermissions.length > 0) {
        const skillConfig = this.context.plugin?.settings?.skillConfigurations?.[fullName];
        const allowedPermissions = skillConfig?.allowedPermissions as string[] | undefined;
        if (allowedPermissions) {
          // User has explicitly allowed only certain permissions
          const denied = declaredPermissions.filter(p => !allowedPermissions.includes(p));
          if (denied.length > 0) {
            const result: SkillResult = {
              success: false,
              error: `Skill requires permissions [${denied.join(', ')}] which are not granted in settings`,
              metadata: { executionTime: Date.now() - startTime }
            };
            skillCall.result = result;
            skillCall.status = 'error';
            return result;
          }
        }
      }

      // Check if confirmation is required (settings override takes precedence)
      const skillConfig = this.context.plugin?.settings?.skillConfigurations?.[fullName];
      const requiresConfirmation = skillConfig?.requireConfirmation !== undefined
        ? skillConfig.requireConfirmation
        : !!skill.metadata?.requiresConfirmation;

      if (requiresConfirmation && !options.skipConfirmation) {
        const fullName = typeof namespace === 'string' && namespace.includes(':')
          ? namespace
          : this.registry.getFullName(namespace as SkillNamespace, name);
        this.eventBus?.emit({
          type: 'confirm_request' as AgentEvent['type'],
          skillName: fullName,
          params: validatedInput,
          message: `智能体申请执行操作: 【${skill.description}】。是否批准？`,
        } as AgentEvent);
        const approved = await this.waitForConfirm(fullName);
        if (!approved) {
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
        timeoutMs,
        options
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
        error: error instanceof Error ? error.message : String(error) || 'Unknown error',
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

  private safeParseToolArguments(toolCall: ToolCall): Record<string, unknown> {
    if (typeof toolCall.arguments !== 'string') {
      return toolCall.arguments;
    }
    return safeParseJson(toolCall.arguments);
  }

  /**
   * Execute a skill from a ToolCall (from AI provider)
   */
  async executeFromToolCall(
    toolCall: ToolCall,
    options: ExecutionOptions = {}
  ): Promise<SkillResult> {
    // Parse parameters strictly
    let parameters: Record<string, unknown>;
    try {
      parameters = this.safeParseToolArguments(toolCall);
    } catch (parseError: unknown) {
      console.error('[SkillExecutor] JSON parse and healing failed for', toolCall.name);
      const detail = parseError instanceof Error ? parseError.message : String(parseError);
      return {
        success: false,
        error: `Failed to parse tool arguments for ${toolCall.name}. ${detail} Please regenerate the tool call with valid JSON formatting.`
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
      parameters: Record<string, unknown>;
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
  private validateInput(skill: SkillDefinition, input: Record<string, unknown>): Record<string, unknown> {
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
    input: unknown,
    timeoutMs: number,
    options: ExecutionOptions = {}
  ): Promise<SkillResult> {
    const promises: Promise<SkillResult>[] = [
      skill.execute(input)
    ];

    if (options.abortSignal) {
      if (options.abortSignal.aborted) {
        throw new DOMException('The user aborted a request.', 'AbortError');
      }
      promises.push(
        new Promise<SkillResult>((_, reject) => {
          const onAbort = () => {
            options.abortSignal?.removeEventListener('abort', onAbort);
            reject(new DOMException('The user aborted a request.', 'AbortError'));
          };
          options.abortSignal?.addEventListener('abort', onAbort);
        })
      );
    }

    promises.push(
      new Promise<SkillResult>((_, reject) =>
        window.setTimeout(() => reject(new Error('Skill execution timeout')), timeoutMs)
      )
    );

    return Promise.race<SkillResult>(promises);
  }

  /**
   * Execute MCP skill (placeholder - will be implemented by MCP client)
   */
  private async executeMCPSkill(
    _fullName: string,
    _parameters: Record<string, unknown>,
    _options: ExecutionOptions
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
    bySkill: Record<string, SkillStats>;
  } {
    const total = this.executionHistory.length;
    const successful = this.executionHistory.filter(call => call.status === 'success').length;
    const avgTime = this.executionHistory.reduce((sum, call) => sum + (call.executionTime || 0), 0) / total;

    const bySkill: Record<string, SkillStats> = {};
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
    return `call_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
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
  updateContext(updates: Partial<SkillContext>): void {
    Object.assign(this.context, updates);
  }

  /**
   * Wait for user confirmation via EventBus
   */
  private waitForConfirm(skillName: string, timeout = 300000): Promise<boolean> {
    return new Promise((resolve) => {
      const unsub = this.eventBus?.on('confirm_response', (data) => {
        if (data && (data as Record<string, unknown>).id === skillName) {
          unsub?.();
          resolve(!!(data as Record<string, unknown>).approved);
        }
      });
      setTimeout(() => { unsub?.(); resolve(false); }, timeout);
    });
  }
}
