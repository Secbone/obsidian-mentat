# Mentat - Obsidian Plugin

Your local agentic cognitive partner for Obsidian. Mentat is an AI agent that lives in your vault — it reads, writes, searches, researches, and summarizes your notes through conversation.

## What you can do with it

- **💬 Chat with your vault**: "Find my notes about RAG from last week and summarize them"
- **🔍 Deep research**: Create structured research plans, search the web, fetch pages, and save findings
- **✍️ Write and edit notes**: "Write a technical summary of this paper to Research/"
- **🛠️ Automate tasks**: Bulk operations, frontmatter updates, file moves with link fixing
- **🎨 Two UI themes**: Classic bubble chat or terminal-style timeline — switch anytime
- **🧩 Extensible**: Extension system, skill framework, MCP support

## AI Providers

| Provider | Chat + Tools | Embedding | Local |
|----------|-------------|-----------|-------|
| OpenAI (and compatible) | ✅ | ✅ | ❌ |
| Anthropic Claude | ✅ | ❌ | ❌ |
| Ollama | ❌ (no tool support) | ✅ | ✅ |

Set up in Settings → Mentat → Add AI Provider.

## Quick start

```bash
# Install
cd /path/to/vault/.obsidian/plugins
git clone https://github.com/Secbone/obsidian-mentat mentat
cd mentat && npm install && npm run build

# Enable in Obsidian: Settings → Community plugins → Mentat
# Configure: Settings → Mentat → Add AI Provider
# Open chat: Ctrl/Cmd+P → "Open AI Chat"
```

## Development

```bash
npm run build        # Type check + bundle → dist/
npm run deploy:dev   # Copy to ~/Documents/obsidian/.obsidian/plugins/
npm run lint         # ESLint
npm test             # Vitest
```

### Project structure

```
src/
├── agents/          # Agent runtime (BaseAgent, Compactor, events)
├── chat/            # Chat orchestration (session, query, subagents)
├── context/         # Message windowing, token estimation
├── extensions/      # Extension system (EventBus, ExtensionManager)
├── providers/       # AI providers (OpenAI, Anthropic, Ollama)
├── prompts/         # System prompts, skill prompts, vault context
├── settings/        # Plugin settings & settings UI
├── skills/          # Skill framework (registry, executor, MCP, strategies)
├── ui/              # Themed UI (ChatView, bubble theme, terminal theme)
└── types/           # Shared type definitions
```

## In-depth docs

| Doc | What it covers |
|-----|----------------|
| [`src/ui/themes/README.md`](src/ui/themes/README.md) | Theme system architecture, creating new themes |
| [`src/ui/README.md`](src/ui/README.md) | UI system overview, CSS conventions, icon sizing |
| [`src/agents/README.md`](src/agents/README.md) | Agent system, events, streaming, tool execution |
| [`src/skills/README.md`](src/skills/README.md) | Skill framework internals, MCP integration |
| [`skills/README.md`](skills/README.md) | Adding and documenting skills |
| [`prompts/README.md`](prompts/README.md) | Prompt system, template variables |
| [`docs/agent-system-improvements.md`](docs/agent-system-improvements.md) | Agent improvement roadmap |
| [`docs/theme-system-refactor.md`](docs/theme-system-refactor.md) | Theme system refactoring history |

## Roadmap

- [x] Phase 1: Agent system — conversation, tool calling, multi-turn reasoning
- [x] Phase 2: Skill framework — 12 built-in skills, progressive/native/auto modes, MCP
- [x] Phase 3: Themed UI — BubbleTheme, TerminalTheme, smart scroll, terminal presets
- [x] Phase 4: Extension system v1 + automatic context compaction
- [ ] Phase 5: Tree-structured sessions with branching and comparison
- [ ] Phase 6: Extension system v2 — dynamic loading, permission sandbox
- [ ] Phase 7: i18n, plugin marketplace, community extension registry

## Built with

- [Obsidian](https://obsidian.md/) plugin API
- [Anthropic Claude](https://anthropic.com/) · [OpenAI](https://openai.com/) · [Ollama](https://ollama.ai/)
- [PI Agent](https://pi.dev) design influence (minimal core, extensibility)
- [OpenCode](https://opencode.ai) design influence (event-driven agent, permissions)

## License

MIT
