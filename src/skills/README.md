# Skill System Implementation

## Overview

This is a **hybrid architecture** skill system for AI Agent that combines:

- **Built-in Skills** - Core Obsidian document management tools implemented as internal skills (fast, zero-config)
- **MCP Integration** - Support for external Model Context Protocol (MCP) servers (extensible, ecosystem)
- **Unified Management** - SkillRegistry manages both types with consistent interface

The system integrates with the chat infrastructure and leverages OpenAI/Anthropic Function Calling/Tool Use capabilities. All skills follow the [Agent Skills specification](https://agentskills.io/specification).

### Design Philosophy

1. **Internal Skills First** - Core document operations are built-in for performance and zero-config
2. **MCP for Extension** - External capabilities via standard MCP protocol
3. **Unified Interface** - AI agents see no difference between internal and external skills
4. **Type Safety** - Zod schemas for validation, full TypeScript types

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│              ChatView (Chat Interface)                   │
│  - Display skill calls and results                      │
│  - Distinguish internal (obsidian:) vs MCP (mcp:)       │
│  - Handle user confirmations                            │
└────────────────────┬────────────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────────────┐
│            ChatOrchestrator (Enhanced)                   │
│  - Coordinates Agent + Skill execution                  │
│  - Manages multi-turn conversation flow                 │
│  - Injects skill calls/results into message history     │
└────────────────────┬────────────────────────────────────┘
                     │
        ┌────────────┴────────────┐
        │                         │
┌───────▼────────┐        ┌──────▼──────────┐
│ SkillRegistry  │        │  AI Providers   │
│                │        │   (Extended)    │
│ - Unified mgmt │◄───────┤  - OpenAI       │
│ - Format conv. │        │  - Anthropic    │
│ - Namespacing  │        └─────────────────┘
└───────┬────────┘
        │
        ├──────────────────┬─────────────────┐
        │                  │                 │
┌───────▼──────┐  ┌────────▼────────┐  ┌────▼─────────┐
│Built-in      │  │  SkillExecutor  │  │  MCP Client  │
│Skills        │  │                 │  │              │
│              │  │ - Validation    │  │ - Connection │
│obsidian:     │  │ - Coordination  │  │ - Protocol   │
│query_docs    │  │ - Error handle  │  │ - Discovery  │
│read_doc      │  │ - Permissions   │  │              │
│update_doc    │  └─────────────────┘  │mcp:*:*       │
│create_doc    │                       │filesystem    │
│update_fm     │                       │browser       │
│batch_op      │                       │github...     │
└──────────────┘                       └──────────────┘
```

### Core Components

1. **SkillRegistry** - Central registry for all skills
   - Manages built-in and MCP skills
   - Converts skill definitions to OpenAI/Anthropic formats
   - Maintains namespaces (`obsidian:`, `mcp:server:tool`)

2. **Built-in Skills** - Direct Obsidian API access
   - Zero config, auto-registered on plugin startup
   - High performance, no network overhead
   - 7 executable skills + documentation skills

3. **MCP Client** - Standard MCP protocol implementation
   - Connects to configured MCP servers (stdio/HTTP)
   - Auto-discovers and registers tools from servers
   - Handles tool calls and response formatting

4. **SkillExecutor** - Execution coordinator
   - Routes by namespace to built-in or MCP
   - Unified error handling and retry logic
   - Async execution, non-blocking UI

## Directory Structure

### Project Root: `/skills/`

User-facing skills directory following Agent Skills specification:

```
skills/                              # Unified skills directory
├── README.md                        # User guide (how to use/add skills)
├── query-notes/
│   ├── SKILL.md                     # Metadata + documentation
│   └── scripts/implementation.ts    # Executable implementation
├── read-note/
│   ├── SKILL.md
│   └── scripts/implementation.ts
├── edit-note/
│   ├── SKILL.md
│   └── scripts/implementation.ts
├── batch-operation/
│   ├── SKILL.md
│   └── scripts/implementation.ts
├── list-notes/
│   ├── SKILL.md
│   └── scripts/implementation.ts
└── obsidian-markdown/               # Documentation-only skill
    └── SKILL.md
```

### Source Code: `/src/skills/`

Implementation code for the skill system:

```
src/skills/
├── README.md                        # This file (developer guide)
├── index.ts                         # Public exports
├── skill-types.ts                   # Core type definitions
├── skill-registry.ts                # SkillRegistry class
├── skill-executor.ts                # SkillExecutor class
├── skill-loader.ts                  # UnifiedSkillLoader
└── mcp/                             # MCP integration
    ├── index.ts
    ├── mcp-types.ts                 # MCP protocol types
    ├── mcp-transport.ts             # stdio/HTTP transport
    ├── mcp-client.ts                # MCPClient implementation
    └── mcp-manager.ts               # MCPManager for connections
```

## Implementation Details

### Skill Types

Two types of skills are supported:

1. **Executable Skills** (`ExecutableSkillDefinition`)
   - Have `metadata.executable: true` in SKILL.md
   - Include `scripts/implementation.ts` with:
     - `schema` - Zod validation schema
     - `execute` - Async execution function
     - `createSkill` - Factory function (optional)
   - Executed by SkillExecutor

2. **Documentation Skills** (`DocumentationSkillDefinition`)
   - Have `metadata.executable: false` (or omitted)
   - Only contain SKILL.md with documentation
   - Content injected into AI system prompt
   - Used for guidance (e.g., obsidian-markdown skill)

### SKILL.md Format

Every skill must have a `SKILL.md` file:

```markdown
---
name: skill-name
description: Brief description
metadata:
  executable: true
  requiresConfirmation: false
  version: "1.0.0"
---

# Skill Name

Detailed description and usage documentation.

## Input Schema

\`\`\`typescript
interface Input {
  field: string;
}
\`\`\`

## Output Format

Description of what the skill returns.

## Examples

### Example 1
...
```

### UnifiedSkillLoader

The `UnifiedSkillLoader` class (in `skill-loader.ts`):

1. Scans `/skills/` directory for subdirectories
2. Reads and parses SKILL.md frontmatter
3. Checks `metadata.executable` flag
4. For executable skills: loads implementation via compile-time imports
5. For documentation skills: extracts markdown content
6. Returns unified `AnySkillDefinition[]` array

**Key methods:**
- `loadAllSkills()` - Load all skills from directory
- `isExecutableSkill()` - Type guard for executable skills
- `isDocumentationSkill()` - Type guard for doc skills

### ChatOrchestrator Integration

In `src/chat/chat-orchestrator.ts`:

```typescript
private async loadAllSkills(): Promise<void> {
  // Load all skills (executable + documentation)
  const allSkills = await UnifiedSkillLoader.loadAllSkills();

  // Separate by type
  const executableSkills = allSkills.filter(UnifiedSkillLoader.isExecutableSkill);
  const docSkills = allSkills.filter(UnifiedSkillLoader.isDocumentationSkill);

  // Register executable skills
  executableSkills.forEach(skill => this.skillRegistry.register(skill));

  // Inject documentation skills into system prompt
  this.injectDocumentationSkills(docSkills);
}
```

## Adding New Skills

### Adding an Executable Skill

1. **Create skill directory**:
   ```bash
   mkdir skills/my-new-skill
   ```

2. **Create SKILL.md**:
   ```markdown
   ---
   name: my-new-skill
   description: Does something useful
   metadata:
     executable: true
     requiresConfirmation: false
   ---

   # My New Skill

   Documentation here...
   ```

3. **Create implementation.ts**:
   ```typescript
   import { z } from 'zod';

   export const schema = z.object({
     input: z.string()
   });

   export type Input = z.infer<typeof schema>;

   export async function execute(input: Input, context: SkillExecutionContext) {
     // Implementation
     return { success: true, result: 'done' };
   }

   export function createSkill() {
     return {
       name: 'my-new-skill',
       description: 'Does something useful',
       schema,
       execute
     };
   }
   ```

4. **Add to loader** (if using compile-time imports):
   Update `src/skills/skill-loader.ts` to include your skill in the import map.

5. **Test**: Reload skills and test in chat interface

### Adding a Documentation Skill

1. **Create skill directory**:
   ```bash
   mkdir skills/my-doc-skill
   ```

2. **Create SKILL.md**:
   ```markdown
   ---
   name: my-doc-skill
   description: Provides guidance on X
   metadata:
     executable: false
   ---

   # My Documentation Skill

   This provides guidance to the AI on how to...
   ```

3. **Test**: Reload skills and verify content appears in system prompt

## MCP Integration

### Configuration

MCP servers are configured in plugin settings:

```typescript
interface MCPServerConfig {
  id: string;
  name: string;
  type: 'stdio' | 'http';

  // For stdio
  command?: string;
  args?: string[];
  env?: Record<string, string>;

  // For HTTP
  url?: string;
  headers?: Record<string, string>;

  enabled: boolean;
  autoConnect: boolean;
}
```

### Workflow

1. **Startup**: Plugin connects to `enabled` + `autoConnect` servers
2. **Initialize**: Send MCP `initialize` request
3. **Discover**: Call `tools/list` to get available tools
4. **Register**: Add tools to SkillRegistry with `mcp:server-id:tool-name` namespace
5. **Execute**: When AI calls MCP tool, route through MCPClient to server

### Namespacing

- **Built-in skills**: `obsidian:skill-name`
- **MCP skills**: `mcp:server-id:tool-name`

This prevents naming conflicts and allows permission management.

## Verification

### Build Verification

```bash
npm run build
# Should complete with no errors
```

### Runtime Testing

1. **Skill Loading**:
   - Enable Developer Tools in Obsidian
   - Check console for "Loaded X skills" message
   - Verify no loading errors

2. **Skill Execution**:
   - Test each skill in chat interface
   - Verify correct parameter handling
   - Check result formatting

3. **Reload Command**:
   - Run "Reload all skills" command
   - Verify skills reload without errors

4. **Documentation Injection**:
   - Check that doc skills appear in system prompt
   - Test AI's awareness of documented patterns

### Debugging

Enable debug logging:
```typescript
// In chat-orchestrator.ts
console.debug('Loaded skills:', this.skillRegistry.list());
console.debug('Executing skill:', skillName, input);
```

## Design Decisions

### 1. Hybrid Architecture (Built-in + MCP)

**Choice**: Hybrid approach

**Rationale**:
- Built-in skills: better performance, zero config
- MCP: extensibility and ecosystem access
- Combined: best of both worlds

### 2. Namespace Design

**Choice**: `obsidian:` and `mcp:server:tool`

**Rationale**:
- Clear source identification
- Prevents naming conflicts
- Enables permission filtering

### 3. Compile-time vs Runtime Loading

**Choice**: Compile-time imports for executable skills

**Rationale**:
- Type safety at build time
- No eval() or dynamic requires
- Better error detection
- Tree-shaking support

### 4. SKILL.md as Source of Truth

**Choice**: Metadata in SKILL.md, not in code

**Rationale**:
- Follows Agent Skills specification
- Single source of truth for metadata
- Easier to update documentation
- AI can read skill definitions directly

### 5. executionCategory (Parallelism Control)

Each skill declares an `executionCategory` in its metadata that controls how multiple tools are executed in a single turn:

| Category | Parallelism | Examples |
|----------|-------------|----------|
| `read` | Fully parallel | `read_note`, `query_notes`, `web_search` |
| `write` | Serial within group | `edit_note`, `write_note`, `batch_operation` |
| `mutate` | Serial within group | `move_note` (vault structure changes) |
| `external` | Serial within group | `run_command`, `web_fetch` |

Read operations execute concurrently (safe). Write/mutate/external operations execute serially (prevent race conditions).

### 6. permissions and SkillSecurity

Skills declare required permissions via `metadata.permissions`. The `SkillExecutor` checks these against user configuration before execution:

```typescript
enum SkillPermission {
  READ = 'read',
  WRITE = 'write',
  CREATE = 'create',
  DELETE = 'delete',
  EXTERNAL = 'external'
}
```

User settings can restrict via `skillConfigurations[fullName].allowedPermissions`. Currently permissions are advisory; full enforcement is planned.

## Security Considerations

1. **Input Validation**:
   - All inputs validated with Zod schemas
   - Type-safe at compile time
   - Runtime validation before execution

2. **Path Traversal Protection**:
   - Validate file paths stay within vault
   - Normalize paths before operations

3. **MCP Security**:
   - Only connect to user-configured servers
   - Timeout and retry limits prevent DoS
   - No automatic execution of destructive operations
   - Optional confirmation dialogs

4. **Permissions**:
   - `requiresConfirmation` flag for destructive ops
   - Configurable allowed skills list
   - Dry-run mode support

## Performance Considerations

1. **Async Execution**: All skills run async, UI stays responsive
2. **Lazy Loading**: Skills loaded on demand where possible
3. **MCP Connection Pooling**: Reuse connections to MCP servers
4. **Caching**: Cache frequently accessed data

## Future Enhancements

1. **Validation Script**: Validate SKILL.md format
2. **Hot Reload**: Watch for skill file changes
3. **Skill Marketplace**: Share skills between users
4. **Analytics**: Track skill usage patterns
5. **Skill Composition**: Chain multiple skills together
6. **Conditional Execution**: Skills with preconditions

## Troubleshooting

### Build Errors

**Issue**: TypeScript compilation errors

**Solution**:
- Check all imports are correct
- Verify Zod schemas are properly typed
- Ensure skill-loader.ts import map is up to date

### Skills Not Loading

**Issue**: Skills don't appear in registry

**Solution**:
- Check SKILL.md frontmatter syntax
- Verify `metadata.executable` is correctly set
- Check console for loading errors
- Verify skill directory structure

### MCP Connection Failures

**Issue**: Can't connect to MCP server

**Solution**:
- Verify server command/URL is correct
- Check server is running
- Review server logs
- Test with simple HTTP request (for HTTP servers)

## References

- [Agent Skills Specification](https://agentskills.io/specification)
- [Model Context Protocol](https://modelcontextprotocol.io/)
- [OpenAI Function Calling](https://platform.openai.com/docs/guides/function-calling)
- [Anthropic Tool Use](https://docs.anthropic.com/claude/docs/tool-use)

## Summary

This skill system provides:

- ✅ Unified management of executable and documentation skills
- ✅ Agent Skills specification compliance
- ✅ Type-safe implementation with Zod validation
- ✅ MCP integration for extensibility
- ✅ Clean separation of concerns
- ✅ Easy to extend and maintain
- ✅ Production-ready with proper error handling

The hybrid architecture balances performance (built-in skills) with extensibility (MCP), providing a solid foundation for AI agent capabilities.
