---
name: list_notes
description: List vault folders, tags, and recent files
metadata:
  version: "1.0.0"
  author: personal-agent
  tags: [vault, structure, overview]
  executable: true
  implementation: scripts/index.ts
  performance: variable
  category: vault-info
---

# List Notes Skill

## Description

List vault folders, tags, and recent files to provide overview of vault organization.

## When to use
- Understanding vault organization before queries
- Finding which folders contain most files
- Discovering commonly used tags
- Seeing recently modified files

## When NOT to use
- Searching for specific documents (use query-notes instead)
- Reading file content (use read-note instead)

## Input Schema

```typescript
{
  includeFolders?: boolean;        // Include folder list (default: true)
  includeTags?: boolean;           // Include tag statistics (default: true)
  includeRecent?: boolean;         // Include recent files (default: true)
  limit?: number;                  // Limit for lists (default: 20, max: 100)
}
```

## Output

```typescript
{
  totalFiles: number;
  folders?: Array<{                // Sorted by file count (descending)
    path: string;
    fileCount: number;
  }>;
  tags?: Array<{                   // Sorted by usage count (descending)
    tag: string;
    count: number;
  }>;
  recentFiles?: Array<{            // Sorted by modification time (descending)
    path: string;
    name: string;
    modified: number;
  }>;
}
```

## Examples

### Get complete vault overview

```json
{
  "includeFolders": true,
  "includeTags": true,
  "includeRecent": true,
  "limit": 20
}
```

### Get only folder structure

```json
{
  "includeFolders": true,
  "includeTags": false,
  "includeRecent": false,
  "limit": 50
}
```

### Get recent files only

```json
{
  "includeFolders": false,
  "includeTags": false,
  "includeRecent": true,
  "limit": 10
}
```

## Performance Characteristics

- Variable (100ms - 1s depending on vault size)
- Degrades with large vaults (1000+ files)
- Folder list faster than tag computation

## Common Workflows

### Initial Exploration
1. `list-notes` - Get overview
2. `query-notes` - Search within discovered folders/tags

## Best Practices

1. Use before querying to understand vault structure
2. Check folder organization to see where content lives
3. Discover tags for filtering
4. Adjust limit as needed for comprehensive overviews

## Notes

- Folders sorted by file count (descending)
- Tags sorted by usage count (descending)
- Recent files sorted by modification time (descending)
- Tag counts include both inline and frontmatter tags
- Root folder represented as "/"
- Limit applies to each list independently
