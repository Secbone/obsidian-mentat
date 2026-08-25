# Mentat 日志排障方案设计

> **v2 修订（对齐 DSH/Cordis）**：改用 Cordis 式 exporter 架构 + 命名 logger 自动绑定 fiber + per-name level + 环形缓冲，而非单一 FileLogSink。核心实现已落地 `src/logger/`。

# Mentat 日志排障方案设计

> 目标：让 `connection error` 这类问题从"只有一句笼统报错"变成"拿到 cause/请求/耗时/上下文，一键导出查看"。
> 当前痛点：`console.*` 分散 20+ 文件、不持久化、无结构化、`cause` 被掩盖、无法按 session/provider 检索。

---

## 1. 设计原则

1. **结构化 + JSONL 持久化**——每行一个 JSON，可 grep/按字段检索；不依赖 console 滚动。
2. **上下文绑定**——每条日志带 `sessionId/providerId/toolName/agentId`，排障第一问"是哪次对话/哪个供应商/哪个工具"。
3. **错误深挖**——error 日志自动展开 `cause` 错误链 + 请求 URL + status + 耗时。
4. **按天分文件 + 环形内存缓冲**——避免单文件过大；崩溃时内存日志仍在。
5. **一键导出**——诊断面板/命令导出近期日志，便于用户提供可复现材料。
6. **平台无关**——落盘走 host-agnostic 的 `storage`/`vault` 契约（headless 也可用）。

---

## 2. 架构总览

```
┌─ LoggerService（ctx.provide('logger')）────────────────────────────┐
│  log(level, service, message, ctx?, data?)                         │
│    ├─ 格式化（timestamp/level/service/context/data）               │
│    ├─ 内存环形缓冲（keep last 500）                                │
│    └─ 落盘 JSONL（异步，按天分文件）                               │
├─ 专项 logger：network / provider / tool / session（封装快捷方法）  │
└─ 导出：getLogs(filter) / exportToFile() / openLog()               │
```

### 日志格式（JSONL 一行）
```json
{
  "timestamp": "2026-08-25T18:30:12.345Z",
  "level": "error",
  "service": "provider:deepseek",
  "sessionId": "s1",
  "providerId": "deepseek",
  "toolName": "vault_read",
  "message": "Connection error.",
  "data": { "baseURL": "https://api.deepseek.com", "model": "deepseek-v4-flash", "status": 0 },
  "errCause": "connect ECONNREFUSED 142.250.72.204:443 [proxy 127.0.0.1:7897]",
  "elapsedMs": 15234
}
```

---

## 3. LoggerService 接口

```ts
// src/logger/logger.service.ts
type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogContext {
  sessionId?: string;
  agentId?: string;
  providerId?: string;
  toolName?: string;
  component?: string;   // 如 'provider:openai', 'tools:registry'
}

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  service: string;
  message: string;
  context?: LogContext;
  data?: unknown;        // 结构化载荷（baseURL/model/status/args...）
  errCause?: string;     // 展开的错误根因
  elapsedMs?: number;    // 操作耗时
}

class LoggerService {
  log(level, service, message, opts?: { ctx?: LogContext; data?: unknown; error?: unknown; elapsedMs?: number }): void;
  // 快捷方法
  info(service, msg, opts?): void;
  warn(service, msg, opts?): void;
  error(service, msg, opts?): void;   // 自动展开 error.cause 链 + console.error
  debug(service, msg, opts?): void;

  // 导出
  getLogs(filter?: { level?; service?; sessionId?; since? }): LogEntry[];
  exportToFile(): Promise<string>;    // 写 .mentat/logs/... 并返回路径
  openLog(): Promise<void>;           // Obsidian 打开
}
```

---

## 4. 关键排障增强

### 4.1 错误深挖（解决 connection error 血案）
`logger.error()` 自动展开错误链：
```ts
function unwrapCause(err: unknown): string {
  const parts: string[] = [];
  let cur = err;
  while (cur instanceof Error) {
    parts.push(cur.message);
    cur = (cur as { cause?: unknown }).cause;
  }
  return parts.join(' ← ');
}
// error 日志输出：message="Connection error." errCause="Connection error. ← connect ECONNREFUSED ..."
```
**根治**：结合我在 `openai-provider.formatOpenAIError` 已做的 cause 展开，统一接入 LoggerService，让 provider 每次失败都落盘完整 cause。

### 4.2 provider 网络专项日志
`openai-provider`/`anthropic-provider` 在 `generate/generateStream/generateStreamWithSkills` 的 catch 里记录：
- baseURL、model、request 摘要（非敏感）
- status/code/cause、elapsedMs
- 日志级别 error，服务名 `provider:<id>`，context.providerId

### 4.3 调用链耗时
- 每次 provider 调用记录 `elapsedMs`
- 每条用户消息 session 生命周期记录 turn/step（配合现有 agent/turn 事件）

---

## 5. 落盘实现（平台无关）

```ts
// 复用 storage 契约（documents/storage），headless 也能用
class FileLogSink {
  constructor(private storage: StorageCapability) {}
  async write(entry: LogEntry, dateKey: string): Promise<void> {
    const dir = configDir + '/logs';
    await storage.saveData?? // 用 adapter append 而非覆盖 → 需要 append 原语
  }
}
```
> 落盘需要 `append` 能力。Obsidian 的 `vault.adapter.append` 可用；headless 用 fs append。建议给 `StorageCapability` 增加 `append(path, data)`（或复用 documents 的 adapter append）。

**文件路径**：`.mentat/logs/mentat-YYYY-MM-DD.jsonl`（按天分文件）
**清理**：保留最近 7 天，启动时删更旧的。

---

## 6. 导出与查看

- **命令**：`Mentat: Export Diagnostics` → 生成 `.mentat/logs/diagnostics-<ts>.jsonl` 并打开
- **面板**：设置里"诊断"tab → 查看缓冲日志 / 导出 / 清空
- `diagnostics.service.log()` 升级为调用 LoggerService（保留现有 exportSession）

---

## 7. 与现有衔接

| 现状 | 目标 |
|---|---|
| `console.*` 散落 20+ 文件 | 收敛到 `logger` 服务（console 只作 fallback / debug 镜像）|
| `.mentat/diagnostics.jsonl`（VaultDiagnosticsLogger）| 迁移/兼容到新 LoggerService 的 logs/ 目录 |
| `diagnostics.service.log()`（仅 console）| 升级为走 LoggerService（落盘 + 结构化）|
| `formatOpenAIError`（刚加的 cause 展开）| 接入 error 日志（自动落盘 cause）|
| 新层 provider（llm/providers.service）| provider 调用全走 logger |

---

## 8. 实施拆分（可逐步）

| 步骤 | 内容 | 验证 |
|---|---|---|
| L1 | 实现 `LoggerService` + `FileLogSink`（内存缓冲 + JSONL 落盘 + 基础导出） | 单测：log→entry、落盘、getLogs/export |
| L2 | 错误深挖 + provider 网络日志（openai/anthropic catch → logger.error） | 复现 connection error → 落盘含 cause |
| L3 | session/turn 上下文 + 调用链耗时 | 单测：sessionId 绑定 |
| L4 | 导出命令/面板 + 7 天清理 | 手动 |
| L5 | 收敛 console.* + 迁移 diagnostics.jsonl | 回归 |

---

## 9. 排障闭环（效果）

```
用户报 "connection error"
 → logger 已记录: error | provider=deepseek | baseURL | cause=connect ECONNREFUSED | 15s | sessionId=s1
 → 用户点 Export Diagnostics → 拿到 .mentat/logs/mentat-2026-08-25.jsonl
 → 直接 grep "ECONNREFUSED" 看到完整 cause 链 —— 3 步定位而不是盲猜
```
