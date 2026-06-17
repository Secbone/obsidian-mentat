# Obsidian Personal Agent - Quick Start Guide

## ✅ 已完成的功能

### Phase 1 & 2 (完成)
- ✅ 完整的插件架构
- ✅ 多协议 AI 支持 (OpenAI、Anthropic、Ollama)
- ✅ AI 智能路由系统
- ✅ 设置管理界面
- ✅ Obsidian Skills 双向集成
- ✅ OpenCode 可选集成

## 🚀 安装方法

### 方法 1: 开发安装（推荐用于测试）

1. 将项目复制到您的 Obsidian vault:
   ```bash
   cd /path/to/your/vault/.obsidian/plugins
   cp -r /Users/zhouweipeng/Code/obsidian-mentat .
   ```

2. 在 Obsidian 中:
   - 打开 Settings → Community plugins
   - 关闭 Safe mode（如果启用）
   - 点击 "Reload plugins"
   - 启用 "Personal Agent"

### 方法 2: 符号链接（推荐用于开发）

```bash
cd /path/to/your/vault/.obsidian/plugins
ln -s /Users/zhouweipeng/Code/obsidian-mentat obsidian-mentat
```

然后在 Obsidian 中重载插件。

## ⚙️ 配置 AI 提供者

### 1. OpenAI 或兼容 API

在 Settings → Personal Agent → AI Providers:

1. 点击 "Add AI Provider"
2. 配置：
   - **Name**: `My OpenAI` 或任意名称
   - **Type**: `openai`
   - **Base URL**:
     - OpenAI: `https://api.openai.com/v1`
     - DeepSeek: `https://api.deepseek.com/v1`
     - 其他兼容 API 的 URL
   - **API Key**: 您的 API key
   - **Model**: `gpt-4o`, `deepseek-chat` 等
   - **Embedding Model**: `text-embedding-3-small` (可选)

### 2. Anthropic Claude

1. 点击 "Add AI Provider"
2. 配置：
   - **Name**: `Claude`
   - **Type**: `anthropic`
   - **API Key**: 您的 Anthropic API key
   - **Model**: `claude-sonnet-4-5-20250929`
   - 注意: Anthropic 不支持 embedding，需要配置其他提供者用于 embedding 任务

### 3. Ollama (本地)

确保 Ollama 正在运行:
```bash
ollama serve
ollama pull llama3.2
ollama pull nomic-embed-text
```

然后配置:
- **Name**: `Ollama`
- **Type**: `ollama`
- **Base URL**: `http://localhost:11434`
- **Model**: `llama3.2`
- **Embedding Model**: `nomic-embed-text`

## 🎯 任务路由配置

在 Settings → Task Routing 中，为不同任务类型指定 AI 提供者:

- **Embedding**: Ollama (推荐) - 快速、本地
- **Classification**: Ollama 或 OpenAI Mini - 快速分类
- **Link Suggestion**: Claude 或 GPT-4 - 需要深度理解
- **Chat**: Claude 或 GPT-4 - 复杂对话
- **Review**: Ollama - 生成复习问题

## 🧪 测试 AI 连接

1. 配置完 AI 提供者后
2. 打开命令面板 (Cmd/Ctrl + P)
3. 运行: `Personal Agent: Test AI Providers`
4. 查看测试结果

## 📝 当前可用命令

- `Personal Agent: Test AI Providers` - 测试所有配置的 AI 提供者
- `Personal Agent: Open AI Chat` - 打开 AI 对话 (即将推出)
- `Personal Agent: Classify current note` - 分类当前笔记 (即将推出)
- `Personal Agent: Suggest links` - 建议链接 (即将推出)
- `Personal Agent: Open Knowledge Graph` - 打开知识图谱 (即将推出)
- `Personal Agent: Start review session` - 开始复习 (即将推出)

## 🔧 Skills 集成

如果您安装了 Obsidian Skills 插件:

1. 在 Settings → Integrations 中启用 "Enable Obsidian Skills Integration"
2. 重载插件
3. 可用的 skills:
   - `/pa-classify` - 分类笔记
   - `/pa-suggest-links` - 建议链接
   - `/pa-chat` - AI 对话
   - `/pa-review` - 开始复习

## 📊 当前项目状态

**已完成的 Phases (2/10):**
- ✅ Phase 1: 项目初始化和基础设施
- ✅ Phase 2: AI 能力集成

**进行中的工作:**
- 🚧 Phase 3: 索引系统
- 🚧 Phase 4: 自动分类和标签
- 🚧 Phase 5: 智能链接建议
- 🚧 Phase 6: 对话式交互
- 🚧 Phase 7: 知识图谱可视化
- 🚧 Phase 8: Review 系统
- 🚧 Phase 9: UI/UX 优化
- 🚧 Phase 10: 测试和发布

## 🐛 已知问题

暂无

## 💡 开发建议

如果您想继续开发:

```bash
cd /Users/zhouweipeng/Code/obsidian-mentat

# 开发模式（带热重载）
npm run dev

# 生产构建
npm run build

# 代码检查
npm run lint
```

## 📖 下一步

参考完整计划: `/Users/zhouweipeng/.claude/plans/parallel-growing-puffin.md`

当前构建状态: ✅ 成功 (main.js: 158K)
