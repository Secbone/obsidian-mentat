# Mentat 技术债清单（完整审计版）

> 审计时间：2026-08-28 · 全模块逐文件通读 · 三路并行审计 + 交叉验证
> 每条均基于实际源码阅读，非 TODO/FIXME 推测

---

## 🔴 HIGH（严重 — 功能缺陷 / 安全 / 数据丢失）

### H1. web_search 是假桩函数
- **位置**: `src/tools/web/web-tools.ts:33-45`
- **现状**: 返回固定字符串 `"web_search is a stub; full provider wiring lands with the skills/L4 integration"`，模型拿到假数据
- **影响**: 所有搜索类问题拿到假结果，用户被误导

### H2. 旧 adapter generate() 丢弃历史和 systemPrompt
- **位置**: `src/llm/legacy-adapter.ts:23-29`
- **现状**: `generate()` 只取 `messages.at(-1)` 发给 provider，多轮历史、system prompt、`options.systemPrompt` 全部丢失
- **影响**: 最终答案保障路径（loop L178-197）调用时没有上下文，生成的答案无依据

### H3. adapter generate()/generateStream() 不转发 systemPrompt
- **位置**: `src/llm/legacy-adapter.ts:23-30, 31-38`
- **现状**: 两个方法都把 systemPrompt 丢弃，不传给 source provider
- **影响**: 无工具路径下（生成最终答案）模型没有系统指令

### H4. 提交了真实 API Key 到代码库
- **位置**: `tests/core/l5-real-provider.test.ts:14`, `l5-real-e2e.test.ts:9`, `l5-answer-quality.test.ts:7`
- **现状**: `const KEY = process.env.DEEPSEEK_KEY || 'YOUR_API_KEY_HERE'` 硬编码在测试中，CI 执行时用真实 key
- **影响**: API Key 泄露到版本控制

### H5. 新架构下"停止"按钮卡死
- **位置**: `src/agents/loop.service.ts:52, 113` + `src/ui/chat-view/index.ts:495-631`
- **现状**: abort 时 yield `{ type: 'agent:error' }` 然后 break，**不 yield `agent:end`**；UI 的 `handleStreamEvent` 没有 `agent:error` case
- **影响**: 点停止后 `isStreaming` 永远为 true，界面永久卡在流式状态

### H6. SummarizeCompactionStrategy 不做任何 LLM 摘要
- **位置**: `src/session/compaction.service.ts:39-51`
- **现状**: `compact()` 忽略 `llm` 参数，用静态字符串 `【上下文压缩】已压缩 N 条历史消息。` 替换历史
- **影响**: 对话内容被直接丢弃，压缩后模型丢失之前的工具结果和上下文

### H7. web_fetch 在 Obsidian renderer 失败
- **位置**: `src/tools/web/web-tools.ts:11-26`
- **现状**: `globalThis.fetch` 在渲染进程有 CORS 限制；无超时、忽略 signal、原始 HTML 未清洗
- **影响**: 网页抓取全部失败（"Failed to fetch"）

---

## 🟠 MEDIUM（中 — 用户可见缺陷 / 架构债）

### M1. provider 配置变更不热重载
- **位置**: `src/llm/providers.service.ts:34-58`
- **现状**: 同一 id 的 provider 已注册即跳过，改模型/APIKey/baseURL 后 `settings:update` 无效
- **影响**: 必须重启插件才能切换模型

### M2. ConfirmModal 被 Esc 关闭时 Promise 永久挂起
- **位置**: `src/platform/obsidian/obsidian-platform.ts:219-253`
- **现状**: `ConfirmModal` 不覆盖 `onClose()`，Obsidian Modal 的默认 `onClose` 不调用 `onSubmit`
- **影响**: 用户按 Esc 关闭授权弹窗后，`ui.confirm()` 的 Promise 永远 pending

### M3. MCP server 不注入平台能力到 ToolContext
- **位置**: `src/external/mcp-server/mcp-server.service.ts:29-38`
- **现状**: `callTool` 以空 ToolContext `{}` 执行，vault 工具对委派智能体返回 "not found"
- **影响**: 外部智能体通过 MCP 无法使用 vault 工具

### M4. MCP server schemaToInputSchema 是占位
- **位置**: `src/external/mcp-server/mcp-server.service.ts:42-47`
- **现状**: 永远返回 `{ type: 'object', properties: {} }`
- **影响**: 外部智能体不知道工具参数，只能猜

### M5. LazyBackend 无 single-flight 保护（竞态）
- **位置**: `src/external/delegated/delegated.service.ts:72-75`
- **现状**: 两个并发 `streamChat` 会创建两个后端实例，第一个被覆盖泄漏
- **影响**: 外部进程句柄泄漏

### M6. 搜索空向量崩溃
- **位置**: `src/indexing/index-manager.ts:84-87`, `vector-store.ts:97-100`
- **现状**: 降级模式存 `embedding: []`，后续 `search()` 做余弦相似度时抛 "Vectors must have the same length"
- **影响**: embedding 离线期间索引过的文件永久污染搜索

### M7. sendViaNewArchitecture catch 里错误被吞
- **位置**: `src/ui/chat-view/index.ts:475-481`
- **现状**: 先 `finalizeStream`（把 streamState 置 null），再发 `system:error`——但 handleStreamEvent 因 streamState 为 null 直接 return
- **影响**: 用户看不到错误信息

### M8. permissions.service 无缓存 + fail-open
- **位置**: `src/external/permissions.service.ts:44-56, 48`
- **现状**: 文档承诺 session 缓存但代码中无缓存；未知权限放行（fail-open）
- **影响**: 5 次写工具 = 5 个弹窗；拼错权限直接无门禁

### M9. MCP client connectFn 缺失
- **位置**: `src/external/mcp-client/mcp-client.service.ts:25, 65-71`
- **现状**: `connectFn` 为可选且从不提供，`connect()` 永远抛错，无人调用
- **影响**: MCP client 是空转脚手架，与可用的旧实现重复

### M10. ToolDefinition.schema 执行时不校验
- **位置**: `src/tools/tools.service.ts:43-55`
- **现状**: `execute()` 直接传原始 input，zod schema 只用于广告
- **影响**: 模型传的参数类型错误时不报错，直接进入工具

### M11. agent:error 不在 AgentEvent 联合类型中
- **位置**: `src/agents/agent-types.ts:47-76`
- **现状**: loop 产出 `agent:error` 但该类型不在联合中，UI switch 无 case
- **影响**: 类型安全漏洞，abort 事件静默丢弃

### M12. context:compact:end 从未产出
- **位置**: `src/agents/loop.service.ts:73`
- **现状**: 只 yield `context:compact:start`，从不 yield `context:compact:end`
- **影响**: UI 永远显示"正在压缩上下文..."直到被下一个事件覆盖

### M13. Ollama 流式分块丢内容
- **位置**: `src/providers/ollama-provider.ts:141-153`
- **现状**: 按 `read()` 分块后逐行 JSON parse，跨块断行的两个碎片被静默跳过
- **影响**: 流式回答无声丢失内容

### M14. 首次部署 skills 未拷贝
- **位置**: `scripts/deploy.sh:28-30`
- **现状**: `cp -rn ... 2>/dev/null || true`，`$TARGET/skills/` 不存在时静默失败
- **影响**: 新 vault 的 skills 一个都没拷进去

### M15. base-agent.ts 转义 bug
- **位置**: `src/agents/base-agent.ts:319`
- **现状**: `\$` 转义导致用户看到字面文本 `${err.message}` 而非插值值
- **影响**: 错误信息无用

### M16. base-agent.ts 空参数崩溃
- **位置**: `src/agents/base-agent.ts:786, 793-801`
- **现状**: `args as Record<string, unknown>` 无校验，解析为 null 时崩溃，且在 try/catch 之外
- **影响**: 整个智能体运行崩溃

### M17. context-assembler 非响应式绑定
- **位置**: `src/context/context-assembler.ts:52-57`
- **现状**: 无 `inject: ['documents']`，一次性 `ctx.get(..., false)`
- **影响**: 先于平台挂载则永久无文档

### M18. session.create() 静默覆盖已存在 sessionId
- **位置**: `src/session/session.service.ts:28-32`
- **现状**: 旧 SessionHandle 的 backend 不 dispose
- **影响**: 资源泄漏

### M19. 旧架构 base-agent 压缩丢用户问题
- **位置**: `src/agents/base-agent.ts:255-278`
- **现状**: 压缩只保留最近 6 条，原始用户问题被丢弃
- **影响**: 旧路径下上下文丢失（新路径也受 CompactionStrategy 为空影响）

---

## 🟡 LOW（低 — 代码质量 / 小缺陷 / 未来改进）

### L1. agent-loop.tool:end.result 类型与联合类型不匹配
- **位置**: `loop.service.ts:158` + `agent-types.ts:63`
- **现状**: `as never` 强转掩盖了 ToolResult vs SkillResult 类型差异

### L2. agent-loop 工具结果无大小限制
- **位置**: `loop.service.ts:152-161`
- **现状**: `JSON.stringify(toolResult)` 无上限，大结果可撑爆上下文

### L3. agent-loop turn:end.toolResults 传的是调用而非结果
- **位置**: `loop.service.ts:165`
- **现状**: UI 只取 `.length`，侥幸可用

### L4. LoopOptions.mode 死参数
- **位置**: `loop.service.ts:28-37`
- **现状**: never 读取，embedded.backend 还把 sessionId 当 mode 传

### L5. headless watch() 是 no-op 却返回 disposer
- **位置**: `headless/headless-platform.ts:57`
- **现状**: 订阅者以为在监听但永远收不到变更

### L6. headless toDoc() 路径不一致
- **位置**: `headless/headless-platform.ts:62`
- **现状**: parent.path 绝对路径，doc.path 相对路径

### L7. headless moveDocument 不创建父目录
- **位置**: `headless/headless-platform.ts:45`
- **现状**: 与 writeDocument 不一致

### L8. Obsidian watch() 路径匹配无边界
- **位置**: `obsidian-platform.ts:115-120`
- **现状**: `startsWith` 无 `/` 分隔，foo 匹配 foobar.md

### L9. Obsidian search() 在新版静默返回 []
- **位置**: `obsidian-platform.ts:126-137`
- **现状**: vault.search 已移除，search 永远空结果

### L10. legacy-adapter embed() 只调 embeds/embed 不调 generateEmbedding
- **位置**: `legacy-adapter.ts:16 vs 59-64`
- **现状**: 能力检测与实际调用不一致

### L11. context.formatForLLM 截断用户消息
- **位置**: `context/context.ts:373-375`
- **现状**: >2000 字符的非工具消息被截断

### L12. skill-loader new Function() 代码执行风险
- **位置**: `skills/core/skill-loader.ts:253-263`
- **现状**: 从 vault 文件读取并执行任意 JS

### L13. skill-loader-v2 schema undefined as never
- **位置**: `skills/skill-loader-v2.ts:44-46`
- **现状**: 类型谎言，execute 只回显文件内容

### L14. MCP transport stdio 在 Obsidian 不可用
- **位置**: `skills/mcp/mcp-transport.ts:36-41`
- **现状**: `require('child_process')` 在插件运行时不可用

### L15. chat-view 恒真死三元
- **位置**: `chat-view/index.ts:444`
- **现状**: `maxTurns ? 120000 : 120000` 两个分支相同

### L16. DEBUG console.log 残留在生产代码
- **位置**: `openai-provider.ts:360-379`
- **现状**: 每次 API 调用都打印完整请求体到 console

### L17. deploy.sh skills cp 静默失败
- **位置**: `scripts/deploy.sh:28-30`
- **现状**: `|| true` 掩盖错误

### L18. event-bridge 无任何 AgentEvent 生产者
- **位置**: `src/events/event-bridge.service.ts:44-48`
- **现状**: extension-api-v2.on() 永远不触发

### L19. ask_user 只能确认不能回答
- **位置**: `src/tools/system/system-tools.ts:12-24`
- **现状**: 映射到 ui.confirm()，返回 {confirmed}，无自由文本能力

### L20. 空消息可发送导致 400
- **位置**: `chat-view/index.ts:299, 437` + `chat-messages.ts:13-17`
- **现状**: 纯文档无文字时发送空 user content

### L21. 主题默认值不一致
- **位置**: `settings.ts:234` vs `main.ts:309` vs `chat-view:69`
- **现状**: `terminal` vs `bubble` 不一致

### L22. tests/README.md 过时
- **位置**: `tests/README.md:19-23`
- **现状**: 只列出 skills/utils，实际有 agents/chat/context/core 等

---

## 已修复项（上一版记录，已验证完成）

| # | 原描述 | 修复方式 |
|---|--------|----------|
| ~~#1 L5 切换默认 false~~ | `useNewArchitecture: true` 已设为默认 | 代码已改 |
| ~~#9 maxTurns 硬编码 4~~ | `embedded.backend.ts` 改为 10 | 代码已改 |
| ~~#14 新架构缺 E2E 测试~~ | 新增 7 个 E2E 测试文件，171 测试通过 | 测试已加 |

---

## 优先级建议

**立即修复**（影响当前可用性）：
- H4（删除 Key 并轮换）
- H5（停止按钮卡死）
- H1（web_search 假桩）
- M1（provider 配置不热重载）
- M2（ConfirmModal 挂起）

**短期**（影响功能完整性）：
- H2/H3（adapter generate 丢历史/systemPrompt）
- H6（CompactionStrategy 空实现）
- M3/M4（MCP server 不注入平台能力）
- M7（sendViaNewArchitecture 错误被吞）
- M14（首次部署 skills 未拷贝）

**中期**（架构改善）：
- M11/M12（AgentEvent 类型对齐）
- M10（ToolDefinition schema 执行时校验）
- M17（context-assembler 响应式绑定）
- L18（event-bridge 空接线）

**将来**（重构）：
- L12（skill-loader new Function 安全）
- L14（MCP transport Obsidian 不可用）
- L19（ask_user 能力缩水）
