# Connection error 排障进展记录

> 场景：用户 Obsidian 插件（Mentat，DeepSeek provider）报 `大模型决策异常: Connection error`，
> 后经日志定位到 `Connection error. ← Failed to fetch`。

## 一、已确认的事实（证据）

| 事实 | 证据 | 结论 |
|---|---|---|
| provider | `openai-1782467347320-qrowpv`（DeepSeek，baseURL=api.deepseek.com，model=deepseek-v4-flash）| 走旧 `AIRouter → OpenAIProvider` 路径（base-agent.ts:316 报错）|
| 真实 cause | 日志 `errorChain: "Connection error. ← Failed to fetch"` | SDK `APIConnectionError`，root cause 是 `Failed to fetch` |
| **Node 环境全部连通** | ① curl ✓ ② raw https ✓ ③ SDK 复现 ✓ ④ **无代理 fetch ✓** ⑤ 流式 SSE ✓ ⑥ **bundle 成 browser + 自定义 fetch ✓** | 网络/代理/URL/SDK/bundle 配置**都不是根因** |
| 唯一失败点 | **Obsidian 渲染进程的 fetch** | 只有 Obsidian 执行时 `Failed to fetch` |

**沙箱内不可复现**：Node（含浏览器 bundle 模拟）各种方式都能连 DeepSeek；`Failed to fetch` 仅发生在 Obsidian 渲染进程运行时。

## 二、根因判断

1. **`Failed to fetch` 是 Obsidian 渲染进程 fetch 的网络层失败**——同一 URL 在 Node 全通，仅 Obsidian renderer 失败。
2. 已排除：代理（无代理也通）、URL 可达、apiKey、SDK shim、esbuild bundle 配置、自定义 fetch（bundle 测试通过）。
3. 最可能：**Obsidian 渲染进程的 fetch 受到环境限制**（Chromium 渲染进程网络栈 / CSP / 沙箱），而旧版本之所以"能跑"，需确认旧版实际行为。

## 三、已实施的修复栈（每层都**没有**被用户实测通过）

| 步骤 | 改动 | 状态 |
|---|---|---|
| L0 诊断增强 | `base-agent`/provider catch 显示完整 `errorChain` | ✅ 已生效（日志可见）|
| L1 LoggerService | exporter 架构 + FileLogSink JSONL 落盘 | ✅ 已生效（日志文件生成）|
| L2 provider 日志接入 | openai/anthropic catch → logger + ai-router 注入 | ✅ |
| L3 显式全局 fetch | `fetch: globalThis.fetch` | ⚠️ **未验证**（用户日志在更早构建）|
| L4 **obsidianFetch** | 用 Obsidian 主进程 `requestUrl` 绕过渲染进程 fetch | ⚠️ **未验证**（23:11 部署，用户日志是 15:21）|

## 四、关键时间线（重要）

- **14:49 / 15:21**：用户导出日志的 `Failed to fetch` —— 此时部署的是较早构建（不含 obsidianFetch）
- **23:11**：部署含 `obsidianFetch` 的版本（628994，与 dist 一致）
- **用户尚未 reload/测试 obsidianFetch** → 最新的 `Failed to fetch` 根因修复**未被验证**

## 五、下一步（待用户操作 + 验证）

1. **用户 reload 到 23:11 的 obsidianFetch 版**，再次触发模型调用 → 看是否仍 `Failed to fetch`
   - **若不再失败** → 根因=渲染进程 fetch 受限，obsidianFetch（主进程 requestUrl）已解决 ✅
   - **若仍失败** → 需在 Obsidian 内做更深入诊断（如直接测 `requestUrl` 连 DeepSeek、确认 Obsidian 版本/网络）
2. 确认用户 Obsidian 的 Obsidian 版本、是否网络受限
3. **重新审视"旧版能跑"**：确认用户说的旧版是否真的在相同 Obsidian 环境连通过 DeepSeek（排除偶发/其他配置）

## 六、待办（若 obsidianFetch 仍失败）

- 在 Obsidian 插件内加"连接自检"：直接 `requestUrl` 测 `api.deepseek.com`，把 status/error 写日志 —— 确认主进程 requestUrl 是否连通
- 核对 Obsidian 渲染进程 vs 主进程网络差异（Obsidian 的 net 模块 / CSP / 代理继承）
