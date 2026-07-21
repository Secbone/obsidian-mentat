# Agent 系统改进计划

> 基于对 PI Agent 框架的调研，识别 Mentat 现有 Agent 系统的差距，制定增量改进方案。

## 目录

1. [并行工具执行](#1-并行工具执行)
2. [自动上下文压缩](#2-自动上下文压缩)
3. [树结构会话与分支](#3-树结构会话与分支)
4. [扩展系统](#4-扩展系统)
5. [改进事件粒度](#5-改进事件粒度)
6. [改进优先级总览](#6-改进优先级总览)

---

## 1. 并行工具执行

### 问题

当前 `BaseAgent.executeSingleToolCall()` 对每个 `tool_calls` 数组中的工具**串行执行**：

```typescript
// 当前：串行执行
for (const toolCall of toolCalls) {
  const result = await this.executeSingleToolCall(toolCall);
  // ...
}
```

当 LLM 在一次响应中发起多个工具调用时（如同时读多个文件），串行执行浪费了 I/O 并发优势。

### 目标

支持并行工具执行，同时保留串行模式的配置能力。

### 方案

#### 1.1 扩展 AgentConfig

在 `src/agents/agent-types.ts` 中添加：

```typescript
interface AgentConfig {
  // ... 现有字段
  toolExecutionMode?: 'sequential' | 'parallel';  // 默认 'sequential'
}
```

#### 1.2 修改 BaseAgent 执行循环

```typescript
// pseudocode for the change in base-agent.ts
private async executeToolCalls(toolCalls: ToolCall[]): Promise<void> {
  const mode = this.config.toolExecutionMode || 'sequential';

  if (mode === 'parallel') {
    await Promise.all(toolCalls.map(tc => this.executeSingleToolCall(tc)));
  } else {
    for (const tc of toolCalls) {
      await this.executeSingleToolCall(tc);
    }
  }
}
```

#### 1.3 并发控制

- 添加 `maxParallelTools?: number` 限制最大并发数（默认 5）
- 使用信号量或分批 `Promise.all` 实现控制

```typescript
async function parallelWithLimit<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results: T[] = [];
  const executing = new Set<Promise<void>>();

  for (const task of tasks) {
    const p = task().then(result => { results.push(result); });
    executing.add(p.then(() => executing.delete(p)));

    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }

  await Promise.all(executing);
  return results;
}
```

#### 1.4 工具调用顺序

并行执行后的 tool result 消息必须**按原始顺序**插入消息列表，确保 LLM 的理解正确：

```typescript
const results = new Map<string, ToolResult>();
await Promise.all(toolCalls.map(tc =>
  this.executeSingleToolCall(tc).then(result => {
    results.set(tc.id, result);
  })
));
// 按原始顺序插入
for (const tc of toolCalls) {
  const result = results.get(tc.id);
  this.state.messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
}
```

#### 1.5 异常处理

- 单个工具失败不应取消其他并行工具的执行
- 失败工具的结果应包含错误信息，让 LLM 自行处理
- 可选的 `failFast?: boolean` 配置

#### 1.6 配置暴露

- 在 `src/settings/settings.ts` 中添加 `toolExecutionMode?: 'sequential' | 'parallel'`
- 在 `src/settings/settings-tab.ts` 中添加下拉选择器
- 在 `AgentConfig` 中传递设置值

### 工作量估算

| 模块 | 文件 | 估算 |
|------|------|------|
| 类型定义 | agent-types.ts | 0.5h |
| 执行逻辑 | base-agent.ts | 3h |
| 并发控制 | utils/ 或 inline | 1h |
| 设置 | settings.ts + settings-tab.ts | 1h |
| 测试 | base-agent.test.ts | 2h |
| **合计** | | **7.5h** |

---

## 2. 自动上下文压缩

### 问题

当前仅 `ChatManager.getContextForLLM({ maxMessages: 50 })` 做硬截断：

```typescript
// chat-manager.ts (现有)
if (maxMessages && messages.length > maxMessages) {
  messages = messages.slice(-maxMessages);
}
```

问题：
- 早期上下文（vault 结构、用户偏好、研究计划）被完全丢弃，不保留任何语义
- 长会话中 LLM 丢失关键背景信息
- 没有 token 级别的度量，50 条消息的 token 消耗因消息长度而异巨大

### 目标

- 达到 token 预算时自动触发压缩
- 保留完整 JSONL 历史（压缩仅影响发送给 LLM 的上下文）
- 支持手动触发压缩
- 压缩过程对用户透明（后台进行）

### 方案

#### 2.1 Token 预算检测

在 `Context` 类或 `BaseAgent` 中添加 token 估算：

```typescript
// src/context/ 或 base-agent.ts
interface ContextBudget {
  maxTokens: number;           // 上下文 token 上限
  currentTokens: number;       // 当前消息总 token
  compactionThreshold: number; // 触发压缩的阈值（如 0.8 * maxTokens）
}
```

- 使用简单的字符→token 估算（4 chars ≈ 1 token），或 provider 返回的实际 usage
- 每次 LLM 调用前检查，如果超过阈值则触发压缩
- 在 `AgentContext` 中传递或从 `AgentConfig` 读取

#### 2.2 压缩策略

```
压缩前：
  [消息 1] [消息 2] ... [消息 N-k] [消息 N-k+1] ... [消息 N]
  └───── 保留 k 条最新消息 ────┘
                    │
                    压缩
                    ▼
  [摘要] [消息 N-k+1] ... [消息 N]
```

**策略参数**：
- `keepRecentMessages: number` — 保留的最新消息数（默认 10，包含 system prompt 和最近 1-2 轮对话）
- `summaryPrompt: string` — 自定义摘要提示词（可配置）

#### 2.3 摘要生成

```typescript
// src/agents/compactor.ts
export class Compactor {
  constructor(private provider: AIProvider) {}

  async compact(messages: AgentMessage[], options?: CompactOptions): Promise<string> {
    const messagesToCompact = messages.slice(0, -options?.keepRecent ?? 10);
    const prompt = options?.summaryPrompt
      || 'Summarize the above conversation. Preserve all decisions, requirements, '
       + 'user preferences, and key information needed to continue the task. '
       + 'Be concise but thorough. The summary will be used as context for future turns.';

    // 调用 LLM 生成摘要
    const summary = await this.provider.generateSingleMessage([
      ...messagesToCompact,
      { role: 'user', content: prompt }
    ]);

    return summary;
  }
}
```

#### 2.4 压缩后的消息结构

```typescript
// 压缩后的表示
const compactedMessages: AgentMessage[] = [
  {
    role: 'system',
    content: '--- 上下文摘要（自动压缩）---\n' + summary
         + '\n--- 以下是最新对话 ---'
  },
  ...recentMessages  // 保留的最新 k 条消息
];
```

压缩结果作为一条 `system` 角色消息插入，不修改原始历史。

#### 2.5 触发时机

- **自动触发**：每次 LLM 调用前检测 token 预算
- **手动触发**：通过命令或按钮（如 `/compact`）
- **事件通知**：触发时 yield `compaction_start` / `compaction_end` 事件

```typescript
// base-agent.ts
private async maybeCompact(): Promise<void> {
  const tokens = estimateTokens(this.state.messages);
  const threshold = this.config.maxContextTokens * 0.8;

  if (tokens > threshold) {
    // yield compaction_start event
    const summary = await this.compactor.compact(this.state.messages);
    this.state.messages = [
      { role: 'system', content: '--- Context Summary ---\n' + summary + '\n--- Recent Messages ---' },
      ...this.state.messages.slice(-10)
    ];
    // yield compaction_end event
  }
}
```

#### 2.6 Provider Token 使用

如果 provider 返回实际 token usage，优先使用精确值：

```typescript
// provider 返回值扩展
interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
  // ...
}
```

#### 2.7 配置

```typescript
// settings.ts
interface MentatSettings {
  // ...
  compaction?: {
    enabled: boolean;           // 默认 true
    threshold: number;          // 触发阈值比例 (0.0-1.0, 默认 0.8)
    keepRecentMessages: number; // 保留最新消息数 (默认 10)
    maxContextTokens: number;   // 上下文 token 上限 (默认 32000)
    summaryPrompt?: string;     // 自定义摘要提示词
  };
}
```

### 工作量估算

| 模块 | 文件 | 估算 |
|------|------|------|
| Compactor 类 | src/agents/compactor.ts | 4h |
| Token 估算 | src/context/ 或 utils | 2h |
| 触发逻辑 | base-agent.ts | 3h |
| 事件类型 | agent-types.ts | 0.5h |
| 配置 | settings.ts + settings-tab.ts | 1h |
| 测试 | 新建 | 3h |
| **合计** | | **13.5h** |

---

## 3. 树结构会话与分支

### 问题

当前会话是**线性 JSON**存储，每次新消息追加到末尾。问题：
- 无法回退到历史某个点重新探索
- 不能并行试验不同方案
- LLM 走错方向后只能清空重来
- 没有"分支—比较—选择"的工作流

### 目标

- 支持分支：从任意历史点创建新分支
- 所有分支保存在单个 JSONL 文件中
- 支持树视图导航和分支切换
- 保留线性模式的向后兼容

### 方案

#### 3.1 存储格式

当前格式（线性）：
```json
[
  { "role": "user", "content": "..." },
  { "role": "assistant", "content": "..." },
  ...
]
```

目标格式（树）：
```jsonl
{"id": "msg1", "parentId": null, "role": "user", "content": "..."}
{"id": "msg2", "parentId": "msg1", "role": "assistant", "content": "..."}
{"id": "msg3", "parentId": "msg2", "role": "user", "content": "tell me more"}
{"id": "msg4", "parentId": "msg2", "role": "user", "content": "try different approach"}  // 分支！
```

每条消息有：
- `id` — 唯一标识（UUID 或递增 ID）
- `parentId` — 父消息 ID（根消息为 null）
- `role` / `content` / `tool_calls` 等现有字段
- 可选：`label` — 用户标记（如 "checkpoint"、"good result"）

#### 3.2 SessionManager 重构

```typescript
// src/chat/session-manager.ts

export class SessionManager {
  private entries: SessionEntry[] = [];
  private leafId: string | null = null;

  // 读取
  getActivePath(): SessionEntry[] {
    // 从 leafId 回溯到 root，返回当前活跃路径
  }

  // 写入
  append(entry: SessionEntry): void {
    entry.parentId = this.leafId;
    this.entries.push(entry);
    this.leafId = entry.id;
  }

  // 分支
  branch(entryId: string): void {
    // 将 leafId 设置为 entryId，新消息从该点开始
    this.leafId = entryId;
  }

  // 树操作
  getTree(): TreeNode { /* 构建树结构 */ }
  getBranches(): string[] { /* 返回所有叶子节点 */ }
  getChildren(parentId: string): SessionEntry[] { /* 获取子节点 */ }
  comparePaths(idA: string, idB: string): PathDiff { /* 比较两条路径 */ }
}

interface SessionEntry {
  id: string;
  parentId: string | null;
  role: string;
  content: string;
  tool_calls?: ToolCall[];
  metadata?: Record<string, unknown>;
  label?: string;
  timestamp: number;
}
```

#### 3.3 序列化

- 每个分支独立序列化为 JSONL 文件（单文件多分支）
- 文件后缀 `.session.jsonl`
- 加载时重建树结构
- 兼容旧格式：识别无 `id`/`parentId` 字段的旧文件，自动转换

```typescript
// 序列化示例
export function serializeSession(entries: SessionEntry[]): string {
  return entries.map(e => JSON.stringify(e)).join('\n');
}

export function deserializeSession(content: string): SessionEntry[] {
  return content.split('\n').filter(Boolean).map(line => {
    const entry = JSON.parse(line);
    // 兼容旧格式
    if (!entry.id) entry.id = generateId();
    return entry;
  });
}
```

#### 3.4 UI 导航

树视图需要终端或气泡主题的支持：

**终端命令**：
- `/branch` — 查看分支列表，选择切换到哪一条
- `/branch <entryId>` — 从指定消息创建新分支
- `/label <entryId> <label>` — 标记消息
- `/tree` — 树视图导航

**UI 组件**（气泡主题）：
- 消息菜单中添加 "从此处分支" 选项
- 分支指示器显示当前活跃路径
- 分支切换下拉框

#### 3.5 迁移路径

1. 第一阶段：SessionManager 支持树结构，旧会话自动转换为单分支树
2. 第二阶段：添加分支命令（`/branch`、`/tree`）
3. 第三阶段：UI 分支导航组件
4. 第四阶段：分支比较 / 合并功能

### 工作量估算

| 模块 | 文件 | 估算 |
|------|------|------|
| 类型定义 | src/chat/session-manager.ts 或 types | 2h |
| SessionManager 重构 | src/chat/session-manager.ts | 8h |
| 序列化兼容 | 同上 | 2h |
| 分支命令 | chat-orchestrator.ts | 4h |
| UI 导航（终端主题） | terminal/index.ts | 6h |
| UI 导航（气泡主题） | bubble/index.ts | 6h |
| 测试 | 新建 | 4h |
| **合计** | | **32h** |

---

## 4. 扩展系统

### 问题

当前 Mentat 的功能扩展需要直接修改核心代码：
- 添加新命令 → 修改 `ChatView`
- 添加新 UI 组件 → 修改主题
- 添加新事件处理 → 修改 `BaseAgent`
- 无法热加载 / 动态注册

### 目标

- 插件化：TypeScript 模块可注册工具、命令、事件监听、UI 组件
- 热加载：安装插件后通过 reload 生效，无需重启 Obsidian
- 沙箱化：插件声明所需权限（读文件、写文件、网络等）

### 方案

#### 4.1 Extension API 设计

```typescript
// src/extensions/extension-api.ts

export interface ExtensionAPI {
  // 注册工具
  registerTool(tool: ToolDefinition): void;

  // 注册命令
  registerCommand(name: string, handler: CommandHandler): void;

  // 事件监听
  on<K extends keyof ExtensionEvents>(event: K, handler: EventHandler<ExtensionEvents[K]>): void;

  // UI 组件（可选）
  registerUIComponent(slot: UISlot, component: UIComponentFactory): void;

  // 系统服务
  getVault(): Vault;
  getSettings(): MentatSettings;
  getProvider(): AIRouter;

  // 生命周期
  onLoad(): Promise<void>;
  onUnload(): Promise<void>;
}

export interface ExtensionManifest {
  name: string;
  version: string;
  description: string;
  author?: string;
  permissions: ExtensionPermission[];  // 声明所需权限
  main: string;                        // 入口文件路径
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;  // JSON Schema
  execute: (params: unknown) => Promise<ToolResult>;
}

export type ExtensionPermission =
  | 'vault:read'
  | 'vault:write'
  | 'network'
  | 'command'
  | 'settings:read'
  | 'settings:write';

export type UISlot = 'chat:toolbar' | 'message:menu' | 'header:actions';

export type ExtensionEvents = {
  'agent:before_turn':  { messages: AgentMessage[] };
  'agent:after_turn':   { messages: AgentMessage[]; toolResults: ToolResult[] };
  'agent:before_tool':  { toolCall: ToolCall };
  'agent:after_tool':   { toolCall: ToolCall; result: ToolResult };
  'session:created':    { sessionId: string };
  'session:switched':   { sessionId: string };
  'settings:changed':   { key: string; value: unknown };
};
```

#### 4.2 扩展发现与加载

```
~/.mentat/extensions/
  my-extension/
    manifest.json     # ExtensionManifest
    index.ts          # 入口：export default function(api: ExtensionAPI) { ... }
    package.json      # 可选依赖
```

```
.vault/.mentat/extensions/   # 项目本地扩展
~/.config/mentat/extensions/ # 全局扩展
```

```typescript
// src/extensions/extension-manager.ts
export class ExtensionManager {
  private extensions: LoadedExtension[] = [];

  async loadFromDir(dir: string): Promise<void> {
    // 扫描 manifest.json
    // 动态导入入口模块
    // 验证权限声明
    // 调用 extension(api)
  }

  async reload(): Promise<void> {
    await this.unloadAll();
    await this.loadAll();
  }

  registerBuiltin(): void {
    // 内置功能也可以作为扩展注册
    // 如 /clear, /settings, /help 命令
  }
}
```

#### 4.3 权限系统

```typescript
// src/extensions/permission-system.ts
export class PermissionSystem {
  private granted = new Map<string, Set<ExtensionPermission>>();

  async requestPermission(extName: string, permission: ExtensionPermission): Promise<boolean> {
    // 如果是内置扩展或已授权 → 自动通过
    // 否则 → 弹出确认弹窗（类似 HITL）
    // 记住选择
  }

  revokePermission(extName: string): void {
    this.granted.delete(extName);
  }
}
```

#### 4.4 事件总线

```typescript
// src/extensions/event-bus.ts
export class EventBus {
  private handlers = new Map<string, Set<Function>>();

  on<K extends keyof ExtensionEvents>(event: K, handler: (data: ExtensionEvents[K]) => void): void {
    // 注册
  }

  emit<K extends keyof ExtensionEvents>(event: K, data: ExtensionEvents[K]): void {
    // 同步广播给所有订阅者
  }
}
```

- 事件总线注入到 `ExtensionAPI`，每个扩展只看到自己的订阅
- `BaseAgent` 在关键节点 emit 事件（`before_turn`, `after_turn`, `before_tool` 等）
- 扩展不能阻塞 agent 执行（事件处理器是 fire-and-forget）

#### 4.5 发现策略

| 来源 | 路径 | 说明 |
|------|------|------|
| 内置 | `src/extensions/builtin/` | 随插件发布的官方扩展 |
| 全局 | `~/.config/mentat/extensions/` | 用户安装的全局扩展 |
| 项目 | `.obsidian/mentat/extensions/` | 特定 vault 的扩展 |
| 测试 | `DEVELOPMENT_EXTENSIONS` env | 开发时临时加载 |

#### 4.6 已知限制

- TypeScript 扩展需要 Obsidian 的 Electron 环境支持动态 `import()`，由于 Obsidian 插件沙箱可能受限，v1 建议扩展仅支持注册命令和事件监听，不直接操作 DOM
- UI 组件 slot 机制较复杂，v1 可能仅支持 `chat:toolbar` 这类简单 slot
- 权限系统 v1 可简化为白名单（读取 manifest 声明的权限，不给运行时弹窗）

### 工作量估算

| 模块 | 文件 | 估算 |
|------|------|------|
| ExtensionAPI 接口定义 | src/extensions/extension-api.ts | 3h |
| ExtensionManager | src/extensions/extension-manager.ts | 6h |
| 事件总线 | src/extensions/event-bus.ts | 2h |
| 权限系统 | src/extensions/permission-system.ts | 4h |
| 加载器（动态 import） | extensions/loader.ts | 4h |
| 内置扩展迁移 | 多个文件 | 4h |
| 设置 UI | settings-tab.ts | 2h |
| 测试 | 新建 | 4h |
| **合计** | | **29h** |

---

## 5. 改进事件粒度

### 问题

当前 `AgentEvent` 只有 8 种事件类型，UI 消费方缺少关键节点的精确反馈：

```typescript
// 当前 AgentEvent 类型
export type AgentEvent =
  | { type: 'status'; message: string }
  | { type: 'chunk'; text: string }
  | { type: 'skill_call'; ... }
  | { type: 'skill_success'; ... }
  | { type: 'skill_error'; ... }
  | { type: 'confirm_request'; ... }
  | { type: 'steer'; ... }
  | { type: 'error'; ... };
```

缺少：
- 工具生命周期事件（开始/更新/结束）— 当前用 skill_call/skill_success/skill_error 混用
- 轮次事件（turn_start/turn_end）— 当前无法区分"一句话的不同 chunk"和"多轮对话"
- 压缩事件（compaction_start/compaction_end）— 压缩时 UI 无法知道发生了压缩
- 工具中途的流式结果（tool_execution_update）— 不能显示工具执行过程中的部分输出

### 目标

- 15+ 事件类型，覆盖 agent、turn、message、tool 全生命周期
- 向后兼容现有的 `onStream` 回调
- 为 UI 提供精确的状态机（如 "当前在第 3 轮的第二个工具执行中"）

### 方案

#### 5.1 新事件类型

```typescript
// src/agents/agent-types.ts

export type AgentEvent =
  // Agent 生命周期
  | { type: 'agent_start' }
  | { type: 'agent_end'; messages: AgentMessage[] }

  // Turn 生命周期（一次 LLM 调用 + 可能的工具执行）
  | { type: 'turn_start'; turnIndex: number }
  | { type: 'turn_end'; turnIndex: number; message: AgentMessage; toolResults: ToolResult[] }

  // 消息生命周期
  | { type: 'message_start'; message: AgentMessage }
  | { type: 'message_update'; message: Partial<AgentMessage>; delta?: string }
  | { type: 'message_end'; message: AgentMessage }

  // 工具调用生命周期
  | { type: 'tool_execution_start'; toolCallId: string; toolName: string; args: unknown }
  | { type: 'tool_execution_update'; toolCallId: string; partialResult: unknown }
  | { type: 'tool_execution_end'; toolCallId: string; result: ToolResult; isError: boolean }

  // 压缩事件
  | { type: 'compaction_start' }
  | { type: 'compaction_end'; summaryLength: number }

  // 确认请求
  | { type: 'confirm_request'; taskId: string; skillName: string; description: string; parameters: unknown }

  // 用户引导
  | { type: 'steer'; message: string }

  // 错误
  | { type: 'error'; message: string }

  // 状态
  | { type: 'status'; message: string };
```

#### 5.2 向后兼容

保留现有 `onStream` 回调签名，内部将新事件映射为旧事件：

```typescript
// 过渡层
function toLegacyEvent(event: AgentEvent): LegacyStreamEvent | null {
  switch (event.type) {
    case 'agent_start':
      return null; // 旧版 UI 不需要这个事件
    case 'chunk':
      return { type: 'chunk', text: event.delta || '' };
    case 'tool_execution_start':
      return { type: 'skill_call', name: event.toolName, args: event.args };
    case 'tool_execution_end':
      return { type: event.isError ? 'skill_error' : 'skill_success', ... };
    case 'error':
      return { type: 'error', message: event.message };
    default:
      return null;
  }
}
```

#### 5.3 UI 消费方更新

`ChatView` 的流式处理逻辑改为基于事件类型的分发：

```typescript
// chat-view/index.ts
for await (const event of this.theme.themeGenerator()) {
  switch (event.type) {
    case 'turn_start':
      if (this.currentStreamingBubble) {
        this.theme.finalizeStreaming(this.currentStreamingBubble, ...);
      }
      this.currentStreamingBubble = this.theme.createStreamingBubble();
      break;

    case 'message_update':
      if (event.delta) {
        this.theme.updateStreamingUI(this.currentStreamingBubble, { ... });
      }
      break;

    case 'tool_execution_start':
      this.theme.updateStreamingUI(this.currentStreamingBubble, {
        activeTasks: [...]
      });
      break;

    case 'compaction_start':
      this.theme.renderInfoBanner('正在压缩上下文...');
      break;
  }
}
```

#### 5.4 AsyncGenerator 适配

保持 `BaseAgent.execute()` 返回 `AsyncGenerator<AgentEvent, AgentResponse>` 不变，仅扩展事件类型：

```typescript
// base-agent.ts
async *execute(context: AgentContext): AsyncGenerator<AgentEvent, AgentResponse> {
  yield { type: 'agent_start' };

  while (turnCount < maxTurns) {
    yield { type: 'turn_start', turnIndex: turnCount };

    const stream = this.provider.generateStreamWithSkills(messages, tools);
    yield { type: 'message_start', message: { role: 'assistant' } };

    for await (const chunk of stream) {
      yield { type: 'message_update', delta: chunk.text };
    }

    yield { type: 'message_end', message: assistantMessage };

    for (const toolCall of toolCalls) {
      yield { type: 'tool_execution_start', toolCallId: toolCall.id, toolName: toolCall.name, args: toolCall.args };
      const result = await this.executeToolCall(toolCall);
      yield { type: 'tool_execution_end', toolCallId: toolCall.id, result };
    }

    yield { type: 'turn_end', turnIndex: turnCount, message: assistantMessage, toolResults };
  }

  yield { type: 'agent_end', messages: this.state.messages };
}
```

### 工作量估算

| 模块 | 文件 | 估算 |
|------|------|------|
| 类型定义 | agent-types.ts | 1h |
| 事件映射层 | 同上 | 1h |
| BaseAgent 事件 emit | base-agent.ts | 3h |
| 气泡主题适配 | bubble/index.ts | 2h |
| 终端主题适配 | terminal/index.ts | 2h |
| 测试 | base-agent.test.ts | 2h |
| **合计** | | **11h** |

---

## 6. 改进优先级总览

### 按影响/成本排序

| 优先级 | 改进项 | 影响 | 成本 | 累计价值 |
|--------|--------|------|------|---------|
| P0 | 并行工具执行 | 中高 | 1天 | 感知性能提升、多工具 scene 加速 |
| P0 | 改进事件粒度 | 高 | 1.5天 | 为后续所有改进提供基础事件基础设施 |
| P1 | 自动上下文压缩 | 高 | 2天 | 长会话体验关键改进，防止上下文丢失 |
| P2 | 扩展系统 | 高 | 4天 | 长期生态健康度，但短期收益不明显 |
| P3 | 树结构会话与分支 | 中 | 4天 | 功能吸引力强，但工作量大且需 UI 配合 |

### 阶段规划

**Phase 1：改进事件粒度 + 并行工具执行**
- 新事件类型为后续所有改进提供基础设施
- 并行执行是改动最小、收益最直接的性能改进
- 预计 2 周

**Phase 2：自动上下文压缩**
- 依赖 Phase 1 的 `compaction_start/end` 事件
- 需要 Provider API 的 token usage 支持
- 预计 2 周

**Phase 3：扩展系统**
- 依赖 Phase 1 的事件总线
- 先实现内置扩展迁移（skill 命令、/clear、/help 等）
- 预计 3 周

**Phase 4：树结构会话与分支**
- 依赖 Phase 1 的事件和 UI 改进
- 需要大量 UI 工作
- 预计 4 周

---

## 参考

- PI Agent Core: https://github.com/earendil-works/pi/tree/main/packages/agent
- PI 设计哲学: https://mariozechner.at/posts/2025-11-30-pi-coding-agent/
- 当前 Agent 实现: `src/agents/base-agent.ts`
- 当前事件类型: `src/agents/agent-types.ts`
- 当前会话管理: `src/chat/chat-manager.ts`
