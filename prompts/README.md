# Prompt Templates

This directory contains customizable prompt templates used by the Personal Agent plugin.

## Directory Structure

```
prompts/
├── system/                          # System prompts for AI assistant behavior
│   ├── system-prompt.md            # Main system prompt with vault info
│   └── skills.md                   # Skill usage instructions
└── messages/                        # User-facing messages
    └── no-results-error.md         # Error message when no documents found
```

## Template Variables

Prompt files can contain template variables that get replaced with dynamic content at runtime. Variables use the `{{variableName}}` syntax (similar to Mustache templates).

### Available Variables

#### `system-prompt.md`
- `{{totalFiles}}` - Total number of documents in the vault
- `{{topFolders}}` - List of main folders in the vault
- `{{topTags}}` - Most common tags across documents
- `{{skillContent}}` - Skill instructions (from skills.md)

#### `skills.md`
- `{{skillList}}` - Dynamically generated list of available skills

#### `no-results-error.md`
- No variables (static content)

## How to Customize

### 1. Edit Prompt Files

Simply open any `.md` file in this directory and modify the text. Changes will take effect after reloading the plugin.

**Example - Customizing the system prompt:**

```markdown
You are a helpful AI assistant for an Obsidian vault.

VAULT OVERVIEW:
- Total documents: {{totalFiles}}
- Main folders: {{topFolders}}
- Common tags: {{topTags}}

{{skillContent}}

RULES:
- Base answers on provided context documents
- When context is insufficient, use available skills to find more information
- Always cite your sources
- Be concise but thorough
- Use proper Markdown syntax

[Add your custom instructions here]
```

### 2. Preserve Template Variables

When editing, make sure to keep the `{{variableName}}` placeholders intact. These will be replaced with actual values at runtime.

**Good:**
```markdown
Total documents: {{totalFiles}}
```

**Bad:**
```markdown
Total documents: 42  <!-- Hard-coded value won't update -->
```

### 3. Reload Plugin

After making changes:
1. Open Command Palette (Ctrl/Cmd+P)
2. Search for "Reload app without saving"
3. Or disable and re-enable the plugin in Settings

## Tips

- **Test your changes**: After editing, start a chat to verify the prompt works as expected
- **Keep backups**: Consider versioning your custom prompts with git
- **Language customization**: You can translate prompts to any language
- **Formatting**: Use Markdown formatting for better readability

## Fallback Behavior

If a prompt file is missing or cannot be loaded, the plugin will automatically fall back to embedded default prompts. This ensures the plugin always works even if prompt files are deleted.

## Advanced Customization

### Adding New Variables

To add new template variables:
1. Modify the prompt file to include `{{newVariable}}`
2. Update the code in `src/prompts/prompt-loader.ts` to provide the variable value
3. Rebuild the plugin

### Multi-Language Support (Future)

In the future, we plan to support multiple language directories:
```
prompts/
├── en-US/
│   └── system/
│       └── system-prompt.md
└── zh-CN/
    └── system/
        └── system-prompt.md
```

## Troubleshooting

### Changes Not Taking Effect

1. Verify the file was saved
2. Reload the plugin
3. Check the developer console (Ctrl/Cmd+Shift+I) for errors

### Syntax Errors

- Make sure template variables are properly formatted: `{{variableName}}`
- Avoid special characters in variable names
- Keep opening `{{` and closing `}}` on the same line

### Template Variables Not Replaced

- Check that the variable name matches exactly (case-sensitive)
- Verify the variable is defined in the prompt loader
- Check the developer console for warnings

## Examples

### Minimal System Prompt

```markdown
You are an AI assistant for Obsidian. You have {{totalFiles}} documents to work with.

{{skillContent}}

Be helpful and concise.
```

### Detailed System Prompt

```markdown
# AI Assistant Configuration

## Your Role
You are an advanced AI assistant integrated into an Obsidian vault.

## Vault Statistics
- Documents indexed: {{totalFiles}}
- Primary folders: {{topFolders}}
- Frequently used tags: {{topTags}}

## Available Tools
{{skillContent}}

## Guidelines
1. Always cite sources with [[wikilinks]]
2. Suggest relevant vault connections
3. Maintain consistency with existing notes
4. Use the appropriate heading levels
5. Apply tags thoughtfully

## Response Format
- Start with a brief summary
- Provide detailed explanation
- End with related notes or next steps
```

## Support

For issues or feature requests, please visit:
https://github.com/Secbone/obsidian-personal-agent/issues
