---
name: read_document
description: Read content from a document. Can read the entire document or a specific section by heading name.
metadata:
  version: "1.0.0"
  author: personal-agent
  tags: [read, file, content]
  executable: true
  implementation: scripts/index.ts
---

# Read Document Skill

## Description

Reads content from Obsidian documents with flexible options:
- Read entire document or specific sections
- Include/exclude metadata (tags, links, headings, word count)
- Include/exclude frontmatter
- Include/exclude backlinks
- Extract specific sections by heading name

## Usage

Use this skill after finding documents with `query_documents`. Always use exact file paths from query results.

## Input Schema

```typescript
{
  path: string;                    // File path to read (required)
  section?: string;                // Specific section/heading to read (optional)
  includeMetadata?: boolean;       // Include file metadata (default: true)
  includeFrontmatter?: boolean;    // Include frontmatter (default: true)
  includeLinks?: boolean;          // Include outgoing links (default: true)
  includeBacklinks?: boolean;      // Include backlinks (default: false)
}
```

## Output

Returns document content with optional metadata:

```typescript
{
  path: string;                    // Full file path
  name: string;                    // File basename
  content: string;                 // Document content (or section content)
  frontmatter?: Record<string, any>;  // Frontmatter metadata (if included)
  metadata?: {
    tags: string[];                // All tags (from content and frontmatter)
    links: string[];               // Outgoing wikilinks
    backlinks?: string[];          // Backlinks to this document
    headings: Array<{              // Document headings
      level: number;               // Heading level (1-6)
      text: string;                // Heading text
      position: number;            // Character position in document
    }>;
    wordCount: number;             // Word count
    charCount: number;             // Character count
    modified: number;              // Last modified timestamp
    created: number;               // Creation timestamp
  }
}
```

## Examples

### 1. Read entire document with metadata

```json
{
  "path": "Notes/My Note.md",
  "includeMetadata": true
}
```

### 2. Read specific section

```json
{
  "path": "Projects/Project A.md",
  "section": "Task List",
  "includeMetadata": false
}
```

### 3. Read with backlinks

```json
{
  "path": "Index.md",
  "includeBacklinks": true
}
```

### 4. Read content only (minimal metadata)

```json
{
  "path": "Templates/Note Template.md",
  "includeMetadata": false,
  "includeFrontmatter": false
}
```

## Best Practices

1. **Use exact paths**: Always use paths from `query_documents` results
2. **Read sections for large documents**: Use the `section` parameter to extract specific parts
3. **Disable metadata when not needed**: Improves performance for large documents
4. **Use backlinks sparingly**: Backlink computation can be expensive
5. **Check headings first**: Review the headings array to find section names

## Notes

- Section extraction is case-insensitive
- Section extraction includes all content until the next heading of the same or higher level
- If a section is not found, the skill returns an error
- Backlinks are computed from the metadata cache and may not be real-time
- Word count is based on whitespace-separated tokens
