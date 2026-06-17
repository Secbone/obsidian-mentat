---
name: read_note
description: Read document content with optional metadata
metadata:
  version: "1.0.0"
  author: mentat
  tags: [read, file, content]
  executable: true
  implementation: scripts/index.ts
  performance: fast
  category: file-operations
---

# Read Document Skill

## Description

Read document content with optional metadata, supporting full reads, specific sections, line/character ranges, and multi-section extraction.

## When to use
- Reading file content after finding with query-notes
- Extracting specific sections or line ranges from documents
- Reading multiple sections in one operation
- Getting document metadata (tags, links, headings)

## When NOT to use
- Searching for documents (use query-notes instead)
- Modifying documents (use edit-note instead)
- Listing multiple files (use query-notes or list-notes instead)

## Input Schema

```typescript
{
  path: string;                    // File path (required)
  section?: string;                // Specific section/heading
  includeMetadata?: boolean;       // Include metadata (default: true)
  includeFrontmatter?: boolean;    // Include frontmatter (default: true)
  includeLinks?: boolean;          // Include outgoing links (default: true)
  includeBacklinks?: boolean;      // Include backlinks (default: false)

  // Partial read parameters
  startLine?: number;              // Starting line (1-based, inclusive)
  endLine?: number;                // Ending line (1-based, inclusive)
  startChar?: number;              // Starting character (0-based)
  length?: number;                 // Characters to read from startChar
  sections?: string[];             // Array of section headings
  contextLines?: number;           // Context lines before/after range
}
```

### Parameter Priority

1. If `sections` array provided → Extract all specified sections
2. Else if `section` (single) provided → Extract single section
3. Else if `startLine` & `endLine` provided → Extract line range
4. Else if `startChar` & `length` provided → Extract character range
5. Otherwise → Read full document

## Output

```typescript
{
  path: string;
  name: string;
  content: string;

  lineRange?: {                    // When reading line range
    start: number;                 // 1-based
    end: number;                   // 1-based, inclusive
    totalLines: number;
  };

  charRange?: {                    // When reading character range
    start: number;                 // 0-based
    end: number;                   // 0-based
    totalChars: number;
  };

  sectionsContent?: Array<{        // When reading multiple sections
    heading: string;
    content: string;
    startLine: number;             // 1-based
    endLine: number;               // 1-based
    level: number;
  }>;

  beforeContext?: string;          // Lines before range (if contextLines used)
  afterContext?: string;           // Lines after range (if contextLines used)

  frontmatter?: Record<string, any>;
  metadata?: {
    tags: string[];
    links: string[];
    backlinks?: string[];
    headings: Array<{
      level: number;               // 1-6
      text: string;
      position: number;
      lineNumber: number;          // 1-based
    }>;
    wordCount: number;
    charCount: number;
    lineCount: number;
    modified: number;
    created: number;
  }
}
```

## Examples

### Read entire document

```json
{
  "path": "Notes/My Note.md",
  "includeMetadata": true
}
```

### Read specific line range with context

```json
{
  "path": "LargeDocument.md",
  "startLine": 50,
  "endLine": 100,
  "contextLines": 5
}
```

### Read multiple sections

```json
{
  "path": "Projects/Project Plan.md",
  "sections": ["Tasks", "Notes", "Goals"]
}
```

### Read content only (minimal)

```json
{
  "path": "Templates/Note.md",
  "includeMetadata": false,
  "includeFrontmatter": false
}
```

## Performance Characteristics

- Fast (< 100ms for typical documents)
- Scales with file size
- Metadata extraction adds minimal overhead
- Backlink computation can be slower (100ms+)

## Common Workflows

### Query → Read → Update
1. `query-notes` - Find files
2. `read-note` - Read content
3. `edit-note` - Make changes

## Best Practices

1. Use exact paths from `query-notes` results
2. Use line ranges for targeted reads in large documents
3. Disable metadata when not needed for better performance
4. Use multi-section extraction instead of multiple reads

## Notes

- Line numbers are 1-based; character offsets are 0-based
- Section extraction is case-insensitive
- Line ranges are inclusive on both ends
- Missing sections in multi-section reads are silently skipped
- Backlinks computed from cache (may not be real-time)
