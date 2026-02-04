---
name: batch_operation
description: Perform bulk operations on multiple documents matching filter criteria
metadata:
  version: "1.0.0"
  author: personal-agent
  tags: [batch, bulk, update]
  executable: true
  implementation: scripts/index.ts
  requiresConfirmation: true
  performance: slow
  category: file-operations
---

# Batch Operation Skill

## Description

Perform bulk operations on multiple documents: add/remove tags, update frontmatter, or append content.

## When to use
- Applying same change across many documents
- Bulk tagging or metadata updates
- Adding consistent content to multiple files

## When NOT to use
- Single file updates (use edit-note instead)
- Complex per-file logic (process files individually instead)
- When you need file-specific content changes

**IMPORTANT**: This skill requires user confirmation before execution. Always use dry-run first.

## Input Schema

```typescript
{
  operation: 'add-tags' | 'remove-tags' | 'update-frontmatter' | 'append-content';
  filter: {
    folders?: string[];                // OR logic
    tags?: string[];                   // AND logic
    frontmatter?: Record<string, any>;
    paths?: string[];                  // Specific file paths
  };
  params: Record<string, any>;         // Operation-specific (see below)
  dryRun?: boolean;                    // Preview without applying (default: false)
  maxFiles?: number;                   // Max files to process (default: 50, max: 100)
}
```

### Operation Parameters

**add-tags / remove-tags**:
```typescript
params: {
  tags: string[];  // Tag names without # prefix
}
```

**update-frontmatter**:
```typescript
params: {
  updates: {
    [key: string]: string | number | boolean | string[];
  };
}
```

**append-content**:
```typescript
params: {
  content: string;  // Markdown content to append
}
```

## Output

```typescript
{
  operation: string;
  filesProcessed: number;
  filesModified: string[];
  filesSkipped: string[];
  errors: Array<{
    path: string;
    error: string;
  }>;
  dryRun: boolean;
}
```

## Examples

### Add tags to folder (dry run first)

```json
{
  "operation": "add-tags",
  "filter": {
    "folders": ["Projects"]
  },
  "params": {
    "tags": ["active", "project"]
  },
  "dryRun": true
}
```

### Update frontmatter for tagged files

```json
{
  "operation": "update-frontmatter",
  "filter": {
    "tags": ["project"]
  },
  "params": {
    "updates": {
      "reviewed": true,
      "reviewDate": "2025-01-20"
    }
  }
}
```

### Append content to specific files

```json
{
  "operation": "append-content",
  "filter": {
    "paths": ["Notes/Note1.md", "Notes/Note2.md"]
  },
  "params": {
    "content": "\n## Follow-up\n\nAdded on 2025-01-20"
  }
}
```

## Performance Characteristics

- Slow (1s+ for batches of 10+ files)
- Scales linearly with file count (~100-200ms per file)
- Dry-run mode is faster (read-only)

## Common Workflows

### Query → Preview → Apply
1. `query-notes` - Find files
2. `batch-operation` (dryRun: true) - Preview
3. `batch-operation` (dryRun: false) - Apply

## Best Practices

1. Always use dry-run first to preview changes
2. Start with small batches to test
3. Use specific filters to avoid unintended changes
4. Use maxFiles limit to prevent processing too many files

## Notes

- Filters work with AND logic (all must match)
- If `paths` specified, other filters ignored
- Tag filtering checks both inline and frontmatter tags
- Files skipped if operation makes no changes
- Errors collected but don't stop batch
- Dry-run shows changes without modifying files
- Max 100 files per batch
