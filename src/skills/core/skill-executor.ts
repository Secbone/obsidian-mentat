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
import { DiagnosticsLogger } from '../../agents/agent-types';
import { RunRuntime, RunBlocked, RunSuspended } from '../../runtime/types';
import { fingerprint } from '../../runtime/fingerprint';
import { abortable, throwIfAborted, errorDetails, isAbortError } from '../../utils/execution';

/**
 * Skill execution options
 */
export interface ExecutionOptions {
  runtime?: RunRuntime;
  operationId?: string;
  fingerprint?: string;
  dryRun?: boolean;           // If true, validate but don't execute
  timeout?: number;            // Execution timeout in ms
  skipConfirmation?: boolean;  // Skip user confirmation even if required
  abortSignal?: AbortSignal;   // Abort signal for execution cancellation
  sessionId?: string;
  runId?: string;
  agentId?: string;
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
  private static writeBarriers = new WeakMap<object, { tail: Promise<void> }>();
  private writeBarrier: { tail: Promise<void> };

  constructor(
    private registry: SkillRegistry,
    private context: SkillContext,
    private eventBus?: EventBus,
    private diagnosticsLogger?: DiagnosticsLogger,
  ) {
    const key = context.vault || context;
    this.writeBarrier = SkillExecutor.writeBarriers.get(key) || { tail: Promise.resolve() };
    SkillExecutor.writeBarriers.set(key, this.writeBarrier);
  }

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
    const callId = options.operationId || this.generateCallId();

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
      throwIfAborted(options.abortSignal);
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

      const category = skill.metadata?.executionCategory || 'external';
      const previous = options.runtime?.getOperation(callId);
      if (previous?.status === 'finished' && previous.result) return previous.result;
      if (previous?.status === 'unknown' || previous?.status === 'running') throw new RunBlocked('操作结果尚未确认，不能重复执行');
      await options.runtime?.setOperation({ id: callId, name: fullName, category, status: 'planned' });

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
              success: false, outcome: 'denied',
              error: `Skill requires permissions [${denied.join(', ')}] which are not granted in settings`,
              metadata: { executionTime: Date.now() - startTime }
            };
            await options.runtime?.setOperation({ id: callId, name: fullName, category, status: 'finished', result });
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
        if (options.runtime) {
          options.fingerprint = await this.approvalFingerprint(fullName, validatedInput);
          const response = await options.runtime.interact({ id: `${callId}:approval`, operationId: callId, kind: 'approval',
            question: `允许执行 ${fullName}？`, context: JSON.stringify(validatedInput, null, 2), fingerprint: options.fingerprint });
          if (response.kind !== 'approved') return { success: false, outcome: response.kind === 'expired' ? 'expired' : response.kind === 'rejected' ? 'denied' : 'cancelled', error: '操作未获授权' };
        } else {
          const taskId = `${fullName}:${callId}`;
          const response = this.waitForConfirm(taskId, 300000, options.abortSignal);
          this.eventBus?.emit({ type: 'confirm:request', taskId, skillName: fullName, params: validatedInput,
            message: `智能体申请执行操作: 【${skill.description}】。是否批准？`, sessionId: options.sessionId, runId: options.runId, agentId: options.agentId });
          const outcome = await response;
          if (outcome !== 'approved') return { success: false, outcome: outcome === 'expired' ? 'expired' : 'denied', error: outcome === 'expired' ? 'Approval expired' : 'Operation rejected by user' };
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
      const timeoutMs = category === 'interaction' ? 0 : options.timeout || 30000; // Default 30s
      const result = await this.executeWithTimeout(
        skill,
        validatedInput,
        timeoutMs,
        options
      );

      result.outcome ||= result.success ? 'success' : 'failure';
      await options.runtime?.setOperation({ id: callId, name: fullName, category, status: 'finished', result });
      // Update call record
      skillCall.result = result;
      skillCall.status = result.success ? 'success' : 'error';
      skillCall.executionTime = Date.now() - startTime;

      console.log(`[SkillExecutor] Executed ${fullName} in ${skillCall.executionTime}ms`);

      return result;
    } catch (error) {
      if (error instanceof RunSuspended) {
        const operation = options.runtime?.getOperation(callId);
        if (operation?.category === 'orchestration') await options.runtime!.setOperation({ ...operation, status: 'planned' });
        throw error;
      }
      if (error instanceof RunBlocked) {
        const operation = options.runtime?.getOperation(callId);
        if (operation?.status === 'running') await options.runtime!.setOperation({ ...operation, status: 'unknown' });
        throw error;
      }
      console.error(`[SkillExecutor] Error executing skill:`, error);
      if (!options.runtime) await this.diagnosticsLogger?.logIncident({
        agentId: options.agentId || 'skill-executor', agentName: 'Skill Executor',
        sessionId: options.sessionId, runId: options.runId, kind: 'tool', toolName: `${namespace}:${name}`,
        originalArgs: JSON.stringify(parameters), errorMessage: error instanceof Error ? error.message : String(error),
        strategy: 'execution', success: false, details: errorDetails(error),
      });

      const result: SkillResult = {
        success: false,
        outcome: isAbortError(error) ? 'cancelled' : error instanceof z.ZodError || /Validation failed/.test(String(error)) ? 'input_error' : /timeout/i.test(String(error)) ? 'timeout' : 'failure',
        error: error instanceof Error ? error.message : String(error) || 'Unknown error',
        metadata: { executionTime: Date.now() - startTime }
      };

      const operation = options.runtime?.getOperation(callId);
      if (operation) {
        const uncertain = operation.status === 'running' && operation.category !== 'read' && operation.category !== 'interaction';
        if (uncertain) result.outcome = 'unknown';
        await options.runtime!.setOperation({ ...operation, status: uncertain ? 'unknown' : 'finished', result });
      }
      skillCall.result = result;
      skillCall.status = 'error';
      skillCall.executionTime = Date.now() - startTime;
      return result;
    }
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

    // Parse skill name (convert __ to : for names from AI provider)
    const normalizedName = toolCall.name.replace(/__/g, ':');
    const { namespace, name } = this.registry.parseName(normalizedName);

    // Route to appropriate executor
    if (namespace.startsWith('mcp:')) {
      // MCP skill - will be handled by MCP client
      return this.executeMCPSkill(normalizedName, parameters, options);
    } else {
      // Built-in skill
      return this.execute(namespace, name, parameters, { ...options, operationId: options.operationId || toolCall.id });
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
    throwIfAborted(options.abortSignal);
    const controller = new AbortController();
    const onAbort = () => controller.abort(options.abortSignal?.reason);
    options.abortSignal?.addEventListener('abort', onAbort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
      throwIfAborted(controller.signal);
      if (options.fingerprint && options.fingerprint !== await this.approvalFingerprint(skill.namespace + ':' + skill.name, input as Record<string, unknown>)) throw new RunBlocked('授权后文件已变化，请重新核对并授权');
      if (options.runtime && options.operationId && skill.metadata?.executionCategory !== 'interaction') {
        const operation = options.runtime.getOperation(options.operationId)!;
        await options.runtime.setOperation({ ...operation, status: 'running' });
      }
      throwIfAborted(controller.signal);
      if (timeoutMs > 0) timer = setTimeout(() => controller.abort(new Error('Skill execution timeout; 操作结果尚未确认，请先核对实际结果。')), timeoutMs);
      return skill.execute(input, { abortSignal: controller.signal, runtime: options.runtime, operationId: options.operationId });
    };
    const serial = !['read', 'interaction', 'orchestration'].includes(skill.metadata?.executionCategory || 'external');
    const operation = serial ? this.writeBarrier.tail.then(run) : run();
    // Keep the write barrier until the actual operation settles, even after timeout.
    if (serial) this.writeBarrier.tail = operation.then(() => undefined, () => undefined);
    void operation.then(async result => {
      if (controller.signal.aborted && options.runtime && options.operationId) {
        const operation = options.runtime.getOperation(options.operationId);
        if (operation) await options.runtime.setOperation({ ...operation, status: 'finished', result });
      }
      if (controller.signal.aborted && !options.runtime) await this.diagnosticsLogger?.logIncident({
        agentId: options.agentId || 'skill-executor', agentName: 'Skill Executor',
        sessionId: options.sessionId, runId: options.runId, kind: 'tool-late-result', toolName: skill.name,
        originalArgs: '', errorMessage: '工具在停止等待后返回，已记录实际结果。', strategy: 'late-result',
        success: result.success, details: { result },
      });
    }).catch(error => { if (controller.signal.aborted) console.error('[SkillExecutor] Late operation result:', error); });
    try {
      return await abortable(operation, controller.signal);
    } finally {
      clearTimeout(timer);
      options.abortSignal?.removeEventListener('abort', onAbort);
    }
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
    if (namespace === 'custom') return 'custom';
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

  private async approvalFingerprint(name: string, input: Record<string, unknown>): Promise<string> {
    const paths = new Set<string>();
    const visit = (value: unknown, key = '') => {
      if (typeof value === 'string' && /path(s)?$/i.test(key)) paths.add(value);
      else if (Array.isArray(value)) value.forEach(item => visit(item, key));
      else if (value && typeof value === 'object') Object.entries(value).forEach(([k,v]) => visit(v,k));
    };
    visit(input);
    const files: Record<string, string | null> = {};
    for (const path of paths) {
      const file = this.context.vault?.getAbstractFileByPath(path);
      files[path] = file && 'extension' in file ? await this.context.vault.read(file as import('obsidian').TFile) : null;
    }
    return fingerprint({ name, input, files });
  }

  /**
   * Wait for user confirmation via EventBus
   */
  private async waitForConfirm(taskId: string, timeout = 300000, signal?: AbortSignal): Promise<'approved' | 'rejected' | 'expired'> {
    throwIfAborted(signal);
    let timer: ReturnType<typeof setTimeout>;
    let unsub: (() => void) | undefined;
    const pending = new Promise<'approved' | 'rejected' | 'expired'>((resolve) => {
      unsub = this.eventBus?.on('confirm:response', (data) => {
        if (data && (data as Record<string, unknown>).taskId === taskId) {
          unsub?.();
          resolve((data as Record<string, unknown>).approved ? 'approved' : 'rejected');
        }
      });
      timer = setTimeout(() => resolve('expired'), timeout);
    });
    try { return await abortable(pending, signal); }
    finally { clearTimeout(timer!); unsub?.(); }
  }
}
