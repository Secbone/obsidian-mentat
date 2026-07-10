# 主题开发指南

## 架构概览

```
ChatView (控制器)
  │
  ├─ ThemeRegistry ─── 工厂注册表
  │     ├─ register('bubble', () => new BubbleTheme(...))
  │     └─ register('terminal', () => new TerminalTheme(...))
  │
  └─ ChatTheme (接口) ─── 当前主题实例
        ├─ mount() / unmount()        生命周期
        ├─ renderXxx()                渲染方法
        ├─ createStreamingBubble()    流式渲染
        ├─ updateStreamingUI()        流式更新
        └─ finalizeStreaming()        流式完成
```

ChatView 是纯控制器，不直接操作消息 DOM。所有渲染通过 `ChatTheme` 接口委托。

## 核心类型

### ChatTheme 接口

每个主题必须实现 `ChatTheme`（定义在 `types.ts`）：

```typescript
interface ChatTheme {
  readonly id: string;           // 唯一标识，如 'bubble'
  readonly name: string;         // 显示名，如 '经典气泡'
  readonly description: string;  // 简短描述

  // 生命周期
  mount(container: HTMLElement, callbacks: ThemeCallbacks): void;
  unmount(): void;

  // 消息渲染
  renderUserMessage(content: string): HTMLElement;
  renderAssistantMessage(data: AssistantMessageData): HTMLElement;

  // 流式渲染
  createStreamingBubble(): StreamingBubble;
  updateStreamingUI(bubble: StreamingBubble, data: StreamingUpdateData): void;
  finalizeStreaming(bubble: StreamingBubble, data: AssistantMessageData): HTMLElement;

  // 特殊消息
  renderSteerCard(message: string): HTMLElement;
  renderError(message: string): HTMLElement;
  renderInfoBanner(message: string): HTMLElement;
  renderConfirmRequest(data: ConfirmRequestData): HTMLElement;

  // 滚动
  scrollToBottom(): void;

  // 输入区域
  createInputArea(): InputAreaElements;
  updateInputState(state: InputState): void;
  getMessagesContainer(): HTMLElement;
  getInputArea(): HTMLDivElement;
  getSendButton(): HTMLButtonElement;

  // 可选：运行时配置更新（如终端预设颜色）
  updatePreset?(preset: string): void;
}
```

### ThemeCallbacks

宿主视图（ChatView）提供给主题的事件回调：

| 回调 | 用途 |
|------|------|
| `onSend(text, contextPaths)` | 发送消息 |
| `onSteer(text)` | 流式中动态引导 |
| `onCancel()` | 取消生成 |
| `onClear()` | 清空聊天 |
| `onConfirmApprove(taskId)` | 批准工具确认 |
| `onConfirmReject(taskId)` | 拒绝工具确认 |
| `onAddDocument()` | 打开文档选择器 |
| `onRemoveDocument(path)` | 移除上下文文档 |
| `onSettings()` | 打开设置 |
| `onExportDiagnostics()` | 导出诊断日志 |
| `onToggleOutput(typeKey)` | 展开/折叠工具输出（当前未使用） |

### StreamingBubble

流式渲染的 DOM 句手：

```typescript
interface StreamingBubble {
  el: HTMLElement;               // 根元素
  consoleContainer: HTMLElement;  // 工具调用时间线容器
  answerContainer: HTMLElement;   // 最终回答容器
}
```

### AssistantMessageData

完成后的助手轮次数据。**注意**：当前两个主题主要使用 `messages` 数组，其他字段（`toolCalls`、`explanation`、`finalAnswer`、`interrupted`、`subagentTraces`）实际未被读取。

## 生命周期

```
mount(container, callbacks)
  │
  ├─ 获取 contentEl = container.children[1]
  ├─ 设置 data-theme 属性
  ├─ 创建 Component + AnswerRenderer
  ├─ 构建 header / document panel / messages container / input area
  └─ 附加 SmartScroller

  ... 渲染消息、流式更新 ...

unmount()
  ├─ 分离 SmartScroller
  ├─ 卸载 Component
  ├─ 清除定时器
  └─ 置空所有 DOM 引用
```

### mount() 中的关键步骤

1. **获取容器**：`const contentEl = container.children[1] as HTMLElement` — Obsidian ItemView 的 content 区域
2. **设置主题属性**：`contentEl.setAttribute('data-theme', 'bubble')` — 驱动 CSS 作用域
3. **创建 Obsidian Component**：`new Component()` + `.load()` — 为 MarkdownRenderer 提供生命周期
4. **构建 UI 结构**：header → document panel → messages container → input area
5. **附加 SmartScroller**：自动跟随 + 用户上滚暂停 + "新消息"按钮

## 流式渲染架构

```
createStreamingBubble() → StreamingBubble
  ↓ (反复调用)
updateStreamingUI(bubble, data)
  ↓ (最终)
finalizeStreaming(bubble, data) → HTMLElement
```

- `createStreamingBubble()` 创建流式容器（工具时间线 + 回答区）
- `updateStreamingUI()` 增量更新（节流：bubble 用内容去重，terminal 用 100ms 时间节流）
- `finalizeStreaming()` 移除流式容器，调用 `renderAssistantMessage()` 生成最终静态消息

**节流策略差异**：
- **BubbleTheme**：基于内容去重（比较 statusMessage、activeTasks JSON、explanation 的变化），答案渲染 150ms 节流
- **TerminalTheme**：统一 100ms 时间节流（console 和答案共用 `lastRenderTime`）

## 共享工具库

### message-utils.ts

两个主题共用的纯函数：

| 函数 | 用途 |
|------|------|
| `parseFinalAnswer(rawContent)` | 从 `<final_answer>` 标签提取回答 |
| `resolveToolDisplayName(name, args)` | 解析 `spec`/`invoke` → `name:skillName` |
| `getToolShortName(displayName)` | 取 `:` 后的短名 |
| `truncateText(text, threshold=500)` | 截断长文本，返回 `{display, isTruncated, fullText}` |
| `valueToString(value)` | 任意值转字符串（string 直传，其他 JSON.stringify） |

### AnswerRenderer

封装 Obsidian 原生 `MarkdownRenderer.render()`，支持完整 Obsidian 语法（表格、callout、任务列表等）。失败时回退到 `MessageRenderer`（正则渲染器）。

```typescript
const answerRenderer = new AnswerRenderer(app, component);
await answerRenderer.renderFinalAnswer(markdown, container);
```

**注意**：`renderFinalAnswer()` 是异步的，当前调用方用 `void` 丢弃 Promise，异步错误会被静默吞没。

### SmartScroller

自动滚动管理：

- 流式输出时自动跟随到底部
- 用户上滚超过 50px 时暂停自动滚动
- 显示"↓ 新消息"浮动按钮，点击恢复跟随
- `attach(container, onScrollToBottom)` / `detach()` 生命周期

## CSS 约定

### 作用域前缀

所有 CSS 选择器必须以 `[data-theme="xxx"]` 前缀：

```css
[data-theme="bubble"] .chat-header { ... }
[data-theme="terminal"] .term-header { ... }
```

### 终端预设色板

通过 `data-terminal-preset` 属性切换，`green` 是默认（无属性 = green）：

```css
[data-theme="terminal"] { --term-accent: #58b258; ... }           /* green 默认 */
[data-terminal-preset="amber"] { --term-accent: #ffb000; ... }
[data-terminal-preset="github-dark"] { --term-accent: #58a6ff; ... }
[data-terminal-preset="dracula"] { --term-accent: #bd93f9; ... }
```

### 图标大小

不使用 Obsidian 的 `--icon-size` 机制（在非原生 `data-theme` 下不可靠）。改用显式像素值：

```css
.icon-container {
  width: 28px;
  height: 28px;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}

.icon-container svg {
  width: 18px;   /* 固定像素，不用 100% 或 --icon-size */
  height: 18px;
}
```

## 创建新主题

### 步骤

1. **创建主题类**：在 `src/ui/themes/<name>/index.ts` 中实现 `ChatTheme` 接口

```typescript
import { ChatTheme, ThemeCallbacks, ... } from '../types';
import { SmartScroller } from '../smart-scroller';
import { AnswerRenderer } from '../answer-renderer';
import { parseFinalAnswer, ... } from '../message-utils';

export class MyTheme implements ChatTheme {
  readonly id = 'my-theme';
  readonly name = 'My Theme';
  readonly description = '自定义主题';

  // ... 实现所有 ChatTheme 方法
}
```

2. **创建 CSS**：在 `src/ui/themes/<name>/style.css` 中，所有选择器加 `[data-theme="my-theme"]` 前缀

3. **注册主题**：在 `src/ui/chat-view/index.ts` 构造函数中：

```typescript
this.themeRegistry.register('my-theme', () => new MyTheme(this.app, this.messageRenderer));
```

4. **添加设置选项**：在 `src/settings/settings-tab.ts` 的主题下拉框中添加选项

5. **导入 CSS**：在 `src/ui/index.css` 中添加 `@import './themes/<name>/style.css';`

### 推荐方式

由于两个主题约 60-70% 代码重复，建议从现有主题复制后修改，重点关注：

- `mount()` / `unmount()` — DOM 结构和 CSS 类名
- `renderUserMessage()` / `renderAssistantMessage()` — 消息布局
- `createStreamingBubble()` / `updateStreamingUI()` — 流式渲染
- `buildHeader()` / `buildInputArea()` — UI 骨架

### 未来改进：BaseTheme 抽象类

当前缺少 `BaseTheme` 抽象类，导致以下逻辑在两个主题中重复：
- header 构建（设置/清空/导出/停止按钮）
- document panel 构建
- input area 构建
- `renderTruncatedText()` 截断文本
- `updateInputState()` 输入状态切换
- `renderConfirmRequest()` 确认请求
- braille spinner 逻辑

提取 `BaseTheme` 可将新主题的开发量从 ~600 行降至 ~200 行。

## 已知问题与待改进

### 高优先级

| 问题 | 说明 |
|------|------|
| 默认主题 fallback 不一致 | `chat-view/index.ts` 和 `main.ts` 用 `\|\| 'bubble'` 但 DEFAULT_SETTINGS 是 `'terminal'` |
| 终端预设下拉框始终显示 | 应仅在 `chatTheme === 'terminal'` 时显示 |

### 中优先级

| 问题 | 说明 |
|------|------|
| 缺少 BaseTheme 抽象类 | 两个主题 60-70% 代码重复，新主题开发门槛高 |
| 流式节流策略不一致 | bubble 用内容去重，terminal 用时间节流，应统一 |
| 终端主题缺少复制按钮 | bubble 有消息/代码块复制按钮，terminal 没有 |
| `AssistantMessageData` 死字段 | `toolCalls`/`explanation`/`finalAnswer`/`interrupted`/`subagentTraces` 未被主题使用 |
| `saveSettings()` 过度触发 | 每次设置变更都检查主题，应仅在主题/预设变更时触发 |

### 低优先级

| 问题 | 说明 |
|------|------|
| BRAILLE_DOTS 重复 | 应提取到 message-utils.ts |
| `ThemeRegistry.list()` 资源泄漏 | 实例化所有工厂仅读元数据 |
| `createInputArea()` 命名误导 | 返回缓存而非创建新实例 |
| `container.children[1]` 假设 | 依赖 Obsidian ItemView DOM 结构 |
| 硬编码中文 | 无 i18n 机制 |
| `switchTheme()` 异步顺序 | `void` 调用后立即同步调 `updateTerminalPreset()` |
| SmartScroller 无防抖 | scroll 事件未用 requestAnimationFrame |
| `truncateText` 魔术数字 | threshold=500 但 display 截取 400 字符 |
