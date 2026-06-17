---
name: query_notes
description: Search documents by content, tags, folders, or glob patterns
metadata:
  version: "1.0.0"
  author: mentat
  tags: [search, query, filter]
  executable: true
  implementation: scripts/index.ts
  performance: variable
  category: search
---

# Query Documents Skill

## Description

Search documents by semantic search, tags, folders, or glob patterns. At least one of `query`, `tags`, `folders`, or `pattern` should be provided.

## When to use
- Finding documents by semantic search (natural language queries)
- Filtering by tags, folders, or frontmatter fields
- Pattern matching with glob syntax (e.g., daily notes)
- Discovering files before reading them

## When NOT to use
- Reading a specific known file path (use read-note instead)
- Listing all vault structure (use list-notes instead)
- Searching within a single document (use read-note then process content)

**IMPORTANT**: Always use this skill BEFORE trying to read documents. Don't guess file paths - query first to find exact paths.

## Input Schema

```typescript
{
  query?: string;              // Semantic search query (natural language)
  tags?: string[];             // Filter by tags (AND logic)
  folders?: string[];          // Filter by folder paths (OR logic)
  pattern?: string;            // Glob pattern (e.g., "Daily/2025-*.md")
  dateFrom?: string;           // Modified after (ISO format)
  dateTo?: string;             // Modified before (ISO format)
  frontmatter?: Record<string, any>;  // Filter by frontmatter fields
  limit?: number;              // Max results (default: 10, max: 100)
  sortBy?: 'modified' | 'created' | 'name' | 'relevance';  // Default: 'relevance'
}
```

## Output

```typescript
{
  results: Array<{
    path: string;
    name: string;
    score?: number;            // If sortBy is 'relevance'
    metadata: {
      tags: string[];
      frontmatter: Record<string, any>;
      modified: number;
      created: number;
    }
  }>;
  total: number;
  query?: string;
  filters: {
    pattern?: string;
    tags?: string[];
    folders?: string[];
    dateFrom?: string;
    dateTo?: string;
  }
}
```

## Examples

### Find all project notes

```json
{
  "tags": ["project"],
  "limit": 50
}
```

### Semantic search

```json
{
  "query": "machine learning techniques",
  "limit": 5
}
```

### Pattern matching for daily notes

```json
{
  "pattern": "Daily/2025-*.md",
  "limit": 20
}
```

### Complex query with multiple filters

```json
{
  "query": "API design",
  "tags": ["development"],
  "folders": ["Projects", "Notes"],
  "frontmatter": { "status": "active" },
  "limit": 10
}
```

## Performance Characteristics

- Variable (50ms - 2s depending on vault size and complexity)
- Semantic search slower than metadata filtering
- Tag/folder/pattern filtering is fastest
- Degrades with large vaults (1000+ documents)

## Common Workflows

### Discover → Read → Update
1. `query-notes` - Find files
2. `read-note` - Read content
3. `edit-note` - Modify files

## Best Practices

1. Start broad, then add filters if needed
2. Use semantic search for concepts, tags for categorization
3. Use patterns for structured files (daily notes, dated files)
4. Check total - if you hit limit, refine your query

## Notes

- Semantic search requires index manager (falls back to metadata if unavailable)
- Glob patterns support `*`, `**`, `?`
- Date filtering uses file modification time
- Tag filtering checks both inline tags and frontmatter
- Returns empty array if no matches (not an error)
