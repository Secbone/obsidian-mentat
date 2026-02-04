// BaseAgent - Base class for all agents with skill support

import { AIProvider, ChatMessage, ToolCall, GenerateResponse } from '../types';
import { SkillRegistry } from '../skills/core/skill-registry';
import { SkillExecutor } from '../skills/core/skill-executor';
import { SkillInvocationContext } from '../skills/strategies/skill-invocation-strategy';
import { SkillCall, isExecutableSkill } from '../skills/skill-types';
import { AgentConfig, AgentContext, AgentResponse } from './agent-types';

/**
 * Dependencies required by BaseAgent
 */
export interface AgentDependencies {
  skillRegistry: SkillRegistry;
  skillExecutor: SkillExecutor;
  skillInvocationContext: SkillInvocationContext;
}

/**
 * BaseAgent - Handles agent execution with skill support
 */
export class BaseAgent {
  protected config: AgentConfig;
  protected provider: AIProvider;
  protected skillRegistry: SkillRegistry;
  protected skillExecutor: SkillExecutor;
  protected skillInvocationContext: SkillInvocationContext;

  constructor(
    config: AgentConfig,
    provider: AIProvider,
    dependencies: AgentDependencies
  ) {
    this.config = config;
    this.provider = provider;
    this.skillRegistry = dependencies.skillRegistry;
    this.skillExecutor = dependencies.skillExecutor;
    this.skillInvocationContext = dependencies.skillInvocationContext;
  }

  /**
   * Execute agent task
   */
  async execute(
    prompt: string,
    context: AgentContext,
    onStream?: (chunk: string) => void
  ): Promise<AgentResponse> {
    const systemPrompt = this.buildSystemPrompt();

    // If skills are enabled and provider supports them
    if (this.config.enableSkills && this.provider.supportsSkills?.()) {
      return await this.executeWithSkills(
        prompt,
        systemPrompt,
        context,
        onStream
      );
    } else {
      return await this.executeSimple(
        prompt,
        systemPrompt,
        context,
        onStream
      );
    }
  }

  /**
   * Execute with skills (multi-turn agent loop)
   */
  private async executeWithSkills(
    prompt: string,
    systemPrompt: string,
    context: AgentContext,
    onStream?: (chunk: string) => void
  ): Promise<AgentResponse> {
    const messages: ChatMessage[] = [
      ...context.messages,
      { role: 'user', content: prompt, timestamp: Date.now() }
    ];

    // Get skills in provider format
    const skills = this.skillInvocationContext.getToolDefinitions(
      this.skillRegistry,
      this.provider.type === 'openai' ? 'openai' : 'anthropic'
    );

    let fullResponse = '';
    let turnCount = 0;
    // Prioritize context metadata, then config, then default (20)
    // Clamp value between 1 and 99
    const maxTurns = Math.max(1, Math.min(99, context.metadata?.maxTurns ?? this.config.maxTurns ?? 20));
    const skillCalls: SkillCall[] = [];

    // Agent loop
    while (turnCount < maxTurns) {
      turnCount++;

      const result: GenerateResponse = await this.provider.generateStreamWithSkills!(
        messages,
        (chunk: string) => {
          fullResponse += chunk;
          if (onStream) {
            onStream(chunk);
          }
        },
        undefined,
        {
          temperature: this.config.temperature || 0.7,
          maxTokens: 2048,
          systemPrompt,
          skills,
          toolChoice: 'auto'
        }
      );

      // Add assistant message to history
      messages.push({
        role: 'assistant',
        content: result.content,
        timestamp: Date.now(),
        tool_calls: result.toolCalls
      });

      // Check if there are tool calls
      if (!result.toolCalls || result.toolCalls.length === 0) {
        break;
      }

      // Execute tool calls
      for (const toolCall of result.toolCalls) {
        const skillCall = await this.executeToolCall(toolCall, onStream);
        skillCalls.push(skillCall);

        messages.push({
          role: 'tool',
          content: skillCall.result?.success
            ? JSON.stringify(skillCall.result.data, null, 2)
            : `Error: ${skillCall.result?.error || 'Unknown error'}`,
          timestamp: Date.now(),
          tool_call_id: toolCall.id,
          name: toolCall.name
        });
      }
    }

    if (turnCount >= maxTurns) {
      console.warn('[BaseAgent] Reached maximum turns limit');
    }

    return {
      content: fullResponse,
      messages,
      skillCalls,
      metadata: {
        turns: turnCount
      }
    };
  }

  /**
   * Execute without skills (simple generation)
   */
  private async executeSimple(
    prompt: string,
    systemPrompt: string,
    context: AgentContext,
    onStream?: (chunk: string) => void
  ): Promise<AgentResponse> {
    const messages: ChatMessage[] = [
      ...context.messages,
      { role: 'user', content: prompt, timestamp: Date.now() }
    ];

    let fullResponse = '';

    await this.provider.generateStream(
      prompt,
      (chunk: string) => {
        fullResponse += chunk;
        if (onStream) {
          onStream(chunk);
        }
      },
      {
        systemPrompt,
        temperature: this.config.temperature || 0.7,
        maxTokens: 2048
      }
    );

    messages.push({
      role: 'assistant',
      content: fullResponse,
      timestamp: Date.now()
    });

    return {
      content: fullResponse,
      messages
    };
  }

  /**
   * Execute a tool call
   */
  private async executeToolCall(
    toolCall: ToolCall,
    onStream?: (chunk: string) => void
  ): Promise<SkillCall> {
    // Check if this is a meta-tool call (spec or invoke)
    if (this.skillInvocationContext.isMetaToolCall(toolCall.name)) {
      return await this.handleMetaToolCall(toolCall, onStream);
    } else {
      return await this.handleDirectSkillCall(toolCall, onStream);
    }
  }

  /**
   * Handle meta-tool calls (spec/invoke)
   */
  private async handleMetaToolCall(
    toolCall: ToolCall,
    onStream?: (chunk: string) => void
  ): Promise<SkillCall> {
    const args = this.safeParseToolArguments(toolCall);

    const skillCall: SkillCall = {
      id: toolCall.id,
      skillName: toolCall.name,
      namespace: 'meta',
      parameters: args,
      status: 'executing',
      timestamp: Date.now()
    };

    let resultContent: string;
    let success = true;

    if (toolCall.name === 'spec') {
      // Handle spec: get skill specification
      const skillName = args.skill_name;

      if (onStream) {
        onStream(`\n\n📖 Getting spec: ${skillName}\n`);
      }

      const details = this.skillRegistry.getSkillDetails(skillName, 'markdown');

      if (details.startsWith('Error:')) {
        success = false;
        resultContent = details;
        if (onStream) {
          onStream(`✗ not found\n\n`);
        }
      } else {
        resultContent = details;
        if (onStream) {
          onStream(`✓ loaded\n\n`);
        }
      }
    } else if (toolCall.name === 'invoke') {
      // Handle invoke: execute the actual skill
      const skillName = args.skill_name;
      const skillParams = args.params || {};

      // Get skill for display purposes
      const skill = this.skillRegistry.get(skillName);
      const shortName = skillName.split(':').pop() || skillName;
      const displayParam = this.getSkillDisplayParam(skillName, skillParams);
      const requiresConfirmation = skill && isExecutableSkill(skill) && skill.metadata?.requiresConfirmation;

      // Notify about skill call
      if (onStream) {
        if (requiresConfirmation) {
          const paramStr = displayParam ? `(${displayParam})` : '()';
          onStream(`\n\n⚠️ ${shortName}${paramStr}\n`);
        } else {
          const paramStr = displayParam ? `(${displayParam})` : '()';
          onStream(`\n\n${shortName}${paramStr}\n`);
        }
      }

      // Parse skill name to get namespace and name
      const { namespace, name } = this.skillRegistry.parseName(skillName);

      // Execute the skill
      const result = await this.skillExecutor.execute(namespace, name, skillParams);

      success = result.success;
      resultContent = result.success
        ? JSON.stringify(result.data, null, 2)
        : `Error: ${result.error}`;

      // Notify about completion
      if (onStream) {
        if (result.success) {
          onStream(`✓ success\n\n`);
        } else if (result.error && result.error.includes('cancelled')) {
          onStream(`✗ cancelled\n\n`);
        } else {
          onStream(`✗ failed\n\n`);
        }
      }
    } else {
      success = false;
      resultContent = `Unknown meta-tool: ${toolCall.name}`;
    }

    skillCall.status = success ? 'success' : 'error';
    skillCall.result = {
      success,
      data: success ? resultContent : undefined,
      error: success ? undefined : resultContent
    };
    skillCall.executionTime = Date.now() - skillCall.timestamp;

    return skillCall;
  }

  /**
   * Handle direct skill calls
   */
  private async handleDirectSkillCall(
    toolCall: ToolCall,
    onStream?: (chunk: string) => void
  ): Promise<SkillCall> {
    const args = this.safeParseToolArguments(toolCall);

    const skillCall: SkillCall = {
      id: toolCall.id,
      skillName: toolCall.name,
      namespace: toolCall.name.startsWith('mcp:') ? 'mcp' : 'obsidian',
      parameters: args,
      status: 'executing',
      timestamp: Date.now()
    };

    // Check if skill requires confirmation
    const skill = this.skillRegistry.get(toolCall.name);
    const requiresConfirmation = skill && isExecutableSkill(skill) && skill.metadata?.requiresConfirmation;
    const isAskUser = toolCall.name === 'obsidian:ask_user';

    // Notify about skill call
    if (onStream) {
      const shortName = toolCall.name.split(':').pop() || toolCall.name;
      const displayParam = this.getSkillDisplayParam(toolCall.name, args);

      if (isAskUser) {
        onStream(`\n\n${shortName}()\n`);
      } else if (requiresConfirmation) {
        const paramStr = displayParam ? `(${displayParam})` : '()';
        onStream(`\n\n⚠️ ${shortName}${paramStr}\n`);
      } else {
        const paramStr = displayParam ? `(${displayParam})` : '()';
        onStream(`\n\n${shortName}${paramStr}\n`);
      }
    }

    // Execute the skill
    const result = await this.skillExecutor.executeFromToolCall(toolCall);

    skillCall.status = result.success ? 'success' : 'error';
    skillCall.result = result;
    skillCall.executionTime = Date.now() - skillCall.timestamp;

    // Notify about completion
    if (onStream) {
      if (result.success) {
        onStream(`✓ success\n\n`);
      } else if (result.error && result.error.includes('cancelled')) {
        onStream(`✗ cancelled\n\n`);
      } else {
        onStream(`✗ failed\n\n`);
      }
    }

    return skillCall;
  }

  /**
   * Safely parse tool call arguments
   */
  private safeParseToolArguments(toolCall: ToolCall): Record<string, any> {
    if (typeof toolCall.arguments !== 'string') {
      return toolCall.arguments;
    }

    const argsString = toolCall.arguments as string;

    try {
      return JSON.parse(argsString);
    } catch (error: any) {
      console.error(`[BaseAgent] JSON parse failed for ${toolCall.name}:`, error.message);

      // Try recovery strategies
      // Strategy 1: Fix unterminated strings
      if (error.message.includes('Unterminated string')) {
        try {
          const fixed = argsString + '"}';
          return JSON.parse(fixed);
        } catch {
          // Continue to next strategy
        }
      }

      // Strategy 2: Extract valid JSON prefix
      try {
        const lastValidPos = argsString.lastIndexOf('}');
        if (lastValidPos > 0) {
          const truncated = argsString.substring(0, lastValidPos + 1);
          return JSON.parse(truncated);
        }
      } catch {
        // Failed
      }

      throw new Error(
        `Failed to parse tool call arguments for ${toolCall.name}: ${error.message}`
      );
    }
  }

  /**
   * Get display parameter for skill execution messages
   */
  private getSkillDisplayParam(skillName: string, parameters: Record<string, any>): string {
    // File operations - show filename only
    if (parameters.path) {
      const filename = parameters.path.split('/').pop() || parameters.path;
      return filename;
    }

    // Query operations
    if (parameters.query) {
      return `"${parameters.query.substring(0, 30)}"`;
    }

    if (parameters.pattern) {
      return parameters.pattern;
    }

    if (parameters.tags && Array.isArray(parameters.tags)) {
      return `tags: [${parameters.tags.slice(0, 2).join(', ')}]`;
    }

    return '';
  }

  /**
   * Build system prompt
   */
  private buildSystemPrompt(): string {
    return this.config.systemPrompt || 'You are a helpful AI assistant.';
  }

  // Getters
  getId(): string {
    return this.config.id;
  }

  getName(): string {
    return this.config.name;
  }

  getDescription(): string {
    return this.config.description;
  }

  getConfig(): AgentConfig {
    return { ...this.config };
  }
}
