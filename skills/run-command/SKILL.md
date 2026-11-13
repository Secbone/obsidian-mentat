---
name: run_command
description: Execute explicitly authorized host shell commands, starting in the vault working directory.
metadata:
  version: "1.0.0"
  author: mentat
  tags: [terminal, execution, command-line, automation]
  executable: true
  implementation: scripts/index.ts
  performance: medium
  category: system-operations
  requiresConfirmation: true
---

# Run Terminal Command Skill

## Description

Execute host commands (e.g. `git`, `python`, `grep`, `curl`) through the injected command driver after approval. The initial working directory must resolve inside the vault. The process retains the current user permissions: absolute paths, interpreters, networking and child processes are not isolated. A command blacklist is an additional guardrail, not a sandbox. Cancellation or a nonzero exit does not establish that no external effects occurred; uncertain results require verification.

## When to use
- Running version control commands like `git status`, `git commit`, `git push` or `git pull`
- Running data analysis or automation tasks like `python process_data.py`
- Searching files with fast grep operations (e.g. `grep -rn "keyword" .`)
- Executing system tools inside the vault root to sync or process vault documents

## When NOT to use
- Reading or writing a single note (use `read_note` or `edit_note` instead for 10x better speed and zero overhead)
- Running destructive commands (such as `rm` or `format` which are blacklisted)
- Assuming approval or the working directory provides filesystem or network isolation

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
