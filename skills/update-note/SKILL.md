---
name: update_note
description: Update document content with replace, append, prepend, or insert modes
metadata:
  version: "1.0.0"
  author: personal-agent
  tags: [write, update, modify]
  executable: true
  implementation: scripts/index.ts
  requiresConfirmation: true
  performance: fast
  category: file-operations
---

# Update Document Skill

## Description

Update document content with multiple update modes including line-based, section-based, and search-replace operations.

Supports: replace, append, prepend, insert after heading, insert at line, replace lines, delete lines, replace section, delete section, search-replace, exact-replace, and dry-run mode.

**IMPORTANT**: Before updating note content, reference the `obsidian-markdown` skill to ensure proper Obsidian Flavored Markdown syntax (Wikilinks, callouts, tags, frontmatter, etc.).

## When to use
- Modifying existing document content
- Adding new sections or content at specific locations
- Replacing outdated content or performing bulk text replacements
- Removing specific sections or line ranges
- Previewing changes before applying (dry-run)

## When NOT to use
- Creating new documents (use create-note instead)
- Only updating frontmatter (use update-frontmatter instead)
- Bulk updates across files (use batch-operation instead)

**IMPORTANT**: This skill requires user confirmation before execution.

## Input Schema

```typescript
{
  path: string;                    // File path (required)
  content: string;                 // Content to add/replace
  mode: UpdateMode;                // Update mode (required)
  heading?: string;                // Heading name (for heading-based modes)
  createIfNotExists?: boolean;     // Create file if missing (default: false)
  triggerReindex?: boolean;        // Trigger reindex (default: true)

  // Line-based parameters
  startLine?: number;              // Starting line (1-based)
  endLine?: number;                // Ending line (1-based)

  // Search-replace parameters
  searchPattern?: string;          // Text or regex pattern
  replaceWith?: string;            // Replacement text
  useRegex?: boolean;              // Treat pattern as regex (default: false)
  matchCase?: boolean;             // Case-sensitive (default: true)
  maxReplacements?: number;        // Max replacements (0 = all)

  // Exact-replace parameters
  oldString?: string;              // Exact string to find
  newString?: string;              // Exact replacement

  // Safety options
  dryRun?: boolean;                // Preview without applying (default: false)
}
```

### Update Modes

| Mode | Required Params | Description | Risk |
|------|----------------|-------------|------|
| **replace** | content | Replace entire document | High |
| **append** | content | Add to end | Safe |
| **prepend** | content | Add to beginning (preserves frontmatter) | Safe |
| **insert-after-heading** | heading, content | Insert after heading | Safe |
| **insert-at-line** | startLine, content | Insert at line | Safe |
| **replace-lines** | startLine, endLine, content | Replace line range | Medium |
| **delete-lines** | startLine, endLine | Delete line range | High |
| **replace-section** | heading, content | Replace section | Medium |
| **delete-section** | heading | Delete section | High |
| **search-replace** | searchPattern, replaceWith | Find and replace | Medium |
| **exact-replace** | oldString, newString | Replace exact match | Safe |

## Output

```typescript
{
  path: string;
  name: string;
  updated: boolean;
  created: boolean;
  previousLength: number;
  newLength: number;
  reindexed: boolean;

  changes: {
    linesAdded: number;
    linesRemoved: number;
    linesModified: number;
    replacementCount?: number;     // For search-replace
  };

  preview?: {                      // Only when dryRun: true
    before: string;                // First 500 chars
    after: string;                 // First 500 chars
  };

  warnings?: string[];
}
```

## Examples

### Append content

```json
{
  "path": "Notes/Daily/2025-01-20.md",
  "content": "## New Section\n\nContent here",
  "mode": "append"
}
```

### Insert at specific line

```json
{
  "path": "Notes/Document.md",
  "content": "## New Section",
  "mode": "insert-at-line",
  "startLine": 10
}
```

### Replace section content

```json
{
  "path": "Projects/Project.md",
  "content": "- [ ] New task 1\n- [ ] New task 2",
  "mode": "replace-section",
  "heading": "Tasks"
}
```

### Exact replace (Claude Code Edit pattern)

```json
{
  "path": "Notes/Document.md",
  "mode": "exact-replace",
  "oldString": "Line 42: old text here",
  "newString": "Line 42: updated text here"
}
```

### Dry-run preview

```json
{
  "path": "Notes/Important.md",
  "content": "New content",
  "mode": "replace",
  "dryRun": true
}
```

## Performance Characteristics

- Fast (< 100ms for most updates)
- Append/prepend are fast regardless of size
- Replace scales with document size
- Reindexing adds 100-500ms if enabled

## Common Workflows

### Query → Read → Update
1. `query-notes` - Find files
2. `read-note` - Read content
3. `update-note` - Apply changes

## Best Practices

1. Read before updating to understand structure
2. Use dry-run for destructive operations (delete, replace)
3. Prefer section-based over line-based (more robust to changes)
4. Use exact-replace when you know the exact text (safer than search-replace)

## Notes

- Line numbers are 1-based; ranges are inclusive
- Heading operations are case-insensitive
- exact-replace validates uniqueness (fails if multiple matches)
- Dry-run mode does NOT modify files or trigger reindex
- Replace mode overwrites entire document including frontmatter
- Prepend mode preserves frontmatter at the top
