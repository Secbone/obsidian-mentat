---
name: update_document
description: Update content in a document. Supports replace, append, prepend, and insert-after-heading modes.
metadata:
  version: "1.0.0"
  author: personal-agent
  tags: [write, update, modify]
  executable: true
  implementation: scripts/index.ts
  requiresConfirmation: true
---

# Update Document Skill

## Description

Updates content in existing Obsidian documents with multiple modes:
- **Replace**: Replace entire document content
- **Append**: Add content to the end of the document
- **Prepend**: Add content to the beginning (preserves frontmatter)
- **Insert after heading**: Insert content after a specific heading

## Usage

Use this skill to modify existing documents. Always read the document first to understand its structure.

**IMPORTANT**: This skill requires user confirmation before execution.

## Input Schema

```typescript
{
  path: string;                    // File path to update (required)
  content: string;                 // Content to add or replace (required)
  mode: 'replace' | 'append' | 'prepend' | 'insert-after-heading';  // Update mode (required)
  heading?: string;                // Heading name (required for insert-after-heading mode)
  createIfNotExists?: boolean;     // Create file if it does not exist (default: false)
  triggerReindex?: boolean;        // Trigger reindex after update (default: true)
}
```

## Output

Returns update result:

```typescript
{
  path: string;                    // Full file path
  name: string;                    // File basename
  updated: boolean;                // Whether file was updated
  created: boolean;                // Whether file was created
  previousLength: number;          // Previous content length
  newLength: number;               // New content length
  reindexed: boolean;              // Whether file was reindexed
}
```

## Examples

### 1. Append content to document

```json
{
  "path": "Notes/Daily/2025-01-20.md",
  "content": "## New Section\n\nContent here",
  "mode": "append"
}
```

### 2. Replace entire document

```json
{
  "path": "Templates/Note.md",
  "content": "# Template\n\n{{content}}",
  "mode": "replace"
}
```

### 3. Insert after heading

```json
{
  "path": "Projects/Project A.md",
  "content": "- [ ] New task",
  "mode": "insert-after-heading",
  "heading": "Tasks"
}
```

### 4. Prepend content (preserves frontmatter)

```json
{
  "path": "Notes/Important.md",
  "content": "> [!warning]\n> This is urgent!",
  "mode": "prepend"
}
```

## Best Practices

1. **Read before updating**: Always read the document first to understand its structure
2. **Use appropriate mode**: Choose the mode that best fits your use case
3. **Be careful with replace**: Replace mode overwrites the entire document
4. **Check heading names**: Use exact heading names for insert-after-heading mode
5. **Preserve formatting**: Maintain consistent Markdown formatting

## Notes

- Replace mode overwrites the entire document (including frontmatter)
- Prepend mode preserves frontmatter at the top
- Insert-after-heading is case-insensitive
- If heading is not found, the skill returns an error
- Reindexing happens asynchronously
- If `createIfNotExists` is true and file doesn't exist, it will be created with the content
