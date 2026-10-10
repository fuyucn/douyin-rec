# 030 — hub/tasks 协作 + 编排/队列/多节点优化（实施计划）

> **结构化任务的唯一执行源 = `plans/030_tasks.json`**（本文件是它的可读布局；若两者冲突，以 tasks.json 为准）。
> 台账条目：`T-30`。**取代** `plans/029_room_config_and_resilience.md`（T-26 的 P0/P2/C 工作并入本计划，见 §0）。
> 校验：`python3 ~/.agents/skills/plan-loop/tools/validate_plan.py --tasks plans/030_tasks.json` → ok（20 任务 / 8 组件）。

## 0. 与既有计划的关系（避免两份活规范）

| 既有 | 处理 |
|---|---|
| `plans/029` P0-1/P0-2/P0-3（节点韧性） | 并入 T1/T2/T3。**设计已修正**：删除以「节点 store − 期望」为准；快照降级为审计用（快照 ≡ 期望，diff 恒空，不能作删除依据） |
| `plans/029` P2-1/P2-2（统一房间 API/页面） | 并入 T9/T10（+ T18 房间级动作、T20 退役旧入口） |
| `plans/029` C-1/C-2（resources UI + 内存联动） | 并入 T15。**修正**：写「master 实际解析的那份配置」（`--hub-config` 可能覆盖默认路径）并热读即时生效 |
| `plans/026` T-2 自动选点 | 本计划**不做**（保留显式 workers + requires 门控）；T-2 仍待议 |
| `plans/027` T-18 节点侧上传 | 本计划新增 **T19**（节点侧上传共用持久化 601 冷却）作为其前置 |
| `plans/029` §2 D1–D4 | D1/D2/D3 承接执行；**D4（master 内存）仍需你裁决** |

## 1. 目标与完成态

1. master 配置不可读 → 节点任务一条不减（`rejected` 告警）；规则**disabled** = 停用保留，规则**文件消失** = 两阶段删除；合法缩容用 force。
2. 队列页与 hub workflow 由 **SSE 推送**；局域网 1s 内可见；时长每秒本地刷新；慢请求不覆盖新值；断连有过期提示。
3. `reconcileAll` 跨房间并发派发（同房间串行、不重复建稿），后一房间 job 行不再等前一房间上传结束。
4. 上传冷却/窗口**跨 master 重启保留**；节点侧上传共用同一冷却（T19）。
5. 一个 `PUT /api/rooms/:key` 同时改录制与处理，且在**既有 Hub 页**一处配完（T10 弹窗内联录制 + T18 房间级动作）；**不新建页面、不退役旧入口**（完整单页合并 = T20，需求反转，需你确认后立项）。
6. 上传后按**实际提交段数**核验分 P 完整性再删源；清理失败可见、可重试。
7. 短命录制输出递进退避 + 熔断告警。
8. master/worker 的期望版本与 bundle 版本可见、错配可告警；录制状态实时化（不再固定 5s 陈旧）。

## 2. 非目标

- 不引入消息中间件/常连控制通道；不引入 worker claim/lease 队列。
- 不改 `selectWinner` 选优与冗余录制模型；本计划不做自动选点（T-2）。
- 不合并 `tasks` 表与 `config/hub/*.json` 物理存储（029 Phase 3 仍可选）。
- 不触碰 B 站上传硬标准与 `upload-recording-today` skill 的唯一权威。

## 3. 全局约束

行为零变更（除声明处）；向后兼容旧 `config/hub/*.json`、旧 DB、旧 bundle。
验证门：`pnpm test` + `pnpm typecheck` + `pnpm bundle`；动前端加 `cd packages/web && pnpm build`；动架构跑 `gen-architecture.mjs`。
提交：`feat|fix|chore(scope): 中文`；`feat|fix` bump version；TODO/计划文件与代码分开提交。部署前两节点 `recording===true` 为 0。

## 4. 组件

| id | 名称 | 说明 |
|---|---|---|
| c1 | control-plane-safety | 审计快照 / 骤减守卫+force / 禁用与删除分离 |
| c2 | realtime-state | HubWatch + SSE + 前端订阅（替换 3s 轮询、消除竞态） |
| c3 | queue-scheduling | 跨房间非阻塞派发、并行度可配、同房间串行 |
| c4 | durable-upload-limits | 上传冷却/窗口跨重启持久化（master + 节点侧） |
| c5 | room-unification | 一个房间一个入口：`/api/rooms` + `/rooms` 页 + 旧入口退役 |
| c6 | artifact-verification | 上传后按实际段数核验分 P 再删源；清理独立可重试 |
| c7 | cleanup-maintenance | 孤儿/空壳/中间产物可预览可审计清理（守「最后一份」不变式） |
| c8 | recording-health | 有效落盘判健康、短命录制熔断 |

## 5. 任务表（拓扑序）

| id | 标题 | serves | depends_on | est LOC | 阶段 | 状态 |
|---|---|---|---|---|---|---|
| T1 | 节点落盘「上次成功下发」审计快照（managed/rooms.json） | c1 | — | 190 | P0 | 计划中 |
| T2 | 期望骤减安全阀（空期望拒绝 / 骤减只停不删） | c1 | T1 | 210 | P0 | 计划中 |
| T3 | 删除语义收敛：节点 store 减期望（T2 守卫保护）+ 禁用与删除分离 | c1 | T2 | 300 | P0 | 计划中 |
| T4 | hub 状态变更监视 + SSE 端点 /api/hub/stream | c2 | — | 290 | P1 | 计划中 |
| T5 | 队列读取批量化：去 N+1 查询与连接复用 | c2,c3 | — | 200 | P1 | 计划中 |
| T6 | 前端改推送驱动：useHubStream + 去重入 + 过期提示 + 本地计时 | c2 | T4,T5 | 340 | P1 | 计划中 |
| T7 | reconcileAll 非阻塞派发:job 先行创建 + 有界并发(CPU 仍串行) | c3 | — | 320 | P1 | 计划中 |
| T8 | 上传冷却与滑动窗口持久化（跨重启保留） | c4 | T7 | 220 | P1 | 计划中 |
| T9 | 统一房间 API：GET/PUT /api/rooms/:key | c5 | T2 | 320 | P2 | 计划中 |
| T10 | Hub 房间弹窗内联录制配置(复用既有 Hub 页,不新建页) | c5 | T9 | 240 | P2 | 计划中 |
| T11 | 产物完整性核验 + 延迟删源 | c6 | — | 330 | P0 | 计划中 |
| T12 | 清理独立化：可重试、与上传解耦、失败不影响终态 | c6,c7 | T11 | 280 | P0 | 计划中 |
| T13 | 孤儿与中间产物维护清理（可预览、可审计） | c7 | T12 | 240 | P0 | 计划中 |
| T14 | 录制健康：以有效落盘判成功 + 短命录制熔断 | c8 | — | 300 | P0 | 计划中 |
| T15 | 资源池并行度可配置 + 同资源公平轮转 | c3,c8 | T7 | 320 | P1 | 计划中 |
| T16 | 【后置/可选】节点应用回执与版本可见性 | c1,c3 | T1,T2 | 300 | M4 | 后置/可选 |
| T17 | 录制侧状态实时化（任务/节点录制状态不再各自 5s 轮询） | c2,c8 | T4,T6 | 260 | P1 | 计划中 |
| T18 | 房间级动作(加在既有 Hub 房间详情,不新建页) | c5 | T12 | 220 | P2 | 计划中 |
| T19 | 节点侧上传共用持久化 601 冷却（T-18 房间不上传风暴） | c4 | T8 | 300 | P1 | 计划中 |
| T20 | 【需你确认后立项】完整单页合并 + 退役旧入口 | c5 | T18,T10 | 220 | M4 | 待确认 |

### 里程碑(分批发版,避免大爆炸)

| 里程碑 | 名称 | 任务 | 发布门槛 |
|---|---|---|---|
| M1 | P0 止血(首要) | T1, T2, T3, T11, T12, T13, T14 | 节点任务不再被误删;分P不符不删源;清理失败可见可重试;短命录制退避递增。每个任务独立可发布。 |
| M2 | 实时与吞吐 | T4, T5, T6, T7, T8, T15, T19 | 队列/workflow SSE 1s 内同步且无旧值覆盖;后一房间 job 行立即可见;冷却跨重启保留;节点侧共用冷却。 |
| M3 | 房间入口(低风险版) | T9, T10, T18 | 在既有 Hub 页一处配完房间并可执行房间级动作;既有页面行为零变更。 |
| M4 | 可选/需确认 | T16, T20 | T16 运维可见性可按需;T20 是需求反转,需你确认后立项。当前不排期。 |

## 6. 整体验收

- [ ] master `config/hub/` 不可读 → 节点任务一条不减、有 `rejected`；恢复后自动对账。
- [ ] 规则 disabled → 停用保留；规则文件删除 → 两阶段删除；7→0 可用 force。
- [ ] 队列/workflow 由 SSE 驱动：状态 1s 内两处一致；断连有过期提示；无旧值覆盖。
- [ ] 两场同时收播：后一场 job 行立即可见（CPU 型 merge/burn 仍串行，除非 T15 + D4 提高并行度）。
- [ ] 冷却/窗口跨 master 重启保留；节点侧上传共用（或不实现则 TODO + 风险表登记）。
- [ ] `PUT /api/rooms/:key` 一次改两半；`/rooms` 为唯一可写入口。
- [ ] 分 P 数不一致 → 不删源、转人工；unknown → 下轮重验；清理失败不改终态且可重试。
- [ ] 短命录制退避递增、熔断告警。
- [ ] master/worker 版本可见、错配告警；录制状态实时化。
- [ ] 全程 `pnpm test`/`typecheck`/`bundle`/web build 绿；架构图一致；每个 `feat|fix` bump version。

## 7. 风险与缓解

| 风险 | 缓解 |
|---|---|
| SSE 改动面大 | HubWatch/帧格式纯逻辑先单测；SSE 失败前端退避兜底轮询（T6：单连接/隐藏暂停/3s→30s） |
| T7 并发导致同房间重复跑 | dispatcher 仅按**活动** key 去重 + `withStreamLock`；`await drain()` 保留 hub running 守卫 |
| T11 核验误判占满磁盘 | 基线 = 实际提交批次数（分段 + **合并**两条路径都写）；unknown 走可重试而非转人工 |
| T2/T3 协议跨版本 | `DREC_EXPLICIT_DELETE` 默认关；旧 bundle 忽略未知字段；force 显式 |
| T12/T13 误删弹幕源 | 只删「非最后一份」；空壳/孤儿判定可单测；dryRun 预览 |
| T14 误伤正常长直播 | 稳定性 = 时长 + 进度新鲜双条件；正常断流仍快速恢复 |
| 节点侧上传绕过限流 | T19 共用持久化冷却；若缓做则在 TODO + 风险表显式登记 |
| master 内存不足（D4 未决） | 并行度默认保守（cpu=1, pipelines=2）；T15 推荐值仅供参考 |

## 8. 复现证据

```bash
rg -n 'await this._runPipeline' packages/orchestrator/src/reconciler.ts       # 跨房间串行
rg -n 'uploadBlockedUntil|uploadTimes' packages/orchestrator/src/workflow.ts  # 冷却只在内存
rg -n 'desiredKeys.has|removeTask' packages/app/src/task-sync.ts              # 现状删除语义
rg -n 'sourceTaskId' packages/cli/src/cli.ts                                 # desiredFor 跳过 disabled
rg -n 'reconnectFails = 0' packages/manager/src/index.ts                     # 退避被无条件清零
rg -n 'videoOnly' packages/orchestrator/src/pipeline.ts                      # 清理只删视频
rg -n 'if \(!g.ts.length\) continue' packages/orchestrator/src/scan.ts      # 纯 xml 会话不进清单
rg -n 'new DatabaseSync\(syncDbPath' packages/app/src/hub-jobs.ts           # 每请求新连接（N+1）
```

## 9. 执行方式

按 `plans/030_tasks.json` 的 `order` 逐任务执行。先 P0（T1–T3、T11–T14）→ P1（T4–T8、T15–T17、T19）
→ P2（T9–T10、T18、T20）。每任务完成即跑验证门。
