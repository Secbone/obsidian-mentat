# Mentat 会话状态快照（防上下文丢失备份）

> 快照时间：2026-08-26 · 分支：`feat/cordis-kernel` · 提交数 164 · 代码 21523 行 · 工作区干净（全部已提交）
> 用途：当前对话上下文即将耗尽，此文件固化最关键的会话状态，若上下文崩溃可按此恢复/继续。

---

## 1. 当前状态（一句话）
Mentat 已完成 **L1-L5 干净架构重构**（宿主无关 + 多模式）并**全部通过测试**，且在用户 Obsidian 里**部署运行正常**（排障闭环走通）。

> 测试更新（2026-08-27）：新增/扩展回归测试套件，全量 `tests/core/` **39 文件 150 用例全通过**（含真实 DeepSeek `l5-real-provider` 端到端）。针对新架构早期 bug（流式缓冲、工具未传给模型、用户消息丢失、孤儿 tool 消息 400）新增确定性回归测试，并用突变验证确认测试能抓住这些 bug。新增文件：`tests/core/agent-loop-streaming.test.ts`（流式时序/工具传递/工具配对）、`tests/core/agent-loop-edge.test.ts`（maxTurns/工具错误/压缩/参数解析）、`tests/core/openai-messages.test.ts`、`tests/core/chat-messages.test.ts`、`tests/core/legacy-adapter.test.ts`；抽取纯函数 `src/agents/chat-messages.ts`、`src/providers/openai-messages.ts` 使关键逻辑可单测。

## 2. 已完成的工作

### 2.1 L1-L5 逐层实现（干净架构，docs/mentat-architecture-clean.md）
| 层 | 内容 | 关键提交 |
|---|---|---|
| L0 内核 | Cordis 兼容内核（Context/Fiber/Registry/Events/Service）| `60b2a80` |
| L1 平台 | 宿主无关 contracts(documents/search/storage+graph/workspace/ui) + platform:obsidian + headless | `0f94e18`…`fa778cc` |
| L2 能力 | llm 注册表+provider热切换、knowledge、tools 注册表+vault/web/system 工具、skills 去宿主化、mcp-client | `e2a5abb`…`d8eb2ba` |
| L3 编排 | context-window、compaction、agent-loop、embedded-backend、session | `0bb0207`…`35a47e3` |
| L4 交互/外部 | event-bridge、permissions、mcp-server、delegated、extensions-v2 | `3470dce`…`94e3660` |
| L5 组装 | NewArchitectureLayer 全挂载 + headless E2E（双形态验证）| `f88b02e`…`7a5f1d7` |

### 2.2 日志/排障体系（docs/logging-design.md，对齐 DSH/Cordis）
- `LoggerService`（exporter 架构：可插拔 sink + 命名 logger + per-name level + 环形缓冲 + errorChain）
- `FileLogSink`（JSONL 落盘 `.mentat/logs/mentat-YYYY-MM-DD.jsonl`）
- 诊断命令 `diagnose-connection`（fetch vs requestUrl 自检）+ `export-diagnostics`
- provider catch → logger（含 stage + cause 链）

### 2.3 部署基建
- `package.json`：dev=一次性构建、deploy:dev 指向真实 vault、typecheck/lint 用显式 node 路径
- `scripts/deploy.sh`：复制 dist 产物 + skills 到 vault 插件目录，保留 data.json
- Obsidian 插件已部署到 `/mnt/data/obsidian/.obsidian/plugins/mentat/`（main.js 630KB）

## 3. 核心决策（重要，勿丢）

### 3.1 架构原则
- 宿主类型不出 L0-L3 接口；可选能力=可选服务名（能力缺失→组件自动 pending）
- 平台层=一个宿主插件+多个细粒度服务名（documents/search/storage/graph/workspace/ui）
- 能力即组件（tools/llm/agents 注册表 + 实现组件）
- UI 是插件；Obsidian register* 只在 L5 壳

### 3.2 日志（对齐 DSH）
- exporter 架构（非单一 sink）；命名 logger 自动绑定 fiber；per-name level；环形缓冲

### 3.3 排障根因（connection error）
**Obsidian 继承坏代理（127.0.0.1:7890）→ ERR_PROXY_CONNECTION_FAILED**，后清理代理解决。**第二个坑**：obsidianFetch(requestUrl) 不适合 SSE 流式 → `ERR_INVALID_ARGUMENT`，改为**原生 fetch 优先**（支持流式），obsidianFetch 仅兜底。

**修复链**：诊断命令 fetch vs requestUrl → 定位代理 → 清理系统代理 → 流式用原生 fetch → 插件恢复正常。

## 4. 待办（下一步）
1. **L5 切换点（进行中）**：
   - ✅ 已完成：UI 事件流改为走 kernel-backed `event-bridge`（提交 `50f71f6`，零行为变化，新架构事件可达 UI）
   - ⏳ 剩余：chat-view 的 `sendMessage` 从 `chatOrchestrator.sendMessage` → `session.send()` (for-await 喂 handleStreamEvent)，旧 ChatService 退役。建议加"架构切换开关"+备份。
2. CI lint 清理（base-agent.ts 等既有 no-explicit-any）。
3. 新架构组件（agent-loop/mcp/delegated）失败路径接入 logger。

## 5. 如何恢复/继续
- **代码**：`git checkout feat/cordis-kernel`（164 提交全在）
- **理解架构**：`docs/mentat-architecture-clean.md`（设计）、`docs/mentat-cordis-refactor.md`（迁移）、`docs/implementation-plan.md`（执行计划）、`docs/logging-design.md`（日志）、`docs/connection-debug-progress.md`（排障）
- **继续 L5**：读 `docs/implementation-plan.md` 的 L5 部分 + 本文件 §4

## 6. 关键文件索引
- 架构设计：`docs/mentat-architecture-clean.md`
- 内核：`src/core/cordis/`
- 平台层：`src/platform/`（contracts/obsidian/headless）
- 新层：`src/llm/ src/tools/ src/knowledge/ src/agents/ src/session/ src/events/ src/external/ src/extensions/ src/obsidian/`
- 日志：`src/logger/`
- 装配：`src/app/new-architecture.layer.ts`、`src/root.ts`


---

## 7. 排障经验（connection error → 卡死 完整链条）

**症状演进**：Connection error → Failed to fetch → ERR_PROXY_CONNECTION_FAILED → ERR_INVALID_ARGUMENT → 对话卡死(无输出/不能停)

**根因链（每个都已验证修复）**：
1. **Obsidian 继承坏代理** `http://127.0.0.1:7890`（GNOME manual 代理，未运行）→ `ERR_PROXY_CONNECTION_FAILED`。
   修复：`gsettings set org.gnome.system.proxy mode none` + 重启 Obsidian。
2. **requestUrl 不适合 SSE 流式** → `net::ERR_INVALID_ARGUMENT`。修复：provider **原生 fetch 优先**，obsidianFetch 仅兜底。
3. **embedding 缺失导致交互卡死**：DeepSeek 无 embeddingModel，但 `AIRouter.getProvider(EMBEDDING)` 只按 type==openai 误选 → `indexManager.search`(对话检索) 和 `indexFile`(笔记编辑后索引) 抛错无 catch → 卡死。
   修复：search 和 indexFile 都**优雅降级**（embedding 失败返回空/存内容无向量）。
4. **事件流回归（关键教训）**：旧 BaseAgent 发事件到 legacy eventBus，但 UI 曾改听 kernel event-bridge → 事件流断裂 → UI 卡住无输出（日志零新增是信号）。修复：**UI 保持订阅 legacy eventBus**，event-bridge 仅新架构用。

**日志系统排障价值**：FileLogSink(JSONL) + diagnose-connection(fetch vs requestUrl) + export 命令 → 每次卡死都能定位到具体环节（provider 错误 or UI 事件层）。

**关键提交**：`50f71f6`(事件桥,后被回退) · `10c97d3`(回退修UI卡死) · `e104135`(search降级) · `9985dc2`(indexFile降级) · `a55e6a2`(fetch优先) · `a03a7ef`(obsidianFetch)
