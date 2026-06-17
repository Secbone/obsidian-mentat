# Skills Directory

This directory contains all skills for the Personal Agent plugin, following the [Agent Skills specification](https://agentskills.io/specification).

## Structure

Each skill is organized as a separate directory with the following structure:

```
skills/
├── query-notes/              # Example executable skill
│   ├── SKILL.md              # Skill metadata and documentation
│   └── scripts/
│       └── index.ts          # TypeScript implementation
├── obsidian-markdown/        # Example documentation-only skill
│   └── SKILL.md              # Documentation only (no scripts/)
└── README.md                 # This file
```

## Skill Types

### Executable Skills

Executable skills contain both metadata/documentation (SKILL.md) and implementation code (scripts/implementation.ts).

**Example: query-notes/**
- **SKILL.md**: Defines name, description, usage, examples
- **scripts/index.ts**: Contains schema and execute function

**Executable skills in this directory:**
- `query-notes`: Search and filter documents with semantic search
- `read-note`: Read document content with metadata
- `edit-note`: Create or update documents with intelligent operation detection
- `batch-operation`: Batch operations on multiple documents
- `list-notes`: Get vault structure overview

### Documentation-Only Skills

Documentation-only skills provide information and guidelines to the AI without executable code.

**Example: obsidian-markdown/**
- **SKILL.md**: Complete guide to Obsidian Flavored Markdown syntax
- No `scripts/` directory

**Documentation skills in this directory:**
- `obsidian-markdown`: Guide for Obsidian Flavored Markdown

## SKILL.md Format

Each skill must have a `SKILL.md` file with YAML frontmatter and Markdown documentation:

```markdown
---
name: skill_name
description: Brief description of what the skill does
metadata:
  version: "1.0.0"
  author: mentat
  tags: [tag1, tag2]
  executable: true  # false for documentation-only skills
  implementation: scripts/index.ts
  requiresConfirmation: true  # optional, for destructive operations
---

# Skill Name

## Description
Detailed description...

## Usage
How to use this skill...

## Input Schema
```typescript
{
  param1: string;
  param2?: number;
}
```

## Output
Expected output format...

## Examples
Example usage...

## Best Practices
Tips and guidelines...

## Notes
Additional information...
```

## Implementation Structure

For executable skills, `scripts/index.ts` exports:

```typescript
import { z } from 'zod';
import { SkillContext, SkillResult } from '../../../src/skills/skill-types';

// Input schema
export const schema = z.object({
  // Define input parameters
});

export type Input = z.infer<typeof schema>;

// Execute function
export async function execute(
  input: Input,
  context: SkillContext
): Promise<SkillResult> {
  // Implementation
}

// Factory function for backward compatibility
export function createSkill(context: SkillContext) {
  return {
    schema,
    execute: (input: Input) => execute(input, context)
  };
}
```

## Adding a New Skill

### Executable Skill

1. Create a new directory: `skills/my-skill/`
2. Create `SKILL.md` with frontmatter and documentation
3. Create `scripts/index.ts` with schema and execute function
4. Add the skill to the implementation map in `src/skills/skill-loader.ts`:
   ```typescript
   import * as MySkillImpl from '../../skills/my-skill/scripts';

   this.implementationMap = new Map([
     // ... existing skills
     ['my_skill', MySkillImpl]
   ]);
   ```
5. Reload skills using the command palette: "Reload all skills"

### Documentation-Only Skill

1. Create a new directory: `skills/my-guide/`
2. Create `SKILL.md` with:
   - `executable: false` in metadata
   - Complete documentation in Markdown body
3. No `scripts/` directory needed
4. Reload skills using the command palette: "Reload all skills"

## Skill Context

Executable skills receive a `SkillContext` object with access to:

```typescript
interface SkillContext {
  vault: Vault;                    // Obsidian vault API
  metadataCache: MetadataCache;    // File metadata and cache
  workspace: Workspace;            // Workspace API
  indexManager: IndexManager;      // Semantic search index
  plugin: MentatPlugin;     // Main plugin instance
}
```

## Best Practices

1. **Clear naming**: Use descriptive, action-oriented names (e.g., `query_notes`, not `search`)
2. **Complete documentation**: Include description, usage, examples, and best practices in SKILL.md
3. **Type safety**: Use Zod schemas for input validation
4. **Error handling**: Return proper SkillResult with success/error states
5. **User confirmation**: Set `requiresConfirmation: true` for destructive operations
6. **Metadata separation**: Keep all metadata in SKILL.md, not in implementation code
7. **Single responsibility**: Each skill should do one thing well
8. **Consistent style**: Follow existing skills for structure and documentation

## Skill Registry

Skills are loaded by `SkillLoader` and registered in `SkillRegistry`:

```typescript
// In RAGOrchestrator
const skillLoader = new SkillLoader(app, 'skills');
const allSkills = await skillLoader.loadAllSkills(context);

// Separate and register
const executableSkills = allSkills.filter(isExecutableSkill);
const docSkills = allSkills.filter(isDocumentationSkill);

skillRegistry.registerBulk(executableSkills);
skillRegistry.registerDocumentationBulk(docSkills);
```

## Testing Skills

1. Build the plugin: `npm run build`
2. Reload Obsidian
3. Use the command palette: "Reload all skills"
4. Check the console for loading messages
5. Test skill execution in the chat interface

## Validation

Use [skills-ref](https://github.com/agentskills/skills-ref) to validate SKILL.md format:

```bash
npm install -g @agentskills/skills-ref
skills-ref validate skills/query-notes
```

## References

- [Agent Skills Specification](https://agentskills.io/specification)
- [Obsidian API Documentation](https://docs.obsidian.md/Reference/TypeScript+API)
- [Zod Documentation](https://zod.dev/)
