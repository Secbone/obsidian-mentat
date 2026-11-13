# 模块化重构部署验收 · 2026-11-13

## 交付范围

完成方案 B2/C/D/E/F：宿主小端口、权威运行仓库与上下文 checkpoint、统一文件变更计划、模型/embedding/引擎契约、共享观测查询与有界 UI。A/B1 已在此前提交。生产仍使用 native 引擎和现有供应商；第二引擎、第二仓库/模型等替换能力由独立实现的共享契约测试验收，不表示已安装第三方 Agent SDK。

实现入口：`src/contracts/`、`src/adapters/`、`src/agents/host-engine.ts`、`src/runtime/run-store.ts`、`src/skills/mutations/`、`src/observability/observation-query.ts`。详细设计和分批记录见 [重构方案](MODULAR_REFACTOR_PLAN.md)。

## 自动化及真实边界验证

| 验证 | 结果 |
| --- | --- |
| build（含 TypeScript）、lint、diff 检查 | 通过 |
| 离线测试 | 52 文件，419 项通过；实机修复后重新全跑 |
| 联网集成 | 4 项通过 |
| 真实 DeepSeek 合成工具续接 | high / 65536，codec 1；两次请求、一次 echo_value(7)，最终回复 7 |
| 真实隔离文件系统 | 3 次持久审批，3 次写入、1 次移动；批量 YAML 保留嵌套字段，移动更新引用 |
| 账本重启恢复 | 2 个运行，新运行 delta-v1；恢复 10 条消息，不重放副作用 |

真实模型请求仅含合成测试内容，没有发送用户历史。文件变更验收目录为 `/private/tmp/mentat-acceptance-Koxa2j`，没有在用户笔记内测试写入/移动。

自动化日志：`/tmp/mentat-release-tests.log`、`/tmp/mentat-release-build.log`、`/tmp/mentat-release-lint.log`、`/tmp/mentat-final-network-tests.log`。结构化证据：`/private/tmp/mentat-completion-provider-evidence.json`、`/private/tmp/mentat-filesystem-evidence.json`、`/private/tmp/mentat-observation-benchmark.json`。

## 查询性能

合成事件查询，不包含磁盘 IO、Controller 快照复制、DOM 或模型耗时；不能代表完整交互延迟。

| 事件数 | 冷查询 ms | 热查询中位 ms | 追加 1 条后查询 ms |
| --- | ---: | ---: | ---: |
| 2K | 6.11 | 0.369 | 0.469 |
| 20K | 19.96 | 0.375 | 0.853 |
| 100K | 62.75 | 0.377 | 3.248 |

## 本地部署

Vault：`/Users/soar/Documents/obsidian`。代码安装在 `.obsidian/plugins/mentat`，历史运行仍兼容读取 `.obsidian/plugins/obsidian-mentat`。

- 首次完整备份（旧版 B1）：`/Users/soar/Documents/obsidian-mentat-modular-backup-20261113-115441`。
- 实机修复前再次备份：`/Users/soar/Documents/obsidian-mentat-modular-backup-20261113-115823`。此目录已包含第一版模块化代码；回退 B1 应使用前一备份。
- 最终 main.js SHA256：`c4aed5e6811e85e82083d1a3c1a18ef235951d5baba6780a02f0ce8680d11e5a`。
- styles.css SHA256：`4830fcc0d910886a067aaa89c95a4b5b02c350aadec3357e66361b693d6f4378`。
- 安装后独立回读 main/styles/manifest 均与 dist 一致；data.json 校验和未改变，DeepSeek high/65536 保留；全部既有 legacy 文件与备份逐字节一致。未自动恢复历史任务。

## Obsidian 实机检查

- 重载插件成功，既有长会话显示，终态为已完成；卡片时间线对齐、分段间隙保留。
- 发现真实宿主冲突：Modal 的 selection 属性覆盖检查器 selection() 方法，造成空白和重复 global:error。改名 observationFilter，并在测试注入宿主同名属性；重新构建、备份、部署、重载后通过。
- 检查器显示 234 条匹配事件；摘要耗时和未闭合计数可见，搜索 model:result 后 24 条；单条详情按需展开。
- 点击“导出当前筛选”生成 `Mentat/Diagnostics/Run_Log_1794542424616.md`。独立回读共 24 条 model:result，不含其他事件类型，健康字段无读写错误/丢弃/损坏行。
- 历史弹窗显示四条运行，三条 completed、一条历史 failed；未点击恢复或重放。
- 草稿测试文本落入独立 drafts.json，未改变 data.json；最终重载后的界面恢复/清理检查待电脑界面连接恢复完成。
- 修复后两个启动实例日志均到达 plugin:ready / initialize:completed，无 warn/error；最后一次启动耗时约 105ms（只表示插件初始化，不代表整个 Obsidian 启动）。
- 第三方 Remotely Save 状态栏出现“同步失败”；本次未改其配置、未排查其服务，不作为 Mentat 初始化错误。

## 保证边界与回滚

- 文件仓库有版本检查、回读、备份和宿主支持的 rename；不承诺 fsync、跨设备或跨进程事务。备份不是合并工具。
- 同进程扩展/命令执行是可信宿主能力，不是 JS 或 OS 沙箱。MCP 本地验证 envelope/必填字段；完整 JSON Schema 语义还依赖远端。MCP 连接配置变更仍需重载。
- 首次全局索引/搜索与完整导出仍有线性成本；UI 使用窗口和分页，没有引入全量虚拟列表或数据库。
- 旧版不能理解新的 session_projection 游标和 delta-v1。若新版已经产生新运行，回滚前必须先物化最新会话/运行的旧格式副本并核对，不能直接覆盖新数据；直接恢复旧备份会丢失备份后的新活动。当前部署验证没有创建新用户运行。
