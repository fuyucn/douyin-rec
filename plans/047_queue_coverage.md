# 047 队列系统全景与覆盖矩阵（现状快照 v2）

> **快照口径**：代码基线 `origin/main` @ `0.0.310`（本文对应的评审分支另含本文件）；生产观测 **2026-11-06**（UTC+8）。
> **术语**：本文的「runner」指**每个节点 serve 进程内的 ProcRunner**（`@drec/proc-queue`），不是物理 worker/节点；
> 「节点」= 一台跑 `task serve` 的机器，「worker」= hub 配置里的录制节点 id。
> **三列定义**：**已合并** = 代码在 main；**默认启用** = 不开开关就生效；**生产接通** = 现场配置/调用链真的在跑。
>
> 前置：plan 036（proc-queue/处理器）、plan 038（节点上传队列）、plan 039（0 落盘直传）、plan 046（按分 P 任务链，已全部合并）。
> 隐私：不写房间号、主播名、BV、主机名。
>
> v2 说明：v1 有六处事实错误（分层禁令、`assertSidecarPath` 适用 kind、既有 `onPartConfirmed`、直传对账、整场 cleanup、
> rolling 前提条件），由独立设计评审指出后逐条对照源码修正。

## 1. 三个执行主体

| 执行主体 | 位置 | 做什么 | 边界 |
|---|---|---|---|
| **节点 proc-queue** | `<root>/db/proc-queue.db`（**每节点一份**） | 认领/执行/重试/对账/清理**文件型**任务 | 单节点内的租约接管；不是跨物理节点的分布式消费（`store.ts:713`） |
| **master 台账** | `sync_jobs`（`douyin-rec-sync.db`） | 选优 → pull → merge → burn → upload → 清理 | 自己执行，不代节点执行 |
| **录制进程内** | `live-pump`（录制子进程） | 0 落盘流式上传（块与 ffmpeg 并行） | 当前连接的上传不可转移；**已封口 P 的整文件回退可独立于连接**（`live-pump.ts:2162`、`live-pump.ts:3529`） |

### 两条约束的准确表述（v1 在此写错，已修正）

1. **进程绑定**只适用于**当前在线 stdout 流**——块来自 ffmpeg 管道，进程一死块就断。已封口的分 P 有独立 signal，可整文件重传。
   → 因此「线上传不入队」是**现状与合理取舍**，不是「所有未来架构都不可能」。
2. **层分方向**：`@drec/zero-upload` = L0.35，`@drec/proc-queue` = L0.3（`test/arch/layering.test.ts:31,34`）；
   守卫规则是 `depRank >= myRank` 才算违规（`:90`），故 **0.35 → 0.3 的依赖在层级上是合法的**。
   当前 `packages/zero-upload/package.json:10` 只依赖 `core` + `post-process`，这是**当前依赖集合**，不是禁令。
   → 选择「回调由 app 层注入」是**解耦取舍**（避免录制核心包反向依赖队列），不是「只能如此」。

## 2. 覆盖矩阵（含前提与源码锚点）

| | **边录边传**（rolling） | **直播直传**（0 落盘 + spool） | **整场上传** |
|---|---|---|---|
| 前提 | 需 `rollingQueueMode=on` **且** `uploadOwner=node` | 任务 `streamUpload=true`（spool 默认开，`#537` 后恒开） | 需 `nodeUpload.mode=queue`；其中 `partChain=true` 且节点广播该能力时才走**分 P 链** |
| 数据源 | 分段文件（`segmentSec` 封口） | ffmpeg stdout（按字节/时间切 P） | 收播后的文件集合 |
| 上传时机 | 段封口**后** | **边写边传**（块与 ffmpeg 并行） | 收播 + settle 后 |
| 上传入队 | ✅ `upload-part`（`rolling-queue.ts:142`） | ❌ 不入队（现状，进程绑定） | ⚠️ 条件能力：`nodeUpload.mode` 默认 `blocking`（`node-upload-config.ts:27`），`partChain` 默认 `false` |
| 成功判据 | 明确信号（建稿 bv / append 无歧义 ack）+ `fp` 一致 + 字节证据（**证据 unknown 时仍可 confirmed**，`upload-part.ts:130`、`plans/046:165`） | `complete` 成功拿 stem → 建稿/append ack → confirmation 持久化 → 才 `cleanupConfirmed`（`live-pump.ts:2151,996,1026`） | biliup 建稿/append ack |
| 不确定态对账 | ⚠️ 出边已落地，但 **`startReconciliation` 无生产调用方**（`upload-part.ts:16,235`），现状仍落 `uncertain` | ⚠️ **无 proc-queue reconciling**，但有**进程内 WAL 对账**：`pending` + `recover` 按 title 查建稿、按 stem 查 append，歧义保留 pending（`live-pump.ts:336,839,925`） | `needs_manual`（master 台账） |
| 清理 | ✅ `cleanup-part`（**仅当 `uploadOwner=node` 且非 skip**；`hubOwned` 只写 `skipped(hub-owned)` 保留源，空/碎片段也写 skip，`rolling-upload.ts:938,1040,1055`） | ❌ **未队列化**：`live-pump` 自己在确认后 `rmSync(spoolPath)`（`live-pump.ts:1173`） | ❌ **不用 `cleanup-part`**：`whole-order` 明确不链 cleanup（`runner.ts:687`），由 master `cleanupSourcesShared` / `transport.cleanup` 清理（`pipeline.ts:454,525`） |
| 可交接 | ✅ 同节点内多 runner/进程租约接管 | ❌ 绑定录制进程 | ✅（节点侧） |

图例：✅ 已合并且按前提生效；⚠️ 部分/未接线；❌ 不入队或不在该路径。

## 3. 已合并能力（三列）

| 能力 | 已合并 | 默认启用 | 生产启用状态 |
|---|---|---|---|
| 每节点持久队列（租约/fencing/保序/notBefore/场间游标/原子批量） | ✅ 036+038 | 是 | 是（serve 启动即持有租约） |
| `upload-part`（单 P 上传 + 确认后同事务链出 cleanup） | ✅ 046 PR1/PR5 | 否 | **未核验**：需 `rollingQueueMode=on` **或** `nodeUpload.mode=queue && partChain`（两条生产来源，`rolling-queue.ts:54`、`node-upload-queue.ts:144`） |
| `cleanup-part`（唯一队列删除者 + 架构守护） | ✅ PR2 #515 | 否（无行则空转） | 条件生效（仅作为 upload-part 的下一环；2026-11-06 手动开 rolling 测试时观测到 `done` 行） |
| `reconcile-part`（对账，**影子模式**） | ✅ PR3 #516 | 否 | **未核验**：代码路径上缺 `startReconciliation` 调用方且 `reconcileQuery` 生产未注入；未抽样确认现场是否曾有该 kind 执行 |
| 重试策略统一（去 3 次即停/确定性即停/告警去重） | ✅ PR4 #514 | 是 | 直接生效（无开关） |
| 对账解析器适配真实 `biliup list` | ✅ PR0 #513 | 是 | 是（默认 `trustNo=false`，保守） |
| 边录边传只入队模式 | ✅ PR6 #529 | **否**（代码缺省 off，`rolling-queue.ts:54`） | **未核验**：源码只能证明缺省 off；现场是否曾开启未抽样（本次测试期为手动开启、现已回 off） |
| hub 托管写 `skipped(hub-owned)` + `uploadOwner` 单点 | ✅ PR7 #520 | 是 | 是 |
| 前端队列页（链式/状态徽标） | ✅ PR8 #523 | 是 | 是（但**只显示最后一条 part receipt**，`queue-chain.ts:8`） |
| `upload-part` 字节采样误判修复 | ✅ #533 | 是 | **条件生效**：仅在 `upload-part` 执行路径内生效（`upload-part.ts:130,141`）；2026-11-06 手动开 rolling 测试时观测到上传 `done`，默认 off 下无执行样本 |
| 禁 `streamUploadSpool=false` | ⏳ #537 | — | — |
| 统一「P 确认」口径 + spool 清理队列化 | ⏳ #538 | — | — |

## 4. 不变量（区分「目标」与「现状」）

**目标（设计意图，尚未全局成立）**
1. 同一场上传只有一个执行者（`uploadOwner` 单点 + `orderKey/generation/seq` 保序 + `tryRollingShortCircuit` 的 `queueOrderKey` hold，`pipeline.ts:735`）。
2. 删除只由「明确成功信号 + 可核对证据」触发。
3. 队列内**只有** `cleanup-part` 删源（`cleanup-part.ts:86` 走 `assertJobInvariants`）。

**现状（今天实际不成立的）**
- 「删除只经 `cleanup-part`」**不是全局事实**：master `rmStage`/`transport.cleanup`（`pipeline.ts:314,525`）、`live-pump`（`live-pump.ts:1180`）、legacy rolling 各自清理。
  → 这是**队列的局部规则**，不是全仓不变量。
- `.xml`/`.ass` 的「不得删最后一份」由 `xmlKeepRule` 在 master 侧执行，队列侧由 `assertJobInvariants` 拒绝非视频扩展名。

**已被批准、必须保持的语义**
- 字节证据 `unknown` ≠ 上传失败：`unknown + 明确成功 + fp 一致` 仍 **confirmed 并删源**（`plans/046:169`、`upload-part.ts:141`、`runner.ts:692`）。
- 降级必须显式（日志 `byte check unavailable`）。

## 5. 缺口

### G4（先做）master 看不到节点散任务的 proc-job 级状态
- 现状：`/queue` 只渲染 hub 台账（`sync_jobs`）；页面已轮询 tasks/worker status 并显示直传 lane（`QueuePage.tsx:651,802`、`queue-live.ts:30`），
  但**没有 proc-job 级列表**（`upload-part`/`cleanup-part` 行）。节点上的散任务在 master 端不可观察。
- **现有接口做不到行级枚举**（这是本缺口的关键）：
  节点 `_proc-status` 只接受**已知 jobIds** 并逐个 `get`（`app/src/node-enqueue.ts:215,227`）；
  `/api/proc/active` 只返回按 kind 聚合的 `running/pending/leaseAlive`（`app/src/web/api/proc.ts:4,24`）。
  两者**都无法凭空发现 master 不知道的节点散任务**。
- 因此分两步：
  1. **第一步（只读、可行）**：只做**聚合计数**（在队列页显示各节点的 upload-part/cleanup-part 运行/待办数），用于量化风险发生率；
  2. **第二步（需新接口）**：行级列表必须新增节点侧的**只读分页枚举接口**（如 `_proc-list <root> --kind --state --limit --cursor`，不出 cookies、不派发）
     或由节点事件索引提供；否则 `jobIds` 无处可来。

### G3（次之）`reconciling` 未闭环
- 现状：入边 `startReconciliation` 与出边 `settleReconciling` 已落地（`store.ts:785`），但**无生产调用方**（`upload-part.ts:235` 仍返回 `uncertain`），
  `reconcileQuery` 生产未注入，runner 默认影子。
- 不只是「补一个调用」：`settleReconciling(yes)` 现在只改 `done`，**不原子链 cleanup、不补 BV 到 rolling sidecar**（`store.ts:811`、`runner.ts:451,187`）。
- 顺序：先影子实测（统计 `uncertain` 行数/阻塞时长），再开写入方。

### G1（再次）直传 spool 清理未队列化
- 现状：`live-pump` 自己删（`live-pump.ts:1173`）。**这不是事故**——确认落盘后再删，数据安全。
- **v1 的理由是错的**：`assertSidecarPath` 只在 `kind ∈ {upload, reconcile}` 时调用（`processor.ts:401-403`），
  `cleanup-part` 走 `assertJobInvariants` 但**不校验 sidecarPath**。所以「sidecar 命名冲突」不构成障碍。
- **真实障碍**：`cleanup-part` 要求单视频输入、`bv` 非空、`fp` 与 `ctx.file` 匹配（`cleanup-part.ts:54`）；
  直传的确认证据（stem + confirmation）需要**可信地映射**为该契约，不能让调用方自称 confirmed。
- **删除授权远不止 `spoolPath ∈ state.parts`**：`parts` 含未确认 P（`live-pump.ts:795`）；活跃 P 在 open 时创建、seal 才入 parts（`live-pump.ts:3523,3297`）；
  state 只做浅 schema 校验（`:371`）。至少还需：canonical statePath 派生 + room/session 匹配 + 精确 confirmed 且已持久化 + 非 pending 引用 +
  受限根 realpath + `fp` 防路径复用 + 执行前重验与租约 fencing。任何未知 → 保留文件。
- **既有 `onPartConfirmed` 不能直接复用**：它已存在且是 **display-only**（载荷 `{count, bvid?}`，抛错被吞，CLI 已用于进度，`live-pump.ts:2503,3146`）。
  要做交付，必须新增**持久交付接口**，或明确兼容扩展，不能把 observer 变成不可丢投递。
- **磁盘上限不是「多占 1 个 P」**：runner 掉线/清理失败可累积任意多个，必须有 backlog 与磁盘水位告警；本地兜底删除也要走同一校验与幂等。
- **孤儿与活写者要分开授权**：现有 `sweepOrphanSpools` 只凭名字 + mtime>10 分钟 + keep-set（`live-pump-spool.ts:24,40`），**无 active-writer 锁**。
  补偿扫描（state 已 confirmed 但队列无行）与孤儿清扫必须是两套明确授权，并额外保留 active spool / PID / 租约保护。

### G2（最后）确认口径的形式整合
- rolling 有 `bv/ack + fp + 字节证据(known/unknown)`；直传有 `complete→stem→ack→confirmation`。
- **不要统一执行路径**：可在 core 放纯 evidence/result 类型，两个 adapter 从各自既有权威结果**映射**，清理消费该确认结果。
- **三态必须区分「某项证据 unknown」与「整体 unknown」**：rolling 的 `byteEvidence=unknown + ack + fp` 仍是 confirmed；若新函数把任一 unknown 升级为 overall unknown，会悄悄改变删源/重试行为。

### G5（低）重试状态持久化与账号暂停接线
- 退避/告警去重只在 runner 内存（重启后从头计时，行仍 pending 不丢）；`pauseUploadAccount` 生产未接线。台账 T-156。

### G6（低）`streamUploadSpool=false` 存量
- 已确认：三节点 35 个 0 落盘任务全部 `true`，无在用 `false` → #537 为零迁移。

## 6. 建议顺序与理由

**G4 → G3 → G1 → G2**（G1 的误删防护可与 G4 并行设计）

- G1 当前已有安全路径（确认落盘后才删），**没有被证明的事故**；
- G3 是**真实人工成本**：`uncertain` 行会阻塞同场后续 seq（`store.ts:722`）；
- 没有 G4，就无法量化 G1/G3 的实际发生率（`uncertain` 行数、阻塞时长、spool 清理失败/积压字节、低水位次数）。
- 优先级应由这些指标调整，**不由「任务开关占比」单独决定**。

## 7. 生产数据（口径说明，不能过度推导）

采集：`GET /api/tasks`（master 与各节点 serve），字段 `streamUpload` / `streamUploadSpool` / `rollingEffective` / `managedBy` / `recording`。

| 节点 | 任务数 | `streamUpload` | 其中 spool 开 | `rollingEffective` | hub 受管 |
|---|---|---|---|---|---|
| master | 28 | 18 | 18 | 25 | — |
| worker-1 | 11 | 6 | 6 | 10 | 10 |
| worker-2 | 17 | 11 | 11 | 16 | 16 |

**口径限制（重要）**：
1. master 与各节点有**同步副本**，三行相加 ≠ 独立业务对象数；
2. `streamUpload` 与 `rollingEffective` **不是互斥列**（CLI 只在传 flag 时互斥，`cli.ts:322`），相加不能当出处总数；
3. 因此本文只能得出：**master 的配置记录里 `streamUpload` 占多数**（18/28 ≈ 64%），
   **不能**推出「录制时长/流量占多数」「plan 046 只覆盖少数任务」（后者还要扣除 `rollingQueueMode=off`、`hubOwned`、`skipped`）。
4. **#533 的适用范围**：它的字节判据只在 `upload-part`，不在 `live-pump` 上传路径；这**不等于** spool 无其他确认风险
   （直传有自己的 WAL/pending 恢复与「create 查不到即清 pending 可重试」语义，与 proc-queue 的 settle 窗口不同）。

要得到可信影响面，需按 `节点 × 执行模式 × uploadOwner × rollingQueueMode × nodeUpload.mode/partChain × enabled/active` 的去重交叉表。

## 8. plan 046 交付边界（避免「全部合并 = 模板全实现」的误读）

plan 046 §4.2 的模板表承诺了三件事，**实际交付状态不同**：

| 模板承诺 | 实际 |
|---|---|
| 0 落盘「确认后清 spool」入队 | ❌ 未交付（G1），`live-pump` 自己删 |
| 边录边传「封口入队 → 确认 → 删该段」 | ✅ 交付，但**默认关**且 hub 托管时只写 skip |
| 整场「最后一个 P 确认后 cleanup」 | ❌ 未交付（`whole-order` 明确不链 cleanup，`runner.ts:687`），由 master 清理 |
| 崩溃接管（孤儿扫描补入队） | ❌ 未交付（`plans/046 §5.5` 仍为 TODO） |
| `reconciling` 自动对账 | ⚠️ 出边已落地，入边无生产调用方（G3） |

## 9. 请 reviewer 判断的三个问题

1. **G1 的删除授权清单是否足够**（§5 列出 7 条前置）？是否还有遗漏的「活跃 writer / 路径复用 / 跨会话」风险？
2. **G2 的「只映射、不合并」是否会被写成第二套判定**？三态里「某项 unknown ≠ 整体 unknown」的边界是否表达清楚？
3. **G4 → G3 → G1 的顺序**：在「没有 G4 就无法量化风险」的前提下，这个排序是否合理？有没有更快的量化手段（例如只加只读计数、不改 UI）？
