# 036 后处理插件化：Processor 契约 + 每节点持久任务表

状态：设计稿（未实施）。依据：2026-10-15 对代码的实测盘点（下文行号均为当日 `feat/hub-optimization` 基线，含 #141 原子写分P产物）。
与 plan 033（不变量 I1–I12）、plan 034（交付模型）兼容；本文只管「转封装 / 合并 / 烧录 / 上传」这四类
**文件处理**怎么执行，不改选优、聚类、对账语义。台账：本计划被 accept 后由记账会话在 `TODO.md` 记 `T-N`，
本文不改 `TODO.md`。

## Goal

把后处理做成和平台、录制引擎一样的插件：

1. core 定义 `Processor` 契约 + 注册表（与 `Platform`、`registerEngine` 同级）。
2. 一个处理器一个包：`@drec/proc-remux`、`@drec/proc-merge`、`@drec/proc-burn`、`@drec/proc-biliup`。
3. 执行底座 = **每节点一张持久任务表**：文件在哪个节点，任务就在哪个节点执行；按资源类（cpu / net / upload）
   限并发；崩溃后按表续跑，不再扫目录猜。
4. 派发：本机直接写表；master → 远端用新隐藏命令 `_enqueue <dataRoot> <base64>`（与 `_apply-tasks` 同构），不用 webhook。
5. orchestrator 的 pipeline 退化为「派发 + 等回执」。
6. **核心原则：输入文件由派发方显式列出，处理器从不扫目录。** issue #143 的根因就是「哪些文件属于这一场」
   在 5 处各自从目录推导（见 §1.3）。

## 1. 现状

### 1.1 三份转封装实现

| 维度 | 录制封口转换 `app/src/node-remux.ts`（566 行） | 节点侧管线 `app/src/node-pipeline.ts`（890 行） | master 管线 `orchestrator/src/pipeline.ts`（1134 行）+ `segment-pipeline.ts`（803 行） |
|---|---|---|---|
| 入口 | manager 封口钩子 `makeNodeRemuxHookFactory` 357-412 | `_node-pipeline` 隐藏命令 → `runNodeSidePipeline` 594-830 | `runPipeline` 605-635；分段模式 `runSegmentPipeline` |
| 转换调用 | `convertSegmentInPlace` 300-351 | `produceParts` 459-540：`remuxSegment`/`mergeSession` 写 `.work/NNN.mp4` 525-529 | 整场：merge 节点起子进程 `douyin-rec merge --format`（`workflow.ts` 154-157）；分段：逐段 `remuxSegment` 348-390，组合并 `mergeSession` 404-422 |
| 输入从哪来 | 封口事件给的单个分段（显式） | spec 里的 `tsFiles[]`（显式），但会话 xml 靠同目录同名查找 484-491 | 对账聚类得到的 `Broadcast.members`；stage 内产物由 `stageProductPaths` / `deriveSegmentPlan` 从目录推导 |
| 并发 | 每任务一条 promise 串行链 | 每场一个 pid 文件 135-154，**节点无全局上限** | `ResourcePool`（`workflow.ts` 459+）cpu/net/upload + `JobDispatcher` 跨房间上限；**分段模式的 remux/merge/burn 不进 `withCpu`**（只有上传走 `withUpload`），**pull 不进 `withNet`** |
| 校验 | 完整：`verifyRemuxed` 254-295（头部时长、全包 PTS 跨度、包数、音频、ffprobe 告警行数、体积 ≥ 0.5×） | **无**（ffmpeg 退出码即认） | **无**（退出码即认） |
| 磁盘闸 | 有：源大小 + 1 GiB 324-327（`disk-gate.ts` 69-76 用 `bavail*bsize`） | 节点上无；master 派发前 `diskWatermarkGate`（`node-side-upload.ts` 69-85, 348-352） | pull 前**无**；`diskMinGB` 只在对账里告警（`reconciler.ts` 186-210） |
| 崩溃恢复 | 扫目录：`recoverNodeRemux` 436-503（孤儿 tmp 按 pid/2h mtime 判，配对靠 sidecar `nodeFormat`，存疑改名 `.drec-suspect`） | 结果文件 `.drec-node-result.json` 84-108 + pid；已 done 短路 620-625，不确定拒绝重入 642-649 | 台账 `sync_jobs` 状态机 + `sync_node_states` + `sync_parts`；`.work/` 输出已存在即跳过 |
| 删原文件 | 校验通过后 `rmSync` 347 | 收尾自删源 803-807（xml 保留） | `cleanupSourcesShared` 244-317（远端经 ssh `rm -f`） |

**重复**：同一件事（`-c copy` 换容器）有 3 套调用、只有 1 套带校验；上传速率闸有 2 份（core `UploadGate`
被节点与边录边传使用；master 的 `ResourcePool._awaitUploadSlot`（`workflow.ts` 733-767）是同语义的另一份实现，
共用同一个 store 与 key）；并发限额有 3 种口径；崩溃恢复有 3 种风格；删视频源有 4 个入口
（node-remux、节点执行体、master 共享清理、边录边传闸）。

**分歧（会出事故的）**：
- 节点侧与 master 的转换产物不经校验就上传；只有录制封口转换会校验。
- 分段模式 CPU 不受 `maxCpuParallel` 约束；pull 无网络限额、无磁盘闸。
- 空闲空间两种算法：`disk-gate.ts` 69-76（`bavail*bsize`）与 core `freeBytesOf`（`disk-watermark.ts` 20-23，优先 `frsize`）。
- 网页「合成所选」固定产出 mp4（`web/api/merge.ts` 52-54），不跟任务输出格式。

### 1.2 现有持久化/派发构件（可复用）

- 节点能力协商：`_node-capabilities` → `NodeCapabilities`（`core/api-types.ts` 777-786）；旧 bundle 报未知命令时
  `isUnknownCommandError`（`transport-ssh.ts` 95-98）→ 调用方回落（`node-side-upload.ts` 330-335）。
- 远端写入范式：`_apply-tasks <dataRoot> <base64>`（`cli.ts` 1743-1804）解码 JSON → 写本机库 → 打印单行 JSON。
- 持久后台 job：`merge_jobs` 表（`app/src/merge-jobs.ts`，网页合成用）。
- 多进程安全认领：`openUploadLimitStore` 的 `BEGIN IMMEDIATE`（`core/upload-gate.ts` 202-225）。
- 原子写产物（#141）：post-process `artifact.ts` 的 `runFfmpegAtomic` / `withAtomicOutput`（写 `atomicPartPath` 再 rename）、
  `isCompleteMedia` / `unreadableParts`（续跑判定「存在 ≠ 完整」）—— merge/burn/remux 处理器的写出与 recover 直接复用。
- 队列视图：`buildQueueView`（`app/src/hub-jobs.ts` 542-696）+ `ResourcePool.snapshot()`（`workflow.ts` 607-642）；
  节点状态已有 5s 轮询（`cli.ts` 904 汇总 F1 数据）。

### 1.3 #143 的结构根因：5 处从目录推导「这一场有哪些文件」

| 调用点 | 是否认节点侧 mp4/mkv |
|---|---|
| `orchestrator/scan.ts` 189 `groupSessions(…, {nodeFormats})` | 是 |
| `app/web/api/merge.ts` 24、46 | 是 |
| `cli.ts` 424（merge 命令） | **否** |
| `cli.ts` 539（burn 命令） | **否** |
| `session-plan.ts` 67 / 243（`deriveStageProducts` / `deriveSegmentPlan`，pipeline 795/798/996 调用） | stage 内另一套推导 |

另有 `scanRollingSessions`（`scan.ts` 84-110）、`orphan-cleanup.ts` 166-170、`recoverNodeRemux` 445-499、
`node-pipeline.ts` 856/875、`pipeline.ts` 60 `stageVideoLeftovers` 也各自扫目录。#143 的最小修复（stage 拉 sidecar +
合并前未认领分段守卫）**独立先行**，本计划不重复它；本计划让「推导」只发生在派发方一处（对账/选优），处理器只认 job 行里的路径。

## 2. Architecture

### 2.1 契约（core，`core/src/processor.ts`）

```ts
export type ResourceClass = "cpu" | "net" | "upload";

export interface ProcessJob {
  jobId: string;                 // 派发方给定、确定性 → 幂等（重复派发返回现状，不重跑）
  kind: string;                  // "remux" | "merge" | "burn" | "biliup"
  inputs: string[];              // 绝对路径，显式列出；处理器不得扫目录
  outputs?: string[];            // 期望产物（merge/burn 必填）
  params: Record<string, unknown>;
  replaceInputs: boolean;        // true = 校验通过后删除 inputs（只允许视频扩展名，拒 .xml/.ass）
  after?: string[];              // 前驱 jobId（T16 引入）
  // jobId 约定：`${logicalKey}#g${generation}`；generation 只由人工重试递增
  owner: { taskId?: number; streamKey?: string };
  createdAt: number;
}

export interface Processor {
  kind: string;
  resource: ResourceClass;
  lane?: string;                 // 同资源类内的独立通道：remux = "copy"，不与烧录抢 cpu 槽
  retryable: boolean;            // biliup = false：失败不自动重跑
  validate(job: ProcessJob): string | null;
  estimateDiskBytes(job: ProcessJob): number;   // runner 的磁盘准入用
  run(job: ProcessJob, ctx: ProcessContext): Promise<ProcessResult>;
  recover?(job: ProcessJob, ctx: ProcessContext): Promise<"rerun" | "done" | "uncertain">;
}
// registerProcessor / getProcessor / listProcessors / processorKinds / _resetProcessors（同 engine.ts）
```

`ProcessContext` 带 `signal: AbortSignal`（取消）、`log`、`alert`、`progress`、`tmpPathFor`、`freeBytes`。

任务状态：`pending → running → done | failed | uncertain | cancelled`；`running → pending` 仅当租约过期且 `recover()=rerun`；
`failed → pending` 只经 `requeue`（人工重试，换新 generation）；`uncertain` 须先人工 `ackUncertain`；`done`/`cancelled` 是终态
（`PROC_TRANSITIONS`，纯函数，放 core）。**biliup 在写 intent 之后被取消 → `uncertain`，不得记成 cancelled/failed。**
入队命中已 done 的行但 `outputs` 有文件已不存在 → 返回 `stale`，由派发方换新 generation，绝不当 done。

### 2.2 包与分层

| 包 | rank | 依赖 | 被谁依赖 |
|---|---|---|---|
| `@drec/proc-remux` | 2 | core、post-process | app、cli |
| `@drec/proc-merge` | 2 | core、post-process | app、cli |
| `@drec/proc-burn` | 2 | core、post-process | app、cli |
| `@drec/proc-biliup` | 2 | core | app、cli |

orchestrator（4.5）**不依赖**任何处理器包：它只构造 `ProcessJob`（core 类型）并经 `Transport` 派发。
`test/arch/layering.test.ts` 的 `RANKS` 加 `proc-*: 2`，随后 `pnpm arch:gen`。

### 2.3 执行底座：每节点持久任务表（app 层）

- 存储：`<dataRoot>/db/proc-queue.db`（**D1**），WAL + `busy_timeout`；表 `proc_jobs`（jobId 主键、状态、输入输出、
  租约、尝试次数、结果/错误）+ `proc_runner_lease`（每 kind 一行，每类本机至多一个存活持有者）。路径只由 `app/src/paths.ts` 的 `procQueueDbPath()`
  （由 `drecRoot()` 推出）给出，serve / record / `_enqueue` / `_node-pipeline` 共用，不受 `--db` 覆盖影响。
- 执行者 `ProcRunner`，**租约按 kind 分行**（`proc_runner_lease(kind PK, owner, pid, heartbeatAt, expiresAt)`，
  leaseMs = 30s、心跳 10s；过期为权威，pid 已死只用于提前接管）。`claim` 只认领本进程已注册且持有租约的 kind。
  `task serve` 为全部已注册 kind 抢租约；独立 `record` 进程只为 remux 抢、且仅当无存活持有者（**D2**）；serve 启动时
  遇 record 持有 remux 租约 → 等其过期再接管，不抢正在跑的 job。这样录制子进程持有 remux 租约不会饿死 merge/burn/biliup。
- 并发：cpu / net 走 core `ResourceLimiter`（从 `ResourcePool` 抽出，同一套语义：热读上限、cpu 带空闲内存闸）；
  upload 由 `proc-biliup` 内部走 core `UploadGate`（同一 store、同一账号 key，跨进程共享冷却）。
  cpu/net 槽按 `(resource, lane)` 分开计数：remux（`lane="copy"`，`-c copy` 只吃 IO）默认独立上限 1，不排在数小时的烧录后面。
  上限来源（**D3**）：节点本地 settings，默认值 = 现行 `ResourcePool` 默认（cpu 1 / net 1）；master 本机沿用 hub `resources`。
- 磁盘准入：认领前要求 `freeBytesOf(输出目录) ≥ estimateDiskBytes + 1 GiB`，不足则保持 pending 并告警一次；
  统一用 core `freeBytesOf`，消除两种算法。
- 租约防护（fencing）：心跳写失败或发现持有者已换人 → runner 立即 abort 本进程全部 job；处理器在不可逆动作前
  （rename + 删 inputs、写 biliup intent、调用 biliup）调用 `ctx.assertLease()`，失租即抛错不执行。`record` 退出时
  结束或中止当前 job 并**显式删除自己的租约行**，告警剩余 pending 数，serve 下一轮即可接管。
- 崩溃续跑：**每次接管租约**（不仅启动时）对该 kind 的 `running` 行调用 `processor.recover(job)`；租约过期但原 pid 仍活
  （卡住）时，retryable 的 kind 先杀该 pid 再 recover，biliup 直接记 uncertain；remux recover 只删嵌入 pid 已死的 tmp。**只碰该行列出的
  inputs / outputs / tmp 路径**，不扫目录。`uncertain` 告警、不自动重跑。
- 告警：serve 内执行时 `ctx.alert` 按 `owner.taskId` 投递到该任务的通知/事件中心（与 `@@DREC_ALERT@@` 同等可见）；
  record 子进程内执行时仍走 `@@DREC_ALERT@@`。
- 取消：store 置 `cancelRequested` → runner abort 该 job → 处理器清 tmp，按 `cancelOutcome(kind, hasIntent)` 落状态。
- 保留：done/cancelled 行 30 天后 GC；failed/uncertain 不自动删。

### 2.4 派发与回执

- 本机：`LocalTransport.enqueue` 直接写本机表。
- 远端：`_enqueue <dataRoot> <base64>`（`EnqueueRequest{v:1,jobs}` → 打印单行 `EnqueueResponse`），
  `_proc-status <dataRoot> <base64-jobIds>` 返回 `ProcessReceipt[]`，`_proc-cancel <dataRoot> <base64-jobIds>` 请求取消。
  master 端 `dispatchAndAwait()` 轮询回执。
- 协商：`NodeCapabilities.processors?: string[]`。缺字段 / 未知命令 → `ProcUnsupported` → 调用方走旧路径。
- **降级只在确定未受理时**：master **发送 `_enqueue` 之前**先在 `sync_jobs.dispatchedVia` 写 `proc`（意图）。只有确定性的
  「未知命令」错误才回落旧路径并清掉该标记；超时 / 断连等其他错误视为「可能已受理」，用 `_proc-status` 查清，查不清 →
  needs_manual。标记为 `proc` 之后任何 `_proc-status` 错误（未知命令 / 不可达 / 行缺失）一律 `ProcLost` → needs_manual，
  **绝不回落 `_node-pipeline`**（否则 worker 回滚后会二次建稿，违反 #25）。
- 反向钉死：已有任何 `_node-pipeline` 状态（节点结果文件 / node state）的 streamKey 固定走旧路径，不再 `_enqueue`；worker 侧
  `_node-pipeline` 发现 proc-queue 已有同 streamKey 的 job 时拒绝执行（双保险）。
- 输入推导点唯一：master 侧 `planStageJobs(broadcast, pulledPaths, cfg)`，输入 = 传给 `Transport.pull` 的确切路径 + 同名 xml；
  不再让 merge 子进程对 stage 目录 `groupSessions(readdirSync)`（现 `cli.ts` 424 被 `workflow.ts` 154-157 调用）。

### 2.5 输出格式新模型（用户已确认）

- 格式只作用于**收尾后留存**的文件；中间产物保持原生容器（录像）或 stage 格式（上传固定 mp4，`effectiveStageFormat`）。
- 拆成两个概念：`shouldConvertAtSeal(task)`（录制封口是否原地转换；hub-rule / hub-managed / rolling 一律 false，是
  `resolveNodeOutputFormat`（`node-remux.ts` 514-520）的唯一输入）与 `nodeOutputFormatLock`（只管 UI 锁定与原因）。
  解锁规则任务的输出格式**只改后者**，因此规则任务录制中仍绝不转换。
- 有规则的任务**处理中途绝不转换**；交付 done 且清理完成后，按 `survivingArtifacts(rule)` 计算留存清单，
  对容器 ≠ 任务输出格式的文件派发 remux（节点源派到该节点，stage 产物派到本机）；替换前由 proc-remux 的
  `markSessionNodeFormat` 写会话 sidecar 的 `nodeFormat`，保证扫描与「合成所选」仍认得转换后的文件。作为跟随任务，不阻塞 done（**D5**）。
- 规则使收尾后本机不留任何视频 → 输出格式锁定，原因 `no-survivors`（UI 显示文案）。`hub-managed` / `rolling` 仍锁。
- 网页「合成所选」产物扩展名跟随任务输出格式（`original` → mp4）。

### 2.6 队列页

`_node-status` 附可选 `procQueue`（active + recent，各上限 50，路径只给文件名）；master 现有 5s 轮询汇总，本机直读表；
`HubQueueDTO.nodeJobs` 按节点分组；QueuePage 新增「节点任务」分区；旧节点缺字段显示「节点版本不支持」。

## 3. 不变量映射（迁移前 → 迁移后由谁保证）

| 不变量 | 现在 | 迁移后 |
|---|---|---|
| 一场一个 BV（I1/I3/I8，#25） | P1 后立即 `ledger.setBv`（`workflow.ts` 241）；续跑分支 `resumeAppends`（`pipeline.ts` 676, 979-1134）；节点结果文件带 bv | biliup job 在 P1 返回 0 后 `ctx.progress({bv})` 写回行；master 见回执 bv 即 `setBv`；create 的 jobId 由 streamKey + generation 确定，重复派发不重跑；**换 generation 前**先查该 logicalKey 全部旧代行：有 bv → setBv 只补 append，有未 ack 的 uncertain → 拒绝重试 |
| 只认 biliup 返回码（#92） | `pipeline.ts` 325-330, 387-416 | 原样搬入 `proc-biliup`：调用前写 intent，返回 0 写 confirm |
| 结果未知不重传 | `UNSAFE_RETRY_NODES`（`reconciler.ts` 100）；节点拒绝不确定重入 619-626 | `proc-biliup.retryable=false`；intent 有、confirm 无 → `uncertain` → master 映射 needs_manual |
| 重试上限 3 → needs_manual | `reconciler.ts` 92, 586-604 | 不变（仍在 reconciler，按回执 failed 计数） |
| 上传速率 / 601 冷却跨进程共享 | `UploadGate` 与 `_awaitUploadSlot` 两份，同 store | 只剩 `UploadGate` |
| 关水印 / copyright / 仅自己可见 | `app/upload/biliup.ts` 常量 | 常量原样搬入 `proc-biliup`，diff 为零，测试快照 argv |
| xml/ass 不删最后一份 | `xmlKeepRule`（`pipeline.ts` 82-84）；各删除点都跳过 xml | 契约层拒绝：`replaceInputs` 的 inputs 只许视频扩展名；`survivingArtifacts` 从 `xmlKeepRule` 抽出成唯一判定 |
| 校验通过才删原文件 | 仅 node-remux | 所有 remux（含节点侧、master 分段）都经 `verifyRemuxed` |
| 磁盘准入（I12） | 分散 / 缺失 | runner 统一准入 |
| 用户中止 | `job-abort.ts` + `_node-abort` | `_proc-cancel` + `signal`；biliup intent 后中止 → uncertain |
| 版本回滚不二次建稿 | `_node-pipeline` 结果文件 | 受理后 `dispatchedVia=proc`，状态错误只进 needs_manual |
| 同场不并发 | `withStreamLock` + `JobDispatcher` 活动去重 | 不变（流级锁仍在 master）；节点表靠 jobId 幂等 |
| 部署由人 | — | 不变；本计划所有 PR 都不部署 |

## 4. 迁移对照与新旧 bundle 混跑

| 能力 | 旧路径（保留到 T18） | 新路径 | 切换开关 |
|---|---|---|---|
| 录制封口转换 | 进程内串行链 + 扫目录接管 | 入队 remux job | T7 合入即切（单节点内部行为） |
| master 合并/烧录 | 本进程 ffmpeg | 本机表 merge/burn job | T12a（整场）/ T12b（分段）合入即切 |
| 节点侧分 P 产出 | `produceParts` 直接 ffmpeg | 节点本机表 job | T13 合入即切（节点内部） |
| master 上传 | 本进程 biliup | 本机表 biliup job | T15 |
| 节点侧上传 | `_node-pipeline` | `_enqueue` 作业链 | T16：按节点 `processors` 能力逐节点切 |
| 留存转格式 | 无（规则任务锁定） | done 后跟随 remux | T9：节点不支持则跳过 + 标注 |

混跑矩阵：

| master | worker | 行为 |
|---|---|---|
| 新→回滚旧 | 新 | 旧 master 不认 `dispatchedVia`，可能对 `uploading` 场重发 `_node-pipeline`；新 worker 的 `_node-pipeline` 见同 streamKey 已有 proc job 即拒绝 → 旧 master 记失败，人工处理 |
| 新 | 新→回滚旧 | 已受理的链 → `ProcLost` → needs_manual（不回落旧路径）；未受理的场 → 旧路径 |
| 新 | 旧 | `processors` 缺失 → 节点侧上传走 `_node-pipeline`、留存转格式跳过并标注、队列页该节点「不支持」 |
| 旧 | 新 | 新 worker 继续提供全部旧隐藏命令（T18 之前不删）；worker 自身封口转换走本机表，对 master 透明 |
| 新 | 新 | 全走新路径 |

回滚到旧 bundle：`proc-queue.db` 被忽略；未完成的 remux job 留下的 tmp 保持旧命名 `{final}.{owner}-{pid}.drec-remux`，
旧版 `recoverNodeRemux` 能照常清理；原文件在新文件校验通过前从不删除，回滚不丢数据。未完成的 biliup job 回滚后不会被旧代码
看到 —— 因此 T15/T16 回滚前提：master 账本与**每个** worker 的 proc-queue 均无 pending/running 的 biliup job，且每个 done 的 biliup 行的 bv
都已在 master 账本（`_proc-status` 实测输出贴 PR）。

## Global Constraints

- 只有 `accept` 的 issue 才实施；一 issue 一分支；PR base `feat/hub-optimization`；不部署。
- 每个 `feat`/`fix` PR bump 根 `package.json` version 并 `pnpm bundle`。
- 验证门：`pnpm test`、`pnpm typecheck`、`pnpm arch:check`；动前端加 `cd packages/web && pnpm build` + tsc。
- 处理器内**禁止** `readdirSync` / `groupSessions` / 任何目录推导（T10、T18 用 grep 验收）。
- 涉及上传 / 删源 / 台账的 PR（T14、T15、T16、T18）`pr-risk-scan` 必命中 → 走 `needs-decision`，不自行合并。
- 不得删除 `recordings/` 下最后一份 `.xml` / `.ass`；契约层拒绝把 xml/ass 放进 `replaceInputs`。
- 每步可独立合并、可独立回滚；旧路径保留到 T18。
- 新包接线清单（T6/T10/T14 都要做）：`packages/proc-X/package.json`（仿 post-process）；app 与 cli 的 package.json 加
  `workspace:*` 依赖；`pnpm install` 并提交 `pnpm-lock.yaml`；`vitest.config.ts` alias 与 `tsconfig.json` paths 各加一行；
  RANKS 登记 2；`pnpm arch:gen` 提交生成物；`pnpm bundle` 后 grep `dist/douyin-rec.mjs` 含该包符号。
- 行为变化的任务同 PR 更新 `AGENTS.md` 对应段落（T7、T9、T15、T16）与 `docs/multi-node-sync.md`（T5、T16）。

## Tasks

依赖顺序：T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8 → T9 → T10 → T11 → T12a → T12b → T13 → T14 → T15 → T16 → T17 → T18。
可并行：T1/T2；T6/T8/T10（依赖 T1 或 T1+T2）；T14 依赖 T1+T2（改 `ResourcePool.withUpload`）；T17 在 T5 后任意时刻。

### P0 地基（无行为变化）

- [ ] **T1 core Processor 契约 + 注册表 + 状态机**（~260 行）
  - 做什么：§2.1 的类型（含 `signal`、`lane`、`cancelled`）、`registerProcessor` 系列、`assertJobInvariants`（空 inputs / 相对路径 / `replaceInputs` 含非视频 → 拒）、`PROC_TRANSITIONS`、`cancelOutcome`、`jobIdOf/parseJobId`、`EnqueueRequest/Response` 与 `decodeEnqueue`。
  - 为什么：所有后续包与派发只依赖 core 类型；xml 保护从契约层兜底。
  - 文件：`packages/core/src/processor.ts`（新）、`packages/core/src/index.ts`、`test/core/processor.test.ts`。
  - 验收/测试：重复注册抛错；xml 进 `replaceInputs` 被拒；`uncertain→pending` 不允许；`cancelOutcome('biliup', true)==='uncertain'`；`decodeEnqueue` 拒 v≠1。
  - 风险：低。回滚：删文件。

- [ ] **T2 core 资源限额器**（~220 行）
  - 做什么：把 `Semaphore`（`workflow.ts` 411-442）、cpu 内存闸（645-666）、`withNet`（668-675）抽到 `core/src/resource-limits.ts` 的 `ResourceLimiter`；`ResourcePool` 委托它，对外 API 与 `PoolSnapshot` 不变。
  - 为什么：节点 runner（app）不能依赖 orchestrator；限额语义必须只有一份。
  - 测试：既有 ResourcePool 测试不改即过；热读上限 1→2 时等待者立即放行。
  - 风险：低（纯重构）。

- [ ] **T3 节点持久任务表 `ProcQueueStore`**（~340 行）
  - 做什么：`app/src/proc-queue.ts`，库文件 `<dataRoot>/db/proc-queue.db`；`enqueue`（jobId 幂等；命中 done 但输出缺失 → `stale`）、按 kind 分行的租约、`claim(kinds, resource, lane, owner)`（`BEGIN IMMEDIATE`）、`heartbeat`、`finish`（校验租约持有者 + 合法迁移）、`markUncertain`、`requeue`（仅 failed）、`ackUncertain`（人工）、`requestCancel`、`list`、`get`、`gc`；库路径走 `procQueueDbPath()`。
  - 测试：同 jobId 二次入队不改 done 行；输出缺失 → stale；两个连接并发 claim 同一行只有一个成功；`requeue(uncertain)` 抛错；gc 不删 failed/uncertain。
  - 风险：sqlite 多进程锁 —— 复用 `UploadGate` store 已验证的写法。

- [ ] **T4 `ProcRunner` 执行底座**（~380 行）
  - 做什么：按 kind 租约 + 心跳；按 `(resource, lane)` 在限额内认领；磁盘准入；启动续跑三分支（rerun / done / uncertain）；告警按 `owner.taskId` 路由；取消；serve 启动 runner（无处理器注册时空转）。
  - 测试（假处理器）：cpu 上限 1 时两个 cpu job 串行而 net 并行；长时 burn 占槽时 remux（copy 通道）照常执行；record 持有 remux 租约时 serve 仍执行 merge；持有者心跳停止 → 30s 内被接管；进程已死 + recover=uncertain → 不调用 run；磁盘不足保持 pending；取消运行中 job → 子进程被杀、tmp 删、inputs 不变；被接管后恢复的卡住持有者 `assertLease` 失败 → 不删 inputs、不调用 biliup；运行期接管也触发 recover。
  - 风险：中（新常驻循环）。缓解：无注册处理器时行为与现状一致；本任务无线上调用方。

- [ ] **T5 派发通道**（~360 行）
  - 做什么：`_enqueue` / `_proc-status` / `_proc-cancel` 隐藏命令；`sync_jobs.dispatchedVia`（受理后不回落）；`NodeCapabilities.processors?`；`Transport.enqueue?/procStatus?`（ssh 实现 + 未知命令降级为 `ProcUnsupported`）；`orchestrator/src/proc-dispatch.ts` 的 `dispatchAndAwait`；发送前写意图、歧义错误经 `_proc-status` 消解；旧路径 streamKey 钉死与 `_node-pipeline` 拒绝检查。
  - 测试：旧节点未知命令 → `ProcUnsupported`；**已受理后**状态命令报未知 → `ProcLost` 且零次 `_node-pipeline`；`_enqueue` 超时但 worker 已受理 → 零次 `_node-pipeline`；已走旧路径的 streamKey 不发 `_enqueue`；同请求入队两次第二次返回原状态；能力缺字段按不支持。
  - 混跑：本任务只铺通道，无调用方。

### R 转封装先行

- [ ] **T6 `@drec/proc-remux`**（~320 行，多为搬移）
  - 做什么：把 `verifyRemuxed`（251-292）、`convertSegmentInPlace`（297-348）、tmp 命名（167-175）、全部阈值常量与 `markSessionNodeFormat/readNodeFormat` **逐字**搬入新包；导出 `remuxProcessor`（cpu，lane=copy，retryable）。`recover`：只有 tmp → 删 tmp 返回 rerun；final 存在且校验通过 → done 并删原文件；存疑 → uncertain，新文件加 `.drec-suspect`，绝不删最后一份。`node-remux.ts` 改为薄封装。
  - 验收：仓内 `function verifyRemuxed` 只有一处；完成新包接线清单（见 Global Constraints）+ `arch:check`。
  - 测试：既有 node-remux 测试全过；recover 三分支；`replaceInputs=false` 不删原文件。

- [ ] **T7 录制封口转换改走任务表**（~300 行，feat，bump）
  - 做什么：封口钩子改为入队 `remux:${taskId}:${段文件名}`；`markSessionNodeFormat` 仍在入队前写；`record` 注册 `remuxProcessor`，抢到租约则就地运行 runner；`recoverNodeRemux` 只兜底「不在表里」的老 tmp（一个版本）；`record` 退出释放租约；同 PR 更新 AGENTS.md 输出格式段。
  - 为什么：用表续跑取代扫目录接管与会话收尾等待。
  - 测试：封口 3 段 → 表中 3 行 pending 且 sidecar 已写；持有者退出 → serve 一个轮询周期内认领；runner 中途崩溃 → 重启续跑完成，原文件只在校验通过后删；VPS 真实录制一场（人工）。
  - 回滚：旧 bundle 按 tmp 旧命名照常接管。

- [ ] **T8 输出格式：留存判定 + 锁定原因（纯逻辑）**（~180 行）
  - 做什么：core `survivingArtifacts(rule, { stageHasXmlCopy })`（节点侧交付时 stage 无 xml 副本，等价现 `keepNodeXml`，`pipeline.ts` 261/276/346/672）从 `xmlKeepRule`（`pipeline.ts` 82-84）与 `cleanupSourcesShared`（244-317）抽出，pipeline 改用它；**拆出 `shouldConvertAtSeal`** 作为 `resolveNodeOutputFormat` 唯一输入；锁定原因联合类型收到 `core/api-types.ts` 一处（现 `api-types.ts` 917、`app/web/api/types.ts` 152、`node-remux.ts` 526 三处重复），增 `no-survivors`；`packages/web/src/lib/room-form-rules.ts` 显示原因文案。**锁定结果本步不变**。
  - 测试：cleanSource × stageAfterDone 四组合 × 两种交付模式（stage 有 / 无 xml 副本）；节点侧 × stageAfterDone=false → 节点 xml 留存；绑定规则且选 mkv 的任务 `resolveNodeOutputFormat()==='original'`；既有清理测试不变；web build。

- [ ] **T9 收尾后对留存文件派发 remux，解锁规则任务**（~300 行，feat，bump）
  - 做什么：`orchestrator/src/finalize-format.ts` 的 `planSurvivorRemux()`；pipeline / segment-pipeline 在 done + 清理之后调用；jobId `final-remux:${streamKey}:${文件名}`；节点不支持 → 跳过并标注；**只从 UI 锁** `nodeOutputFormatLock` 去掉 `hub-rule`，`shouldConvertAtSeal` 不动；job 带 `markSidecar`，替换前写 sidecar `nodeFormat`；同 PR 更新 AGENTS.md。依赖 T5/T6/T8。
  - 测试：全清理 → 不派发；只转容器不一致的文件；节点不支持 → done 不变、告警一次；T9 前后绑定规则任务 `resolveNodeOutputFormat` 均为 `original`；转换后 `groupSessions(…, {nodeFormats})` 仍得到该会话。
  - 验收：处理中途从不转换；上传仍用 mp4。

### M 合并 / 烧录

- [ ] **T10 `@drec/proc-merge`、`@drec/proc-burn`**（~300 行）
  - 做什么：包装 post-process `mergeSessions/mergeSession/remuxSegment`、`renderXmlToAss/burn`；产物写出复用 `runFfmpegAtomic`（tmp 再 rename）；recover：`isCompleteMedia(final)` → done，否则删 tmp → rerun。
  - 验收：两包内 grep 无 `readdirSync` / `groupSessions`；完成新包接线清单。

- [ ] **T11 CLI merge/burn 与「合成所选」**（~260 行，fix，bump）
  - 做什么：`cli.ts` 424/539 补 `nodeFormats`（#143 同类漏点）并改为组装显式 job 后直接调用 `getProcessor(kind).run(job, localCtx)`（不经任务表，无 serve 也能用；参数与产物逐字节兼容，因为 T12a 前 master 仍调用此 CLI）；网页 `startMerge` 改为入队 merge job，产物扩展名跟随任务输出格式；`MergeJobView` 由回执映射，前端零改动；`merge_jobs` 只读兼容老行。
  - 测试：outputFormat=mkv → 产物 .mkv；老 merge job 可查；含节点侧 mp4 的目录能识别分段；workflow 拼出的 merge 命令前后产物一致（golden）。

- [ ] **T12a master 整场管线 merge/burn 改派发 + 唯一输入推导点**（~360 行，feat，bump）
  - 做什么：`orchestrator/src/stage-jobs.ts` 的 `planStageJobs(b, pulledPaths, cfg): ProcessJob[]`（输入 = pull 清单 + 同名 xml，golden fixture 与现 `deriveStageProducts` 对拍）；workflow 的 merge / burn 节点（`workflow.ts` 154-157 起子进程）改为 `dispatchAndAwait(localTransport, job)`；`sync_node_states.generation`（幂等 ALTER），`retryHubNode`（`app/web/api/hub-jobs.ts` 112）人工重试时递增；中止按钮（core `abortJob`）联动 `procCancel`；`transport-local.ts` 实现 enqueue / procStatus / procCancel。
  - 测试：对拍一致；master 重启 done 的 job 不重跑、人工重试换 generation 后重跑；中止 → job cancelled、sync_job needs_manual。

- [ ] **T12b 分段管线改派发 + pull 进 net 限额**（~260 行，fix，bump）
  - 做什么：segment-pipeline 逐段 remux（348-390）/ 组合并（404-422）/ 烧录（444-476）经 `planStageJobs` 派发；`pipeline.ts` 785 pull 前取 net 槽；`ResourcePool.snapshot` 的 cpu 计数改读 runner。
  - 为什么：修分段模式绕过 CPU 闸、pull 不受限。
  - 测试：两场分段并行时 cpu job 串行；既有 segment-pipeline 测试（假回执）全过。

- [ ] **T13 节点侧 `produceParts` 改用 job**（~220 行，fix，bump）
  - 做什么：`node-pipeline.ts` 459-540 的 remux/merge 改为本机表 job，获得校验与磁盘准入；`.ts` 直传硬链接分支保持；`_node-pipeline` 协议不变。新增 `awaitLocalJobs(store, ids, {timeoutMs, noLeaseMs: 60s})`：无存活租约持有该 kind → 结果 failed（未上传，非 uncertain）。依赖 T4/T6/T10。
  - 测试：worker 无 runner → 60s 后 failed、未调用 biliup；校验失败 → 结果 failed 且未调用 biliup；磁盘不足 → 等待告警不产出半截分 P；分 P 命名逐字不变。

### U 上传（最后，needs-decision）

- [ ] **T14 `@drec/proc-biliup` + 上传闸统一**（~380 行）
  - 做什么：搬 `app/upload/biliup.ts`（cookie 路径参数化）；`uploadProcessor`（upload，retryable=false）：intent → `UploadGate.run(biliup)` → confirm / `progress({bv})`；recover：intent 有 confirm 无 → uncertain。`ResourcePool.withUpload` 委托 `UploadGate`，删 `_awaitUploadSlot`。
  - 测试：硬常量 argv 快照；601 后冷却期内被挡；intent 后崩溃 → uncertain 且不调 biliup。
  - 验收：grep `_awaitUploadSlot` 无结果；硬常量 diff 为零；完成新包接线清单。

- [ ] **T15 master 上传节点改派发**（~380 行，feat，bump，needs-decision）
  - 做什么：upload_plain / append、`resumeAppends`、分段上传改派发到本机表；回执见 bv 立即 `setBv`；uncertain → needs_manual；中止联动 `procCancel`（intent 后 → uncertain）；create 换 generation 前查旧代行（见 §3）；同 PR 更新 AGENTS.md。依赖 T12a/T14。
  - 测试：P1 done 后 master 崩溃重启 → 只补 append；同 streamKey 重复派发 create 不重跑；g1 done 有 bv 而账本无 bv → 人工重试零次 create；g1 uncertain 未 ack → 重试被拒；append uncertain → needs_manual 不重试；#25/#92 回归全绿。
  - 回滚前提：master 账本与本机 proc-queue 无 pending/running 的 biliup job。

- [ ] **T16 节点侧上传改 `_enqueue` 作业链**（~400 行，feat，bump，needs-decision）
  - 做什么：`ProcessJob.after` + runner「前驱 done 才认领、前驱失败 → blocked」；节点具备全部 kind 时 master 一次 `_enqueue` 整条链（分 P 产出 → create → append），轮询 `_proc-status` 代替 `_node-result`；节点源删除只由 master `cleanupSourcesShared` 做（消除双删），节点侧链以 `stageHasXmlCopy:false` 调用，保住最后一份 xml。不支持（受理前）→ 原 `_node-pipeline`；受理后任何状态错误 → needs_manual；中止经 `_proc-cancel`；同 PR 更新 AGENTS.md 与 `docs/multi-node-sync.md`。
  - 回滚前提：master 账本与每个 worker 的 proc-queue 均无 pending/running biliup job（`_proc-status` 实测贴 PR）。
  - 测试：老节点走原测试全过；链已受理后 worker 回滚（状态命令未知）→ needs_manual 且零次 `_node-pipeline`；create 回执带 bv → master 先 setBv；VPS 真实一场（人工，仅自己可见）。

### Q 队列页

- [ ] **T17 队列页统一展示所有节点任务**（~340 行，feat，bump）
  - 做什么：§2.6；`_node-status` 附 `procQueue`；`HubQueueDTO.nodeJobs`；QueuePage「节点任务」分区。
  - 测试：节点缺字段 → 标 unsupported；web build + tsc；`serve:local` 手动核对。

### X 收尾

- [ ] **T18 删除旧路径（D4 通过后）**（~300 行，chore/refactor）
  - 条件：两节点 `_node-capabilities` 实测 `processors` 含全部 kind，且新路径稳定运行满 D4 约定期限（命令输出贴 PR）。
  - 删除：`recoverNodeRemux` 扫目录兜底、节点执行体 `node-pipeline.ts` 与 `_node-pipeline/_node-result`（命令名保留一个版本返回明确错误；`_node-abort` 仅在 `_proc-cancel` 覆盖全部中止场景后删）、`merge_jobs` 兼容、无调用的 `ResourcePool.withCpu`、被表取代的孤儿清理分支；同步 `AGENTS.md`、`docs/multi-node-sync.md`。
  - 验收：转封装仅 `proc-remux` 一份；上传闸仅 `UploadGate` 一份。

## 决策点（需用户拍板，均附推荐）

1. **D1 任务表位置** —— 要决定：独立库文件 `db/proc-queue.db` 还是任务库新表。不决定：T3 无法开工。
   **推荐独立文件**：迁移失败不波及任务库；录制子进程高频写不和 serve 抢任务库锁；回滚时旧 bundle 完全无感。
2. **D2 runner 宿主** —— 要决定：只在 `task serve` 里跑，还是无 serve 时独立 `record` 也可抢租约就地跑。不决定：独立录制时转换无人执行。
   **推荐两者都可，靠按 kind 分行的租约保证每类本机唯一**：serve 持有全部 kind；独立 `record` 只在无存活持有者时持有 remux（保持现在独立 `record` 也能转换的行为）。
3. **D3 节点并发上限来源** —— 要决定：节点本地 settings，还是 master 每次派发下发。不决定：VPS 上限只能用默认值。
   **推荐节点本地 settings**（默认 = 现行 cpu 1 / net 1），master 本机沿用 hub `resources`；节点资源由节点自己说了算。
4. **D4 上传迁移与旧路径删除** —— 要决定：T15/T16 是否实施（上传、删源属 needs-decision），以及 T18 删旧路径的门槛。不决定：上传仍是两套代码，重复与分歧继续存在。
   **推荐实施，且 T18 门槛 = 两节点均报告全部 processors 且新路径连续 14 天无 uncertain/needs_manual 新增**。
5. **D5 留存文件转格式的时机** —— 要决定：交付 done 后作为跟随任务（不阻塞 done），还是纳入 done 前的必经步骤。不决定：T9 无法开工。
   **推荐跟随任务**：转格式失败只影响本地归档容器，不应把已送达的稿件标为未完成；失败告警、原文件保留。

## AGENTS.md 硬约束在新模型里如何成立

- **recordings/ 下 xml/ass 不删最后一份**：契约层拒绝 xml/ass 进入 `replaceInputs`；处理器只删 `replaceInputs` 列出的视频；
  清理仍只由 master `cleanupSourcesShared` 按 `survivingArtifacts`（即原 `xmlKeepRule`）执行。
- **部署由人**：所有任务 PR 只合并不部署；混跑矩阵保证任意顺序部署 master / worker 都安全；部署前仍按 `recording===true` 守卫。
- **上传规则**：关水印、copyright、仅自己可见常量原样搬入 `proc-biliup` 并有 argv 快照测试；一稿一 BV 由 jobId 幂等 + 回执即 setBv 保证；
  人工投稿仍用 `upload-recording-today` skill，与本计划无关。
- **不破坏 VPS 生产录制**：T7/T13/T16 的真实验证只在用户安排的场次做，不重启、不删文件。

## 回滚

每个任务单独可回滚（`git revert` 对应 PR）。数据侧：`proc-queue.db` 对旧 bundle 不可见；remux tmp 保持旧命名；
原文件在校验通过前从不删除。唯一需要前置条件的是 T15/T16：回滚前确认队列无 running 的 biliup job，否则先等它结束或人工处理。

## 审计记录

（plan-loop 独立评审轮次见下，每轮列出阻断/主要问题与修订。）

**第 1 轮**（principal-engineer 角色独立评审）：verdict = revise，分 61；阻断 3、主要 7。已全部修订：

| 问题 | 级别 | 修订 |
|---|---|---|
| T9 去掉 `hub-rule` 锁会让规则任务录制中原地转换（`resolveNodeOutputFormat` 复用锁判定） | 阻断 | T8 拆出 `shouldConvertAtSeal` 作为唯一转换判定；T9 只改 UI 锁；补前后回归测试 |
| 单一 runner 租约：record 子进程持有时 merge/burn/biliup 无人执行 | 阻断 | 租约按 kind 分行；record 只抢 remux 且仅无存活持有者时；serve 等过期接管 |
| worker 回滚后 `_proc-status` 失败回落 `_node-pipeline` 会二次建稿 | 阻断 | 受理后记 `dispatchedVia=proc`，状态错误一律 needs_manual；T16 测试零次旧路径调用 |
| 无取消语义，中止按钮失效 | 主要 | `signal` + `cancelled` + `_proc-cancel`；biliup intent 后取消 → uncertain |
| done 行输出被清理后重派发直接当 done | 主要 | `stale` 回执 + generation（人工重试递增） |
| 长时 burn 占 cpu 槽饿死 remux | 主要 | `(resource, lane)` 计数，remux 走 copy 通道 |
| serve 内 `ctx.alert` 无投递对象 | 主要 | 按 `owner.taskId` 路由 |
| T12 过大且 stage 输入仍扫目录 | 主要 | 拆 T12a/T12b；`planStageJobs` 唯一推导点 + golden 对拍 |
| 转换后 sidecar 未写 `nodeFormat`，扫描漏认 | 主要 | proc-remux 承接 `markSessionNodeFormat`，替换前写 |
| 新包接线、AGENTS.md / 文档同步未列入任务 | 主要 | Global Constraints 新增接线清单与文档同步要求，T6/T7/T9/T10/T14/T15/T16 引用 |

另：`room-form-rules.ts` 路径更正为 `packages/web/src/lib/`；锁原因联合类型收到 core 一处；T11 CLI 直接调用处理器并加 golden；T13 `awaitLocalJobs` 无租约 60s → failed；T18 `_node-abort` 删除以 `_proc-cancel` 覆盖为前提。

**第 2 轮**：verdict = revise，分 72；阻断 1、主要 4、次要 3。已全部修订：

| 问题 | 级别 | 修订 |
|---|---|---|
| `_enqueue` 已被受理但回复丢失 → master 误判未受理回落旧路径，双链双 BV；旧路径中途的场被改投新路径；缺 master 回滚行 | 阻断 | 发送前写 `dispatchedVia` 意图；只有确定性未知命令才回落；旧路径 streamKey 钉死 + worker `_node-pipeline` 拒绝；混跑矩阵补 master 回滚行；回滚前提加「done 行 bv 已入账」 |
| generation 递增让 biliup create jobId 变化，旧代行有 bv 未入账时二次建稿 | 主要 | 换代前查旧代行：有 bv 只补 append，未 ack 的 uncertain 拒绝 |
| `survivingArtifacts(rule)` 漏 `keepNodeXml`，节点侧交付会删最后一份 xml | 主要 | 增 `stageHasXmlCopy` 入参；T16 节点侧链以 false 调用；测试覆盖两种交付模式 |
| 租约无 fencing，卡住的持有者恢复后仍执行删源 / 上传 | 主要 | `ctx.assertLease()` 置于不可逆动作前；心跳失败自停；每次接管都 recover；卡住 pid 先杀再 recover，biliup 记 uncertain |
| §2.3 仍写「单行租约」与按 kind 分行矛盾 | 主要 | 改为每 kind 一行 |
| record 退出不释放租约；库路径受 `--db` 影响；T14 依赖 T2；两处行号偏移 | 次要 | 退出显式删租约行；`procQueueDbPath()` 单点；并行说明修正；行号改为 917 / 526 |
