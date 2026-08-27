# Mentat 技术债清单

> 生成：2026-08-26 · 分支 `feat/cordis-kernel`（174 提交）· 基于 L1-L5 重构 + 排障后的完整盘点。
> 用途：为后续规划提供依据；按「影响 × 难度」排序。

---

## 一、架构债（新旧并存，未完成切换）

| # | 债项 | 现状 | 影响 | 难度 |
|---|---|---|---|---|
| 1 | **L5 切换未完成** | 新架构（session/agent-loop/CompactionService）已实现并挂载，但 `useNewArchitecture` 默认 false，**实际使用走旧路径**（chatOrchestrator→BaseAgent） | 新架构（模型热切换、多模式、新事件）未被真实使用；两套代码都在维护 | 高（UI 行为级，有事件流回归前科）|
| 2 | **旧 ChatService/BaseAgent/Compactor 未退役** | 仍是主路径 | 维护双份 agent 实现；日志/排障覆盖两套 | 中 |
| 3 | **event-bridge 未真正用于新架构** | chat-view 已回退 legacy eventBus（`10c97d3` 教训）；event-bridge 只被 extensions-v2 用 | 新架构事件要流到 UI 需完整方案（不只换 bus）| 中 |

## 二、代码债（双系统 / 遗留 / hack）

| # | 债项 | 现状 | 影响 | 难度 |
|---|---|---|---|---|
| 4 | **双事件系统** | legacy `EventBus`（`src/extensions/event-bus.ts`）+ kernel `EventsService` + `EventBridge` | 三个事件层；新组件该用哪个不清晰 | 中 |
| 5 | **双日志系统** | `LoggerService`（新）+ 109 处散落 `console.*` 未收敛 | 部分日志不进 FileLogSink，排障不完整 | 中 |
| 6 | **双 provider 构建** | `ai-router.ts` 与 `llm/providers.service.ts` 各自 buildProvider（重复）| 维护两份；新架构用后者，旧路径用前者 | 低 |
| 7 | **`AIRouter.getProvider(EMBEDDING)` 逻辑缺陷** | 只按 `type==openai/ollama` 选，不查 `supportsEmbedding`/`embeddingModel`（曾导致 embedding 卡死）| 依赖 search/indexFile 降级兜底，根因未除 | 低 |
| 8 | **obsidianFetch 是半成品** | 支持非流式；流式（SSE）走原生 fetch 兜底；requestUrl 对 SSE 会 ERR_INVALID_ARGUMENT | 未用于流式；文档未明确 | 低 |
| 9 | **`EmbeddedBackend` 硬编码 maxTurns=4** | `streamChat` 里 `loop.run(..., { maxTurns: 4 })` 写死 | 新架构对话轮次固定，不可配置 | 低 |
| 10 | **CompactionService 摘要为占位** | `SummarizeCompactionStrategy.compact` 不真正调 LLM，只加固定文案 | 上下文压缩不生效（新架构）| 中 |
| 11 | **knowledge 是内存版** | `KnowledgeService` 无持久化，重启丢索引 | headless/新架构的 RAG 不持久 | 中 |
| 12 | **schemaToInputSchema 空实现** | mcp-server 的 zod→MCP schema 是占位（返回空 object）| MCP 工具参数无 schema | 中 |
| 13 | **`SkillsService`/旧 skills 与新 tools 未合并** | 技能框架（skillRegistry）与 tools 注册表并存 | 工具/技能两套入口 | 中 |

## 三、测试债

| # | 债项 | 现状 | 影响 | 难度 |
|---|---|---|---|---|
| 14 | **新架构缺端到端测试** | agent-loop 单测用 mock provider；无真实 DeepSeek 集成测试 | 新路径的真实行为（流式/工具/压缩）未验证 | 中 |
| 15 | **UI/chat-view 无测试** | UI 是 Obsidian 视图，无法 CI 测 | 事件流/渲染回归只能真机发现（教训：50f71f6）| 高 |
| 16 | **headless 只测了最小对话** | L5.3 只有单例 | 知识/压缩/MCP 在 headless 未覆盖 | 中 |

## 四、运行时 / 配置债（用户环境）

| # | 债项 | 现状 | 影响 | 难度 |
|---|---|---|---|---|
| 17 | **Obsidian 系统代理曾被坏代理污染** | 已清理（gsettings mode none）；但环境可能再设 | 复现需重新诊断（脚本 scripts/diagnose-obsidian-proxy.sh 已备）| 低 |
| 18 | **data.json 关闭了 4 个功能开关** | `autoClassificationEnabled/graphEnabled/linkSuggestionEnabled/reviewEnabled=false`（因 DeepSeek 无 embedding）| RAG/图谱/分类不可用；将来配 embedding provider 需重开 | 低 |
| 19 | **embedding provider 缺失** | 只有 DeepSeek（无 embeddingModel）| 语义搜索/索引降级为空；需配 Ollama 等才能用 | 低 |
| 20 | **部署流程依赖手动** | deploy.sh 需完整访问权限；Obsidian reload 手动 | 迭代慢；无 CI 自动部署 | 中 |

## 五、横切债

| # | 债项 | 现状 | 影响 | 难度 |
|---|---|---|---|---|
| 21 | **FileLogSink 导出格式** | 导出 txt 曾显示 `undefined`（JSONL 正常）；recent() 字段映射弱 | 导出可读性差 | 低 |
| 22 | **新架构 provider 错误链路未全覆盖** | agent-loop/mcp-server 已接 logger；delegated/extensions 未接 | 部分失败无日志 | 低 |
| 23 | **`docs/SESSION_SNAPSHOT.md` 需持续更新** | 会话级快照，非长期文档 | 新会话需读它续接 | 低 |

---

## 优先级建议

**高价值先做**（影响实际使用）：
- #1 L5 切换（但高风险，需完整事件桥方案 + 真机验证）
- #4/#5 统一事件/日志（为切换铺路）
- #19 配 embedding provider（恢复 RAG 功能，或明确不启用）

**低风险快赢**：
- #6 合并 provider 构建、#7 修 getProvider 缺陷、#9 可配置 maxTurns、#14 加真实 provider 集成测试

**将来**：
- #10/#11/#12 完整实现（压缩摘要、knowledge 持久化、MCP schema）
