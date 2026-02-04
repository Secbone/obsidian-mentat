---
name: edit_note
description: Create or update notes with intelligent operation detection
metadata:
  version: 1.0.0
  tags: [create, update, write, edit]
  executable: true
  implementation: scripts/index.ts
  requiresConfirmation: true
---

# edit_note

Create or update Obsidian notes with intelligent operation detection.

## When to use
- Creating new notes with optional frontmatter
- Appending content to existing notes
- Replacing specific text with exact matching
- Updating section content under headings
- Replacing entire file content
- Prepending content (preserves frontmatter)

## When NOT to use
- Reading note content (use read-note)
- Searching for notes (use query-notes)
- Batch operations on multiple files (use batch-operation)

## Input Schema

```typescript
{
  path: string;                   // File path (required)
  content: string;                 // Content to write/add/replace (required)

  // Operation hints (all optional)
  frontmatter?: object;            // Frontmatter metadata (for create/replace-all)
  heading?: string;                // Target heading for section operations
  replace?: string;                // Text to find and replace (exact match)
  append?: boolean;                // Add content to end of file
  prepend?: boolean;               // Add content to beginning of file
  insertAfter?: boolean;           // Insert after heading instead of replacing section

  // Configuration
  failIfExists?: boolean;          // Fail if file exists (default: false)
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
                                 // replace-content, replace-section,
                                 // insert-after-heading, replace-all)
  previousLength: number;         // Length of content before operation
  newLength: number;              // Length of content after operation
  reindexed: boolean;            // Whether file was reindexed
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

### Replace specific text (exact matching)

```json
{
  "path": "Notes/Project.md",
  "content": "in progress",
  "replace": "Status: planned"
}
```

**Note**: Text must match exactly (including whitespace) and appear only once. If ambiguous, include more surrounding context.

### Update section content

```json
{
  "path": "Notes/Documentation.md",
  "heading": "Installation",
  "content": "## Installation\n\n1. Clone the repository\n2. Run npm install\n3. Configure settings"
}
```

### Replace entire file

```json
{
  "path": "Notes/Template.md",
  "content": "# New Template\n\nThis is completely new content.",
  "frontmatter": {
    "type": "template",
    "version": "2.0"
  }
}
```

## Operation Detection Logic

```
File doesn't exist?              → CREATE
Has 'replace' parameter?          → REPLACE TEXT (exact match)
Has 'heading' parameter?
  └─ With 'insertAfter: true'?   → INSERT AFTER HEADING
  └─ Without 'insertAfter'?      → REPLACE SECTION
Has 'append: true'?              → APPEND
Has 'prepend: true'?             → PREPEND
Otherwise                        → REPLACE ALL
```

## Performance Characteristics

- Fast (< 100ms for most operations)
- Create/full replace: Depends on file size
- Section operations: Scales with document size
- Text replacement: O(n) with uniqueness validation

## Best Practices

1. Use exact paths - ensure file path exists or will be auto-created
2. Text replacement - provide unique strings with sufficient context
3. Section updates - use case-insensitive heading names
4. Frontmatter - only works with create and replace-all operations
5. Reindexing - enabled by default for search availability

## Error Handling

- **File exists with failIfExists**: "File exists and failIfExists is true: {path}"
- **Text not found**: "Text not found in file: '{text}' (Tip: The text must match exactly including whitespace, capitalization, and line breaks)"
- **Text appears multiple times**: "Text '{text}' appears N times in the file (at lines X, Y, Z). Please provide a longer string with more surrounding context."
- **Heading not found**: "Heading '{heading}' not found. Available headings: {list}"

## Notes

- Folders auto-created as needed
- Text replacement uses exact string matching (must be unique)
- Section matching is case-insensitive
- Prepend preserves existing frontmatter
- Line breaks and whitespace matter for text replacement