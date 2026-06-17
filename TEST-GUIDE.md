# Personal Agent 插件测试指南

## 📦 编译完成

✅ 插件已成功编译，包含以下文件：
- `main.js` (204 KB) - 插件主程序
- `styles.css` (8.7 KB) - 样式文件
- `manifest.json` (455 B) - 插件清单

## 🚀 安装步骤

### 方法 1: 直接复制到 Obsidian 插件目录（推荐测试）

1. **找到您的 Obsidian vault 插件目录**：
   ```
   /path/to/your/vault/.obsidian/plugins/
   ```

2. **创建插件文件夹**：
   ```bash
   mkdir -p "/path/to/your/vault/.obsidian/plugins/mentat"
   ```

3. **复制文件**：
   ```bash
   cp dist/main.js dist/styles.css dist/manifest.json "/path/to/your/vault/.obsidian/plugins/mentat/"
   ```

4. **重启 Obsidian**

5. **启用插件**：
   - 打开设置 → 社区插件
   - 找到 "Personal Agent" 并启用

### 方法 2: 使用开发模式（推荐开发）

如果您已经在当前项目目录下，可以创建软链接：

```bash
# 替换为您的 vault 路径
VAULT_PATH="/path/to/your/vault"
ln -s "$(pwd)" "$VAULT_PATH/.obsidian/plugins/mentat"
```

## ⚙️ 配置 AI Provider

在测试功能之前，您需要配置至少一个 AI Provider：

1. 打开设置 → Personal Agent
2. 点击 "Add AI Provider"
3. 配置提供商（选择其中一种）：

### 选项 A: OpenAI / DeepSeek
```
Name: DeepSeek
Type: OpenAI
API Key: 您的 API Key
Base URL: https://api.deepseek.com/v1
Model: deepseek-chat
Embedding Model: text-embedding-3-small
```

### 选项 B: Ollama（本地、免费）
```
Name: Ollama
Type: Ollama
Base URL: http://localhost:11434
Model: llama3.2:latest
Embedding Model: nomic-embed-text
```

**注意**:
- 对于 **Embedding** 任务，必须选择支持嵌入的 provider（OpenAI 或 Ollama）
- Anthropic Claude 不支持嵌入，只能用于聊天

4. 在 "Task Routing" 中分配任务：
   - **Embedding**: 选择 OpenAI 或 Ollama
   - **Chat**: 可以选择任何 provider

## 🧪 测试场景

### ✅ 场景 1: 基础功能测试（必须通过）

**目标**: 验证插件能正常启动和索引

1. **启动插件**
   - ✅ 检查控制台无错误（F12 打开开发者工具）
   - ✅ 右侧边栏出现 "脑" 图标

2. **索引文档**
   - 按 `Ctrl/Cmd + P` 打开命令面板
   - 搜索 "Index all documents"
   - 执行命令
   - ✅ 应该看到进度通知："Indexing: 1/10 - file.md"
   - ✅ 完成后显示："✓ Indexed X documents successfully"

3. **检查索引统计**
   - 按 `Ctrl/Cmd + P`
   - 搜索 "Show index statistics"
   - 执行命令
   - ✅ 应该显示已索引的文件数和块数

### ✅ 场景 2: 文档对话测试（核心功能）

**目标**: 验证 RAG 功能正常工作

1. **打开聊天窗口**
   - 按 `Ctrl/Cmd + P` → "Open AI Chat"
   - ✅ 右侧面板应该显示聊天界面
   - ✅ 顶部显示 "Context Documents" 面板
   - ✅ 面板样式正常（有边框、背景色等）

2. **添加文档到上下文**
   - 点击 + 按钮
   - ✅ 弹出文件选择器
   - 选择一个 Markdown 文件
   - ✅ 文件应出现在文档面板中
   - ✅ 文件项显示文件名、图标和删除按钮

3. **发送查询**
   - 在输入框输入："这个文档的主要内容是什么？"
   - 按 Enter 或点击发送按钮
   - ✅ 消息应该立即显示在聊天区域
   - ✅ AI 回复应该流式显示（逐字出现）
   - ✅ 回复末尾应该包含源引用，格式如：
     ```
     ---
     **Sources:**

     1. [[file.md]] (lines 1-100)
     ```

4. **测试文档移除**
   - 点击文档项的 X 按钮
   - ✅ 文档应从列表中移除

### ✅ 场景 3: 多轮对话测试（上下文记忆）

**目标**: 验证 AI 能记住对话历史

1. **第一轮对话**
   - 选择一个文档
   - 问："文档中提到了哪些关键概念？"
   - ✅ AI 应该回答并列出概念

2. **第二轮对话**
   - 继续问："能详细解释第一个概念吗？"
   - ✅ AI 应该记住第一轮提到的概念，并详细解释
   - ✅ 不需要重复说"第一个概念是什么"

3. **第三轮对话**
   - 问："和第二个概念相比呢？"
   - ✅ AI 应该能对比两个概念

**预期行为**: AI 能理解"第一个"、"第二个"等引用，说明上下文传递成功

### ✅ 场景 4: 增量索引测试

**目标**: 验证只重新索引修改过的文件

1. **初始索引**
   - 执行 "Index all documents"
   - 记录索引的文件数（假设为 10）

2. **修改文件**
   - 打开一个已索引的文件
   - 添加一些内容并保存

3. **增量索引**
   - 执行 "Update index (incremental)"
   - ✅ 应该显示："✓ Updated 1 documents"（只更新了修改的文件）

4. **未修改时**
   - 再次执行 "Update index (incremental)"
   - ✅ 应该显示："✓ Index is up to date"

### ✅ 场景 5: 无文档纯聊天测试

**目标**: 验证普通聊天模式（无 RAG）

1. **清空文档上下文**
   - 移除所有选中的文档
   - 文档面板应显示："No documents selected. Click + to add."

2. **发送通用问题**
   - 问："什么是机器学习？"
   - ✅ AI 应该正常回答
   - ✅ 回复末尾**不应该**包含源引用

3. **测试多轮对话**
   - 继续问："能举个例子吗？"
   - ✅ AI 应该记住前一个问题是关于机器学习的

## 🐛 常见问题排查

### 问题 1: 插件无法启动
- 检查控制台错误（F12）
- 确认 API Key 配置正确
- 尝试禁用后重新启用插件

### 问题 2: 索引失败
**错误**: "Indexing failed: No embedding model configured"
- **原因**: 未配置支持嵌入的 Provider
- **解决**: 在 Task Routing 中为 "Embedding" 任务选择 OpenAI 或 Ollama

### 问题 3: 文档面板不显示
- 检查是否成功编译了 `styles.css`
- 强制刷新 Obsidian（Ctrl/Cmd + R）

### 问题 4: AI 不回答
**错误**: "OpenAI API error: invalid_api_key"
- **原因**: API Key 无效
- **解决**: 在设置中更新 API Key

### 问题 5: AI 无法记住对话
- 检查是否成功实现了上下文传递
- 查看控制台是否有 `getContextMessages` 相关错误

## 📊 验收标准

所有以下测试必须通过才算功能正常：

- [x] 插件能正常启动，无控制台错误
- [x] 能成功索引文档
- [x] 聊天窗口 UI 正常显示
- [x] 文档面板样式正确
- [x] 能添加和删除文档
- [x] RAG 问答能返回正确答案
- [x] 回答包含源引用
- [x] AI 能记住多轮对话上下文
- [x] 增量索引只更新修改的文件
- [x] 无文档时能进行普通聊天

## 📝 测试报告

测试完成后，请记录以下信息：

```
测试日期: 2026-01-18
Obsidian 版本:
测试场景:
通过情况: ✓/✗
问题描述:
控制台错误:
```

## 🎯 下一步

测试通过后，可以考虑：
1. 添加索引状态 UI 指示器
2. 实现文件自动监听和索引
3. 优化大文件索引性能
4. 添加更多可配置选项

---

**祝测试顺利！如有问题请查看控制台日志或提交 issue。** 🚀
