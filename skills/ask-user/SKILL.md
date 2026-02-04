---
name: ask_user
description: Ask user a question to get clarification or guidance
metadata:
  version: "1.0.0"
  author: personal-agent
  tags: [interaction, guidance, clarification]
  executable: true
  implementation: scripts/index.ts
  performance: fast
  category: user-interaction
---

# Ask User Skill

## Description

Ask user a question to get clarification or guidance.

## When to use
- Multiple files match a pattern and you need to know which to use
- User intent is ambiguous and you need clarification
- You need confirmation before a potentially destructive operation
- You have multiple valid approaches and need user preference
- Missing required information to complete the task

## When NOT to use
- When you can reasonably infer the answer
- For simple yes/no that could be assumed safely
- When you have enough context to proceed

## Input Schema

```typescript
{
  question: string;              // The question to ask
  context?: string;              // Why asking
  options?: string[];            // Predefined choices
  defaultValue?: string;         // Default answer
  requiresInput?: boolean;       // Whether empty response allowed (default: true)
}
```

## Output

```typescript
{
  answer: string;
  timestamp: number;
  selectedOption?: string;       // If options were provided
}
```

## Examples

### Ambiguous file selection

```json
{
  "question": "I found 3 files named 'project.md'. Which one should I update?",
  "context": "You asked me to update the project file, but multiple files match.",
  "options": [
    "Projects/2024/project.md",
    "Archive/project.md",
    "Drafts/project.md"
  ]
}
```

### Unclear intent

```json
{
  "question": "How should I organize your notes?",
  "context": "You asked me to organize notes, but didn't specify the method.",
  "options": [
    "By date",
    "By topic",
    "By tags"
  ]
}
```

### Confirmation request

```json
{
  "question": "Are you sure you want to delete all files in the Archive folder?",
  "context": "This operation cannot be undone.",
  "options": [
    "Yes, delete them",
    "No, cancel"
  ]
}
```

## Performance Characteristics

- Fast (instant skill execution, waits for user response)
- No computational overhead
- Response time depends on user

## Common Workflows

### Ambiguous Query Resolution
1. `query-notes` - Find matching files
2. `ask-user` - Let user select
3. `read-note` or `edit-note` - Process selected file

## Best Practices

1. Be specific with clear, focused questions
2. Provide context explaining why you're asking
3. Offer predefined choices when possible
4. Don't overuse - only ask when truly uncertain

## Notes

- Skill pauses execution until user responds
- If user cancels, skill returns error
- Answer added to conversation context automatically
- Use options array for multiple choice, omit for free text
