---
name: create_note
description: Create new document with optional template and frontmatter
metadata:
  version: "1.0.0"
  author: personal-agent
  tags: [create, write, new]
  executable: true
  implementation: scripts/index.ts
  requiresConfirmation: true
  performance: fast
  category: file-operations
---

# Create Document Skill

## Description

Create new document with optional content, frontmatter metadata, and automatic folder creation.

**IMPORTANT**: Before creating note content, reference the `obsidian-markdown` skill to ensure proper Obsidian Flavored Markdown syntax (Wikilinks, callouts, tags, frontmatter, etc.).

## When to use
- Creating new notes, daily notes, or journal entries
- Creating project files with structure and metadata
- Creating documents from templates

## When NOT to use
- Modifying existing documents (use update-note instead)
- Appending to existing documents (use update-note instead)
- When file already exists (check with query-notes first)

**IMPORTANT**: This skill requires user confirmation before execution.

## Input Schema

```typescript
{
  path: string;                    // File path (required)
  content?: string;                // Initial content
  template?: string;               // Template name (not yet implemented)
  variables?: {                    // Template variables (not yet implemented)
    [key: string]: string | number | boolean;
  };
  frontmatter?: {                  // Frontmatter metadata
    [key: string]: string | number | boolean | string[];
  };
  triggerReindex?: boolean;        // Trigger reindex (default: true)
}
```

## Output

```typescript
{
  path: string;
  name: string;
  created: boolean;
  length: number;
  reindexed: boolean;
}
```

## Examples

### Create with frontmatter

```json
{
  "path": "Projects/New Project.md",
  "content": "# Project Name\n\n## Overview\n\nProject description here.",
  "frontmatter": {
    "status": "active",
    "priority": "high",
    "tags": ["project"],
    "created": "2025-01-20"
  }
}
```

### Create daily note

```json
{
  "path": "Daily/2025-01-20.md",
  "content": "# Daily Note - 2025-01-20\n\n## Tasks\n- [ ] Task 1",
  "frontmatter": {
    "date": "2025-01-20",
    "tags": ["daily-note"]
  }
}
```

### Create empty file with frontmatter only

```json
{
  "path": "Templates/Meeting.md",
  "frontmatter": {
    "title": "Meeting Template",
    "type": "template"
  }
}
```

## Performance Characteristics

- Fast (< 100ms)
- Reindexing adds 100-500ms if enabled
- Folder creation adds minimal overhead

## Common Workflows

### Template-Based Creation
1. `read-note` - Get template content
2. (Process template)
3. `create-note` - Create with processed content

## Best Practices

1. Use descriptive paths with folder structure
2. Add frontmatter for metadata (tags, dates, status)
3. Check if file exists first with `query-notes`
4. Use `.md` extension and follow Markdown conventions

## Notes

- Returns error if file already exists (no overwriting)
- Parent folders created automatically
- Frontmatter added at top in YAML format
- Reindexing happens asynchronously
- Template support planned but not yet implemented
