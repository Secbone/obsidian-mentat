# Mentat 基于 Cordis 内核的重构方案（参考 DSH 设计模式）

> 状态：设计稿 v1 · 依赖：`src/core/cordis/`（Cordis 兼容内核，已提交）+ `docs/cordis-analysis.md`
> 参考：`docs/dsh-harness.md`（DSH 架构调研）、`docs/mentat-agent-modes-rfc.md`（多模式 RFC）

## 1. 目标与原则

**目标**：把 Mentat 从"`main.ts` 手写装配 + `ChatOrchestrator` 上帝对象"重构为
**Cordis 组件化**的架构——每个子系统是一个服务组件（声明依赖、提供服务、可逆效应注册），
为多模式（embedded ↔ delegated）与未来生态铺路。

**原则**（对应 DSH 的设计模式）：
1. **一切皆服务**：agent 循环、模型路由、技能、索引、会话、工具都是组件。
2. **声明依赖、响应式激活**：`static inject` 声明；依赖缺失时纤维 pending，出现后自动激活。
3. **注册即可逆效应**：任何资源（监听器、技能、MCP 连接）都是 `ctx.effect`，卸载自动回收。
4. **三层平面**：Host（进程级单例）→ 会话（scope 上下文）→ 能力（技能/工具）。
5. **薄装配**：`main.ts` 只做"挂载根组件"，不做业务编排。
6. **零回归迁移**：一次迁移一个服务，每步通过现有 vitest + typecheck 守护。

## 2. DSH 设计模式提炼（本方案的依据）

| DSH 模式 | 具体做法 | Mentat 对应改造 |
|---|---|---|
| Service 组件 | `class X extends Service { static inject=[...]; constructor(ctx,cfg){ super(ctx, name); ctx.effect(...) } }` | 每个子系统 → Service 子类 |
| 工具即组件 | 工具包 `inject:['tools']`，apply 里 `ctx.tools.register(defineTool(...))` | 技能 → 组件注册进 skills 服务 |
| 注册即可逆 | `ctx.provide`/`ctx.on`/`register` 全部是 `ctx.effect` | 收口所有手动注册 |
| 响应式依赖 | 依赖变化 → notify → 纤维 reload/unload | provider 热切换、技能自动启停 |
| 隔离 realm | `isolate: {planMode: true}`、会话 scope 上下文 | 每会话私有 agent 实例 |
| 薄 boot | `boot()`：new Context → 装 Loader → 配置树 → await quiescent | `main.ts onload` 只做装配 |
| 事件驱动 | `dispatch.waterfall('agent/pre-step', ...)` | EventBus 迁移到内核 EventsService |

## 3. 现状问题（重构动机）

```
main.ts onload() 手写依赖图（顺序敏感）：
  settings → platform → aiRouter → indexManager → eventBus
  → chatOrchestrator（内部再 new 14 个依赖！）→ extensionManager → openCodeIntegration

ChatOrchestrator 聚合：agentManager / defaultAgent / skillRegistry / skillExecutor /
  skillInvocationContext / skillLoader / mcpManager / skillCache / promptLoader /
  diagnosticsLogger / readTracker / eventBus / platform / settings / aiRouter / indexManager

onunload 只 dispose 2 个子系统；ExtensionManager 无 unloadAll 路径。
```

## 4. 目标架构（三层平面）

```
┌─ Host 平面：进程级单例服务（main.ts 只挂载 MentatRoot 组件）──────────────┐
│                                                                       │
│  MentatRoot（装配组件）                                                  │
│   ├─ settings      Service('settings')      ← MentatSettings           │
│   ├─ platform      Service('platform')      ← ObsidianAdapter          │
│   ├─ eventBus      Service('eventBus')      ← 现有 EventBus（兼容 UI）   │
│   ├─ aiRouter      Service('aiRouter')      ← AIRouter（provider 热切） │
│   ├─ indexing      Service('indexing')      ← IndexManager             │
│   ├─ skills        Service('skills')        ← SkillRegistry/Executor   │
│   ├─ mcp           Service('mcp')           ← MCPManager               │
│   ├─ prompts       Service('prompts')       ← PromptLoader             │
│   ├─ chatStore     Service('chatStore')     ← ChatManager（历史）       │
│   ├─ agents        Service('agents')        ← AgentManager + 工厂       │
│   ├─ chat          Service('chat')          ← ChatOrchestrator 拆分     │
│   ├─ extensions    Service('extensions')    ← ExtensionManager（补 unloadAll）│
│   ├─ readTracker   Service('readTracker')   ← ReadTracker               │
│   └─ diagnostics   Service('diagnostics')   ← DiagnosticsExporter       │
└───────────────────────────────────────────────────────────────────────┘
┌─ 会话平面：每会话一个 scope 上下文（isolate realm，互不干扰）─────────────┐
│  ChatSession（modeId 决定后端）                                          │
│   ├─ AgentBackend（embedded: BaseAgent 适配 / delegated: 外部适配器）    │
│   ├─ 会话 prompt 分区（systemPrompt sections）                           │
│   └─ 会话状态（消息流、上下文窗口、abort）                                │
└───────────────────────────────────────────────────────────────────────┘
┌─ 能力平面：技能/工具组件（inject 声明，随依赖自动启停）───────────────────┐
│  每个技能 → 组件：inject: ['skills', ...]，apply: ctx.effect(注册)       │
└───────────────────────────────────────────────────────────────────────┘
```

## 5. 服务化映射表（现状 → 目标）

| 现状类 | 目标组件 | inject（依赖） | provide | 备注 |
|---|---|---|---|---|
| `main.ts` 装配 | `MentatRoot`（函数插件） | — | — | 薄装配，注册全部 Host 服务 |
| `ObsidianAdapter` | `platform` 服务 | — | `platform` | 保持 `IPlatformAdapter` 接口 |
| `MentatSettings` | `settings` 服务 | — | `settings` | 监听变化 → 响应式 notify |
| `EventBus` | `eventBus` 服务 | — | `eventBus` | 兼容现有 UI；内核 EventsService 为底层 |
| `AIRouter` | `aiRouter` 服务 | settings | `aiRouter` | provider 配置变 → 重 provide → 依赖者自动重载 |
| `IndexManager` | `indexing` 服务 | platform, aiRouter | `indexing` | 惰性初始化（无 embedding provider 时 pending） |
| `SkillRegistry/Executor/Loader` | `skills` 服务 | platform, settings | `skills` | 合并三者为单服务 + 内部子组件 |
| `MCPManager` | `mcp` 服务 | skills, settings | `mcp` | 连接 = ctx.effect（断开自动回收） |
| `ChatOrchestrator` | `chat` 服务 | skills, aiRouter, indexing, agents, chatStore, prompts | `chat` | 拆掉上帝对象；只留编排 |
| `AgentManager` + 工厂 | `agents` 服务 | aiRouter, skills | `agents` | 会话 agent 的创建/注销（可逆） |
| `BaseAgent` | `EmbeddedBackend` | aiRouter, skills, indexing | — | 实现 `AgentBackend` 接口（RFC §3.1） |
| `ChatManager` | `chatStore` 服务 | platform | `chatStore` | 历史持久化 |
| `PromptLoader` | `prompts` 服务 | platform | `prompts` | 分区/模板 |
| `ExtensionManager` | `extensions` 服务 | skills, settings, eventBus | `extensions` | **补 unloadAll + DisposeStack 收口** |
| `ReadTracker` / `DiagnosticsExporter` | 独立小服务 | — | — | 各归其位 |

## 6. 关键组件设计（骨架）

### 6.1 MentatRoot（装配）
```ts
// src/root.ts —— main.ts 只 import 它并 `this.addChildPlugin(MentatRoot)`
export const MentatRoot: PluginObject = {
  inject: [],   // 无依赖，最先激活
  apply(ctx) {
    // Host 平面：注册全部单例服务（每个是独立子组件，便于按需加载）
    ctx.plugin(SettingsService);       // provide('settings')
    ctx.plugin(PlatformService);       // provide('platform')
    ctx.plugin(EventBusService);       // provide('eventBus')
    ctx.plugin(AIRouterService);       // provide('aiRouter')，inject: ['settings']
    ctx.plugin(IndexingService);       // inject: ['platform', 'aiRouter']
    ctx.plugin(SkillsService);         // inject: ['platform', 'settings']
    ctx.plugin(McpService);            // inject: ['skills', 'settings']
    ctx.plugin(PromptsService);        // inject: ['platform']
    ctx.plugin(ChatStoreService);      // inject: ['platform']
    ctx.plugin(AgentsService);         // inject: ['aiRouter', 'skills', 'indexing']
    ctx.plugin(ChatService);           // inject: 全部
    ctx.plugin(ExtensionsService);     // inject: ['skills', 'settings', 'eventBus']
    // UI 平面（保留 Obsidian register* 机制，不做 Cordis 管理）由 main.ts 挂载
  },
};
```

### 6.2 服务组件示例（AIRouter）
```ts
// src/providers/ai-router.service.ts
export class AIRouterService extends Service {
  static inject = ['settings'];
  private router = new AIRouter(this.ctx.get('settings')!);

  constructor(ctx: Context) {
    super(ctx, 'aiRouter');
    // settings 变化 → 重建 router → 依赖者（agents/indexing）自动 reload
    ctx.on('settings:update', () => {
      ctx.set('aiRouter', new AIRouter(ctx.get('settings')!));
    });
  }
}
```

### 6.3 会话与模式（每会话 scope 上下文）
```ts
// src/chat/session.ts —— 会话 = scope 上下文上的组件实例
export function createSession(rootCtx: Context, sessionId: string): SessionHandle {
  const sessionCtx = rootCtx.isolate('agent');          // 会话私有 realm
  const modeId = settings.getSessionMode(sessionId);     // embedded | delegated:xxx
  const backend = AgentModeRegistry.get(modeId).createBackend({ ctx: sessionCtx });
  return {
    sessionId,
    ctx: sessionCtx,
    backend,                                            // AgentBackend
    dispose: () => backend.dispose(),                   // 可逆回收
  };
}
```
- **切换**：旧后端 `onSessionEnd` + dispose → 新后端创建 → 历史以 `AgentChatInput.messages` 重放。
- **注册表**：`AgentModeRegistry`（RFC §3.3）持有 `embedded`（内置）+ 自定义模式描述符。

### 6.4 EmbeddedBackend（现状 BaseAgent 的适配）
```ts
// src/agents/embedded-backend.ts
export class EmbeddedBackend implements AgentBackend {
  constructor(private deps: { aiRouter; skills; indexing }) {}
  async *streamChat(input: AgentChatInput): AsyncGenerator<AgentEvent> {
    const agent = new BaseAgent({ provider: await this.deps.aiRouter.getProvider(TaskType.CHAT), ... });
    yield* agent.executeGenerator(input.messages, {...});  // 复用现有 RAGP 循环
  }
  dispose() { /* agent 会话注销 = ctx.effect */ }
}
```

## 7. 迁移路径（增量，每步可验证）

| 步骤 | 内容 | 验证 |
|---|---|---|
| **M1 骨架** | `MentatRoot` 组件 + `main.ts` 改为挂载（**不改任何行为**，服务先不迁移） | 现有测试全绿；Obsidian 加载正常 |
| **M2 基础服务** | 迁移 `settings`/`platform`/`eventBus`/`readTracker`/`diagnostics` 为服务 | typecheck + 既有测试 |
| **M3 能力服务** | 迁移 `aiRouter`/`indexing`/`skills`/`mcp`/`prompts`（inject 依赖链） | 技能加载/搜索回归测试 |
| **M4 会话服务** | 迁移 `chatStore`/`agents`/`chat`；拆 `ChatOrchestrator`（编排 → chat 服务，其余下沉） | 会话历史/发送消息回归 |
| **M5 收口** | `extensions` 服务补 `unloadAll`；`onunload` 改为 `ctx.fiber.dispose()` 级联；全量清理审计 | 卸载测试（无泄漏） |
| **M6 会话平面** | `createSession` + scope 上下文 + `AgentModeRegistry` + `EmbeddedBackend`；UI 改为经 `chat` 服务接口 | 双会话并行 + 切换 |
| **M7+ 委托模式** | MCP server + 权限层 + `ExternalBackend`（见 RFC 阶段 2/3） | 外部 agent 可连 |

**迁移原则**：
- 每步保持**公共行为不变**（UI、技能、对话流）。
- 服务化只改"如何组装"，不改"做什么"；纯增量（新增 `src/*.service.ts`），旧类先保留为内部实现，逐步替换。
- **UI 平面不动**：`ChatView` 等继续用 Obsidian `registerView`（Obsidian 生命周期管 UI，Cordis 管业务层——与 DSH 的 host/preset 分离同理）。

## 8. 收益（迁移后）

1. **卸载自动回收**：`onunload` → `ctx.fiber.dispose()`，全部注册（技能/MCP/监听/扩展）LIFO 恢复，补上 `ExtensionManager.unloadAll` 缺口。
2. **provider 热切换**：`aiRouter` 重 provide → agents/indexing 自动 reload（不再"try-catch + 手动重试"）。
3. **会话隔离**：多会话并行、互不干扰（scope 上下文 + realm）。
4. **可测试性**：每个服务独立 vitest（mock 依赖即可），不再依赖 Obsidian 环境。
5. **为多模式铺路**：`AgentBackend` 抽象让 delegated 模式成为"注册一个新后端"。

## 9. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 回归（迁移期间 UI/对话损坏） | 每步保持行为不变 + 既有 21 个测试守护；先服务化后替换 |
| Obsidian 生命周期与 Cordis 双轨 | 明确边界：Obsidian 管 UI/命令/设置页；Cordis 管业务服务与会话 |
| `ChatOrchestrator` 拆分牵一发动全身 | M4 拆为"编排壳（chat 服务）+ 内部子服务"，接口不变，逐步下沉 |
| 性能（每访问过 Proxy） | 显式 ctx 注入（无 getTraceable 魔法）；`notify` 后期加反向索引 |
| 技能/Extension 双重注册 | 统一收口到 `ctx.effect`；`extensions` 服务保证幂等 |

## 10. 验收标准

1. `npm run typecheck && npm run lint && npm test` 全绿（含新增服务测试）。
2. Obsidian 加载后行为与现状一致（迁移期零感知）。
3. `onunload` 一次 `ctx.fiber.dispose()` 完成全部回收（可测试：禁用插件后无残留技能/MCP 连接）。
4. 修改 provider 配置 → agents/indexing 自动 reload（无需重启）。
5. 两个会话并行互不干扰；会话间可切换 embedded 模式（M6 后）。
