# DeepSeek Harness (dsh) 调研文档

> 调研日期：2026-08-16。信息来源：`deepseek-ai/deepseek-harness` 官方 README、`docs/architecture.md`、`docs/cordis-primer.md`、各 subsystem 文档、`packages/README.md`、`vendor/README.md`、各包 `package.json`。
>
> ⚠️ dsh 处于 **developer preview** 阶段，官方声明"未来将出现破坏兼容性的变更"。本文档所有结论基于 `master` 分支（2026-08 时点）的调研快照。

---

## 1. 概述

**DeepSeek Harness（`dsh`）** 是由 DeepSeek AI 开发的开源 agent harness（智能体框架），仓库位于 `deepseek-ai/deepseek-harness`（MIT 协议，~106k stars，12k+ commits）。

一句话定位：**dsh 是一个"一切皆插件"的通用 agent 运行时**，用来构建可组合、可替换、可观测的 agent 产品，而不是某一个具体的聊天机器人或插件。

关键事实：

| 项 | 值 |
|---|---|
| 运行方式 | `npx @deepseek-ai/dsh web`（默认 `http://127.0.0.1:3080`） |
| 底层框架 | [Cordis](https://github.com/cordiverse/cordis)（vendored，改名为 `@deepseek-ai/cordis`） |
| 设计论文 | [*A Programming Paradigm for Spatiotemporal Composability*](https://github.com/cordiverse/paper) |
| 生态标识 | 插件仓库可加 `dsh-plugin` topic |
| 版本状态 | developer preview，兼容性破坏变更随时可能发生 |
| 源码运行 | `git clone` → `pnpm install` → `pnpm run build` → `pnpm dsh web` |

**核心卖点**：模型适配器、工具注册表、会话日志、agent 循环本身、持久化、沙箱、审批策略——产品里的每一个零件都是可替换的插件，没有需要"打补丁"的特权核心。

---

## 2. 核心设计理念：一切皆插件

dsh 的架构主张可以浓缩为一句话：**"Everything is a Plugin"**。

- 插件通过 `ctx.effect()`、`ctx.on()`、`ctx.waterfall()` 向共享 context 注册服务、类型化事件、可逆效果。
- **没有特权核心**：你通过"在旁边挂一个插件"来扩展 dsh，而所有注册都是**可逆效果**（effect），插件卸载时自动回滚。
- 模型适配器、工具、会话日志、agent 循环……每一部分都从配置层面可替换。

### 2.1 dsh 为什么 vendored Cordis

dsh 没有直接依赖上游 `cordis`，而是把它 **source-vendored 进自己的 monorepo**（`vendor/` 目录），原因：

- **完全掌控框架层**：可审计、可打补丁、可锁定版本。
- **改名到 `@deepseek-ai` 作用域**：`cordis` → `@deepseek-ai/cordis`，避免在 npm 上抢占上游名字。
- **同步漂移**：所有 dsh 包用 `workspace:^` 的 peerDependencies 互相咬合，整个脊柱同步发布（当前全 `0.1.0-rc.x`）。

Vendored 清单（9 个包，均改名到 `@deepseek-ai` 作用域）：

| 目录 | npm 名 | 上游名 | 版本 |
|---|---|---|---|
| `cosmokit/` | `@deepseek-ai/cosmokit` | `cosmokit` | 1.8.1 |
| `schemastery/` | `@deepseek-ai/schemastery` | `schemastery` | 3.18.0 |
| `cordis/` | `@deepseek-ai/cordis` | `cordis` | 4.0.0-rc.7 |
| `loader/` | `@deepseek-ai/cordis-plugin-loader` | `@cordisjs/plugin-loader` | 1.0.0-rc.5 |
| `include/` | `@deepseek-ai/cordis-plugin-include` | `@cordisjs/plugin-include` | 1.0.4 |
| `group/` | `@deepseek-ai/cordis-plugin-group` | `@cordisjs/plugin-group` | 1.0.0 |
| `timer/` | `@deepseek-ai/cordis-plugin-timer` | `@cordisjs/plugin-timer` | 1.1.2 |
| `hmr/` | `@deepseek-ai/cordis-plugin-hmr` | `@cordisjs/plugin-hmr` | 1.0.15 |
| `logger-console/` | `@deepseek-ai/cordis-plugin-logger-console` | `@cordisjs/plugin-logger-console` | 1.0.0 |

`vendor/README.md` 还记录了 **18 条本地补丁**（相对上游），包括：Cordis fiber 生命周期加固（修复 3 处重入式销毁漏洞）、事件/接口 JSDoc 文档补全、事务化 Loader/Include 配置协调、HMR 精确配置监听、`applyEntryPatches` 导出等。这意味着 **`@deepseek-ai/cordis` 与上游 `cordis` 语义并不完全相同**。

---

## 3. Cordis 框架五要点

Cordis 是 dsh 底下的插件框架（vendored 版本）。官方 primer 把它概括为五个理念：

1. **插件是一个实现 Service 的对象**：可以是带 `inject`/`apply(ctx)` 字段的函数，也可以是被 Cordis 挂载进当前 context 的 `Service` 子类。
2. **context 是服务的仓库**：一个服务在 context 上占据一个稳定的 `ctx.<key>`（如 `ctx.tools`、`ctx.llm`、`ctx.sessions`）。其他插件通过 key 找服务，**而不是 import 具体实现**。
3. **通过 `inject` 声明服务依赖**：声明了所需服务的插件会等这些服务就绪后再运行——**加载顺序由服务需求表达，而不是手动编排启动顺序**。
4. **类型化事件用于通信**：服务通过 TS 声明合并声明事件名，然后按 `emit` / `waterfall` / `parallel` / `serial` 派发，取决于监听者是观察、包裹、扇出还是按序执行。
5. **注册是可逆效果**：提示词片段、工具 schema、适配器、provider、监听器都通过 `ctx.effect()` 或 `ctx.on()` 安装，重载和销毁可预测地回滚。

### 3.1 派发模式（Dispatch Modes）

每个事件有且只有一种派发模式，对应唯一的派发方法：

| 模式 | 是否等待 | 派发顺序 | 有返回值 |
|---|---|---|---|
| `emit` | 否 | 按注册顺序观察 | 无 |
| `waterfall` | 否 | 按注册顺序观察 | 有 |
| `parallel` | 是 | 所有监听并行 | 无 |
| `serial` | 是 | 按注册顺序 | 有 |

### 3.2 Waterfall 语义（around-middleware）

`ctx.waterfall` 是"环绕中间件"：监听器收到 `(...args, next)`，调用 `next()` 把（可能被包裹的）结果交给下一个服务；**不调用 `next()` 就短路**，直接返回自己的结果。

- 协作式监听器通常：改写共享的请求/决策对象 → 委托 `next()`。
- 单决策事件中，短路就是设计：**策略监听器**可以拥有决策并直接返回；**只做注释/观察的监听器**必须委托。
- 需要"先于普通注册运行"时用 `prepend: true`。

### 3.3 实用规则

- 把行为封装进插件：工具流水线事件属于 `ctx.tools`，模型流式属于 `ctx.llm`，实时 agent 协调属于 `ctx.agents`。
- **优先用事件做拦截和策略，用 service 方法做直接能力调用**。
- 每个注册都应该有 disposer（`ctx.effect()` 返回或 Cordis 助手代做）。销毁顺序重要时，把相关逻辑放在同一个 effect 里。

---

## 4. 架构总览：Profiles 与 Bundles

一个运行的 dsh 是一棵**插件树**，由有序分层在启动时组合而成：

- **Profile（配置档）**：存在 Harness home 里的命名组合。列出它堆叠的 bundles，持有它安装的树外插件，并保留用户自己的 `cordis.patch.yml`。`web` 和 `headless` 是内置模板。
- **Bundle（包）**：Cordis 配置行 + 其挂载代码的分发格式，任何插入的东西都可被上层覆盖。

每个 bundle 在自身 `package.json` 的 `dsh` 字段中声明身份：`dsh.profile` 列出 profile 的 bundles；`dsh.bundle` 指向 bundle 的 patch 文件。

分层顺序（应用到空 entry 列表）：
1. profile 中按列出顺序的每个 bundle；
2. profile 的 `cordis.patch.yml`；
3. home 级 patch；
4. 任何 `--patch` 覆盖层。

patch 按 **id** 定位一行配置并整体替换，或插入新行。

核心 bundle：
- **`dsh-base`** — 每个 profile 的第一层：模型适配器、工具、持久化、沙箱与审批策略、设置、凭据、遥测。
- **`dsh-web-app`** — 浏览器应用。
- **`dsh-headless`** — 一次性 runner，无服务器。

查看本机真实启动的插件树：

```sh
dsh --profile web --dump-config
```

打印出的任何一行都可以被你自己的 patch 替换。

---

## 5. 核心包与子系统

以下是组成 Cordis 树的**产品核心**包及其 `ctx` key：

| 包 | 职责 | `ctx` key |
|---|---|---|
| `core/session` | 只追加的 `SessionEvent` 日志 + 内存 store | `ctx.sessions` |
| `core/system-prompt` | 提示词分区 + 工具 schema 组装 | `ctx.systemPrompt` |
| `core/tools` | 作用域工具注册表 + 带守卫的执行流水线 | `ctx.tools` |
| `core/agent` | `Agent` 接口、实时注册表、`agent/*` 事件 | `ctx.agents` |
| `core/agent-loop` | 实现该接口的默认驱动（agent 循环） | `ctx.agentLoop` |
| `core/scope` | 每 agent 作用域注册原语 | 库，无 key |
| `llm/llm` | 消息/流词汇 + 适配器 seam | `ctx.llm` |

`core/agent-loop` 是 `Agent` 公开契约的**唯一具体实现**——正因为它"只是默认实现"，循环本身可被替换。扩展插件依赖 `agent`（包括需要 initiator 时），**从不直接依赖 `agent-loop`**。

---

## 6. 事件系统：三个域

事件是扩展点，选对域是大多数改动的第一步：

| 域 | 载体 | 用途 |
|---|---|---|
| **Session 事件** | 持久化事实，追加进日志并通过 `session/event` 广播 | 事实需要跨重载存活时用它 |
| **Agent 事件**（`agent/*`） | 携带实时 `Agent`：inbox、step、status、request、validation、continuation | 观察或拦截正在飞行的工作 |
| **能力事件** | 把策略和适配器挂到 seam 上（`fs/*`、`tools/*`、`telemetry/*`） | 不 import 循环即可扩展能力 |

完整的事件生产者/消费者图谱在官方 `docs/event-producer-consumer.md`。

### 6.1 类型扩展：声明合并

dsh 几乎所有可扩展和类型都用同一个模式：

```ts
interface ThingMap {
  'a': { kind: 'a'; /* … */ }
  'b': { kind: 'b'; /* … */ }
}
type Thing = ThingMap[keyof ThingMap]   // 判别联合
```

插件通过**声明合并**添加变体，无需改动所属包：

```ts
declare module '@deepseek-ai/dsh-llm' {
  interface ThingMap { 'c': { kind: 'c'; /* … */ } }
}
```

六个权威 Map：`ContentBlockMap`、`MessageSourceMap`、`FinishReasonMap`（属 dsh-llm），`TurnTriggerMap`、`TurnEndReasonMap`、`SessionEventMap`（属 dsh-session）。

此外包间传递的 ID（如 `SessionId`、`CallId`）是**品牌类型**（branded），结构上是字符串但在类型层面不可互换。

---

## 7. Agent 循环生命周期

### 7.1 Turn / Step 模型

- **step** = 一次模型请求 + 它调用的工具。
- **turn** = 零或多个 step：在第一个输入被认领前开启，在"不再欠任何东西"时关闭。

```
turn/start
  认领 next-step 输入 + 一条排队消息
  组装提示词分区 + 工具 schema
  -> agent/pre-step                   reject | enter(messages)
     step/start
     追加进入的消息为 user/message
     从日志派生模型历史
     agent/request -> llm/stream -> assistant/chunk* -> assistant/message
     tool/call* -> tools/pre-execute -> tools/execute -> tools/post-execute -> tool/result*
     step/end
     工具仍欠请求，或 next-step 输入到达 -> 认领 -> 下一个 step
  -> agent/turn-stopping
turn/end
```

`turn/*`、`step/*`、`user/message`、`assistant/*`、`tool/*` 是**持久化 session 事件**；其余是三个域的实时扩展点。`agent/pre-step`、`agent/request`、`llm/stream`、三个 `tools/*` 是 **waterfall**（监听器必须调 `next()` 委托）；`agent/turn-stopping` 是串行、无 `next()`。

### 7.2 Agent 句柄（The Agent Handle）

`Agent` 是每个插件（UI、hook、编排器）编程所对的外表面：

- `send(message, target, wakeup)` — 把输入路由到 inbox 边界，可选唤醒驱动。
- `followup(message)` — 排队一个普通后续 turn 并唤醒。
- `steer(message)` — 为最近一步提交转向；空闲的驱动开新 turn，运行中的驱动在下一个 step 边界消费。
- `inject(message)` — 排队模型可见上下文但**不唤醒**驱动；在最近的后续 step 边界被认领。
- `cancel(cause, options)` — 取消；cause 分 `user` / `parent` / `hook` / `disposed` 四类；`keepInbox` 保留排队工作。
- `whenIdle()` — 等整个 agent 到达静止。
- `runMaintenance(task)` — 在真正空闲阶段运行一个非 turn 维护任务。

生命周期状态只有两个：`idle` / `running`。销毁移除注册并发出 `agent/disposed`，不是一个可观察状态。

### 7.3 Inbox：输入送达词汇

每个 agent 拥有两个有序的待处理消息列表：

- **`next-turn`** — 下一次 turn 边界才消费（普通 follow-up）。
- **`next-step`** — 最近一个 step 边界消费（转向/steering）。

Inbox 支持 `append` / `prepend` / `replace` / `remove` / `clear` / `splice` / `claim`，每次变更都记录为持久化的 `agent/inbox/spliced` 事件，并拒绝重复 pending id。

### 7.4 拦截决策

- **`agent/pre-step`**：决定模型看到什么。可以改写认领的消息，或整体 `reject`（拒绝/空认领仍会关闭一个"没花 step 的持久 turn"，日志记录这次尝试）。返回 `PreStepDecision = { kind: 'reject' } | { kind: 'enter'; messages }`。
- **`agent/request`**：替换冻结的请求配置（provider/model/maxTokens/reasoningEffort）。
- **`agent/request-error`**：处理一次失败的模型请求，可返回 `{ kind: 'retry' }` 让循环重试。

---

## 8. 会话与事件溯源

### 8.1 Session = 只追加的事件日志

一个 `Session` 是**只追加**的类型化 `SessionEvent` 日志——**单一事实来源**。LLM 消息历史是从日志**派生**的（`deriveMessages()`），从不单独存储。重放 = 从同一批事件重新派生。

事件词汇（`SessionEventMap`，可声明合并扩展）：

| 事件 | 含义 |
|---|---|
| `turn/start` / `turn/end` | 开/关 turn；`turn/end` 携带 `TurnEndReason` |
| `step/start` / `step/end` | 开/关 step（一次模型调用 + 其工具） |
| `user/message` | 用户角色消息（直接提问 / `inject()` 上下文 / 目标延续轮） |
| `assistant/chunk` | 原始流 chunk（token 级重放保真） |
| `assistant/message` | 组装后的助手消息（携带 usage），派生历史用这条 |
| `tool/call` | 模型请求的工具调用（原始参数字符串，未解析） |
| `tool/result` | 完成的工具结果（`callId` 配对） |
| `todo/write` | todo 列表整表快照（仅 UI 状态，不进派生历史） |
| `request/header` | 下一个请求的完整头部（call config + 渲染的系统提示 + 组装好的工具 schema） |
| `request/context` | 路由元数据（provider/model/contextWindow） |
| `session/end-seed` | 标记构造种子结束（resume/fork/replay 边界） |

**模型可见即已入日志**：任何到达模型请求的东西都必须能从日志重建，运行时不变量会强制这一点。这也是"新的模型可见输入需要新的 session 事件"的原因。

### 8.2 Surface：表面补丁

三个产生消息的事件类型（`user/message`、`assistant/message`、`tool/result`）是 **SurfaceEventType**，携带 `SurfaceOp`：

- `'append'` — 正常追加到尾部。
- `{ op: 'replace'; start; end }` — 用本节点替换表面上的 `start..end` 区间（compaction 用这个；任何表面替换生产者都可用）。

`sourceEventSeqs` 列出被引用的早期事件 seq。压缩后重放依然正确，因为表面补丁是持久的。

### 8.3 持久化、fork、resume

- 持久化是**插件关注点**：`SessionPersistence` 接口，有 JSONL 和 SQLite 后端；监听 `session/event`，在 `session/flush` 检查点落盘，崩溃恢复会合成 `interrupted` 的 `turn/end`。
- `session/flush` 是被等待的 parallel 事件：每个监听都跑、调用者等全部。
- **fork**：`ctx.sessions.fork(source, boundary?, childSessionId?)` 从任意稳定 turn 边界派生子会话。
- **resume**：`ctx.agents.resume()` 从持久化加载会话后恢复 agent。

### 8.4 派生历史

`Session.deriveMessages()` 沿着 `surfaceOp` 标记的消息产生事件序列，投影出模型消息历史：

- `user/message` → user 消息；
- `assistant/message` → assistant 消息（携带 provider/model；空内容的 `assistant/message` 被跳过——max-tokens 截断仍记录 usage，但不进转录）；
- `tool/result` → 携带 `tool-result` 块的 user 消息；
- 其余（`turn/*`、`step/*`）是结构性的，不投影成消息。

缓存 + 深冻结：每个 surface 节点只投影一次，表面重写（replace）时重建。

---

## 9. 工具系统

### 9.1 `ToolDefinition`

每个已注册工具 = 模型侧 `ToolSchema` + **强制 output 契约** + `execute` 函数 + 可选 final-content 回调 + 可选 UI 呈现回调。`schemas()` 只把 name/description/parameters 暴露给模型，`output`/`execute`/回调**绝不泄漏到请求**。

```ts
interface ToolDefinition extends ToolSchema {
  output: ToolOutputDefinition          // schema + render + presentationMeta
  execute(args, exec: ToolRunContext): Promise<unknown>
  finalizeContent?(exec, result)        // 最后一次内容变换
  timeoutMs?                            // 协作式超时预算（永不发给模型）
  isConcurrencySafe?(args)              // 纯同步分类器：true 才可并行
  presentCall?(args)                    // 未决状态 UI 意图
  presentResult?(args, result)          // 完成状态 UI 意图
}
```

参数和输出用统一 JSON schema DSL 编写（`defineTool` 构建）：`ValueSchemaSpec` 支持 string/number/integer/boolean/null/array/object/`json`(注解)/`oneOf`，精确类型推断到 16 层容器深度后回退 `JsonValue`。参数不匹配抛 `ToolArgsError`（`INVALID_ARGS`），body 无效抛 `ToolOutputError`（`INVALID_TOOL_OUTPUT`）。

### 9.2 执行流水线

`ctx.tools.execute()` 通过一条可扩展的流水线：

```
tools/pre-execute  (allow/deny/ask 决策 waterfall)
  -> 注册的单调 ToolGuard    （只能再拒绝，不能撤销批准）
  -> tools/execute           （around-dispatch 包装，可换 signal）
  -> tools/post-execute      （accept/replace/block 决策）
  -> finalizeContent         （工具自有的最后一次内容变换）
  -> tools/result            （冻结的权威结果，观察者只读）
```

决策类型：
- `PreToolDecision = { kind: 'allow' } | { kind: 'deny'; reason } | { kind: 'ask'; reason? }`（`ask` 在审批服务返回 `allowed-once` 前会拒）。
- `PostToolDecision = { kind: 'accept'; ... } | { kind: 'block'; feedback; ... }`（`block` 把纠正性反馈变成错误结果喂回模型）。

结果类型：
- `ToolExecutionSuccess`：`isError: false`，携带 lossless-JSON 的 `value` + 渲染后的 `content` + 可选 `meta` + 可选 `additionalContexts` + 可选 `concludesTurn`。
- `ToolExecutionFailure`：`isError: true`，携带结构化 `error`。

全程**无损失 JSON**：参数深冻结、逐字节保真；canonical `value` 是执行局部的（持久化只存 `content`/`error`/`meta`），重放能重现呈现但不能重建中间值。

### 9.3 作用域与调度

- **`ToolRestriction`**：per-scope 的 `allow`/`deny` 过滤（白名单/黑名单），作用于 scope 继承的全局工具；scope 自己注册的工具不受影响。
- **调度**：`isConcurrencySafe` 返回精确 `true` 的调用进并行组；其余是 `exclusive`，形成排序屏障。失败即 closed：未知/隐藏/抛异常的分类器一律视为独占。

### 9.4 UI 呈现抽象（与客户端协议无关）

工具**自描述**它想被如何展示——`card` 标签的渲染意图联合（`ToolCallView`/`ToolResultView`），纯函数、可重放：

- `generic` — 默认卡片（图标按 `ToolCallKind`：read/edit/delete/move/search/execute/fetch/other）。
- `terminal` — 终端卡片（命令 + 输出 + exit code）。
- `diff` — 文件变更的内联 diff（`{ path, oldText, newText }[]`）。
- `search` — 发现型搜索结果（按文件分组 or 扁平路径列表 + `truncated`/`total`）。
- `read` — 带行号的代码/文件阅读视图。
- `web` — 网页检索（`search`/`fetch`）。

客户端运行时（Web UI、CLI、编辑器）把这个中性词汇投影成自己的视图；没有对应能力时回退到原始结果内容。

---

## 10. LLM 抽象

### 10.1 `ctx.llm` = `LlmRuntime`

适配器注册表 + 可拦截的流式调用 API：

- `registerAdapter(providers, adapter)` — 注册一个适配器，返回带 `replace()` 的 disposer（原子替换路由）。
- `prepareCall(config)` — 解析一次调用并绑定当前适配器注册，保证 header 记录和派发共享同一适配器。
- `stream(options)` — 直接流式；会经过 `llm/stream` waterfall。

### 10.2 `LlmAdapter` 与 `llm/stream` waterfall

适配器唯一必须实现的方法是 `stream(options)`（异步可迭代，产出 `StreamChunk`）。`llm/stream` 是 waterfall：监听器可调 `next()` 到达真实适配器的流，或自己产出 chunk 短路（重试、重放、路由都在这里挂）。

`Message`/`ContentBlock`/`StreamChunk` 是 provider 无关的词汇。适配器侧/消费侧的失败被归一化成终止 chunk（`finish`，reason 为 `aborted` 或 `error`）。

### 10.3 模型发现与错误分类

- `listModels` / `resolveModelInfo` / `discoverModels` — 目录、精确模型元数据、端点探测。
- `LlmError` — 继承 `HarnessError`，`code` 是共享分类（`AUTH`、`RATE_LIMIT`、`NO_ADAPTER`、`INVALID_ADAPTER`、`DUPLICATE_ADAPTER` 等），可携带 `status`、`providerRetryAfterMs`、`requestId`。
- **dsh 自带 DeepSeek 原生直连适配器**（直接 fetch）以及 pi-ai 库适配器，另有 OpenAI 兼容/Anthropic 等适配器插件（`packages/llm/*`）。

---

## 11. 能力缝（Capability Seams）

**Seam** 是一个可换的能力，三角角色：

1. **Service Definition**（服务定义）— 声明接口；
2. **Service Provider**（服务提供者）— 实现它；
3. **Consumer**（消费者）— 通常是模型面对的工具。

一个包可以兼多职，但单独一个角色不构成 seam；**新增一个能力意味着设计全部三角**。

Seam 的价值：**换一个 provider 就换掉整个产品的相关能力**。例如文件系统和子进程 provider 共享一个执行世界——把它们指向远程沙箱，Bash、PTY、LSP 跟着一起迁移，无需 provider fork。子 agent provider 也一样：从一个全新子 agent 到另一个产品里的委托 turn，只差一个接口。

能力族（来自 `packages/README.md`）：
- `subprocess`（进程树 provider）、`shell`（Bash）、`terminal`（持久 PTY）、`code-runtime`（worker 线程）、`sandbox`（bwrap/Landlock/Seatbelt 后端）、`fs`（文件系统）、`lsp`、`web`（search/fetch）、`compaction`、`context`、`subagent`、`jobs`、`workflow`、`spill`、`interaction`（审批/ask-user）、`skill`（Agent Skills 规范）……

---

## 12. 扩展点总览

官方 architecture 文档给出的"新行为放哪里"速查表：

| 目标 | 机制 |
|---|---|
| 加一个模型 provider | 在 `ctx.llm` 注册适配器 |
| 加一个模型面对的能力 | 注册到 `ctx.tools`，其 schema 进入提示词组装 |
| 给某个会话不同能力集 | 组合 agent preset；需要隔离的服务行用 `isolate` realm |
| 加 shell 执行 | 注册 `ctx.shell` 后端，本地实现经 `ctx.subprocess` spawn |
| 加持久终端执行 | 注册 `ctx.terminals` 后端 + `dsh-tool-terminal` |
| 加人类命令 | 注册到 `ctx.commands`，不经过模型 turn 派发 |
| 加后台工作 | 注册到 `ctx.jobs`，`job_*` 工具收集/停止 |
| 加文件系统访问或策略 | 注册 `ctx.fs` provider 或监听 `fs/*` 事件 |
| 限制派生命令进程 | 用 `ctx.sandbox` 后端，消费者 spawn 前包裹 argv |
| 拦截 request/tool/turn | 用对应的 `agent/*` 或 `tools/*` 事件；`agent/turn-stopping` 停 turn |
| 加模型面对上下文 | `agent.inject()`，落到下一次被接受的请求 |
| 加 UI 或编辑器集成 | 驱动 `ctx.agents`，从 `session/event` 渲染 |
| 加持久会话状态 | 扩展 `SessionEventMap`，从日志渲染并重放 |
| 生成会话标题 | 注册唯一的 `ctx.sessionTitle` provider |
| fork 一个活跃会话 | `ctx.sessions.fork(source, boundary?, childSessionId?)` |
| 把注册作用域限定到一个 agent | 用该 agent 的 `agent.ctx` |

---

## 13. 包目录

`packages/` 按 group 组织（`packages/<group>/<pkg>/`，包名 `@deepseek-ai/dsh-<pkg>`）：

| Group | 角色 | 状态 |
|---|---|---|
| `core/` | Product API 脊柱：sessions、prompts、tools、agent 服务、具体循环 | 产品级，API 稳定 |
| `api/` | 远程 BFF 组装 + Typert RPC 网关 | 产品级 |
| `typert/` | 类型图生成、artifact 加载、运行时注册表 | 产品级 |
| `goal/` | 同会话目标持久化与生命周期 | 产品级 |
| `schedule/` | 会话本地定时后续 | 产品级 |
| `feedback/` | 人类反馈 | 产品级 |
| `identity/` | 共享匿名身份 | 产品级 |
| `llm/` | LLM 能力族：抽象服务 + provider 适配器 | 产品级 |
| `e2b/` | E2B providers | POC |
| `subprocess/` | 子进程能力族：定义 + 本地进程树 provider | 产品级 |
| `shell/` | Bash 能力族 | 产品级 |
| `terminal/` | 持久 PTY 能力族 | 产品级 |
| `code-runtime/` | 代码执行能力族 + worker 线程 provider + Code Mode | 产品级 |
| `sandbox/` | 进程限制 seam；bwrap/Landlock/Seatbelt 后端 | 产品级 |
| `fs/` | 文件系统能力族 | 产品级 |
| `lsp/` | LSP 能力族 | 产品级 |
| `skill/` | Skill 能力族：provider 注册表、catalog/loader | 产品级 |
| `compaction/` | 压缩能力族 | 产品级 |
| `context/` | 模型可见请求上下文 | 产品级 |
| `subagent/` | 子 agent 能力族 + 委托工具 | 产品级 |
| `jobs/` | 通用后台任务运行时 + `job_*` 工具 | 产品级 |
| `workflow/` | 工作流 seam + worker 引擎 + `workflow`/`ralph` 工具 | 产品级 |
| `web/` | Web 能力族：search/fetch provider + 工具 | 产品级 |
| `attachment/` | 持久附件身份 + 本地内容寻址存储 | 产品级 |
| `spill/` | 溢出能力族：存储 seam + 工具结果溢出策略 | 产品级 |
| `todo/` | `todo_write` 工具 | 产品级 |
| `plan/` | 计划协作状态 | 产品级 |
| `preset/` | 基于 preset `cordis.yml` 的每会话 agent 组合 | 产品级 |
| `guard/` | 循环卫生守卫：重复调用提醒 + 执行期限强制 | 产品级 |
| `bundle/` | 可安装的 `dsh --profile` patch 层 | 产品级 |
| `extensions/` | agent 运行时自修改：实时插件/服务检查 + 模型写的插件挂载/卸载 | 产品级 |
| `hooks/` | Hook 桥 + 共享 Claude Code/Codex 线协议库 | 产品级 |
| `session/` | 持久化数据面：persistence seam + JSONL/SQLite 后端、投影、标题、报表 | 产品级 |
| `session-query/` | 会话检索族：逻辑语料、受限读、血缘、事件关系、语义过滤、SQLite FTS | 产品级 |
| `settings/` | 用户设置 seam + 文件 provider | 产品级 |
| `credentials/` | 凭据引用 seam + env-over-`.env` provider | 产品级 |
| `storage/` | 非会话存储枢纽 + 后端 | 产品级 |
| `workspace/` | Workspace 实体 | 产品级 |
| `sdk/` | 进程外运行时 SDK：JSON-RPC 协议、TS 客户端、server 插件 | 产品级 |
| `acp/` | 仅自动化的 Agent Client Protocol 服务器 | 产品级 |
| `interaction/` | 人类协作面：审批/交互 seam、权限预设、命令、ask-user 工具 | 产品级 |
| `boot/` | 共享 app-bin 启动胶水 | 产品级 |
| `host/` | Web-GUI host 半区：API 网关 + HTTP 路由 | 产品级 |
| `client/` | Web-GUI 浏览器半区：shell、wire、对象服务、slots、`ui-*` 插件 | 产品级 |
| `examples/` | 演示 bundles | 支持性 |
| `test-support/` | 测试基础设施 | 支持性 |
| `util/` | 底层零依赖工具（`Branded<B>`、Harness home/path 助手、timeout、retention） | 支持性 |

依赖图由脚本生成：`docs/module-graph.md`（CI 有 freshness 门禁）。

---

## 14. 运行形态与协议

- **CLI**：`dsh web`（:3080 Web UI）、`dsh headless`（一次性 runner）、`dsh --dump-config`（打印启动树）、`--profile`/`--patch` 覆盖。
- **SDK / JSON-RPC**（`packages/sdk`）：进程外运行时的 TS 客户端 + server 插件，走 JSON-RPC 协议。
- **ACP**（`packages/acp`）：自动化 Agent Client Protocol 服务器。
- **Hooks**（`packages/hooks`）：Claude Code / Codex 线协议桥（`SessionStart`、`UserPromptSubmit`、`PreToolUse`、`PostToolUse`、`Stop` 等 hook 事件），把 dsh 接入既有代理客户端生态。
- **Extensions**（`packages/extensions`）：agent 运行时自我修改——模型自己写插件并挂载/卸载。

---

## 15. 与 mentat 的关系（衔接摘要）

完整对比见本项目此前的研究对话；本节只记录与"复用"相关的调研事实。

**复用 dsh 插件 ≠ 只引入 Cordis**。dsh 插件（工具/适配器/持久化/UI）注册在 dsh 自己的 `ctx.tools`/`ctx.llm`/`ctx.sessions` 上、用 dsh 的 `ToolDefinition`/`ContentBlockMap`/`SessionEventMap` 编写，且强耦合（peerDependencies `workspace:^`）。要复用它们，必须同时引入 dsh 的核心脊柱（`dsh-llm`、`dsh-session`、`dsh-tools`、`dsh-scope`、`dsh-agent`、`dsh-agent-loop`、`dsh-system-prompt`、`dsh-invariants`、`dsh-brand`、`dsh-attachment`、`dsh-timeout`、`dsh-typert-protocol`、`@deepseek-ai/cordis` 等）。

**对 mentat 高价值的复用清单**：`packages/llm/*` 适配器（含 **DeepSeek 原生直连适配器**）、`packages/web`（search/fetch 工具）、`packages/session`（JSONL/SQLite 持久化）、`packages/interaction`（审批/ask-user）、`packages/compaction`、`packages/skill`（Agent Skills 规范）、`packages/mcp`、`packages/subagent`/`workflow`/`jobs`/`todo`/`plan`。

**Node 绑定面**（影响嵌入方式）：
- `dsh-session` 源码 import `node:path`；`dsh-llm` 是纯 TS（无 Node 内置）。
- Node 重的能力 provider（`fs`、`shell`、`subprocess`、`terminal`、`sandbox`(bwrap/Landlock/Seatbelt)、native `sqlite` 持久化）在 Obsidian 渲染进程不可用或受限。
- 两种嵌入候选：**A. 进程内嵌入**（esbuild 打进 main.js，Node 内置换 shim，Node 专属 provider 换 vault/`child_process` 实现）；**B. 子进程脊柱**（spawn `npx @deepseek-ai/dsh headless`，用 `dsh-sdk` JSON-RPC 做瘦客户端，复用率最高）。

---

## 参考资料

- 仓库：https://github.com/deepseek-ai/deepseek-harness
- 架构文档：`docs/architecture.md`（含 turn flow、扩展点表）
- Cordis primer：`docs/cordis-primer.md`（五要点、派发模式、waterfall 语义）
- 子系统文档：`docs/subsystems/{core,session,tools,system-prompt,llm-streaming,scope}.md` 等
- 包目录：`packages/README.md`（group 职责表）
- Vendor 说明：`vendor/README.md`（vendored 清单 + 18 条本地补丁 + 同步流程）
- Cordis 上游：https://github.com/cordiverse/cordis
- 设计论文：https://github.com/cordiverse/paper
