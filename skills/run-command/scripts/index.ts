// Run Terminal Command Skill Implementation
// Core logic for executing system terminal commands in a secure sandboxed vault context

import { z } from 'zod';
import { exec } from 'child_process';
import * as path from 'path';
import { FileSystemAdapter } from 'obsidian';
import { SkillContext, SkillResult } from '../../../src/skills/skill-types';

/**
 * Skill metadata
 */
export const metadata = {
  name: 'run_command',
  description: 'Execute system command line commands within the vault root',
  version: '1.0.0',
  tags: ['terminal', 'execution', 'automation'],
  performance: 'medium',
  category: 'system-operations'
};

/**
 * High-risk shell commands blacklisted for active defense
 */
const BLACKLISTED_COMMANDS = [
  'sudo', 
  'rm', 
  'chmod', 
  'chown', 
  'shutdown', 
  'format', 
  'dd', 
  'mkfs', 
  'init', 
  'reboot', 
  'mv', 
  'poweroff', 
  'halt'
];

/**
 * Input schema
 */
export const schema = z.object({
  command: z.string().describe('The system shell command to execute (e.g. git status, python script.py, grep -rn "text")'),
  cwd: z.string().optional().describe('Optional subdirectory path inside the vault to run the command in'),
  timeout: z.number().default(30000).describe('Execution timeout in milliseconds (default: 30000)')
});

export type Input = z.infer<typeof schema>;

/**
 * Check if the command contains any blacklisted high-risk commands
 */
function checkBlacklist(command: string): string | null {
  // Tokenize command based on spaces and common shell punctuation to isolate keywords
  const tokens = command.toLowerCase().split(/[\s|;&'"\/\\()\[\]{}*?~><!^#]+/);
  
  for (const token of tokens) {
    if (BLACKLISTED_COMMANDS.includes(token)) {
      return token;
    }
  }
  return null;
}

/**
 * Execute command line command inside secure vault sandbox
 */
export async function execute(
  input: Input,
  context: SkillContext
): Promise<SkillResult> {
  const startTime = Date.now();
  const { command, timeout } = input;

  // 1. Security Check: Command Blacklist
  const blockedWord = checkBlacklist(command);
  if (blockedWord) {
    return {
      success: false,
      error: `Security Violation: Command contains blocked high-risk keyword '${blockedWord}'. Execution aborted.`,
      metadata: { executionTime: Date.now() - startTime }
    };
  }

  // 2. Resolve Vault root path and target working directory
  const adapter = context.vault.adapter as FileSystemAdapter;
  if (typeof adapter.getBasePath !== 'function') {
    return {
      success: false,
      error: 'Environment Error: Failed to resolve vault root path.',
      metadata: { executionTime: Date.now() - startTime }
    };
  }

  const vaultRoot = adapter.getBasePath();
  let targetCwd = vaultRoot;

  if (input.cwd) {
    // Resolve absolute path of the subdirectory relative to vault root
    const resolvedPath = path.resolve(vaultRoot, input.cwd);
    
    // Sandbox Security Check: Ensure the working directory is still inside vault root!
    if (!resolvedPath.startsWith(vaultRoot)) {
      return {
        success: false,
        error: `Sandbox Violation: Target directory '${input.cwd}' lies outside the Obsidian vault root.`,
        metadata: { executionTime: Date.now() - startTime }
      };
    }
    targetCwd = resolvedPath;
  }

  // 3. Spawning the terminal command
  return new Promise((resolve) => {
    exec(
      command,
      {
        cwd: targetCwd,
        timeout: timeout,
        maxBuffer: 10 * 1024 * 1024 // 10MB maximum buffer
      },
      (error, stdout, stderr) => {
        const executionTime = Date.now() - startTime;
        const exitCode = error ? (error.code || 1) : 0;

        if (error) {
          // Check if process was killed due to timeout
          const isTimeout = error.signal === 'SIGTERM' || error.signal === 'SIGKILL';
          resolve({
            success: false,
            error: isTimeout ? `Command timed out after ${timeout}ms.` : `Execution failed: ${error.message}`,
            data: {
              success: false,
              stdout: stdout.toString(),
              stderr: stderr.toString(),
              exitCode,
              executionTime
            },
            metadata: { executionTime }
          });
        } else {
          resolve({
            success: true,
            message: `Command executed successfully.`,
            data: {
              success: true,
              stdout: stdout.toString(),
              stderr: stderr.toString(),
              exitCode: 0,
              executionTime
            },
            metadata: { executionTime }
          });
        }
      }
    );
  });
}
