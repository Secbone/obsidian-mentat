# RFC: Mentat 多模式 Agent 架构

> 状态：草案（v0.1） · 日期：2026
> 关联：`docs/dsh-harness.md`（DSH/Cordis 架构调研）、`README.md` Roadmap Phase 5–7

## 1. 目标与非目标

### 目标

把 Mentat 从"Obsidian 内的单体助手"演进为**多模式、可插拔的 agent 客户端**：

1. **嵌入式模式（embedded）**——现状保留：agent 在 Obsidian 进程内运行，直接操作 vault。
2. **委托模式（delegated）**——新增：Mentat 退化为 **Obsidian 侧客户端**，对话执行与 MD 操作委托给外部独立 agent 系统（Claude Code / OpenCode / DSH 等 MCP 生态 agent）；Obsidian 的本地 MD 管理机制通过内置 **MCP server** 暴露给外部 agent。
3. **模式可扩展**——模式注册表驱动，第三方可注册自定义模式；切换粒度**每会话**。

### 非目标（本 RFC 范围外）

- 不做 Obsidian 之外的独立部署形态（未来单独评估）。
- 不引入 Cordis 全量框架（理由见 `docs/dsh-harness.md` 对比结论；只借鉴三个核心机制：可逆效应累积器、服务容器、模式/组件注册表）。
- 不承诺某个具体外部 agent 产品的适配完整性——先交付**适配器契约 + 一个参考实现**。

## 2. 架构总览

```
┌──────────────────────── Obsidian 进程 ────────────────────────┐
│                                                              │
│  Mentat 插件                                                  │
│   ┌────────────────────────────────────────────────────┐     │
│   │ ServiceContainer（服务容器：provide/inject）          │     │
│   │  ├─ settings · aiRouter · indexManager · ...        │     │
│   │  └─ eventBus（现有 EventBus）                        │     │
│   └──────────────────────┬─────────────────────────────┘     │
│                          │                                    │
│   ┌──────────────────────▼─────────────────────────────┐     │
│   │ AgentModeRegistry（模式注册表，每会话解析一个模式）      │     │
│   │  ├─ embedded  : AgentBackend = EmbeddedBackend      │     │
│   │  │              （BaseAgent + AIProvider 适配器）     │     │
│   │  └─ delegated:<name> : AgentBackend = ExternalBackend│     │
│   │                  （外部 agent SDK/API 适配器）         │     │
│   └──────────────────────┬─────────────────────────────┘     │
│                          │                                    │
│   ┌──────────────────────▼─────────────────────────────┐     │
│   │ VaultMCPServer（vault 能力暴露，MCP server）          │     │
│   │  └─ 权限层：只读默认放行 · 写/删/执行需授权             │     │
│   └──────────────────────┬─────────────────────────────┘     │
│                          │ MCP (stdio/HTTP)                   │
└──────────────────────────┼────────────────────────────────────┘
                           ▼
              ┌────────────────────────────┐
              │ 外部 agent 进程（MCP client）│
              │ Claude Code / OpenCode /   │
              │ DSH / 任何 MCP 生态 agent   │
              └────────────────────────────┘
```

**两条数据路径（对应两种"客户端"语义）**：

| 路径 | 方向 | 机制 |
|---|---|---|
| 对话执行 | Mentat → 外部 agent | 外部 agent 适配器（SDK/API），流式事件归一化为现有 `AgentEvent` |
| vault 操作 | 外部 agent → Mentat | MCP server（Mentat 暴露 `read/write/search/query/index` 等 tools） |

## 3. 核心抽象

### 3.1 `AgentBackend` —— 对话执行后端

统一"一次会话交互"的契约。embedded 与 delegated 都必须实现它，UI 层只依赖此接口。

```ts
/** 一次对话请求（会话内增量）。 */
interface AgentChatInput {
  sessionId: string;
  messages: ChatMessage[];          // 会话内消息（含历史）
  signal?: AbortSignal;
  config?: Record<string, unknown>; // 模式相关配置（如模型、温度）
}

/** 后端能力描述，供 UI 与配置层探测。 */
interface AgentBackendCapabilities {
  supportsStreaming: boolean;
  supportsCancellation: boolean;
  supportsSkills: boolean;          // 外部 agent 是否自管工具
  maxContextTokens?: number;
}

interface AgentBackend {
  readonly id: string;              // 'embedded' | 'delegated:<name>'
  readonly displayName: string;
  readonly capabilities: AgentBackendCapabilities;

  /** 流式对话；产出复用现有 AgentEvent 类型（agent:start/turn:*/message:*/tool:*/...）。 */
  streamChat(input: AgentChatInput): AsyncGenerator<AgentEvent>;

  /** 会话生命周期钩子（可选）。 */
  onSessionStart?(sessionId: string): void | Promise<void>;
  onSessionEnd?(sessionId: string): void | Promise<void>;

  /** 释放后端持有的资源（外部进程句柄、订阅等）。由 DisposeStack 管理。 */
  dispose(): void | Promise<void>;
}
```

- **EmbeddedBackend**：适配现有 `BaseAgent` + `AIProvider`。现有 `BaseAgent` 的 RAGP 循环即为实现体；`AgentEvent` 复用现有类型，零 UI 改动。
- **ExternalBackend**：适配外部 agent 的 SDK/API。流式事件翻译成 `AgentEvent`（参考实现见 §5）。

### 3.2 `VaultCapability` —— vault 能力面（MCP server 侧）

委托模式下，外部 agent 通过 **MCP tools** 访问 vault，因此 vault 能力面 = MCP server 的 tool 集。

```ts
/** 一个可暴露的 vault 能力（MCP tool 的声明 + 执行）。 */
interface VaultCapability<TInput = unknown, TOutput = unknown> {
  name: string;                     // 如 'vault_read'
  description: string;
  schema: ZodTypeAny;               // 输入校验（复用现有 zod 依赖）
  permissions: Permission[];        // 本能力需要的权限（§4）
  execute(input: TInput, ctx: VaultCapabilityContext): Promise<TOutput>;
}
```

能力清单（v1，覆盖现有 skill 的读写搜面）：
`vault_read` · `vault_write` · `vault_list` · `vault_search` · `vault_query`（语义搜索，走索引）· `vault_metadata` · `vault_move` · `vault_delete` · `vault_create_note` · `vault_batch`（批量操作）。

### 3.3 `AgentModeDescriptor` —— 模式描述符与注册表

```ts
interface AgentModeDescriptor {
  id: string;                       // 'embedded' | 'delegated:<name>' | 第三方自定义
  displayName: string;
  description: string;
  /** 该模式是否需要对 vault 暴露 MCP server（委托模式为 true）。 */
  requiresVaultServer?: boolean;
  createBackend(ctx: ModeContext): AgentBackend;
}

class AgentModeRegistry {
  register(descriptor: AgentModeDescriptor): () => void;  // 可逆注册（DisposeStack）
  unregister(id: string): void;
  get(id: string): AgentModeDescriptor | undefined;
  list(): AgentModeDescriptor[];
  /** 会话绑定：ChatSession 持有 modeId，切换 = 换后端 + 重放历史。 */
}
```

**切换语义（每会话）**：`ChatSession.modeId` 决定当前后端。切换动作：
1. 旧后端 `onSessionEnd` + dispose（走 DisposeStack，回收其全部注册）；
2. 新后端按会话创建（`createBackend`）；
3. 会话历史以 `AgentChatInput.messages` 全量重放（v1 不做状态迁移优化）。

## 4. 权限模型（委托模式安全边界）

委托模式把 vault 暴露给外部进程，必须设权限层（对应 README Phase 6 "permission sandbox" 的地基）：

```ts
type Permission =
  | 'vault:read'                    // 读任意笔记/目录/搜索 —— 默认放行
  | 'vault:write'                   // 写/创建/移动笔记 —— 需授权
  | 'vault:delete'                  // 删除笔记/附件 —— 需授权
  | 'vault:execute'                 // run-command 类外部执行 —— 需授权且默认禁用
  | 'vault:metadata'                // 读 frontmatter/索引元数据 —— 默认放行
  | `vault:path:${string}`;         // 路径级白名单（可选细化）

interface VaultPermissionPolicy {
  /** 默认授予的权限（只读面）。 */
  defaultGrant: Permission[];
  /** 需用户确认的权限（写/删/执行）。 */
  requireConfirmation: Permission[];
  /** 路径白名单；空 = 不限制（配合权限而非代替）。 */
  pathAllowlist?: string[];
  /** 确认回调：Obsidian 侧 Notice/Modal 请求授权，可记忆 per-会话。 */
  requestConfirmation?(req: PermissionRequest): Promise<boolean>;
}
```

规则：
- 权限在 **MCP tool 执行入口**检查（`permissionGuard` 包装所有 tool）。
- 确认结果**按会话缓存**（同会话内写操作第二次起默认放行，可配置）。
- 与现有 `requiresConfirmation` 技能元数据合并（本地技能模型与委托模型共享同一个确认回调）。

## 5. 委托模式参考实现

### 5.1 MCP server（vault 暴露）

- **协议**：复用 `src/skills/mcp/mcp-types.ts` + `mcp-transport.ts` 的 JSON-RPC 协议类型；新增 server 端（transport 监听 + request 分发），对称于现有 `MCPClient`。
- **传输**：v1 支持 **stdio**（外部 agent 以 `mcpServers` 配置连接 Obsidian 侧）与 **HTTP/SSE**（开发期调试）。传输细节在阶段 2 落地时按 Obsidian 进程约束收敛。
- **tool 实现**：`VaultCapability[]` 直接映射为 MCP `tools/list` + `tools/call`。

### 5.2 外部 agent 适配器（对话方向）

- **契约**：`ExternalBackend` 基类 + 传输层接口（SDK/API 归一化）。
- **v1 参考实现**：优先对接 **Claude Code SDK**（生态最大、流式事件完整）；配置驱动，未配置时该模式不出现在注册表中。
- **归一化映射**：外部 agent 的流式事件（message/tool_use/tool_result/error）→ 现有 `AgentEvent` 联合类型（`message:update`/`tool:start`/`tool:end`/`turn:end`…）。
- **开放决策点**：参考实现的具体产品在阶段 3 开工时最终确认（可同时调研 OpenCode SDK / DSH 的 API 网关）。

## 6. 内核：两个基础机制

### 6.1 `DisposeStack`（可逆效应累积器）

论文（Cordis）`ctx.effect` 的最小实现：任何资源注册返回逆操作，卸载按 LIFO 恢复。

```ts
class DisposeStack {
  /** 注册一个逆操作；返回取消函数（从栈中移除此项）。 */
  push(dispose: () => void | Promise<void>, label?: string): () => void;
  /** LIFO 执行全部逆操作；幂等。 */
  dispose(): Promise<void>;
  readonly size: number;
}
```

迁移面：`main.onunload`、`ExtensionManager`（补 `unloadAll`）、`EventBus.on` 的返回值、技能注册、MCP 连接。

### 6.2 `ServiceContainer`（provide/inject 服务容器）

替换 `main.ts` 的手写依赖图（`this.aiRouter = new AIRouter(...)` 链）。

```ts
interface ServiceRegistration<T> {
  name: string;
  impl: T;
  /** 依赖：注册时按名解析；缺失 → 服务处于 pending，出现后自动激活。 */
  requires?: string[];
  onActivate?(ctx: ServiceContainer): void | Promise<void>;
}

class ServiceContainer {
  provide<T>(name: string, impl: T, opts?): () => void;   // 可逆；返回撤销
  inject<T>(name: string): T | undefined;                 // 同步取
  require<T>(name: string): T;                            // 缺失抛错（带依赖链诊断）
  /** 响应式：服务出现/被撤销时通知订阅者（委托模式的 provider 热切换基础）。 */
  onChange(name: string, cb: (impl: unknown | undefined) => void): () => void;
  /** 一次 LIFO 撤销全部提供。 */
  dispose(): Promise<void>;
}
```

迁移面：`main.ts onload` 各子系统注册；`AIRouter` 热切换（provider 配置变化 → 重新 provide → 订阅者自动更新）。

## 7. 分阶段实施计划

| 阶段 | 内容 | 交付物 |
|---|---|---|
| **1 内核化** | DisposeStack · ServiceContainer · AgentModeRegistry/AgentBackend/描述符 · EmbeddedBackend 适配器 · main.ts 迁移 · 清理收口（ExtensionManager.unloadAll 等） | `src/core/`、测试、无行为变化 |
| **2 MCP server** | VaultCapability 清单 · server 端协议（复用 mcp-types）· 权限层（permissionGuard + 确认回调） | `src/mcp-server/`、可被外部 agent 连接 |
| **3 委托模式** | ExternalBackend 契约 · 参考实现（Claude Code SDK 等）· 会话级模式切换（ChatSession.modeId + 设置/命令/UI 选择器）· 自定义模式注册示例 | 双模式可运行、切换流畅 |
| **4 收尾** | vitest 覆盖（内核/权限/归一化）、typecheck、lint、README 与 docs 更新 | CI 绿 |

## 8. 兼容性与风险

- **现有功能零回归**：阶段 1 纯增量（新增 `src/core/`，不动现有行为）；EmbeddedBackend 是薄适配层。
- **Obsidian 进程约束**：MCP server 的 stdio 传输需在 Obsidian 主进程可用（Electron/Node 环境确认）；HTTP 传输作为备选。
- **外部 agent 依赖**：参考实现引入 SDK 依赖会增加 bundle；设计为**可选动态加载**（未配置不打包）。
- **测试隔离**：vault 能力测试用 `tests/__mocks__` 现有 mock vault；权限层纯逻辑可单测。

## 9. 验收标准

1. `npm run typecheck && npm run lint && npm test` 全绿（含新增测试）。
2. 启动后行为与现状一致（阶段 1 无感知变化）。
3. 内置 MCP server 可被一个标准 MCP client（如 `mcp-inspector` 或 Claude Code）连接，只读操作无需确认、写操作弹 Obsidian 确认。
4. 每会话可在 embedded ↔ delegated 间切换；切换后历史可继续对话。
5. 自定义模式可通过注册表注册（文档给出示例）。
