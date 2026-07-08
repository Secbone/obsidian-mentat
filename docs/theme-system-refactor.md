# 主题系统重构任务文档

> 目标：将 obsidian-mentat 的 UI 重构为可插拔主题系统，包含 BubbleTheme（经典气泡）和 TerminalTheme（终端时间线），通过设置切换。

## 阶段 1-2（已完成）

### 主题系统架构

- `src/ui/themes/types.ts` — ChatTheme 接口 + 9 种渲染数据类型
- `src/ui/themes/registry.ts` — ThemeRegistry 工厂模式，mount/unmount/switchTo

### BubbleTheme（经典气泡）

- `src/ui/themes/bubble/index.ts` — 从 ChatView 提取全部渲染逻辑
- `src/ui/themes/bubble/style.css` — 从原 style.css 迁移

### TerminalTheme（终端时间线）

- `src/ui/themes/terminal/index.ts` — `❯` 提示符 + 时间线 + 内联确认按钮
- `src/ui/themes/terminal/style.css` — `[data-theme="terminal"]` 作用域 CSS

### ChatView 重构

- `src/ui/chat-view/index.ts` — 从 1741→~720 行纯控制器

### 设置与切换

- `src/settings/settings.ts` — `chatTheme?` + `terminalPreset?` 字段
- `src/settings/settings-tab.ts` — 主题下拉框 + 终端色板选择器
- `src/main.ts` — `saveSettings()` 触发 `switchTheme()`

## 阶段 3-4（本次实施）

### 清理

- **删除旧 `src/ui/chat-view/style.css`** — 已迁移到 bubble/style.css，不再被 import

### InputHandler 提取

- **`src/ui/chat-view/input-handler.ts`** — ~400 行，从 ChatView 提取所有输入相关逻辑：
  - Autocomplete（slash/mention suggest dropdown）
  - Draft save/restore/clear
  - Pill 插入/移除
  - Send/Steer 按键处理
- ChatView 通过 `InputHandlerCallbacks` 接口与 InputHandler 交互
- `updateElements()` 方法支持主题切换时更新 DOM 引用

### 共享逻辑提取

- **`src/ui/themes/message-utils.ts`** — 纯函数工具集：
  - `parseFinalAnswer()` — `<final_answer>` 标签解析
  - `resolveToolDisplayName()` — spec/invoke → skillName 解析
  - `getToolShortName()` — 取 `:` 后的短名
  - `truncateText()` / `valueToString()` — 截断与格式化
- BubbleTheme 和 TerminalTheme 共用，消除重复逻辑

### JS Braille Dots Spinner

- 替换无效的 CSS `@keyframes term-spin`（`content` 属性不可动画）
- JS 端通过 `Date.now() / 80 % 10` 计算当前 braille 字符
- `TerminalTheme.BRAILLE_DOTS` 静态常量 + `getSpinnerChar()` 方法
- BubbleTheme 同步使用 `getSpinnerChar()` / `getSpinnerPrefix()`

### 智能滚动（SmartScroller）

- **`src/ui/themes/smart-scroller.ts`** — ~100 行，两个主题共用：
  - 流式输出时自动跟随到底部
  - 用户上滚查看历史时暂停自动滚动
  - 显示"↓ 新消息"按钮，点击恢复跟随
  - `attach()` / `detach()` 生命周期管理
- **`src/ui/themes/smart-scroll.css`** — 按钮样式

### MarkdownRenderer 升级

- **`src/ui/themes/answer-renderer.ts`** — 使用 Obsidian 原生 `MarkdownRenderer.render()`：
  - 支持 Obsidian 扩展语法（表格、callout、任务列表等）
  - 异步渲染，带 `Component` 生命周期管理
  - 失败时自动回退到 `MessageRenderer`（正则渲染器）
  - 仅用于 finalAnswer 区域，工具参数/结果仍用 MessageRenderer
- 两个主题在 `mount()` 时创建 `Component` + `AnswerRenderer`，`unmount()` 时 `unload()`

### 终端预设主题

- 4 种色板通过 `data-terminal-preset` CSS 属性切换：
  - **Green**（默认）— `#58b258` accent
  - **Amber** — `#ffb000` accent
  - **GitHub Dark** — `#58a6ff` accent, `#f85149` error
  - **Dracula** — `#bd93f9` accent, `#ff5555` error
- `src/settings/settings.ts` 新增 `terminalPreset?` 字段
- `src/settings/settings-tab.ts` 新增"终端色板"下拉框
- TerminalTheme 构造函数接收 preset 参数，`mount()` 时设置属性

### TerminalTheme 设为默认

- `DEFAULT_SETTINGS.chatTheme = 'terminal'`
- 新用户首次使用将看到终端式界面

## 验证状态

- TypeScript 类型检查：0 errors
- ESLint：0 errors, 0 warnings
- 构建：成功
- 部署：已部署到两个开发 vault

## 关键文件索引

| 文件 | 说明 |
|------|------|
| `src/ui/themes/types.ts` | ChatTheme 接口 + 渲染数据类型 |
| `src/ui/themes/registry.ts` | ThemeRegistry — 工厂模式 |
| `src/ui/themes/bubble/index.ts` | BubbleTheme |
| `src/ui/themes/bubble/style.css` | 气泡主题 CSS |
| `src/ui/themes/terminal/index.ts` | TerminalTheme |
| `src/ui/themes/terminal/style.css` | 终端主题 CSS + 预设色板 |
| `src/ui/themes/message-utils.ts` | 共享消息解析工具函数 |
| `src/ui/themes/smart-scroller.ts` | 智能滚动控制器 |
| `src/ui/themes/smart-scroll.css` | 智能滚动按钮样式 |
| `src/ui/themes/answer-renderer.ts` | Obsidian MarkdownRenderer 封装 |
| `src/ui/chat-view/index.ts` | ChatView 控制器 (~720 行) |
| `src/ui/chat-view/input-handler.ts` | 输入处理 (~400 行) |
| `src/ui/index.css` | 引入双主题 CSS + 智能滚动 |
| `src/settings/settings.ts` | chatTheme + terminalPreset 设置 |
| `src/settings/settings-tab.ts` | 主题 + 色板下拉选择器 |
| `src/main.ts` | 主题切换触发 |
