---
name: query_documents
description: Search and filter documents in the vault. Supports semantic search, tag filtering, folder filtering, glob patterns, date ranges, and frontmatter filtering.
metadata:
  version: "1.0.0"
  author: personal-agent
  tags: [search, query, filter]
  executable: true
  implementation: scripts/index.ts
---

# Query Documents Skill

## Description

Searches and filters documents in the Obsidian vault with various criteria:
- **Semantic search** using embeddings for natural language queries
- **Tag filtering** with AND logic (all tags must match)
- **Folder filtering** to search within specific directories
- **Glob pattern matching** for flexible file path patterns
- **Date range filtering** by modification time
- **Frontmatter filtering** to match specific metadata fields
- **Flexible sorting** by relevance, modification time, creation time, or name

## Usage

**IMPORTANT**: Always use this skill BEFORE trying to read documents. Don't guess file paths - query first to find the exact paths.

## Input Schema

```typescript
{
  query?: string;              // Semantic search query (natural language)
  tags?: string[];             // Filter by tags (AND logic - all must match)
  folders?: string[];          // Filter by folder paths (OR logic)
  pattern?: string;            // Glob pattern (e.g., "Daily/2025-*.md", "**/*.md")
  dateFrom?: string;           // Filter files modified after this date (ISO format)
  dateTo?: string;             // Filter files modified before this date (ISO format)
  frontmatter?: Record<string, any>;  // Filter by frontmatter fields
  limit?: number;              // Maximum number of results (default: 10, max: 100)
  sortBy?: 'modified' | 'created' | 'name' | 'relevance';  // Sort order (default: 'relevance')
}
```

## Output

Returns a list of matching documents with metadata:

```typescript
{
  results: Array<{
    path: string;              // Full file path
    name: string;              // File basename
    score?: number;            // Relevance score (if sortBy is 'relevance')
    metadata: {
      tags: string[];          // All tags (from content and frontmatter)
      frontmatter: Record<string, any>;  // Frontmatter metadata
      modified: number;        // Last modified timestamp
      created: number;         // Creation timestamp
    }
  }>;
  total: number;               // Number of results returned
  query?: string;              // The search query used
  filters: {                   // Applied filters
    pattern?: string;
    tags?: string[];
    folders?: string[];
    dateFrom?: string;
    dateTo?: string;
  }
}
```

## Examples

### 1. Find all project notes

```json
{
  "tags": ["project"],
  "limit": 50
}
```

### 2. Semantic search for machine learning content

```json
{
  "query": "machine learning techniques",
  "limit": 5
}
```

### 3. Find recent documents in Projects folder

```json
{
  "folders": ["Projects"],
  "dateFrom": "2025-01-01T00:00:00Z",
  "sortBy": "modified",
  "limit": 10
}
```

### 4. Pattern matching for daily notes

```json
{
  "pattern": "Daily/2025-*.md",
  "limit": 20
}
```

### 5. Complex query with multiple filters

```json
{
  "query": "API design",
  "tags": ["development"],
  "folders": ["Projects", "Notes"],
  "frontmatter": { "status": "active" },
  "limit": 10
}
```

## Best Practices

1. **Start broad, then narrow**: Begin with a simple query, then add filters if needed
2. **Use semantic search for concepts**: Natural language queries work well for finding related content
3. **Use tags for categorization**: Tags are efficient for filtering by topic or status
4. **Use patterns for structured files**: Glob patterns are perfect for daily notes or dated files
5. **Check the total**: If you get the max limit, there may be more results - refine your query
6. **Combine filters**: Multiple filters work together (AND logic) for precise results

## Notes

- Semantic search requires the index manager to be available and initialized
- If semantic search fails, the skill falls back to metadata-only filtering
- Glob patterns support `*` (any chars), `**` (any path), and `?` (single char)
- Date filtering uses file modification time, not frontmatter dates
- Tag filtering checks both inline tags (`#tag`) and frontmatter tags
