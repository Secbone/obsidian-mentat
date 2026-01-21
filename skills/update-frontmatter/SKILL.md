---
name: update_frontmatter
description: Update frontmatter metadata in a document. Can add, modify, or remove frontmatter fields.
metadata:
  version: "1.0.0"
  author: personal-agent
  tags: [metadata, frontmatter, update]
  executable: true
  implementation: scripts/index.ts
---

# Update Frontmatter Skill

## Description

Updates frontmatter metadata in Obsidian documents:
- Add new frontmatter fields
- Modify existing fields
- Remove fields
- Merge with existing frontmatter or replace entirely

## Usage

Use this skill to update document metadata without modifying the content. This is safer than full document updates when you only need to change metadata.

## Input Schema

```typescript
{
  path: string;                    // File path to update (required)
  updates: Record<string, any>;    // Frontmatter fields to add or update (required)
  remove?: string[];               // Frontmatter fields to remove (optional)
  merge?: boolean;                 // Merge with existing frontmatter (default: true)
}
```

## Output

Returns update result:

```typescript
{
  path: string;                    // Full file path
  name: string;                    // File basename
  updated: boolean;                // Whether file was updated
  previousFrontmatter: Record<string, any>;  // Previous frontmatter
  newFrontmatter: Record<string, any>;       // New frontmatter
}
```

## Examples

### 1. Add tags to a document

```json
{
  "path": "Notes/My Note.md",
  "updates": {
    "tags": ["important", "review"]
  }
}
```

### 2. Update status field

```json
{
  "path": "Projects/Project A.md",
  "updates": {
    "status": "completed",
    "completedDate": "2025-01-20"
  }
}
```

### 3. Remove a field

```json
{
  "path": "Notes/Old Note.md",
  "updates": {},
  "remove": ["draft"]
}
```

### 4. Replace frontmatter entirely

```json
{
  "path": "Templates/Template.md",
  "updates": {
    "title": "New Template",
    "type": "template"
  },
  "merge": false
}
```

### 5. Update multiple fields

```json
{
  "path": "Projects/Project B.md",
  "updates": {
    "status": "in-progress",
    "priority": "high",
    "assignee": "John Doe",
    "lastUpdated": "2025-01-20"
  }
}
```

## Best Practices

1. **Use merge mode by default**: Preserves existing frontmatter fields
2. **Be careful with replace mode**: Only use when you want to completely replace frontmatter
3. **Use consistent field names**: Follow your vault's naming conventions
4. **Use appropriate data types**: Arrays for tags, strings for text, numbers for counts
5. **Remove obsolete fields**: Clean up unused frontmatter fields

## Notes

- Merge mode (default) preserves existing fields and adds/updates specified fields
- Replace mode (merge: false) completely replaces frontmatter with the updates
- Remove operation happens after merge/replace
- Document content is preserved unchanged
- Frontmatter is formatted in YAML syntax
- Arrays are formatted with `- ` prefix for each item
