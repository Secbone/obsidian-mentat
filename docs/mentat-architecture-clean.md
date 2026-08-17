# Mentat 干净架构设计（功能驱动 · 插件拆分 v2）

> 状态：架构设计稿 · 目的：**重新评估插件拆分**，产出可长期扩展的目标架构。
> 约束：**不考虑迁移难度与现有代码**；以功能与依赖为第一性原则。
> 关联：`docs/mentat-cordis-refactor.md`（渐进重构路径）、`docs/mentat-agent-modes-rfc.md`（多模式）。

---

## 0. 设计原则

1. **能力即组件**：每个可独立替换的能力（工具、模型适配器、模式、UI）是一个 Cordis 组件。
2. **注册表与实现分离**：`llm`/`tools`/`agents`/`modes` 是注册表服务；具体实现（OpenAI 适配器、bash 工具、embedded 后端）是注册进表的组件。
3. **单向依赖**：交互层 → 编排层 → 能力层 → 平台层 → 内核层；禁止反向。
4. **UI 也是插件**：聊天视图、设置页、主题都挂在上下文上；Obsidian 的 `register*` 只在根组装壳里出现。
5. **内核不感知领域**：Cordis 内核只管组合/生命周期/依赖解析，不知道"笔记""模型""工具"为何物。
6. **部署形态可切换**：平台层（vault 适配）可替换——Obsidian 实现 vs headless 实现；核心层零感知。
7. **横切独立**：配置、诊断、事件、日志是独立横切组件，不内嵌在业务组件里。

---

## 1. 功能全景梳理（按层）

### L0 内核层 —— 组合与生命周期
- **Cordis 兼容内核**：统一上下文（Γ∞）、可逆效应、响应式依赖、隔离/拦截、事件、纤维生命周期。
- 职责：组件装配、依赖解析、卸载回收。**不含任何 Mentat 领域概念。**

### L1 平台层 —— 宿主能力抽象（薄直通，一个宿主插件多服务名）
| 功能 | 说明 |
|---|---|
| **vault** | 文件系统直通（读/写/移动/删除/列表）；**Markdown 解析、frontmatter、双链、链接修复属于 L2 领域层** |
| **metadata** | 标签、别名、缓存（MetadataCache）、文件状态 |
| **workspace** | 当前文件、打开的叶子、工作区布局 |
| **storage** | 插件数据持久化（loadData/saveData）、配置目录、技能目录 |
| **notify** | Obsidian Notice / Modal / 确认对话框（人机交互原语） |

### L2 能力层 —— 领域能力（可替换单元）
| 功能 | 说明 |
|---|---|
| **LLM 接入** | 对话生成（流式）、嵌入生成、工具调用支持探测；多 provider 注册表 |
| **Knowledge（知识库）** | vault 内容 → 分块 → 嵌入 → 向量存储 → 语义检索；增量索引 |
| **Tools（工具）** | 可被 agent 调用的能力：读/写/搜笔记、网页搜索/抓取、执行命令、询问用户、批量操作 |
| **Skills（技能框架）** | 用户自定义技能（SKILL.md + 实现）、技能策略（progressive/native/auto）、技能目录 |
| **MCP Client** | 连接外部 MCP server，将其工具并入工具面 |
| **Memory（记忆）** | 阅读追踪、相关笔记推荐、来源追踪（对话引用溯源） |

### L3 编排层 —— 智能体行为
| 功能 | 说明 |
|---|---|
| **Agent Loop** | 多轮推理循环（RAGP）：系统提示 → LLM → 工具调用 → 结果回填 → 压缩 → 继续 |
| **Agent Backends** | 统一对话后端契约：embedded（进程内）、delegated（外部 agent） |
| **Compaction** | 上下文窗口压缩（摘要、工具结果剪枝、token 预算） |
| **Session** | 会话生命周期、历史持久化、消息流、abort、投影（UI/导出视图） |
| **Context Window** | 消息窗口化、token 估算、不同消费视图（LLM/UI/导出） |
| **Subagents** | 子代理创建/委托（预留：DSH 的 subagent 模式） |
| **Goal / Plan** | 目标追踪与计划模式（预留：DSH 的 goal/plan-mode 模式） |

### L4 交互层 —— 用户与外部世界
| 功能 | 说明 |
|---|---|
| **Chat UI** | 聊天视图：消息流、流式渲染、工具调用卡片、确认按钮 |
| **Settings UI** | 设置页：provider 配置、模式选择、偏好 |
| **Themes** | 主题注册表：bubble / terminal / 自定义 |
| **Events** | 统一 agent 事件流（agent/turn/message/tool/context/...）→ UI 与扩展消费 |
| **Extensions** | 第三方扩展宿主：注册技能、订阅事件、访问服务 |
| **MCP Server** | 把 vault 能力暴露给外部 agent（delegated 模式的另一半） |
| **Delegated Adapters** | 外部 agent 客户端（Claude Code / OpenCode / DSH）适配器 |
| **OpenCode 集成** | 与 OpenCode 的互操作 |

### L5 组装层 —— 部署形态
| 功能 | 说明 |
|---|---|
| **mentat-root (Obsidian)** | 根组装：挂载 L1–L4 全部插件 + Obsidian register 壳 |
| **mentat-headless**（预留） | 无 UI 部署：替换 platform 实现，复用 L0–L3 |
| **mentat-server**（预留） | 作为服务被外部 agent 连接（MCP server + delegated 双端） |

---

## 2. 功能依赖图

```
L4 交互
  Chat UI ──▶ Session · Events · Settings
  Settings UI ──▶ Settings · LLM（枚举 provider）· Modes
  Extensions ──▶ Tools/Skills · Events · Settings
  MCP Server ──▶ Platform（vault 能力）· Permissions
  Delegated Adapters ──▶ Agent Backends · MCP Server

L3 编排
  Agent Loop ──▶ LLM · Tools · Knowledge · Memory · Compaction · Events
  Agent Backends（embedded）──▶ Agent Loop 实现
  Compaction ──▶ LLM · Session
  Session ──▶ Agent Backends · Context Window · Storage
  Context Window ──▶ Session（消息源）

L2 能力
  Tools ──▶ Platform（vault）· Knowledge（检索）· LLM（部分工具）· Memory
  Skills ──▶ Platform（技能目录）· Tools（注册）· Settings（策略）
  MCP Client ──▶ Tools（注册外部工具）
  Knowledge ──▶ Platform（vault）· LLM（嵌入）
  Memory ──▶ Platform（vault/metadata）

L1 平台
  Platform（vault/metadata/workspace/storage/notify）──▶（宿主：Obsidian 或 headless）

L0 内核
  Cordis 内核（Context/Fiber/Events/Registry）
```

**核心依赖规则**：
- 编排层只依赖**接口**（LLM 注册表、Tools 注册表、Backends 契约），不依赖具体实现。
- 工具组件依赖平台层，但工具**注册表**不依赖任何具体工具。
- UI 只依赖 Session/Events/Settings 三个服务——不知道 Agent Loop 内部。

---

## 3. 插件拆分方案（组件清单）

> 每个"插件"是一个 Cordis 组件（服务或能力组件），挂在统一上下文上。
> 命名即注册名（`ctx.get('llm')` 等）。

### 3.1 平台层插件

**设计决策（v2.1）：平台层是一个宿主插件，提供多个细粒度服务名。**

平台层的替换单位是**宿主整体**（Obsidian → headless），不是单个能力；且平台层保持
**薄直通**（只转发宿主 API，不做领域逻辑——领域逻辑一律上移到 L2 能力层）。因此拆成
多个插件只会产生重复样板与无意义的跨插件耦合。依赖粒度通过"一个插件 provide 多个
服务名"解决：工具组件声明 `inject: ['vault']` 而不触碰 workspace。

| 插件 | 类型 | 依赖 | 提供（细粒度服务名） | 职责 |
|---|---|---|---|---|
| `platform` | 宿主插件 | — | `vault`（读/写/移/删/列表）· `metadata`（标签/别名/缓存）· `workspace`（当前文件/布局）· `storage`（loadData/配置目录）· `notify`（Notice/Modal/确认） | 宿主抽象（Obsidian 实现，整体可替换） |
| `settings` | 服务 | storage | settings schema + 变更事件 | 配置（schema 驱动，DSH 式） |
| `diagnostics` | 服务 | events | 诊断/日志导出 | 横切：日志、诊断包 |

> 拆分边界：仅当某能力有独立生命周期/状态（如独立数据库连接），或确有独立部署替换
> 需求（如 headless 不装 workspace——用"可选的 workspace 插件"解决）时，才从 `platform`
> 拆出独立插件。领域增强（链接修复、frontmatter 批量、双链解析）**不属于平台层**，
> 归属 L2 `tool:vault-*`。

### 3.2 能力层插件
| 插件 | 类型 | 依赖 | 提供 | 职责 |
|---|---|---|---|---|
| `llm` | 注册表服务 | settings | LLM 路由（任务→provider） | 注册/路由/探测 |
| `llm:openai` / `llm:anthropic` / `llm:ollama` | 能力组件 | settings | 各自 provider 实例 | 注册进 llm |
| `knowledge` | 服务 | platform, llm | 索引/检索/增量 | RAG 管线 |
| `tools` | 注册表服务 | — | 工具注册表（schema + execute） | 工具的注册/枚举/调用 |
| `tool:vault-*`（read/write/search/list/move/delete/batch/link-fix） | 能力组件 | platform, tools | 各 vault 工具 | 注册进 tools |
| `tool:web-search` / `tool:web-fetch` | 能力组件 | tools | web 工具 | 注册进 tools |
| `tool:run-command` | 能力组件 | platform, tools | 命令执行工具 | 注册进 tools（权限敏感） |
| `tool:ask-user` | 能力组件 | platform(notify), tools | 询问工具 | 注册进 tools |
| `skills` | 服务 | platform, tools, settings | 技能加载/执行/策略 | 用户自定义技能 + 策略 |
| `mcp-client` | 服务 | tools, settings | MCP 连接管理 | 外部工具并入 tools |

### 3.3 编排层插件
| 插件 | 类型 | 依赖 | 提供 | 职责 |
|---|---|---|---|---|
| `modes` | 注册表服务 | — | 模式注册表 | embedded/delegated/自定义 |
| `agent-loop` | 服务 | llm, tools, knowledge, memory, compaction, events | 对话循环驱动 | RAGP 多轮推理 |
| `backends:embedded` | 能力组件 | agent-loop, llm, tools, skills | Embedded Backend | 进程内 agent |
| `compaction` | 服务 | llm, session | 压缩策略 | 上下文压缩 |
| `session` | 服务 | backends, context, storage | 会话管理 | 创建/历史/投影/abort |
| `context` | 服务 | session | 窗口/估算/视图 | 上下文窗口 |
| `subagents`（预留） | 服务 | agent-loop | 子代理 | 委托/编排 |

### 3.4 交互层插件
| 插件 | 类型 | 依赖 | 提供 | 职责 |
|---|---|---|---|---|
| `events` | 服务（内核） | — | 统一事件流 | agent/turn/message/tool/context 事件 |
| `ui-chat` | 组件 | session, events, settings | 聊天视图 | 消息流/流式渲染/确认 |
| `ui-settings` | 组件 | settings, llm, modes | 设置页 | provider/模式/偏好 |
| `themes` | 注册表服务 | — | 主题注册 | bubble/terminal/自定义 |
| `extensions` | 宿主服务 | tools/skills, events, settings | 扩展 API | 第三方扩展 |
| `mcp-server` | 服务 | platform, settings | vault 能力暴露 | 外部 agent 连接（带权限层） |
| `permissions` | 服务 | platform(notify) | 权限策略 | 写/删/执行授权（MCP + 工具共用） |
| `delegated` | 服务 | modes, mcp-server, platform | 外部适配器 | Claude Code/OpenCode/DSH 注册 |

### 3.5 组装层插件
| 插件 | 类型 | 依赖 | 提供 | 职责 |
|---|---|---|---|---|
| `mentat-root` | 组装 | 全部 | — | 按层挂载 L1–L4；Obsidian register 壳 |

**拆分要点（vs 现状）**：
- `chat`（上帝服务）→ 拆为 `session` + `agent-loop` + `context` + `compaction`（编排层各司其职）。
- `aiRouter` → `llm` 注册表 + `llm:*` provider 组件（模型可插拔）。
- `indexing` → `knowledge`（RAG 管线）。
- 技能 → `skills`（框架）+ `tools`（注册表）+ `tool:*`（能力组件）：技能是"带文档/策略的工具"，统一进工具面。
- `eventBus`（legacy）→ 废弃，统一用内核 `events`。
- `openCode` → `delegated` 的一个适配器实例（不是独立服务）。
- `agentModes`（M6 已建）→ 升级为 `modes` 注册表服务。
- 新增 `permissions` 横切服务（MCP 与权限敏感工具共用）。

---

## 4. 数据流（一次对话）

```
用户输入
  │
  ▼
ui-chat ──▶ session.send(message)
  │
  ▼
session ──▶ backends:<mode>.streamChat({ sessionId, messages })
  │
  ▼
agent-loop（RAGP 循环）
  ├─▶ llm.generateStreamWithSkills（模型路由）
  ├─▶ tools.execute(toolCall) ──▶ tool:vault-* / tool:web-* / skills / mcp-client
  │        └─▶ platform（vault 读/写）· knowledge（检索）· permissions（写授权）
  ├─▶ compaction（超预算时压缩）
  └─▶ events.emit（agent:*/turn:*/message:*/tool:*/context:*）
       │
       ├─▶ ui-chat（流式渲染、工具卡片）
       └─▶ extensions（订阅）· diagnostics（日志）
```

**delegated 模式数据流**（外部 agent）：
```
ui-chat ──▶ session ──▶ backends:delegated-xxx.streamChat
                          │（转发对话给外部 agent SDK/API）
外部 agent ──▶ MCP client ──▶ mcp-server（Mentat 侧）
                                └─▶ permissions（授权）──▶ platform（vault 能力）
```

---

## 5. 扩展点（新增能力如何接入）

| 想做什么 | 做法 |
|---|---|
| 加一个工具 | 写 `tool:xxx` 组件，`inject:['tools']`，`ctx.tools.register({ name, schema, execute })` |
| 加一个模型 | 写 `llm:xxx` 组件，`inject:['llm']`，注册 provider（对话/嵌入能力声明） |
| 加一个 agent 模式 | 写 `backends:xxx` 组件，注册进 `modes`（实现 `AgentBackend` 契约） |
| 加一个主题 | 注册进 `themes` |
| 加一个第三方扩展 | 通过 `extensions` 宿主 API（注册技能/订阅事件/访问服务） |
| 换一个宿主（headless） | 替换 `platform` 实现；L0–L3 零改动 |
| 接一个外部 agent | 注册 `delegated` 适配器（复用 `mcp-server` 暴露 vault） |

---

## 6. 目标目录结构（未来 src 布局）

```
src/
├── kernel/            # Cordis 兼容内核（现状 core/cordis 的演进）
├── app/               # mentat-root 组装 + main.ts 壳（Obsidian register 仅在此）
├── platform/          # 平台层：vault/metadata/workspace/storage/notify 适配
│   └── obsidian/      #   Obsidian 实现（可替换）
├── settings/          # 配置 schema + settings 服务
├── diagnostics/       # 日志/诊断服务
├── llm/               # llm 注册表 + providers/（openai/anthropic/ollama）
├── knowledge/         # 索引/检索/嵌入管线
├── tools/             # tools 注册表 + tools/vault/ web/ command/ ask/
├── skills/            # 技能框架（loader/executor/strategies/自定义）
├── memory/            # read-tracker/related-notes/source-tracker
├── agents/            # agent-loop/backends/compaction/subagents/
├── session/           # session/context-window/persistence
├── events/            # 事件类型定义（统一）
├── extensions/        # 扩展宿主 + API
├── external/          # mcp-client/mcp-server/permissions/delegated/opencode/
├── ui/                # ui-chat/ui-settings/themes/
└── types/             # 跨层共享类型
```

---

## 7. 实施建议（新架构的落地顺序）

> 按"依赖方向"推进，每层完成后下层不再变动：

1. **L0 内核**：已就绪（Cordis 兼容内核）。
2. **L1 平台 + 横切**：`platform`/`settings`/`diagnostics`（settings 升级为 schema 驱动 + 变更事件）。
3. **L2 能力**：`llm` + provider 组件 → `knowledge` → `tools` 注册表 + `tool:*` 组件（从技能中拆出）→ `skills` → `mcp-client`。
4. **L3 编排**：`context`/`compaction`/`agent-loop`/`backends:embedded`/`session`（重建会话层）。
5. **L4 交互**：`events` 统一 → `ui-chat`/`ui-settings`/`themes` 插件化 → `extensions` 宿主。
6. **L5 组装 + 外部**：`mentat-root` 重装；`mcp-server`/`permissions`/`delegated`（多模式落地）。

---

## 8. 与现有架构的关键差异（决策记录）

| 维度 | 现状 | 目标 | 理由 |
|---|---|---|---|
| 编排 | `chat` 上帝服务（11 个子系统） | `session`/`agent-loop`/`context`/`compaction` 分离 | 每个可独立替换/测试 |
| 模型 | `aiRouter` 聚合 3 provider | `llm` 注册表 + provider 组件 | 模型可插拔（DSH llm 模式） |
| 工具 | 技能编译期 import 进 loader | `tools` 注册表 + `tool:*` 组件 | 工具可插拔、权限统一 |
| 事件 | legacy EventBus 双轨 | 内核 events 单轨 | 减少抽象面 |
| UI | main.ts 注册视图 | `ui-*` 插件 + root 壳 | UI 可插拔、可 headless |
| 外部 | `openCode` 独立服务 | `delegated` 适配器注册 | 统一外部 agent 接入 |
| 权限 | 无（技能 requiresConfirmation 零散）| `permissions` 横切服务 | MCP + 敏感工具共用 |
| 部署 | 仅 Obsidian 插件 | root/headless/server 可切换 | 多模式与生态 |
| 平台层 | （隐式依赖 plugin.app）| 一个 `platform` 宿主插件提供 `vault/metadata/workspace/storage/notify` 五个细粒度服务名 | 替换单位=宿主整体；依赖粒度=服务名；薄直通无领域逻辑 |
