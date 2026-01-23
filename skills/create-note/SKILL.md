---
name: create_document
description: Create a new document. Supports templates and frontmatter.
metadata:
  version: "1.0.0"
  author: personal-agent
  tags: [create, write, new]
  executable: true
  implementation: scripts/index.ts
  requiresConfirmation: true
---

# Create Document Skill

## Description

Creates new documents in the Obsidian vault with:
- Custom file paths and folder creation
- Initial content
- Frontmatter metadata
- Optional template support
- Automatic reindexing for semantic search

## Usage

Use this skill to create new notes, daily notes, project files, or any other documents. The skill will automatically create parent folders if they don't exist.

**IMPORTANT**: This skill requires user confirmation before execution.

## Input Schema

```typescript
{
  path: string;                    // File path for the new document (required)
  content?: string;                // Initial content (optional)
  template?: string;               // Template name to use (optional, not yet implemented)
  variables?: Record<string, any>; // Variables for template (optional, not yet implemented)
  frontmatter?: Record<string, any>;  // Frontmatter metadata (optional)
  triggerReindex?: boolean;        // Trigger reindex after creation (default: true)
}
```

## Output

Returns creation result:

```typescript
{
  path: string;                    // Full file path
  name: string;                    // File basename
  created: boolean;                // Whether file was created
  length: number;                  // Content length in characters
  reindexed: boolean;              // Whether file was reindexed
}
```

## Examples

### 1. Create a simple note

```json
{
  "path": "Notes/New Note.md",
  "content": "# New Note\n\nContent here"
}
```

### 2. Create with frontmatter

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

### 3. Create daily note

```json
{
  "path": "Daily/2025-01-20.md",
  "content": "# Daily Note - 2025-01-20\n\n## Tasks\n- [ ] Task 1\n\n## Notes\n",
  "frontmatter": {
    "date": "2025-01-20",
    "tags": ["daily-note"]
  }
}
```

### 4. Create empty file with frontmatter only

```json
{
  "path": "Templates/Meeting Template.md",
  "frontmatter": {
    "title": "Meeting Template",
    "type": "template"
  }
}
```

## Best Practices

1. **Use descriptive paths**: Include folder structure in the path
2. **Add frontmatter for metadata**: Tags, dates, and status fields help with organization
3. **Follow Obsidian conventions**: Use `.md` extension and avoid special characters
4. **Check if file exists first**: Use `query_documents` to avoid conflicts
5. **Use proper Markdown syntax**: Follow Obsidian Flavored Markdown conventions

## Notes

- If the file already exists, the skill returns an error (no overwriting)
- Parent folders are created automatically if they don't exist
- Frontmatter is added at the top of the file in YAML format
- Reindexing happens asynchronously and may take a moment
- Template support is planned but not yet implemented
