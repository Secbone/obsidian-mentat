---
name: batch_operation
description: Perform batch operations on multiple documents. Supports adding/removing tags, updating frontmatter, and appending content.
metadata:
  version: "1.0.0"
  author: personal-agent
  tags: [batch, bulk, update]
  executable: true
  implementation: scripts/index.ts
  requiresConfirmation: true
---

# Batch Operation Skill

## Description

Performs batch operations on multiple documents simultaneously:
- **Add tags**: Add tags to multiple documents
- **Remove tags**: Remove tags from multiple documents
- **Update frontmatter**: Update frontmatter fields across documents
- **Append content**: Append content to multiple documents

Supports flexible filtering to select target documents:
- Filter by folders
- Filter by tags
- Filter by frontmatter fields
- Filter by specific file paths

## Usage

Use this skill for bulk updates across multiple documents. Always use dry-run mode first to preview changes.

**IMPORTANT**: This skill requires user confirmation before execution.

## Input Schema

```typescript
{
  operation: 'add-tags' | 'remove-tags' | 'update-frontmatter' | 'append-content';  // Operation to perform (required)
  filter: {                            // Filter criteria for selecting files (required)
    folders?: string[];                // Filter by folder paths (OR logic)
    tags?: string[];                   // Filter by tags (AND logic)
    frontmatter?: Record<string, any>; // Filter by frontmatter fields
    paths?: string[];                  // Specific file paths to operate on
  };
  params: Record<string, any>;         // Operation-specific parameters (required)
  dryRun?: boolean;                    // Preview changes without applying (default: false)
  maxFiles?: number;                   // Maximum number of files to process (default: 50, max: 100)
}
```

### Operation-Specific Parameters

#### add-tags
```typescript
params: {
  tags: string[];  // Tags to add
}
```

#### remove-tags
```typescript
params: {
  tags: string[];  // Tags to remove
}
```

#### update-frontmatter
```typescript
params: {
  updates: Record<string, any>;  // Frontmatter fields to update
}
```

#### append-content
```typescript
params: {
  content: string;  // Content to append
}
```

## Output

Returns batch operation result:

```typescript
{
  operation: string;               // Operation performed
  filesProcessed: number;          // Number of files processed
  filesModified: string[];         // Paths of modified files
  filesSkipped: string[];          // Paths of skipped files (no changes needed)
  errors: Array<{                  // Errors encountered
    path: string;
    error: string;
  }>;
  dryRun: boolean;                 // Whether this was a dry run
}
```

## Examples

### 1. Add tags to all files in a folder (dry run first)

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

### 2. Remove tags from completed files

```json
{
  "operation": "remove-tags",
  "filter": {
    "frontmatter": { "status": "completed" }
  },
  "params": {
    "tags": ["todo", "in-progress"]
  }
}
```

### 3. Update frontmatter for files with specific tag

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

### 4. Append content to specific files

```json
{
  "operation": "append-content",
  "filter": {
    "paths": [
      "Notes/Note1.md",
      "Notes/Note2.md",
      "Notes/Note3.md"
    ]
  },
  "params": {
    "content": "\n## Follow-up\n\nAdded on 2025-01-20"
  }
}
```

### 5. Add tags to recent files in multiple folders

```json
{
  "operation": "add-tags",
  "filter": {
    "folders": ["Projects", "Notes"],
    "tags": ["important"]
  },
  "params": {
    "tags": ["reviewed"]
  },
  "maxFiles": 20
}
```

## Best Practices

1. **Always use dry-run first**: Preview changes before applying them
2. **Start with small batches**: Test with a few files before processing many
3. **Use specific filters**: Narrow down the target files to avoid unintended changes
4. **Check the results**: Review filesModified and errors arrays
5. **Use maxFiles limit**: Prevent accidentally processing too many files
6. **Backup important data**: Batch operations can affect many files

## Notes

- Filters work together with AND logic (all conditions must match)
- If `paths` is specified, other filters are ignored
- Tag filtering checks both inline tags and frontmatter tags
- Files are skipped if the operation would make no changes
- Errors are collected but don't stop the batch operation
- Dry-run mode shows what would be changed without actually modifying files
- Maximum 100 files can be processed in a single batch
