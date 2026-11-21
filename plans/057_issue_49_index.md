# 057 — issue #49 当前实现与剩余验收索引

> 台账：**T-242**（[TODO.md](../TODO.md)）；上游：[#49](https://github.com/fuyucn/douyin-rec/issues/49)。
> 基线：`673ce733`，2026-11-21 对照源码、测试文件与 #49 全部评论；关联票 #44/#45/#57/#202/#207 当前均 OPEN。
> **这是索引，不是第二份总计划，也不授权上传、删源、保留规则或部署。** 用户接受的第一步仅为逐项对账与无运行时变化的 P0 轨迹测试。
> “已交付”表示当前树有对应实现与测试，不表示本轮跑过测试、完成线上验收或可以关闭 #49。

## 1. 既有计划的职责（不再平行排期）

| 文档 | 继续负责 | 本索引的校准 |
|---|---|---|
| [032 包拆分](032_package-split.md) | 会话命名、录制/处理边界、rolling 判定与元数据下发 | S1/S3/S4 已交付；旧 `uploader` 包草图由 049 的契约/包接替；组装层已迁入 `hub-compose`，不等于执行体已搬迁 |
| [034 交付模型](034_delivery_model.md) | intent → confirm → releaseSource、DeliveryPlan、单机/fleet 与旧节点兼容 | 仍是设计参考；不存在覆盖所有路径的统一 Delivery / `_release-source`，不能把局部收口等同整体完成 |
| [049 上传目标契约](049_upload_target_contract.md) | UploadTarget、upload-runtime、bilibili-upload、驱动与 checkpoint | 以 §8 后续落地记录及源码为准，开头“草案/未接入”与旧表不是当前交付状态；**issue #49 ≠ plan 049** |
| [051 步骤注册表](051_pipeline_step_registry.md) + [评审修订](051_review_2026-11-18.md) | P0 轨迹 → P1 数据 → P2 merge/node 执行器 → P3 分段模型 → P4 上传 port | 以评审修订顺序为准；本轮不搬执行器、不生成 hub-flow、不把分段循环强塞进单张 DAG |
| [052 剩余架构工作](052_architecture_audit_remaining.md) | 上传轴、注册表、协议、配置治理的依赖与风险门 | 复用 §3 的 P0 前置；文中历史部署/阻塞记录不能证明当前节点状态，本轮不探生产 |

## 2. U0–U12 对账

下表源码/测试路径均相对仓库根。测试列是**证据入口**，不是本轮执行结果。

| 项 | 当前实现 / 判定 | 测试入口 | 替代票 / 既有归属 | 剩余验收（不能据此勾掉整张票） |
|---|---|---|---|---|
| **U0 rolling × 烧录守卫** | **现行策略已交付**：`packages/core/src/rolling-policy.ts` 的 `resolveRollingPolicy` 统一起录判定；`packages/orchestrator/src/pipeline.ts` 的 `tryRollingShortCircuit` 处理意图/不确定/残段/多稿。已起录场按起录配置收口，规则后来开烧录只告警“下一场生效” | `packages/core/src/rolling-policy.test.ts`；`test/orchestrator/rolling-guard.test.ts`、`rolling-shortcircuit.test.ts` | #40/#42/#48；032 S3/S4；异常恢复仍归 #57 | 当前行为**不是**早期评论“开烧录就转人工”。保留这项语义差异，不在索引中改回；同步失败/手动启动/旧 sidecar 的跨节点实跑证据不由纯函数测试代替 |
| **U1 会话基名** | **已交付**：`packages/core/src/session-name.ts`；manager/扫描等消费公共命名函数 | `packages/core/src/session-name.test.ts`；`test/arch/session-name-guard.test.ts`；`test/recorder/session-base-percent.test.ts` | #50/#54；032 S1 | 本轮不重做命名抽象；后续改动仍须保留旧后缀/百分号兼容与守护测试 |
| **U2 清理规划** | **部分交付**：`packages/core/src/survivors.ts` 的 `survivingArtifacts` 为留存口径；`pipeline.ts` 的 `cleanupSourcesShared` / `xmlKeepRule` 共享清理，并记录失败供补跑。它是留存清单，不是全系统统一删除命令规划器 | `packages/orchestrator/src/survivors-cleanup.test.ts`、`cleanup-backfill.test.ts`、`cleanup-visibility.test.ts`；`packages/orchestrator/src/pipeline.test.ts` | 034 S3/S4；#429 清理失败补跑；051 清理后置副作用约束 | 尚缺贯穿录制侧/队列/节点/master 的统一可预览删除计划与逐点证据；不允许清理失败把成功上传改 failed。删除入口变更须另行批准 |
| **U3 统一核验与收口** | **未整体完成**：merge/segments/续跑复用 `pipeline.ts` 的 `finalizeAfterUpload`，延后回读通过才 commit done/删源。`node-side-upload.ts` 的 blocking 成功路径仍单独 `markDone` + 共享清理，因无 `sync_parts` 基线跳过回读；rolling 短路的回读是 done 后旁路，不是同一道前置闸门 | `packages/orchestrator/src/finalize-verify.test.ts`、`verify.test.ts`；`test/orchestrator/node-side-upload.test.ts`、`rolling-shortcircuit.test.ts`；本轮 P0 | 034 S1–S4；#27/#59/#327 历史核验工作；节点队列归 #207 | 节点只上传不删源的版本闸、各路径确认语义、分 P 数/时长核对及旧节点兼容尚不能用“共享 cleanup”证明。P0 固定现状，不新增核验也不改删除策略 |
| **U4 上传包 / 上传运行记录** | **包已交付，观测未完成**：`packages/upload-runtime`、`packages/bilibili-upload` 及 core `upload-target.ts` / `upload-call.ts` 已承接目标契约；不能再建 032 草图中的平行 `uploader`。现有队列行/直播进度不等于每次 biliup 运行记录 | `packages/core/src/upload-target.test.ts`、`upload-call.test.ts`；`packages/upload-runtime/src/driver.test.ts`；`test/upload/biliup.test.ts`、`upos-target.test.ts`；`test/arch/upload-single-path.test.ts` | 049 §8（#629–#638 等落地记录）；**#44 / T-79 / plans/039** 接运行观测 | #44 仍需每次调用的节点/分P/线路/PID/字节/最后进展/结果与旧节点降级；target 接线不等于所有路径已使用同一 driver |
| **U5 分P契约 / BV / 超时** | **部分交付**：master 分P checkpoint、`packages/app/src/node-pipeline.ts` 的即时 BV/意图落盘、队列保序/恢复已存在。`node-side-upload.ts` blocking 预算按全部 winnerMembers 字节求和，但仍有总时长上限；队列另走进度停滞语义 | `test/app/node-pipeline.test.ts`；`test/orchestrator/node-side-upload.test.ts`、`node-upload-dispatch.test.ts`、`node-upload-poll.test.ts`；`test/proc-queue/upload-part-chain.test.ts`；`test/upload/biliup-append.test.ts` | **#202（PR0 预算止血）/#207（队列主体），T-62，plans/038**；049 checkpoint；#25/#66 历史关联 | 不能把 blocking 字节预算写成“已全改为字节停滞”。即时 BV、保序、重启不重复、逐 P 关水印与延迟回读需按实际启用路径逐项验收；#202/#207 仍 OPEN，旧合并记录不是本轮实跑 |
| **U6 重试 / 降级 / 孤立接管** | **部分交付**：`packages/app/src/rolling-upload.ts` 有意图恢复/确认/接管，`packages/upload-runtime/src/driver.ts` 区分可重试与不确定；节点队列有持久状态。尚不能称所有路径统一生命周期 | `packages/app/src/rolling-upload.test.ts`；`packages/upload-runtime/src/driver.test.ts`；`test/e2e/rolling.test.ts`、`upload-retry.test.ts`；`test/orchestrator/node-upload-status.test.ts` | **#45（节点中断降级）/#57（rolling 韧性）**，#46/T-89；#207 队列恢复；034、049 | 完整“重试 → 可见待补传 → 收播补传/master 回落 → 人工”的跨路径矩阵、无后继会话的孤儿接管、水位拒开录与状态白名单仍需验收；ambiguous 绝不自动重建/重追加。某条恢复单测存在不能关闭 #45/#57 |
| **U7 处理计划判定器** | **仍缺完整模型**：已有 `resolveRollingPolicy`、core `node-side-upload-policy.ts`、`effectiveStageFormat` 等局部权威；尚无覆盖位置/形态/时机/产物/分P/清理/原因的 `resolveProcessingPlan` | `packages/core/src/rolling-policy.test.ts`；`test/orchestrator/output-format-pipeline.test.ts`；`test/hub-flow-build.test.ts` | 032 S3 已完成局部；034 DeliveryPlan；051/052 后续 | 扩展既有判定而非造第二套。先列单机/fleet、旧任务迁移、stage/rolling/burn 约束表，再单独决定完整计划契约；不能从 UI 展示拓扑推导执行策略 |
| **U8 master 下发元数据** | **部分路径有，rolling 仍缺统一下发**：`node-side-upload.ts` 给 spec 传 `uploadMeta`、`earliest.sessionBase/title/startMs`；零落盘有 core `zero-disk-delivery.ts`。但 `packages/app/src/rolling-upload.ts` 的 `resolveRollingUploadMeta` 仍读节点本地规则/配置 | `test/orchestrator/node-side-upload.test.ts`；`packages/core/src/zero-disk-delivery.test.ts`；`packages/app/src/rolling-upload.test.ts` 的 metadata 用例；`test/app/rolling-drift.test.ts` | 032 S9；034 S5；#57 远端 rolling 前置 | master 快照、私密凭证文件、能力门控、旧 bundle/单机回落仍需逐条对拍；节点侧 spec 正确不代表远端 rolling 不会用默认元数据 |
| **U9 执行体搬迁去重** | **未完成；组装层已交付**：`packages/hub-compose/src/hub-starter.ts` 等接走 CLI 装配（T-201–T-207），但 workflow/segment/node-pipeline/rolling 仍各有执行循环 | `test/app/hub-task-sync.test.ts`；`packages/orchestrator/src/pipeline.test.ts`、`segment-pipeline.test.ts`；`test/app/node-pipeline.test.ts`；本轮 P0 | 032 S2/S6/S7；034 S6；**051 P0–P4、052 C** | P0 先冻结行为；P1 只提数据；P2 再接 merge/node；P3 先定分段循环模型；P4 上传 port 单独审查。app 不能反向依赖 orchestrator，不新建影子 PipelineDeps |
| **U10 配置 / 实验性注册表** | **实验展示已交付，行为配置未统一**：`packages/core/src/experimental.ts` 是纯元数据，驱动 `packages/web/src/components/ExperimentalBadge.tsx`；按 #43 修订不另开实验分区，**不参与行为判定** | `packages/core/src/experimental.test.ts`；`packages/core/src/rolling-policy.test.ts` | #43 替代旧“实验分区”；032/034 配置收口；052 F 配置治理 | 不把展示注册表当 rollout/回滚闸门；跨 settings/规则/任务/env 的配置来源收口与旧节点默认值仍需单独设计，不借本轮增加配置框架 |
| **U11 上传视图前端** | **仍归专票**：`packages/web/src/pages/QueuePage.tsx` 已显示队列/资源/直播交付；`packages/core/src/api-types.ts` 的 `RollingDeliveryDTO` 与 `packages/hub-compose/src/hub-runtime.ts` 有快照，但不是 #44 的逐节点 biliup 运行历史与速率视图 | `test/web/live-upload-contract.test.ts`；`test/hub-flow-build.test.ts`；#44/039 要求的进度/卡住/旧节点测试仍待完整交付 | **#44 / T-79 / plans/039**；034 F1 只是已有基础 | 百分比/吞吐/ETA/换线/最近结果、非 Linux 与读数失败降级、旧节点“未上报”及 Web 手动核对仍缺，不能把 delivering 行当 #44 完成 |
| **U12 保留期与回收** | **仍缺统一保留期**：`packages/app/src/orphan-cleanup.ts` 有扫描/默认 dryRun/审计；`pipeline.ts` 有安全移除空 stage 目录；proc-queue GC 是任务行保留，不是源/待补传产物的保留策略 | `test/app/orphan-cleanup.test.ts`；`packages/orchestrator/src/pipeline.test.ts` 的 `removeEmptyStageDir`；`test/processors/cleanup-part.test.ts` | #45/#57 的待补传保留；034 S4；派生 xml 回收归 **#84 / T-80 / plans/040**，不另造方案 | 首版只预览；必须区分源/中间产物/派生 xml/会话总 xml/日志，未知或未确认不得删、最后一份弹幕不得删。超期告警与人工确认边界须另行批准；清空目录修复不是保留期验收 |

### 评论增加的 U-1（验证前置）

`test/e2e/harness/`、`test/e2e/rolling.test.ts`、`segments.test.ts`、`upload-retry.test.ts` 已有假上传/故障脚手架。
**存在脚手架不等于所有 U 项场景通过**；更不替代 #49 评论要求的危险步骤隔离 dev 证据、逐步回滚/观察指标及稳定观察期。
本轮不跑真实录制、上传或部署，不引用历史别的产物验收冒充当前 HEAD 证据。

## 3. 本轮 P0：可复用的现状轨迹，不是统一模型验收

落点：`packages/orchestrator/src/pipeline.test.ts` 的 `runPipeline P0 execution trace (#49)`。
为复用现成 `makeDeps` / `makeRec` / `makeBroadcast` / `writePlainArtifacts` / `fakeUploadTarget`，测试留在原文件，
**不新建平行测试依赖，也不改 helper 的既有语义**。node-side 使用现有 node-side 测试同类的能力/结果注入口。

| fixture | 固定内容 | 刻意保留的差异 |
|---|---|---|
| merge（upload、无烧录） | select → pull → merge → upload_plain → clean_verify → clean_source → clean_stage_src；1 个分P；完整 state/通知/detail | job 事件没有独立 uploading；禁用 burn/append 仅落节点表 skipped，不伪造 logStep |
| segments（upload、2 段、无烧录） | select → pull → merge(remux 两段) → upload_plain(P1 + append) → clean_verify → clean_source → clean_stage_src；2 个分P | 有 uploading 事件；scratch 清理包括 `.work`；不按展示 DAG 改写分段时序 |
| node-side（blocking、无烧录） | select → node_upload → clean_source；节点成功结果；无 pull/sh/master 上传 | 不存在 burn/append 行；无分P基线、无 clean_verify；当前不发 uploadDone，不在测试中“补齐”理想行为 |
| 边车扫描后消失 | select start/done → pull **skipped**，保留精确 detail 前缀/次数；job 保持 pending | 不把 skipped 误当完成，不开始 pull/merge/上传/清理，也不造节点状态 |

- 直接断言台账 `getSteps` 的有序 `(step, phase, detail)`、`getEvents` 的状态序列、全部最终节点状态（含 skipped）及完整通知。
- 仅剥除时间戳/固定 streamKey；仅节点状态集合排序，**步骤与事件不排序、不去重、不丢 detail**。冻结 `Date.now` 保证节点耗时稳定，不用 fake timer 改变调度。
- remux/探测/上传/删除全部注入假依赖；只写临时夹具文件。没有 ffmpeg、SSH、网络上传或生产目录操作。
- `hub-flow.ts` 是展示拓扑（含无条件展示边），执行真相仍是 `buildWorkflow` 的条件边；不能用 `HUB_FLOW_ORDER` 强行串行化并行轨迹。

### PipelineDeps 依赖边界清单（051 P0 盘点，不新增 port）

| 字段 | 当前提供者 / 可空性 | 后续边界 |
|---|---|---|
| `transports`, `ledger`, `cfg` | 组合根/调用方必传 | orchestrator 拥有 Transport/SyncLedger；低层执行器不得 import 它们的具体类型 |
| `sh`, `upload`, `notify` | 组合根必传；P0 用原 fixture 的假 shell/target/通知 | 执行动作/上传/观测分开注入；target ≠ driver |
| `pool` | 可缺省，runPipeline 内建池 | 资源 port；不把资源策略复制进测试 |
| `nodeUpload` | 可缺省；缺省为 blocking | 队列能力/选路适配仍归 orchestrator |
| `splitForUpload`, `remuxSegment`, `segmentDuration`, `burnSegment`, `mergeSegments` | 可选；默认 post-process 实现 | 媒体动作接缝；P0 覆盖会调用的动作，避免真实进程 |
| `countParts`, `readParts`, `sideCheckDelayMs`, `sleep` | 可选；回读、诊断、时间预算/等待 | 核验策略与时钟接缝；缺基线跳过核验不能被迁移偷偷改变 |
| `rmStage`, `finalizeFormat` | 可选；默认清理 / 未注入则无留存转格式 | 核验后副作用，失败不倒退已确认上传；不可混入统一失败重试 |
| `makeRunLogger`, `stageLayout` | 可选；兼容文件日志 / 旧布局 | 日志与路径适配，不进入纯图数据 |

## 4. 本轮验证与明确未覆盖项

- `git diff --check`：通过。
- `pnpm typecheck`：本 worktree 的共享依赖链接无法解析 `@drec/app`、`@drec/orchestrator`、`@drec/observability`、`qrcode`、`ws` 类型等，**全量类型门未通过**；不改共享 node_modules 或运行时配置来绕过。
- 静态复核修正：实际 `NodeCapabilities.biliup` 是 boolean（不是旧弱类型测试中的路径）；merge 的上传 detail 带 `→` 前缀。TypeScript compiler API 用相同配置分别读取 HEAD 原测试与当前测试：全量诊断 **180 → 180，新增 0**，`pipeline.test.ts` 诊断 **0**；这不等于全量类型门通过。
- 索引相对链接与 U0–U12 完整性静态检查通过；`python3 scripts/issue-guard.py plans/057_issue_49_index.md` 通过。自审后通读最终 diff；未发现其他问题，未执行项仍如下保留。
- **按用户要求未执行 vitest**，因此三路径轨迹只是待主会话运行的显式断言，不宣称已观察到稳定输出或 051 P0 全部退出条件达标。
- 未覆盖：烧录并行交错/条件 append 边、stage 模式、失败/取消/重试/续跑/旧库、队列 node-side 执行体、rolling/live-pump、完整清理组合及临时目录之外的真实节点行为；这些已有测试入口不等于已纳入 P0 trace。尤其不把 blocking node-side 测试冒称 app/node-pipeline 内部执行轨迹。
- 后续 P1 前仍需扩展上述 fixture 矩阵、连续重复对拍并验证变异会失败；本轮只交付用户限定的第一步，不引入运行时行为变化，无需 version bump / bundle。

主会话在全机 vitest 总数不超过 2 时依次执行（本轮未执行）：

```bash
pnpm exec vitest run packages/orchestrator/src/pipeline.test.ts -t 'P0 execution trace' --maxWorkers=1
pnpm exec vitest run packages/orchestrator/src/pipeline.test.ts packages/orchestrator/src/segment-pipeline.test.ts test/orchestrator/node-side-upload.test.ts test/hub-flow-build.test.ts --maxWorkers=1
pnpm test --maxWorkers=1
pnpm typecheck
```

T-242 在回归/类型门补齐前保留进行中；不改变 #49 或任何关联票的状态，不发布评论，不关闭、不 push/merge/部署。
