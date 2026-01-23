---
name: update_frontmatter
description: Update document frontmatter properties with merge or replace mode
metadata:
  version: "1.0.0"
  author: personal-agent
  tags: [metadata, frontmatter, update]
  executable: true
  implementation: scripts/index.ts
  requiresConfirmation: true
  performance: fast
  category: file-operations
---

# Update Frontmatter Skill

## Description

Update document frontmatter properties with merge or replace mode. Supports adding, modifying, and removing fields.

## When to use
- Updating document metadata without modifying content
- Adding or modifying frontmatter fields
- Removing obsolete frontmatter fields
- Safer than full document updates when only changing metadata

## When NOT to use
- Updating document content (use update-note instead)
- Bulk updates across multiple files (use batch-operation instead)

## Input Schema

```typescript
{
  path: string;                    // File path (required)
  updates: {                       // Fields to add/update (required)
    [key: string]: string | number | boolean | string[];
  };
  remove?: string[];               // Fields to remove
  merge?: boolean;                 // Merge with existing (default: true)
}
```

## Output

```typescript
{
  path: string;
  name: string;
  updated: boolean;
  previousFrontmatter: Record<string, any>;
  newFrontmatter: Record<string, any>;
}
```

## Examples

### Add tags

```json
{
  "path": "Notes/My Note.md",
  "updates": {
    "tags": ["important", "review"]
  }
}
```

### Update status field

```json
{
  "path": "Projects/Project A.md",
  "updates": {
    "status": "completed",
    "completedDate": "2025-01-20"
  }
}
```

### Remove a field

```json
{
  "path": "Notes/Old Note.md",
  "updates": {},
  "remove": ["draft"]
}
```

### Replace frontmatter entirely

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

## Performance Characteristics

- Fast (< 100ms)
- Only parses frontmatter, doesn't process markdown content
- Performance independent of document body length

## Common Workflows

### Read → Update
1. `read-note` - Check current frontmatter
2. `update-frontmatter` - Update fields

## Best Practices

1. Use merge mode by default to preserve existing fields
2. Use consistent field names across vault
3. Use appropriate data types (arrays for tags, strings for text, numbers for counts)
4. Read before updating if uncertain about current values

## Notes

- Merge mode (default) preserves existing fields and adds/updates specified fields
- Replace mode (merge: false) completely replaces frontmatter
- Remove operation happens after merge/replace
- Document content preserved unchanged
- Frontmatter formatted in YAML syntax
