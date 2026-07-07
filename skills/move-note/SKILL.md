---
name: move_note
description: Move or rename notes, updating all links automatically
metadata:
  version: "1.0.0"
  author: mentat
  tags: [move, rename, delete, trash, organize]
  executable: true
  implementation: scripts/index.ts
  requiresConfirmation: true
  performance: fast
  category: file-operations
---

# move_note

Move or rename notes to a new path. All wikilinks and markdown links pointing to the note are automatically updated. To delete a note, move it to the Trash folder.

## When to use
- Moving a note to a different folder
- Renaming a note (change the filename)
- Organizing notes into a new folder structure
- Deleting a note by moving it to Trash

## When NOT to use
- Editing note content (use edit_note instead)
- Creating new notes (use write_note instead)
- Reading note content (use read_note instead)
- Batch operations on multiple files (use batch_operation instead)

## Input Schema

```typescript
{
  path: string;                    // Source file path (required, must exist)
  new_path: string;                // Destination file path (required)
  triggerReindex?: boolean;        // Trigger reindex after operation (default: true)
}
```

## Output Schema

```typescript
{
  path: string;                   // Original file path
  new_path: string;               // New file path
  name: string;                   // New filename
  moved: boolean;                 // Always true on success
  linksUpdated: boolean;          // Always true (FileManager updates links)
  reindexed: boolean;             // Whether search index was updated
}
```

## Examples

### Move note to a different folder

```json
{
  "path": "Notes/Meeting.md",
  "new_path": "Archive/Meeting.md"
}
```

### Rename a note

```json
{
  "path": "Notes/Draft.md",
  "new_path": "Notes/Final Version.md"
}
```

### Delete a note (move to Trash)

```json
{
  "path": "Notes/Obsolete.md",
  "new_path": "Trash/Obsolete.md"
}
```

### Move note to a new nested folder (auto-created)

```json
{
  "path": "Notes/Research.md",
  "new_path": "Projects/2025/Q1/Research.md"
}
```

## Behavior

1. **Link updates**: All wikilinks (`[[note]]`) and markdown links (`[text](note.md)`) pointing to the moved file are automatically updated according to your Obsidian link settings.
2. **Folder creation**: If the destination folder does not exist, it is created automatically (including all intermediate folders).
3. **Trash**: To delete a note, move it to `Trash/`. The Trash folder is created if it doesn't exist. This is a soft delete — the note can be recovered by moving it back.
4. **Conflict prevention**: If a file already exists at the destination path, the operation fails.

## Performance Characteristics

- Fast (< 100ms for most operations)
- Link update time depends on the number of links in the vault
- Reindexing adds minimal overhead

## Best Practices

1. Use `read_note` first to verify the source file exists and is the correct one
2. For deletion, prefer `move_note` to Trash over permanent deletion
3. When renaming, keep the `.md` extension in the new_path
4. Destination folders are auto-created, so you can organize freely

## Error Handling

- **File not found**: "File does not exist: {path}"
- **Same path**: "Source and destination paths are the same."
- **Destination exists**: "Destination already exists: {new_path}. Choose a different path."
