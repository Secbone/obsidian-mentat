---
name: run_command
description: Execute terminal shell commands in the vault root directory (e.g., git status, python, grep). Requires user confirmation and blocks high-risk commands.
metadata:
  version: "1.0.0"
  author: personal-agent
  tags: [terminal, execution, command-line, automation]
  executable: true
  implementation: scripts/index.ts
  performance: medium
  category: system-operations
  requiresConfirmation: true
---

# Run Terminal Command Skill

## Description

Execute system command line commands (e.g. `git`, `python`, `grep`, `curl`) directly within the Obsidian vault directory. For security, commands are locked to the vault directory, blacklisted from executing high-risk operations (such as `rm` or `chmod`), and require explicit user authorization prior to running.

## When to use
- Running version control commands like `git status`, `git commit`, `git push` or `git pull`
- Running data analysis or automation tasks like `python process_data.py`
- Searching files with fast grep operations (e.g. `grep -rn "keyword" .`)
- Executing system tools inside the vault root to sync or process vault documents

## When NOT to use
- Reading or writing a single note (use `read_note` or `edit_note` instead for 10x better speed and zero overhead)
- Running destructive commands (such as `rm` or `format` which are blacklisted)
- Doing operations outside the vault (directory sandbox constraints apply)

## Input Schema

```typescript
{
  command: string;                 // The terminal command to run (required)
  cwd?: string;                    // Subdirectory path relative to vault root (optional)
  timeout?: number;                // Execution timeout in milliseconds (default: 30000)
}
```

## Output

```typescript
{
  success: boolean;                // Whether execution completed successfully (exit code 0)
  stdout: string;                  // Standard output of the command
  stderr: string;                  // Standard error output of the command
  exitCode: number | null;         // Command exit status code
  executionTime: number;           // Execution time in milliseconds
}
```
