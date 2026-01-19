# Personal Agent - Obsidian Plugin

AI-powered personal assistant for Obsidian that helps organize notes, create knowledge links, and build your personal knowledge base.

## Features

- **Auto Classification**: Automatically classify and tag your notes with AI
- **Smart Link Suggestions**: Get intelligent suggestions for linking related notes
- **AI Chat**: Chat with your knowledge base using RAG (Retrieval-Augmented Generation)
- **Knowledge Graph**: Visualize your notes in an interactive 3D graph
- **Review System**: Spaced repetition algorithm for effective knowledge review

## AI Provider Support

Personal Agent supports multiple AI providers:

- **OpenAI-compatible APIs**: OpenAI, DeepSeek, and any OpenAI-compatible endpoint
- **Anthropic**: Native support for Claude models
- **Ollama**: Local AI models for privacy and speed

## Installation

### For Development

1. Clone this repository into your Obsidian vault's plugins folder:
   ```bash
   cd /path/to/your/vault/.obsidian/plugins
   git clone https://github.com/yourusername/obsidian-personal-agent personal-agent
   cd personal-agent
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Build the plugin:
   ```bash
   npm run build
   ```

4. Reload Obsidian and enable "Personal Agent" in Settings → Community plugins

### For Users

1. Open Obsidian Settings
2. Go to Community plugins and browse
3. Search for "Personal Agent"
4. Install and enable the plugin

## Configuration

### Setting up AI Providers

1. Go to Settings → Personal Agent
2. Click "Add AI Provider"
3. Configure your provider:
   - **Name**: Give it a descriptive name
   - **Type**: Select OpenAI, Anthropic, or Ollama
   - **API Key**: Your API key (if required)
   - **Base URL**: Custom endpoint URL (for OpenAI-compatible APIs)
   - **Model**: The model to use

### Task Routing

You can assign different AI providers to specific tasks:

- **Embedding**: For generating note embeddings (usually Ollama)
- **Classification**: For classifying and tagging notes
- **Linking**: For suggesting links between notes
- **Chat**: For conversational queries
- **Review**: For generating review questions

### Optional Integrations

- **OpenCode**: Enable advanced automation features
- **Obsidian Skills**: Register and use Skills commands

## Usage

### Commands

- `/classify-note`: Classify the current note
- `/suggest-links`: Get link suggestions for the current note
- `/open-chat`: Open AI chat interface
- `/open-graph`: View knowledge graph
- `/start-review`: Begin a review session

### Skills Integration

When Skills integration is enabled, you can use:
- `/pa-classify`: Classify note (callable by other skills)
- `/pa-link`: Suggest links (callable by other skills)
- `/pa-chat`: Chat interface (callable by other skills)

## Development

### Project Structure

```
src/
├── main.ts                 # Plugin entry point
├── settings/               # Settings management
├── ai/                     # AI providers and routing
├── features/               # Core features
│   ├── classification/
│   ├── linking/
│   ├── chat/
│   ├── graph/
│   └── review/
├── indexing/               # Vector indexing system
├── ui/                     # UI components
└── types/                  # TypeScript definitions
```

### Building

```bash
npm run dev    # Development mode with watch
npm run build  # Production build
npm run lint   # Run ESLint
```

### Testing

```bash
npm test
```

## Performance

- Optimized for vaults with 100-1000 notes
- Batch processing to avoid UI blocking
- Incremental indexing for fast updates
- LRU cache for embeddings

## Privacy

- Use Ollama for local, private AI processing
- All data stays in your vault
- No data sent to cloud unless you configure cloud AI providers

## License

MIT

## Support

- GitHub Issues: [Report bugs or request features](https://github.com/yourusername/obsidian-personal-agent/issues)
- Documentation: [Full documentation](https://github.com/yourusername/obsidian-personal-agent/wiki)

## Roadmap

- [ ] Phase 1: Project setup ✓
- [ ] Phase 2: AI providers integration
- [ ] Phase 3: Indexing system
- [ ] Phase 4: Auto classification
- [ ] Phase 5: Link suggestions
- [ ] Phase 6: Chat interface
- [ ] Phase 7: Knowledge graph
- [ ] Phase 8: Review system
- [ ] Phase 9: UI/UX polish
- [ ] Phase 10: Testing and release

## Credits

Built with:
- [Obsidian](https://obsidian.md/)
- [Anthropic Claude](https://anthropic.com/)
- [OpenAI](https://openai.com/)
- [Ollama](https://ollama.ai/)
- [3D Force Graph](https://github.com/vasturiano/3d-force-graph)
