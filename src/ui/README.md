# UI 系统总览

obsidian-mentat 的 UI 采用可插拔主题架构，ChatView 作为纯控制器，将所有渲染逻辑委托给主题实现。

## 目录结构

```
src/ui/
├── index.css                          # CSS 入口，按顺序 import 所有样式
├── chat-view/
│   ├── index.ts                       # ChatView 控制器 (~676 行)
│   └── input-handler.ts               # 输入处理 (~401 行)
├── code-block/
│   └── style.css                      # 代码块包装、语言标签、复制按钮
├── confirmation-modal/
│   └── index.ts                       # 写操作确认弹窗
├── file-selector-modal/
│   └── index.ts                       # 文件模糊搜索弹窗
├── message-renderer/
│   ├── index.ts                       # 正则 Markdown 渲染器（工具区回退用）
│   └── style.css                      # 消息气泡样式（[data-theme="bubble"] 作用域）
├── responsive/
│   └── style.css                      # 全局响应式调整
├── settings/
│   └── style.css                      # 设置弹窗样式
├── skill-call-renderer/
│   ├── index.ts                       # Skill 调用状态渲染器
│   └── style.css                      # Skill 卡片样式
├── themes/
│   ├── types.ts                       # ChatTheme 接口 + 所有渲染数据类型
│   ├── registry.ts                    # ThemeRegistry 工厂注册表
│   ├── answer-renderer.ts             # Obsidian MarkdownRenderer 封装
│   ├── smart-scroller.ts              # 智能滚动控制器
│   ├── smart-scroll.css               # "新消息"按钮样式
│   ├── message-utils.ts               # 共享纯函数工具集
│   ├── bubble/
│   │   ├── index.ts                   # BubbleTheme 实现
│   │   └── style.css                  # 气泡主题 CSS
│   ├── terminal/
│   │   ├── index.ts                   # TerminalTheme 实现
│   │   └── style.css                  # 终端主题 CSS + 预设色板
│   └── README.md                      # 主题开发指南
└── user-input-modal/
    └── index.ts                       # Agent 询问用户输入弹窗
```

## 模块依赖关系

```
ChatView (控制器)
  ├── ThemeRegistry ──→ ChatTheme (bubble | terminal)
  │                       ├── AnswerRenderer ──→ Obsidian MarkdownRenderer
  │                       ├── SmartScroller
  │                       └── message-utils (纯函数)
  ├── InputHandler (输入逻辑)
  ├── ChatOrchestrator (AI 通信)
  └── SkillCallRenderer (旧式 skill 卡片，非主题渲染)
```

ChatView 不直接操作 DOM（除文档列表外），所有 UI 渲染通过 `ChatTheme` 接口委托给当前主题。

## CSS 作用域约定

所有主题 CSS 选择器必须以 `[data-theme="bubble"]` 或 `[data-theme="terminal"]` 前缀，避免跨主题污染：

```css
/* 正确 */
[data-theme="bubble"] .chat-icon-button { ... }
[data-theme="terminal"] .term-icon-button { ... }

/* 禁止 — 裸选择器会同时影响两个主题 */
.chat-icon-button { ... }
```

终端预设通过 `[data-terminal-preset]` 实现色板切换：

```css
[data-terminal-preset="amber"] { --term-accent: #ffb000; ... }
[data-terminal-preset="github-dark"] { --term-accent: #58a6ff; ... }
[data-terminal-preset="dracula"] { --term-accent: #bd93f9; ... }
```

## 图标大小约定

Obsidian 的 `setIcon()` 使用的 `--icon-size` CSS 变量机制在非原生 `data-theme` 下不可靠（Obsidian 的全局 `svg { width: var(--icon-size) }` 规则只对 `data-theme="dark"/"light"` 生效）。

**当前方案**：在图标容器上设置固定 `width/height`，并在容器上添加 `svg { width: Npx; height: Npx }` 规则：

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

/* SVG 用固定像素值，不用百分比也不用 --icon-size */
[data-theme="terminal"] .term-icon-button svg {
  width: 18px;
  height: 18px;
}
```

**尺寸规范**：
| 用途 | 容器尺寸 | SVG 尺寸 |
|------|---------|---------|
| 终端主题按钮 | 28×28 | 18×18 |
| 终端主题 header icon | 20×20 | 18×18 |
| 气泡主题按钮 | 28×28 | 16×16 |
| 气泡主题 send | 28×28 | 16×16 |
| 小图标（avatar/copy/suggest） | 各异 | 14×14 |

**禁止**：
- 使用 `svg { width: 100%; height: 100% }` 会让图标撑满容器，过大
- 使用 `--icon-size` CSS 变量在非原生主题下不可靠
- 使用 `!important`

## 构建与部署

```bash
npm run build          # TypeScript 编译 + esbuild 打包 → dist/
npm run deploy:dev     # 部署到 ~/Documents/obsidian/ 和 ~/Documents/knowledge/
```

开发 vault 使用符号链接指向 `dist/main.js`，构建后自动生效（Obsidian 中 Ctrl+R 刷新即可）。

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
