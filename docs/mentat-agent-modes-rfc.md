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

## 6. 内核：Cordis 兼容子集（已实现，`src/core/cordis/`）

> **设计决策更新**：内核不采用自定义 `DisposeStack`/`ServiceContainer` API，而是实现
> **与 `@deepseek-ai/cordis` 4.x API 形状兼容的简化子集**（`src/core/cordis/`，约 1800 行，
> 22 个 vitest 用例全过，tsc/eslint 全绿）。理由：① 心智模型与 Cordis 一致，学习/迁移成本低；
> ② 未来可平滑替换为真 Cordis（API 形状不变）；③ 借 Cordis 的语义保证（可逆效应、响应式依赖）。

### 6.1 已实现的 API 面（兼容 Cordis 4 子集）

| 类别 | API |
|---|---|
| 上下文 | `new Context()`（返回 proxy）· `ctx.extend/isolate/intercept` |
| 服务 | `ctx.provide(name, value, check?)` · `ctx.get(name, strict?)` · `ctx.set` |
| 效应 | `ctx.effect(callback, label?)`（fiber 累积器，LIFO 恢复） |
| 插件 | `ctx.plugin(plugin, config?)` · `ctx.use(...)` · `ctx.inject(names, cb)`（函数/类/`{apply}` 三形态） |
| 事件 | `ctx.on/once/off/emit`（监听器即可逆效应；dispatch 风格可选 subject + 通配符） |
| 纤维 | `ctx.fiber`（state 状态机 0/1/2/3/5、`await()`、promise-like、卸载级联） |
| 基类 | `Service`（`super(ctx, name)` 自动注册，纤维卸载自动注销） |

### 6.2 与 Cordis 4 的实现差异（有意为之）

- **ctx 注入替代 getTraceable**：Cordis 靠 Proxy+`getTraceable` 让服务方法 `this.ctx` 动态指向
  调用者上下文；本内核把调用上下文作为服务方法的**显式第一参数**（`registry.provide(ctx, ...)`），
  mixin 只做一次注入。语义等价、无 Proxy 魔法（详见 `docs/cordis-analysis.md` §1.2/§3.1）。
- **同步 disposer 同步执行**：`off()`/disposer 立即生效（Cordis 是异步链）。
- **`_setInertia` 链式清理**：避免"同步完成的 async 任务"导致 `while (inertia)` 死循环。
- **模块拆分**：`context/fiber/registry/reflect/events/service/symbols/utils` 8 个文件。

### 6.3 已知技术债（兼容性约束下的取舍）

- 服务名仍是裸字符串（无类型级校验）——未来加 `declare module` 类型映射。
- 插件形状多态是运行时检查。
- 错误是字符串消息（非结构化错误对象）。

## 7. 分阶段实施计划

| 阶段 | 内容 | 交付物 |
|---|---|---|
| **1 内核化** ✅ | **Cordis 兼容内核已落地**（`src/core/cordis/`）· 待做：AgentModeRegistry/AgentBackend/描述符 · EmbeddedBackend 适配器 · main.ts 迁移 · 清理收口（ExtensionManager.unloadAll 等） | 内核已提交 `60b2a80` |
| **2 MCP server** | VaultCapability 清单 · server 端协议（复用 mcp-types）· 权限层（permissionGuard + 确认回调） | `src/mcp-server/`、可被外部 agent 连接 |
| **3 委托模式** | ExternalBackend 契约 · 参考实现（Claude Code SDK 等）· 会话级模式切换（ChatSession.modeId + 设置/命令/UI 选择器）· 自定义模式注册示例 | 双模式可运行、切换流畅 |
| **4 收尾** | vitest 覆盖（内核/权限/归一化）、typecheck、lint、README 与 docs 更新 | CI 绿 |

## 8. 兼容性与风险

- **现有功能零回归**：阶段 1 内核为纯增量（新增 `src/core/cordis/`，不动现有行为）；EmbeddedBackend 是薄适配层。
- **Obsidian 进程约束**：MCP server 的 stdio 传输需在 Obsidian 主进程可用（Electron/Node 环境确认）；HTTP 传输作为备选。
- **外部 agent 依赖**：参考实现引入 SDK 依赖会增加 bundle；设计为**可选动态加载**（未配置不打包）。
- **测试隔离**：vault 能力测试用 `tests/__mocks__` 现有 mock vault；权限层纯逻辑可单测。

## 9. 验收标准

1. `npm run typecheck && npm run lint && npm test` 全绿（内核 22 用例已绿；阶段 1 迁移后全量绿）。
2. 启动后行为与现状一致（阶段 1 无感知变化）。
3. 内置 MCP server 可被一个标准 MCP client（如 `mcp-inspector` 或 Claude Code）连接，只读操作无需确认、写操作弹 Obsidian 确认。
4. 每会话可在 embedded ↔ delegated 间切换；切换后历史可继续对话。
5. 自定义模式可通过注册表注册（文档给出示例）。
