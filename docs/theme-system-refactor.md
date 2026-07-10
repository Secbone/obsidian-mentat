# 主题系统重构任务文档

> 目标：将 obsidian-mentat 的 UI 重构为可插拔主题系统，包含 BubbleTheme（经典气泡）和 TerminalTheme（终端时间线），通过设置切换。

## 阶段 1-2（已完成）

### 主题系统架构

- `src/ui/themes/types.ts` — ChatTheme 接口 + 渲染数据类型
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

## 阶段 3-4（已完成）

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

### JS Braille Dot Spinner

- 替换无效的 CSS `@keyframes term-spin`（`content` 属性不可动画）
- JS 端通过 `Date.now() / 80 % 10` 计算当前 braille 字符
- `TerminalTheme.BRAILLE_DOTS` 静态常量 + `getSpinnerChar()` 方法
- BubbleTheme 同步使用 `getSpinnerChar()` / `getSpinnerPrefix()`

### 智能滚动（SmartScroller）

- **`src/ui/themes/smart-scroller.ts`** — ~90 行，两个主题共用：
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

## 阶段 5：图标方案迁移（已完成）

### 问题

Obsidian 的 `setIcon()` 使用 `--icon-size` CSS 变量控制 SVG 大小，但该机制仅在 Obsidian 原生 `data-theme="dark"/"light"` 下生效。自定义 `data-theme`（如 `"bubble"`、`"terminal"`）下，Obsidian 的全局 `svg { width: var(--icon-size) }` 规则不匹配，导致 SVG 使用内联默认尺寸（4×18 等异常尺寸）。

### 方案

移除所有 `--icon-size` 和 `--theme-icon-*` CSS 变量，改用显式像素值：

```css
/* 容器定义尺寸 */
[data-theme="terminal"] .term-icon-button {
  width: 28px;
  height: 28px;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}

/* SVG 用固定像素值 */
[data-theme="terminal"] .term-icon-button svg {
  width: 18px;
  height: 18px;
}
```

### 尺寸规范

| 用途 | 容器 | SVG | 主题 |
|------|------|-----|------|
| header/button | 28×28 | 18×18 | terminal |
| header icon | 20×20 | 18×18 | terminal |
| send button | 28×28 | 18×18 | terminal |
| header/button | 28×28 | 16×16 | bubble |
| send button | 28×28 | 16×16 | bubble |
| header icon | 20×20 | 16×16 | bubble |
| document icon | 16×16 | 14×14 | bubble |
| remove button | 20×20 | 14×14 | bubble |
| avatar | 24×24 | 14×14 | bubble |
| copy button | 24×24 | 14×14 | bubble |
| suggest icon | 16×16 | 14×14 | bubble |
| warning callout | — | 16×16 | bubble |
| steer icon | 20×20 | 16×16 | bubble |

### 禁止事项

- `svg { width: 100%; height: 100% }` — 图标会撑满容器，过大
- `--icon-size` CSS 变量 — 在非原生主题下不可靠
- `!important` — 不需要

## 阶段 6：终端主题 UX 改进（已完成）

### 用户消息标记

- **之前**：`❯ 用户输入的文字`（终端提示符风格）
- **之后**：左侧绿色竖条 + 文字（类似 opencode 风格）
- 实现：`border-left: 2px solid var(--term-prompt-color)` + `margin-left: 12px`
- 输入框保留 `❯` 提示符（终端标志性元素）

### 工具调用弱化

终端主题的工具调用视觉层次降低，减少对阅读流的干扰：

| 元素 | 之前 | 之后 |
|------|------|------|
| timeline 字号 | 13px | 12px |
| timeline 颜色 | `--term-text-muted` | `--term-text-faint` |
| 工具名字重 | `font-weight: 600` | `font-weight: 400` |
| 工具名颜色 | `--term-text` | `--term-text-muted` |
| 成功图标颜色 | `--term-accent` (绿色) | `--term-text-faint` (淡灰) |
| 状态行颜色 | `--term-accent` | `--term-text-muted` |
| 图标字号 | 13px | 11px |
| 详情代码字号 | 12px | 11px |
| 间距/padding | 较大 | 收紧 |

### 终端预设即时切换

- **之前**：切换终端预设颜色需要重启 Obsidian
- **之后**：设置中切换立即生效
- 实现：
  - `ChatTheme.updatePreset?()` 可选方法
  - `TerminalTheme.updatePreset()` 只更新 `data-terminal-preset` CSS 属性，不重放 DOM
  - `ChatView.updateTerminalPreset()` 委托给当前主题
  - `main.ts:saveSettings()` 在主题未变时调用 `updateTerminalPreset()`

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
| `src/ui/themes/bubble/index.ts` | BubbleTheme (~852 行) |
| `src/ui/themes/bubble/style.css` | 气泡主题 CSS (~858 行) |
| `src/ui/themes/terminal/index.ts` | TerminalTheme (~593 行) |
| `src/ui/themes/terminal/style.css` | 终端主题 CSS + 预设色板 (~631 行) |
| `src/ui/themes/message-utils.ts` | 共享消息解析工具函数 |
| `src/ui/themes/smart-scroller.ts` | 智能滚动控制器 |
| `src/ui/themes/smart-scroll.css` | 智能滚动按钮样式 |
| `src/ui/themes/answer-renderer.ts` | Obsidian MarkdownRenderer 封装 |
| `src/ui/chat-view/index.ts` | ChatView 控制器 (~676 行) |
| `src/ui/chat-view/input-handler.ts` | 输入处理 (~401 行) |
| `src/ui/index.css` | 引入双主题 CSS + 智能滚动 |
| `src/ui/message-renderer/style.css` | 消息气泡样式（bubble 作用域） |
| `src/settings/settings.ts` | chatTheme + terminalPreset 设置 |
| `src/settings/settings-tab.ts` | 主题 + 色板下拉选择器 |
| `src/main.ts` | 主题切换触发 + 预设即时更新 |
| `src/ui/README.md` | UI 系统总览文档 |
| `src/ui/themes/README.md` | 主题开发指南文档 |

## 已知问题

| # | 严重度 | 问题 | 位置 |
|---|--------|------|------|
| 1 | 中 | 默认主题 fallback 用 `'bubble'` 但 DEFAULT_SETTINGS 是 `'terminal'` | chat-view/index.ts, main.ts |
| 2 | 中 | 终端预设下拉框在 bubble 主题时也显示，应条件性展示 | settings-tab.ts |
| 3 | 低 | `saveSettings()` 每次都检查主题变更，不仅限于主题相关设置 | main.ts |
| 4 | 低 | `switchTheme()` 用 `void` 异步调用后立即调 `updateTerminalPreset()` | main.ts |
| 5 | 低 | BRAILLE_DOTS 在两个主题中重复，应提取到 message-utils | bubble/index.ts, terminal/index.ts |
| 6 | 低 | `ThemeRegistry.list()` 为读元数据实例化所有工厂 | registry.ts |
| 7 | 低 | `createInputArea()` 命名误导（返回缓存而非创建新实例） | types.ts |
| 8 | 低 | `container.children[1]` 假设 Obsidian ItemView DOM 结构 | 两个主题 mount() |
| 9 | 低 | `AssistantMessageData` 中多个字段未被主题使用 | types.ts |
| 10 | 低 | 两个主题约 60-70% 代码重复，缺少 BaseTheme 抽象类 | bubble/, terminal/ |
| 11 | 低 | 流式节流策略不一致（bubble 用内容去重，terminal 用时间节流） | 两个主题 |
| 12 | 低 | 终端主题缺少消息复制按钮 | terminal/index.ts |
| 13 | 低 | 硬编码中文字符串，无 i18n 机制 | 两个主题 |
