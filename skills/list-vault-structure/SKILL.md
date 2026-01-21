---
name: list_vault_structure
description: Get an overview of the vault structure including folders, tags, and recent files. Use this to understand what content exists in the vault.
metadata:
  version: "1.0.0"
  author: personal-agent
  tags: [vault, structure, overview]
  executable: true
  implementation: scripts/index.ts
---

# List Vault Structure Skill

## Description

Provides an overview of the Obsidian vault structure:
- **Folders**: List folders with file counts
- **Tags**: List tags with usage counts
- **Recent files**: List recently modified files

Use this skill to understand the vault organization before querying or creating documents.

## Usage

Use this skill when you need to:
- Understand the vault organization
- Find which folders contain the most files
- Discover commonly used tags
- See recently modified files

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

Returns vault structure overview:

```typescript
{
  totalFiles: number;              // Total number of markdown files
  folders?: Array<{                // Folders sorted by file count (if included)
    path: string;                  // Folder path
    fileCount: number;             // Number of files in folder
  }>;
  tags?: Array<{                   // Tags sorted by usage count (if included)
    tag: string;                   // Tag name
    count: number;                 // Number of files with this tag
  }>;
  recentFiles?: Array<{            // Recent files sorted by modification time (if included)
    path: string;                  // File path
    name: string;                  // File basename
    modified: number;              // Last modified timestamp
  }>;
}
```

## Examples

### 1. Get complete vault overview

```json
{
  "includeFolders": true,
  "includeTags": true,
  "includeRecent": true,
  "limit": 20
}
```

### 2. Get only folder structure

```json
{
  "includeFolders": true,
  "includeTags": false,
  "includeRecent": false,
  "limit": 50
}
```

### 3. Get only tag statistics

```json
{
  "includeFolders": false,
  "includeTags": true,
  "includeRecent": false,
  "limit": 30
}
```

### 4. Get recent files only

```json
{
  "includeFolders": false,
  "includeTags": false,
  "includeRecent": true,
  "limit": 10
}
```

## Best Practices

1. **Use before querying**: Understand the vault structure before searching
2. **Check folder organization**: See which folders contain the most content
3. **Discover tags**: Find commonly used tags for filtering
4. **Find recent work**: See what's been modified recently
5. **Adjust limit as needed**: Use higher limits for comprehensive overviews

## Notes

- Folders are sorted by file count (descending)
- Tags are sorted by usage count (descending)
- Recent files are sorted by modification time (descending)
- Tag counts include both inline tags and frontmatter tags
- Root folder is represented as "/"
- Limit applies to each list independently
