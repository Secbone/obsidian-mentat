# Mentat 逐层实现执行计划

> 依据：[`docs/mentat-architecture-clean.md`](mentat-architecture-clean.md)（干净架构 v2.4）
> 原则：按依赖方向逐层推进；每层完成后下层冻结；**每层交付必须 tsc/eslint/vitest 全绿**；
> 新旧代码并存直至整层切换（切换点以 ✓ 标注）。

---

## 0. 目标

按架构文档实现 L0–L5 六层，最终达到：**任意新能力（工具/模型/模式/平台）通过注册即可接入，
obsidian/headless 部署可切换**。宿主类型不出 L0–L3 接口；可选能力 = 可选服务名。

## 1. 已完成（里程碑回顾）

| 层 | 内容 | 提交 |
|---|---|---|
| L0 内核 | Cordis 兼容内核：Context/Fiber/Registry/Reflect/Events/Service（22 测试） | `60b2a80` |
| 渐进服务化 | M1 MentatRoot 薄装配 → M6 会话平面（AgentBackend/modes） | `ec4daa9`…`e250dfd` |
| L1 平台 | 平台无关 contracts + platform:obsidian（六服务名）+ 插件 + 测试 | `0f94e18` |
| L1e 横切(部分) | diagnostics 服务 + settings:update 事件（未提交） | — |

## 2. 执行计划（按层）

### L1 平台 + 横切（进行中）

| # | 任务 | 交付物 | 验证 |
|---|---|---|---|
| L1.1 ✅ | 平台无关 contracts（documents/search/storage + graph/workspace/ui） | `src/platform/contracts.ts` | tsc |
| L1.2 ✅ | platform:obsidian 实现（六能力，宿主类型内部化） | `src/platform/obsidian/` | 5 测试 |
| L1.3 ✅ | ObsidianPlatformPlugin（六个服务名 + platform-info） | `src/platform/platform.service.ts` | 全量绿 |
| L1.4 | settings 完善：settings:update 事件消费者测试（llm 重建订阅示例） | 测试 | 回归 |
| L1.5 | diagnostics 服务测试 + 接入 mentat-root（挂载） | 测试 | 全量绿 |
| L1.6 | **切换点**：mentat-root 挂载 ObsidianPlatformPlugin，旧 PlatformService 退役 | root.ts | Obsidian 实机加载 |

### L2 能力层（下一步）

| # | 任务 | 交付物 | 验证 |
|---|---|---|---|
| L2.1 | `llm` 注册表服务 + LLMProvider 契约（capabilities 声明） | `src/llm/` | 单元测试 |
| L2.2 | provider 组件：`llm:openai`/`llm:anthropic`/`llm:ollama`（注册进 llm，可逆） | `src/llm/providers/` | 注册/路由测试 |
| L2.3 | `knowledge` 服务（索引/检索，基于 documents + llm 嵌入） | `src/knowledge/` | 检索测试 |
| L2.4 | `tools` 注册表服务 + ToolDefinition/ToolContext 契约 | `src/tools/` | 注册/调用测试 |
| L2.5 | `tool:vault-*` 组件（read/write/search/list/move/delete——从技能拆出） | `src/tools/vault/` | 工具执行测试 |
| L2.6 | `tool:web-search`/`tool:web-fetch`/`tool:run-command`/`tool:ask-user` | `src/tools/` | 各工具测试 |
| L2.7 | `skills` 框架（SkillContext 平台无关化：documents/search/graph 注入） | `src/skills/` 重构 | 技能加载测试 |
| L2.8 | `mcp-client` 服务（外部工具并入 tools 注册表） | `src/external/mcp-client/` | MCP mock 测试 |
| L2.9 | **切换点**：agent/chat 改用新 llm/tools/knowledge（旧 aiRouter/indexing 退役） | 编排层改动 | 全量回归 |

### L3 编排层

| # | 任务 | 交付物 | 验证 |
|---|---|---|---|
| L3.1 | `context` 服务（窗口化/token 估算/视图） | `src/session/context.ts` | 窗口测试 |
| L3.2 | `compaction` 服务（策略注册表 + 内置策略） | `src/agents/compaction.ts` | 压缩测试 |
| L3.3 | `agent-loop` 服务（RAGP 循环，依赖 llm/tools/knowledge/events） | `src/agents/loop.ts` | 循环事件测试 |
| L3.4 | `backends:embedded`（现有 AgentBackend 适配为新契约） | `src/agents/backends/` | 流式测试 |
| L3.5 | `session` 服务（会话创建/历史/abort/dispose + modes 解析） | `src/session/` | 会话生命周期测试 |
| L3.6 | **切换点**：ChatService 拆分退役，mentat-root 用新编排 | root.ts | Obsidian 实机 |

### L4 交互层

| # | 任务 | 交付物 | 验证 |
|---|---|---|---|
| L4.1 | 事件统一：确认 AgentEvent 契约，废弃 legacy EventBus 引用 | `src/events/` | 契约测试 |
| L4.2 | `permissions` 服务（权限策略 + 会话缓存授权） | `src/external/permissions.ts` | 授权测试 |
| L4.3 | `mcp-server` 服务（vault 能力 = ToolDefinition + permission → MCP tools） | `src/external/mcp-server/` | MCP 协议测试 |
| L4.4 | `delegated` 适配器注册框架（外部 agent 接入 modes） | `src/external/delegated/` | 适配器注册测试 |
| L4.5 | `extensions` 宿主（ExtensionAPI：registerTool 可逆 + 白名单服务） | `src/extensions/` 重构 | 扩展生命周期测试 |
| L4.6 | `ui-*` 插件化（ui-chat/ui-settings/themes 契约） | `src/ui/` 重构 | —（UI 实机验证）|

### L5 组装层

| # | 任务 | 交付物 | 验证 |
|---|---|---|---|
| L5.1 | mentat-root 按新架构重装（挂载各层插件 + Obsidian register 壳） | `src/app/` | Obsidian 实机 |
| L5.2 | platform:headless 最小实现（fs + grep 搜索，无 graph/ui） | `src/platform/headless/` | headless 单测 |
| L5.3 | 部署形态验证：核心层可在 headless 下运行（文档演示） | 演示脚本 | 手动 |

## 3. 里程碑

| 里程碑 | 覆盖 | 判定 |
|---|---|---|
| **M-A：L1 完成** | L1.1–L1.6 | 六服务名可用；settings:update 响应式示例通过；全量绿 |
| **M-B：L2 完成** | L2.1–L2.9 | 工具/模型/知识全注册表化；agent 用新能力层 |
| **M-C：L3 完成** | L3.1–L3.6 | 对话经新编排层跑通；ChatService 退役 |
| **M-D：L4 完成** | L4.1–L4.6 | delegated 模式可用（外部 agent 连 mcp-server）|
| **M-E：L5 完成** | L5.1–L5.3 | obsidian/headless 双形态可切换 |

## 4. 依赖与风险

| 风险 | 缓解 |
|---|---|
| 新旧并存期间双平台/双能力层（route 冲突）| 服务名隔离（新名 documents/search/... 旧名 platform/indexing/...）；切换点统一退役 |
| tools 从技能拆出影响既有技能调用 | L2.5 先做工具契约 + 迁移映射表，技能保留为"包装工具"的薄层 |
| ChatOrchestrator 拆分回归面大 | L3 按"编排壳→子服务"顺序，每次切换点前全量回归 |
| Obsidian 实机验证在 CI 不可达 | 关键路径用 mock 单测守护；实机验证列为手动里程碑项 |
| 事件双轨（legacy EventBus vs 内核 events）| L4.1 枚举所有 EventBus 消费点后统一迁移 |

## 5. 当前状态与下一步

- **当前**：L1 平台层核心已完成（contracts/obsidian 实现/插件/5 测试，217 全绿）；L1.4–L1.6 待做。
- **下一步**：完成 L1.4（settings:update 消费者测试）→ L1.5（diagnostics 挂载）→ L1.6（mentat-root 切换）→ 进入 L2.1（llm 注册表）。
