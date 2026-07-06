---
name: write_note
description: Create or overwrite notes with flexible content operations
metadata:
  version: "1.0.0"
  author: mentat
  tags: [create, write, append, prepend]
  executable: true
  implementation: scripts/index.ts
  requiresConfirmation: true
  performance: fast
  category: file-operations
---

# write_note

Create new notes or perform bulk content operations on existing notes. Supports creating, appending, prepending, replacing sections, and full content replacement.

## When to use
- Creating new notes with optional frontmatter
- Appending content to existing notes
- Prepend content to beginning of notes
- Replacing entire note content
- Replacing or inserting content under a specific heading
- Any operation that writes full content rather than making targeted text replacements

## When NOT to use
- Making small targeted text replacements (use edit_note instead)
- Reading note content (use read_note instead)
- Searching for notes (use query_notes instead)
- Batch operations on multiple files (use batch_operation instead)

## Input Schema

```typescript
{
  path: string;                    // File path (required)
  content: string;                 // Content to write/append/prepend (required)

  frontmatter?: object;            // Frontmatter metadata (applied on create and replace-all)
  heading?: string;                // Target heading for section insert/replace
  append?: boolean;                // Append to end of file (default: false)
  prepend?: boolean;               // Prepend to beginning of file (default: false)
  insert_after?: boolean;          // Insert after heading instead of replacing section (default: false)
  create_only?: boolean;           // Only create, fail if file exists (default: false)

  triggerReindex?: boolean;        // Trigger reindex after operation (default: true)
}
```

## Output Schema

```typescript
{
  path: string;                   // File path
  name: string;                   // File basename
  created: boolean;               // Whether file was created
  updated: boolean;               // Whether file was updated
  operation: string;              // Operation performed (create, append, prepend,
                                  // replace-section, insert-after-heading, replace-all)
  previousLength: number;         // Length of content before operation
  newLength: number;              // Length of content after operation
  reindexed: boolean;             // Whether file was reindexed
}
```

## Examples

### Create new file with frontmatter

```json
{
  "path": "Notes/Meeting 2025-01-20.md",
  "content": "# Meeting Notes\n\n## Agenda\n- Review project status\n- Discuss timeline",
  "frontmatter": {
    "date": "2025-01-20",
    "type": "meeting",
    "tags": ["project", "planning"]
  }
}
```

### Append content

```json
{
  "path": "Notes/Daily Log.md",
  "content": "## 3:00 PM\n- Completed feature implementation\n- Started testing",
  "append": true
}
```

### Replace section under heading

```json
{
  "path": "Notes/Documentation.md",
  "heading": "Installation",
  "content": "## Installation\n\n1. Clone the repository\n2. Run npm install\n3. Configure settings"
}
```

### Prepend content (preserves existing frontmatter)

```json
{
  "path": "Notes/Daily Log.md",
  "content": "# Morning Update\nPriority tasks for today.",
  "prepend": true
}
```

### Only create, fail if file exists

```json
{
  "path": "Templates/Note.md",
  "content": "# New Note\n\nStart here.",
  "create_only": true
}
```

## Operation Detection Logic

```
File doesn't exist?              → CREATE
Has 'heading' parameter?
  └─ With 'insert_after: true'  → INSERT AFTER HEADING
  └─ Without 'insert_after'     → REPLACE SECTION
Has 'append: true'?              → APPEND
Has 'prepend: true'?             → PREPEND
Otherwise                        → REPLACE ALL
```

### Note on create_only
When `create_only: true` and the file already exists, the operation fails immediately without making any changes.

## Performance Characteristics

- Fast (< 100ms for most operations)
- Create/full replace: Depends on file size
- Section operations: Scales with document size

## Best Practices

1. Use exact paths — ensure file path exists or will be auto-created
2. Write full content in `content` field, don't rely on partial operations for precision edits
3. Section updates — use case-insensitive heading names
4. Frontmatter — only works with create and replace-all operations
5. Reindexing — enabled by default for search availability

## Error Handling

- **File exists with create_only**: "File already exists and create_only is true: {path}"
- **Heading not found**: "Heading '{heading}' not found. Available headings: {list}"
- **Linter validation failed**: Errors listed with automatic rollback to previous content
