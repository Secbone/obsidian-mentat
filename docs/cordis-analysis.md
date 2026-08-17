# Cordis 4 内核问题分析与改进建议

> 基于 `@deepseek-ai/cordis@4.0.1`（DSH 内置版本，`lib/index.js` 单文件约 3400 行）源码实证分析。
> 目的：为 Mentat 的 Cordis 兼容内核（`src/core/cordis/`）提供改进依据；本内核已在可行处规避了下列问题。

## 1. 复杂度与可维护性

### 1.1 单文件巨石实现
- **现象**：整个内核（Context/Proxy/ReflectService/RegistryService/EventsService/Fiber/Service/日志/错误链）在**一个 `lib/index.js` 文件**里，仅靠 `#region` 注释分区；DSH 依赖它时无法按需 tree-shake。
- **影响**：阅读、测试、审查、版本 diff 都困难；任何改动都触碰"全局"。
- **改进**：按职责拆分模块（本内核已按 `context/fiber/registry/reflect/events/service/symbols/utils` 拆分，每文件 ≤300 行）。

### 1.2 Proxy 魔法 + mixin 的隐式语义
- **现象**：`ctx.foo` 的属性访问走 Proxy handler（`isSpecialProperty` 白名单、`getTraceable` 递归包装、`withProps` 叠加）；`ctx.get/provide/on/...` 来自 `ctx.mixin()` 动态注入的 accessor，绑定到"访问时的上下文"。
- **影响**：
  - 方法从哪来、绑定到谁，需要读源码才能确定（`mixin("reflect", [...])` 列表是运行时知识）。
  - `getTraceable` 让服务实例的 `this.ctx` 动态指向调用者上下文——极聪明但极隐晦；`ctx.reflect.ctx === 调用者 ctx` 这一事实完全不可见。
  - Proxy 的 `has`/`getOwnPropertyDescriptor` trap 与 `Object.keys`/`in`/`for...in` 的交互有边界效应（如 `'foo' in ctx` 对未声明服务返回 false，但 `ctx.foo` 会抛错）。
- **改进**：
  - 保留 `ctx.*` 表面 API，但**内部用显式 ctx 参数**传递调用上下文（本内核的做法：`registry.provide(ctx, name, ...)`，mixin 只做一次注入，无 Proxy 魔法、无运行时绑定魔法）。
  - 用 ESLint 规则/文档把"插件内必须用参数 ctx 而非捕获外层 ctx"固定下来（Cordis 中捕获外层 ctx 的 effect 会注册到错误纤维——本内核测试曾踩中此坑）。

### 1.3 Symbol 键的"双轨制"
- **现象**：`symbols.isolate/intercept/filter/effect/check/init/invoke/extend/resolveConfig/tracker/shadow/receiver` 等十几个 symbol 既是内部机制又是公共 API（`Context.isolate` 静态属性、`Service.check` 等），且用 `Symbol.for` 全局注册表跨包共享。
- **影响**：类型层面全部不可见（`ctx[symbols.isolate]` 无法被 TS 索引）；跨包共享依赖"恰好同名字符串"。
- **改进**：
  - 提供**类型化辅助函数**（`isolationOf(ctx)` 等）替代裸 symbol 索引（本内核已做）。
  - `Symbol.for` 保留（迁移兼容需要），但文档列出所有共享键名。

## 2. 类型安全

### 2.1 服务名是裸字符串
- **现象**：`static inject = ["agents", "llm", "tools"]`、`ctx.get("loader")` 全部是字符串；TS 无法校验拼写错误、无法推断 `ctx.get("loader")` 的返回类型（DSH 代码中大量 `as` 断言）。
- **改进**：
  - 提供 `declare module` 风格的服务名-类型映射（`ctx.get<T>(name)` 的 T 由注册方声明）。
  - 或提供代码生成/类型工具：从 `static inject` 数组推导 `(ctx) => ctx.inject<[...]>` 的签名。
  - 本内核暂保留字符串键（API 兼容优先），但在 `Service` 子类上可以声明泛型。

### 2.2 插件形状多态全部是运行时检查
- **现象**：`resolve(plugin)` 在运行时区分函数/类/`{apply}` 对象，`isConstructor` 判定；`Config` schema 校验在运行时（schemastery/zod）。
- **改进**：用 TS 泛型 + 重载让 `ctx.plugin<TConfig>` 在编译期推导 config 类型；`inject` 声明提供字面量类型检查。

## 3. 性能

### 3.1 每次属性访问都过 Proxy + traceable 包装
- **现象**：`ctx.llm.chat()` 这类调用链中，`ctx.llm` 触发 Proxy get trap → `getTraceable` → 可能再包一层 Proxy；`fiber.store` 沿链查找；热路径（如 agent 循环每秒多次读 `ctx.get`）开销可观。
- **改进**：
  - 对**非声明属性**的访问在 trap 内先查一个快速 Map（props 表本身是 `Object.create(null)`，已较快）。
  - 本内核的显式 ctx 注入方案避免了每次访问的绑定开销（mixin getter 缓存在访问时创建一次闭包）。

### 3.2 `notify` 是全量扫描
- **现象**：`notify(names)` 遍历**所有插件的所有纤维**检查 `name in fiber.inject`——O(插件数 × 纤维数)。
- **改进**：维护"服务名 → 依赖纤维集合"的反向索引（`Map<string, Set<Fiber>>`），provide/撤销时 O(依赖者数)。

### 3.3 事件系统每次 emit 复制数组
- **现象**：`dispatch` 对每个监听者 `filter` + `bind`，`emit` 同步展开。
- **改进**：分桶存储（`Map<name, Set>` 已做）；对高频事件提供"快速路径"（无监听者时提前返回，本内核已做 `fired.size` 短路）。

## 4. 生命周期与并发语义

### 4.1 异步卸载的顺序陷阱
- **现象**：`fiber.dispose()` 返回 Promise，`provide` 的逆要 `await` 依赖者；`while (this.inertia) await this.inertia` 依赖 `inertia` 被正确清空。**当 async 任务同步完成时，函数体内的清理语句可能先于外层赋值执行**（本内核实现时踩中：`finally { this._inertia = null }` 被外层 `this._inertia = task` 覆盖 → 死循环）。
- **改进**：统一用 `_setInertia(task)`（链式 `.then` 清理）而不是在任务体内清理；对"同步完成的异步任务"做显式测试（本内核已加）。

### 4.2 失败后不重试
- **现象**：纤维激活失败后停在错误状态（论文语义：error outcome 阻止重入），但 Cordis 无自动重试/退避；DSH 里插件启动失败需要人工干预。
- **改进**：提供可配置的重试策略（次数/退避）；错误带完整激活链（哪个依赖缺失、哪个 provider 未 ACTIVE）。

### 4.3 循环依赖无检测
- **现象**：A inject B、B inject A 时，两者都永远 pending，无诊断信息。
- **改进**：在 `plugin()` 时静态检查 inject 图的环（在 fiber 树已知时），给出环路径。

### 4.4 同步 disposer 被强制异步化
- **现象**：`ctx.on`/`ctx.provide` 返回的 disposer 内部是 async 链，调用者不 `await` 时逆操作可能延迟到微任务（本内核早期版本：`off()` 后立即 emit 仍触发监听器）。
- **改进**：同步 disposer 同步执行、异步结果链式等待（本内核已实现），并测试"不 await disposer"的同步语义。

## 5. 隔离与拦截机制

### 5.1 隔离只在服务层
- **现象**：`ctx.isolate(name, label)` 只影响 `provide/get` 的 realm 解析；事件、日志、`systemPrompt` 等横切面不感知隔离（DSH 的 preset realm 只隔离服务，prompt 分区靠手工 section 命名）。
- **改进**：把隔离扩展到事件分派（`ctx.on` 的监听器按 realm 过滤——本内核事件已支持 listener filter，可接 realm）。

### 5.2 拦截配置合并复杂
- **现象**：`resolveConfig` 沿原型链收集 `ctx[Context.intercept]` 再合并；`Config.merge` 语义因组件而异。
- **改进**：文档化合并优先级（root → child → base → head）；提供默认的浅合并+深合并选项。

## 6. 可观测性与调试

### 6.1 错误诊断依赖 stack 魔法
- **现象**：`buildOuterStack`、`enhanceError`、`getTraceable` 的 tracker 都是为了"错误时能显示调用链"，但效果依赖调用方式，且 `composeError` 重写 stack 可能丢失原始帧。
- **改进**：提供**官方 fiber 检查面板/CLI**（DSH 已有 `dsh-tool-cordis` 自省，说明需求真实）；结构化错误对象（`{ code, fiberName, missingDeps, providerNames }`）替代字符串拼接。

### 6.2 日志直接 console
- **现象**：内核内部 `console.error` 直出；DSH 需要 LoggerService 包装。
- **改进**：内核通过可注入的 logger 接口输出（本内核暂用 console，标记为待替换点）。

## 7. 生态与迁移

### 7.1 API 版本漂移
- **现象**：Cordis v3（Koishi）与 v4（DSH）语义有差异（论文明确说 v4 重构了 loader/效应语义）；`ctx.use` 在 v4 是别名、v3 是主 API。
- **改进**：语义化版本 + 官方迁移表；提供 `ctx.use` 别名（本内核已加）降低迁移摩擦。

### 7.2 单文件发布
- **现象**：`files: ["lib/*.js"]` 整包发布，无法按子模块引入。
- **改进**：ESM 子路径导出（`cordis/context` 等）。

## 8. 与本文档配套的实践

本仓库 `src/core/cordis/` 即上述改进的**最小可行验证**：
- 显式 ctx 注入替代 getTraceable Proxy 魔法（§1.2、§3.1）；
- 模块拆分（§1.1）；
- 同步 disposer 同步执行（§4.4）；
- `_setInertia` 链式清理（§4.1）；
- 事件分桶 + 短路（§3.3）；
- 类型化 symbol 辅助函数（§1.3）。

> 取舍说明：为保持与 Cordis 4 API 形状兼容（便于未来直接迁移），本内核**保留**了字符串服务键、运行时插件形状多态、`Symbol.for` 共享键——这些是兼容性约束下的已知技术债，后续可在类型层补强。
