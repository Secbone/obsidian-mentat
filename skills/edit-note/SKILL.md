---
name: edit_note
description: Edit existing notes by finding and replacing specific text
metadata:
  version: "2.0.0"
  author: mentat
  tags: [edit, replace, update]
  executable: true
  implementation: scripts/index.ts
  requiresConfirmation: true
  performance: fast
  category: file-operations
---

# edit_note

Make precise text replacements in existing notes by specifying the exact text to find (`old_string`) and its replacement (`new_string`).

## When to use
- Replacing a specific section of text in an existing note
- Renaming headings, variables, or other unique strings
- Fixing typos or updating facts in an existing note
- Making small targeted edits without rewriting the entire file

## When NOT to use
- Creating new notes (use write_note instead)
- Rewriting entire file content (use write_note instead)
- Appending to end of file (use write_note instead)
- Reading note content (use read_note instead)
- Searching for notes (use query_notes instead)

## Input Schema

```typescript
{
  path: string;                    // File path (required, must exist)
  old_string: string;              // Exact text to find (required)
  new_string: string;              // Replacement text (required, must differ from old_string)
  replace_all?: boolean;           // Replace all occurrences (default: false)
  triggerReindex?: boolean;        // Trigger reindex after operation (default: true)
}
```

## Output Schema

```typescript
{
  path: string;                   // File path
  name: string;                   // File basename
  created: boolean;               // Always false (edit does not create files)
  updated: boolean;               // Whether file was updated
  operation: string;              // "replace"
  previousLength: number;         // Length of content before operation
  newLength: number;              // Length of content after operation
  reindexed: boolean;             // Whether file was reindexed
}
```

## Examples

### Replace specific text

```json
{
  "path": "Notes/Project.md",
  "old_string": "Status: planned",
  "new_string": "Status: in progress"
}
```

### Rename a heading

```json
{
  "path": "Notes/Documentation.md",
  "old_string": "## Old Section Name",
  "new_string": "## New Section Name"
}
```

### Replace all occurrences

```json
{
  "path": "Notes/Glossary.md",
  "old_string": "TODO",
  "new_string": "DONE",
  "replace_all": true
}
```

## Matching Rules

1. **Exact match first**: The entire `old_string` must appear exactly once in the file. Include whitespace, indentation, and line breaks exactly as they appear.
2. **Fuzzy fallback**: If exact match fails, the system tries a flexible match (ignoring whitespace differences, case-insensitive).
3. **Uniqueness**: The `old_string` must be unique (appear exactly once). If it appears multiple times, the edit fails with an error listing the line numbers. Provide more surrounding context to make it unique, or use `replace_all: true`.
4. **Read before edit**: You must read the file with `read_note` before editing it.

## Performance Characteristics

- Fast (< 100ms for typical edits)
- Scales with file size
- Text replacement: O(n) with uniqueness validation

## Best Practices

1. Always read the file with `read_note` first to know the exact current content
2. Provide enough surrounding context in `old_string` to ensure uniqueness
3. Use exact whitespace and indentation from the file
4. For bulk replacements of common strings, use `replace_all: true`

## Error Handling

- **File not found**: "File does not exist: {path}. Use write_note to create new files."
- **Text not found**: Detailed message showing the expected search block with tips
- **Multiple matches**: Lists file locations where the text appears, asking for more context
- **Same old/new**: "old_string and new_string must be different."
