# 036 后处理插件化：Processor 契约 + 每节点持久任务表

> **TODO：T-55**（`TODO.md`「待办（Next）」，与本计划同一 PR #147 补入），满足 AGENTS.md「plan 与 TODO 双向引用」；
> `TODO.md` 的 T-52 另有一条单向指向本文。

状态：设计稿（未实施），**返工 R2**。基线 `feat/hub-optimization` = `a208cc5`（含 #141 原子写分P产物、#144 合并收口
`groupSessionsInDir` + stage 带边车 + 未认领分段守卫）。下文行号均在该基线实测。
与 plan 033（不变量 I1–I12）、plan 034（交付模型）兼容；本文只管「转封装 / 合并 / 烧录 / 上传」四类**文件处理**
怎么执行，不改选优、聚类、对账语义。

## Goal

把后处理做成和平台、录制引擎一样的插件，**分两期交付**：

- **第一期（最小可交付，满足用户意图 1 + 意图 2 的「侧进程 / 队列」）**：
  core `Processor` 契约 + 注册表 → 每节点持久任务表包 → remux 处理器 + 录制封口转换迁到任务表 →
  收尾后对「留存文件」转所选输出格式（解锁规则任务）→ 任务页「合成所选」跟随输出格式。
  第一期**只有 remux 一个处理器**进任务表；合并 / 烧录 / 上传路径一行不动，稳定版行为除「规则任务可选输出格式」外不变。
- **第二期（可评审粒度，开工前再细化）**：merge / burn / 上传迁到任务表、master 管线退化为「派发 + 等回执」、
  节点作业链、队列页。

不变的核心原则：**输入文件由派发方显式列出，处理器从不扫目录。**

「加一个处理器 = 一个文件 + 注册一行」：处理器实现放 `@drec/processors/src/<kind>.ts`，在
`packages/cli/src/providers-register.ts` 加一行 `registerProcessor(xxxProcessor)` —— 与该文件现有
`registerPlatform`（22-24）/ `registerEngine`（28-29）并列，风格一致。

## 1. 现状（a208cc5 实测）

### 1.1 三份转封装实现

| 维度 | 录制封口转换 `app/src/node-remux.ts`（566 行） | 节点侧管线 `app/src/node-pipeline.ts`（890 行） | master 管线 `orchestrator/src/pipeline.ts`（1173 行）+ `segment-pipeline.ts`（803 行） |
|---|---|---|---|
| 入口 | 封口钩子 `makeNodeRemuxHookFactory` 357；挂载点 `cli.ts` 255-268（record 命令）、`app/src/cli-task.ts` 131-139（`task run`） | `_node-pipeline` 隐藏命令 → `runNodeSidePipeline` 594 | `runPipeline` 620；分段模式 `runSegmentPipeline` |
| 转换调用 | `convertSegmentInPlace` 300 | `produceParts` 459：`remuxSegment` / `mergeSession` 写 `.work/` | 整场：merge 节点起子进程 `douyin-rec merge --format`（`workflow.ts` 154-157）；分段：`remux` 342/374、组合并 `mergeGroup` 402/417、烧录 `burnOne` 444 |
| 输入从哪来 | 封口事件给的单个分段（显式） | spec 里的 `tsFiles[]`（显式）；stage 产物 `readdirSync` 856/875 | pull 清单显式（含 `sessionJsonPath`，`pipeline.ts` 793-799）；**合并输入仍由 merge 子进程对 stage 目录 `groupSessionsInDir` 推导**（`cli.ts` 424），stage 产物由 `deriveStageProducts`（`session-plan.ts` 67，`pipeline.ts` 834/1035）/ `deriveSegmentPlan`（243）推导 |
| 并发 | 每进程一条 promise 串行链（跨任务并行，各 record 进程各一条） | 每场一个 pid 文件 135，**节点无全局上限** | `ResourcePool`（`workflow.ts` 459）cpu/upload；workflow 节点只用 cpu/upload 两类（147/198/214/227/259/277），**`withNet`（668）无任何调用方**；分段模式 remux/merge/burn 不进 `withCpu`；pull 不限 |
| 校验 | 完整：`verifyRemuxed` 254 | **无** | **无**（#141 后有 `isCompleteMedia`「存在 ≠ 完整」判定，但无 remux 等价校验） |
| 磁盘闸 | 源大小 + 1 GiB（307/324，经 `disk-gate.ts` 69-73 `volumeFreeBytes` = `bavail*bsize`） | 节点无；master 派发前 `diskWatermarkGate`（`orchestrator/src/node-side-upload.ts` 69, 348） | pull 前无；`diskMinGB` 只在对账告警（`reconciler.ts` 160/187） |
| 崩溃恢复 | 扫目录 `recoverNodeRemux` 436（孤儿 tmp 按 owner+pid / `STALE_TMP_MIN_AGE_MS` 77 判） | 结果文件 `NODE_RESULT_FILE` 84 + pid | `sync_jobs` 状态机 + `.work/` 续跑 |
| 收尾等待 | `SESSION_END_BUDGET_MS = 3min`（91），超时放弃并告警（392-405） | — | — |

**分歧（会出事故的）**：节点侧与 master 的转换产物不经 `verifyRemuxed`；分段模式 CPU 不受 `maxCpuParallel` 约束；
空闲空间两种算法（`disk-gate.ts` 72 `bavail*bsize` vs core `freeBytesOf` 20 优先 `frsize`）；网页「合成所选」
固定产出 mp4（`app/src/web/api/merge.ts` 52-54，注释自认遗留）。

### 1.2 可复用构件

- 能力协商 `NodeCapabilities`（`core/api-types.ts` 777）；旧 bundle 未知命令 `isUnknownCommandError`（`transport-ssh.ts` 95）→ 回落（`node-side-upload.ts` 325-335）。
- 远端写入范式 `_apply-tasks <dataRoot> <base64>`（`cli.ts` 1740 起）；节点回执 `_node-status`（1842）。
- 多进程安全认领：`openUploadLimitStore` 的 `busy_timeout`（`core/upload-gate.ts` 183）+ `BEGIN IMMEDIATE`（204）—— **core 已直接用 `node:sqlite`**。
- 原子写（#141）：`post-process/src/artifact.ts` 的 `atomicPartPath` 18 / `withAtomicOutput` 27 / `runFfmpegAtomic` 36 / `unreadableParts` 55 / `isCompleteMedia` 77。
- 会话分组唯一入口（#144）：`groupSessionsInDir`（`post-process/src/concat.ts` 70）。
- 磁盘水位统一解析：core `resolveDiskMinGB`（`disk-watermark.ts` 32），daemon（`daemon.ts` 94）/ reconciler（160）/ cli（928、1497）共用。
- 队列视图 `buildQueueView`（`app/src/hub-jobs.ts` 542）+ `ResourcePool.snapshot()`（`workflow.ts` 607）。
- 注册表先例：`registerPlatform` / `registerEngine`（`cli/src/providers-register.ts` 22-29）。

### 1.3 #144 之后的「这一场有哪些文件」推导

#144 已把**目录上的会话分组**收口到 `groupSessionsInDir` 一处，5 个调用点统一：`scan.ts` 189、`web/api/merge.ts` 24/46、
`cli.ts` 424（merge）/ 539（burn），外加 `pipeline.ts` 58 的 `unclaimedStageSegments`（55-62）守卫；pull 把
`sessionJsonPath`（`transport.ts` 18，`scan.ts` 232 填）带进 stage（`pipeline.ts` 797）；`stageVideoLeftovers`（73-84）
清空 stage 时连会话边车副本（`.session` JSON）一起删。**原 §1.3「cli 424/539 不认节点侧 mp4/mkv」已不成立。**

剩余结构问题：推导仍发生在**执行方**（merge 子进程对 stage 目录分组、`deriveStageProducts` / `deriveSegmentPlan`
对 stage 目录推导、`node-pipeline.ts` 856/875 扫 stage），派发方手里明明有确切的 pull 清单。本计划第二期（T12a）
把推导移到派发方一处，处理器只认 job 行里的路径；第一期不碰合并路径。

## 2. Architecture

### 2.1 契约 + 注册表（core 新模块 `processor`）

```ts
export type ResourceClass = "cpu" | "net" | "upload";

export interface ProcessJob {
  jobId: string;                 // = jobIdOf(kind, logicalKey, generation)，派发方给定、确定性 → 幂等
  kind: string;                  // 第一期只有 "remux"；第二期 "merge" | "burn" | "biliup"
  logicalKey: string;            // 见下「jobId 约定」
  generation: number;            // 从 1 起；只由「stale 重派」或人工重试递增
  inputs: string[];              // 绝对路径，显式列出；处理器不得扫目录
  outputs?: string[];            // 期望产物（merge/burn 必填；remux 由 params.format 推出）
  params: Record<string, unknown>;
  replaceInputs: boolean;        // true = 校验通过后删除 inputs（只允许视频扩展名，拒 xml/ass/会话边车）
  owner: { taskId?: number; streamKey?: string };
  createdAt: number;
}

export interface Processor {
  kind: string;
  resource: ResourceClass;
  lane?: string;                 // 同资源类内的独立通道：remux = "copy"，不与烧录抢 cpu 槽
  retryable: boolean;            // biliup = false
  interruptible: boolean;        // 关停时可直接 abort 回 pending（remux/merge/burn = true；biliup = false）
  validate(job: ProcessJob): string | null;
  estimateDiskBytes(job: ProcessJob): number;
  run(job: ProcessJob, ctx: ProcessContext): Promise<ProcessResult>;
  recover?(job: ProcessJob, ctx: ProcessContext): Promise<"rerun" | "done" | "uncertain">;
}

export function registerProcessor(p: Processor): void;   // 重复 kind 抛错
export function getProcessor(kind: string): Processor | undefined;
export function listProcessors(): Processor[];
export function _resetProcessors(): void;                 // 仅测试
```

形态逐项对齐 `core/src/platform.ts` / engine 注册表（模块级 `Map`、重复注册抛错、`_reset*` 仅测试用）。

- **`jobIdOf(kind, logicalKey, generation) = \`${kind}:${logicalKey}#g${generation}\``**，`parseJobId` 为逆；全仓**只此一处**拼 jobId（F8）。
- **logicalKey 约定**：封口转换 `task${taskId}:${basename}@${fileTag}`；留存转格式 `final:${streamKey}:${side}:${basename}@${fileTag}`；
  `fileTag = ${ino}-${size}`（由**执行节点**的 `enqueue` 对 `inputs[0]` `stat` 得出并回填 —— 派发方不必知道远端 inode）。
  取值用 `statSync(p, { bigint: true })` 后 `String(ino)` / `String(size)`：默认 `statSync` 的 `ino` 是 Number，64 位 inode
  （xfs/btrfs 大盘）可能超 2^53 而丢精度（N8）。
  同名文件被替换 / 不同天同名 → fileTag 不同 → 新行，不会命中旧 done。
- **stale**：入队命中 done 行但 `outputs`（或 remux 的目标文件）已不存在 → 回执 `stale`，派发方以下一代重派一次，不自己记计数：
  本机派发直接用 `store.nextGeneration(kind, logicalKey)`；**远端派发**时 master 没有节点的 store、也不知道节点回填的 fileTag，
  因此节点在 `EnqueueResponse.results[]` 的 `stale` 回执里附 `nextGeneration`（由节点 store 算出），master 原样以该值作
  `generation` 重发（N1）。
- **remux done 后再入队**：remux 行 done 时 `inputs[0]` 已被替换删除，同一 logicalKey 再入队时节点对 `inputs[0]` `stat` 失败 →
  回执 `rejected`（不是 `stale`），派发方不重试、只记标注（N1）。
- `assertJobInvariants(job, { allowedRoots })`：空 inputs / 相对路径 / `replaceInputs` 含非视频 / **任一路径不在 `allowedRoots` 下**
  → 拒（F11）。`allowedRoots` 由执行节点给出 = `drecRoot()` 下的 `recordings/`、`stage/` + 本节点各任务 `resolveOutputDir(task.outDir)`
  + master 本机的 `effectiveHubConfig().stageDir`（N3：stage 目录是 `hubCfg.stageDir ?? rootStageDir()`，`cli.ts` 1023/1028/1055/1274，
  模板 `configs/hub.config.example.json` 9 可在数据根外）（任务可配目录、stage 目录都可在数据根外，不能只认数据根）。
- 状态机 `PROC_TRANSITIONS`（纯函数）：`pending → running → done | failed | uncertain | cancelled`；`pending → cancelled`
  （**仅当从未被认领**，原子条件更新，第二期回落旧路径的前提）；`running → pending` 仅当租约过期且 `recover()=rerun`，或关停时
  `interruptible` 的 job 被 abort；`failed → pending` 只经 `requeue`；`uncertain` 须先人工 `ackUncertain`；`done`/`cancelled` 终态。
  `cancelOutcome(kind, hasIntent)`：biliup 写 intent 之后被取消 → `uncertain`。

### 2.2 包与分层（D7、D8）

| 包 | rank | 依赖 | 被谁依赖 | 内容 |
|---|---|---|---|---|
| `@drec/core`（已有，0） | 0 | — | 全部 | 新模块 `processor`：契约 + 注册表 + 状态机 + `jobIdOf`（第二期 T2 加 `ResourceLimiter`） |
| **`@drec/proc-queue`（新）** | **0.3** | core（+ 内置 `node:sqlite`） | app、orchestrator、cli | `ProcQueueStore`（表 + 租约）+ `ProcRunner`（执行循环）；只经 core 注册表找处理器，**不 import 任何处理器** |
| **`@drec/processors`（新）** | **0.4** | core、post-process（0.2） | app、cli | `src/remux` 模块（第一期）；第二期加 merge / burn / biliup 三个模块；入口只做导出 |

依赖方向核对（`test/arch/layering.test.ts` 要求 rank 严格大于所依赖者）：proc-queue 0.3 > core 0；processors 0.4 > post-process 0.2 > core 0；
app 4 / orchestrator 4.5 / cli 5 均 > 0.4。**orchestrator 只依赖 proc-queue（`LocalTransport.enqueue` 写本机表），不依赖 processors**
（它只构造 `ProcessJob`），守住「编排层不执行处理器」。proc-queue 不依赖 observability（0.5）：告警经 `ProcessContext.alert` 回调注入。
`RANKS` 加两行并更新 post-process 那行注释（被依赖方新增 processors）；`scripts/gen-architecture.mjs` 的 `RANK_LABEL` 补 0.3 / 0.4 两行；`pnpm arch:gen` 提交生成物。

为什么不放 app（审查 F2 选项②）：orchestrator（4.5）要写本机表（第一期 T9b 的 master 本机留存转格式、第二期 T12a），放 app 就得让
orchestrator 首次依赖 app 或由 cli 注入 store —— 后者要求 `startHub` 新增注入口、web merge 与 `node-pipeline` 也各自注入，三处接线。
为什么不直接放 core：core 虽已用 `node:sqlite`（`upload-gate.ts`），但 runner 是常驻循环 + 子进程管理，core 是契约层且被 web 端经
alias 引用子文件（`vitest.config.ts` 58-59、`packages/web/vite.config.ts` 16-18），不宜再塞执行体。

### 2.3 执行底座：每节点持久任务表

**存储**：`<root>/db/proc-queue.db`（与 `rootDbPath()` 同目录，`app/src/paths.ts` 87-89；不受 `--db` 覆盖）。路径单点 =
**纯函数 `procQueueDbPath(dataRoot)` 由 `@drec/proc-queue` 导出**；app `paths.ts` 的 `procQueueDbPath()` 只是
`procQueueDbPath(drecRoot())` 转发；orchestrator（`LocalTransport` 由 `orchestrator/src/index.ts` 71 `registerBuiltinTransports` 及
`cli.ts` 1435/1465 用 `cfg.dataRoot` 构造，不能 import app）直接用 `procQueueDbPath(cfg.dataRoot)`（N4）。WAL + `busy_timeout=5000`；**任何进程首开都执行幂等迁移**
（`CREATE TABLE IF NOT EXISTS` + `PRAGMA user_version` 判版本，迁移包在 `BEGIN IMMEDIATE` 内）——写法抄 `openUploadLimitStore`。
表：`proc_jobs`（jobId PK、kind、logicalKey、generation、state、inputs/outputs/params JSON、attempts、claimedBy、
cancelRequested、result/error、时间戳）+ `proc_runner_lease(kind PK, owner, pid, heartbeatAt, expiresAt, handoverRequested)`。

**租约与宿主**（每 kind 本机至多一个存活持有者；leaseMs 30s、心跳 10s；过期为权威，pid 已死只用于提前接管）：

- `task serve`：为全部已注册 kind 抢租约。遇他人持有且未过期 → 置 `handoverRequested=1`，**不抢正在跑的 job**（F5）。
- `record` 进程（serve 拉起的子进程与独立 record 同一规则）：**只在无存活持有者时**持有 remux；serve 拉起的子进程因 serve
  先持有而只入队。持有期间每次心跳读 `handoverRequested`，置位 → 停止认领、当前 job 跑完、删自己的租约行。
- 入队时若该 kind 无存活持有者，record 立即尝试接管（多个独立 record 时，持有者退出后其余 record 在下一次封口自然接手）。
- **record 收尾**（`onSessionEnd`）**保留现有语义**：若本进程持有 remux 租约 → 等待「owner.taskId = 本任务」的 pending/running 行，
  总时限仍为 `SESSION_END_BUDGET_MS`（3min），超时告警（文案同现在）、未完成行留在表中；若本进程不持有且无存活持有者 →
  先接管再同样等待；若有他人（serve）持有 → 不等待（serve 常驻会做完）。**等待中发现持有者已变为 serve**（`handoverRequested`
  交接完成）→ 立即结束等待，不再占用剩余预算、不发超时告警（N5）。退出时显式删除自己的租约行。

**并发**：按 `(resource, lane)` 计数。第一期只有 `cpu/copy`，上限来自节点本地 settings `procLimits.copy`（默认 1，**D3**）。
注意行为变化：现在每个 record 进程各自串行、跨任务并行；新模型下本节点所有任务的封口转换共用 copy 通道（默认 1 并发）——
`-c copy` 主要吃 IO，多段并发反而互抢磁盘，默认 1 与现「单进程并发 1」口径一致；多任务同时收播时积压由表承接，不丢。
第二期 T2 把 `ResourcePool` 的 `Semaphore`（`workflow.ts` 411）与 cpu 内存闸抽成 core `ResourceLimiter`，runner 改用它。

**磁盘准入**（F15）：认领前要求 `freeBytesOf(statfs(输出目录)) − estimateDiskBytes(job) ≥ diskMinGB`，`diskMinGB` 由 core
`resolveDiskMinGB` 读与 daemon 同一来源（`effectiveHubConfig().resources?.diskMinGB`），不新造常量；不足 → 保持 pending、按 kind
告警一次（恢复后清告警标记）。

**租约防护（fencing）**：心跳写失败或发现持有者已换人 → runner 立即 abort 本进程全部 job；处理器在不可逆动作前（rename + 删
inputs；第二期：写 biliup intent、调用 biliup）调用 `ctx.assertLease()`，失租即抛错不执行。

**崩溃续跑**：每次**接管**租约（不仅启动）对该 kind 的 `running` 行调用 `processor.recover(job)`；只碰该行列出的 inputs / outputs /
tmp 路径，不扫目录。`uncertain` 告警、不自动重跑。

**关停**（F6；`app/src/serve.ts` 395-422 现有 shutdown 只停 daemon/recorder 与 http）：shutdown 首步 `runner.stop()`：
停止认领 → `interruptible` 的 running job 立即 abort（处理器删 tmp、inputs 不动、行回 `pending` 且 `attempts` 不加）→
非 interruptible（第二期 biliup）等待至完成，上限 `procShutdownWaitMs`（默认 15min，节点 settings），到点 abort 并按
`cancelOutcome` 记 `uncertain` → 删自己的租约行。第一期只有 remux（interruptible），关停延迟 ≤ 5s。

**可观测**：新增 `GET /api/proc/active` → `{ host: boolean, running: Record<kind, number>, pending: Record<kind, number>, leaseAlive: Record<kind, boolean> }`；
`_node-status` 附同结构可选字段 `procActive`（旧 master 忽略）。**不往 `GET /api/tasks` 塞**（它是 TaskDTO 列表，部署 guard 以
`recording===true` 判定，保持不变）。部署 guard 的 AGENTS.md 文字改动只在第二期 biliup 迁移（T15）同 PR 做，第一期无需改
（remux 可安全打断，见 §3）：
> 拟改 AGENTS.md「硬性约束 → 部署安全 guard → 判定依据」一句为：「`GET /api/tasks` 里 `recording === true`(真正在录)，
> **或** `GET /api/proc/active` 的 `running.biliup > 0`(任务表里有上传在跑) —— 任一成立就等。」

**告警**：serve 内执行时 `ctx.alert` 按 `owner.taskId` 投递到该任务的通知/事件中心（与 `@@DREC_ALERT@@` 同等可见）；
record 进程内执行时走 `@@DREC_ALERT@@`（与现 `node-remux` 告警同通道）。

**保留**（F13）：done/cancelled 行 7 天后 GC（runner 每小时一次）；failed/uncertain 不自动删，经 `_proc-gc <dataRoot> [--purge-failed]`
与 `POST /api/proc/purge`（uncertain 需先 ack）人工清。

### 2.4 派发与回执

**第一期（只为留存转格式，kind=remux）**：

- 本机：`LocalTransport.enqueue / procStatus` 直接读写本机表。
- 远端：`_enqueue <dataRoot> <base64>`（`EnqueueRequest{v:1,jobs}` → 单行 `EnqueueResponse{v:1,results:[{jobId,state,nextGeneration?}]}`，
  jobId 含节点回填的 fileTag；`state` ∈ `pending|running|done|stale|rejected`；**`stale` 时附 `nextGeneration`**，master 以该值作
  `generation` 重发一次；`rejected`（含 remux done 后原输入已被替换、`stat` 失败）不重试，见 §2.1）；`_proc-status <dataRoot> <base64-jobIds>` → `ProcessReceipt[]{jobId,state,error?,leaseAlive}`。
- 协商：`NodeCapabilities.processors?: string[]`；缺字段 / 未知命令 → `ProcUnsupported` → 留存转格式跳过 + 标注（D5）。
- **无存活执行者**（F4）：留存转格式是跟随任务、不阻塞 done，master **不等待**；只在随后的对账轮询 `_proc-status`，
  `pending` 且 `leaseAlive=false` 持续 ≥ 60s → 告警一次「节点无执行者，留存转格式待节点 serve 恢复后自动执行」，不回落、不重派。
  remux 不涉及不可逆外部动作，等节点 serve 起来自然续跑即可。
- **节点回滚**（N7）：`_enqueue` 已受理、节点随后回滚旧 bundle → `_proc-status` 报未知命令（`isUnknownCommandError`）→
  在 `sync_jobs.followups` 标注「节点已回滚，留存转格式未执行」并停止轮询该节点的这些 job；**不进 needs_manual**（跟随任务、
  原文件未动）。第二期 `ProcLost → needs_manual` 只适用于 merge/burn/biliup。

**第二期（merge/burn/biliup，粒度到可评审）**：`dispatchAndAwait()` + `sync_jobs.dispatchedVia` 意图标记 + `_proc-cancel`；
回落规则（F4）：`pending` 且无存活租约 ≥ 60s →
master 发 `_proc-cancel`，**仅当节点原子地把从未认领的行置为 `cancelled`**（§2.1 `pending → cancelled` 条件）才回落旧路径；
biliup 另加「intent 为空」条件；其余（已认领、状态未知、命令失败）一律 needs_manual，绝不回落（防二次建稿，#25）。
已受理后 `_proc-status` 报未知命令 → `ProcLost` → needs_manual；已走 `_node-pipeline` 的 streamKey 钉死旧路径。

### 2.5 输出格式新模型（用户已确认）

- 格式只作用于**收尾后留存**的文件；中间产物保持原生容器（录像）或 stage 格式（上传固定 mp4，`effectiveStageFormat`）。
- 拆两个概念：
  - `shouldConvertAtSeal(task, hubDir)`：录制封口是否原地转换；是 `resolveNodeOutputFormat`（`node-remux.ts` 514-520）的唯一输入。
    hub-managed / rolling / **有 enabled 规则绑定** → false。**规则存在但 `enabled=false` → 视同未绑定，回落封口转换**（F3）：
    禁用规则时 hub 不处理该房间（`cli.ts` 1048 `if (!rule || !rule.enabled) return null`），无人收尾，只能在封口时转。
  - `nodeOutputFormatLock`（只管 UI 锁与原因；现 529-539 遍历 `listHubRules` 不看 `enabled`）：**T8 起跳过 `enabled=false` 的规则**
    （与 `shouldConvertAtSeal` 同源，保持「锁 ⇔ 封口不转」不变量，N2；规则禁用的任务不锁、走封口转换）；第一期 T9b 起去掉
    `hub-rule`（enabled 规则的任务改由收尾后转换），新增 `no-survivors`。
- 有 enabled 规则的任务**处理中途绝不转换**；交付 done **且清理完成后**，按 `survivingArtifacts(rule, { stageHasXmlCopy })`
  算留存清单，对容器 ≠ 任务输出格式的**源录像分段**派发 remux（节点源派到该节点，stage 源副本派到本机）。
- **stage 三分 P 成品（plain/danmu/livechat）默认不转**（**D6**）：它们是已上传稿件的同一份文件，保持 mp4 便于对照与重传；
  只转源录像分段。
- **边车**：留存的源分段被转换前，由 remux 处理器在同目录会话边车（`{base}` + `.session` JSON）写 `nodeFormat`（`markSessionNodeFormat`，
  `node-remux.ts` 200）——节点源写节点那份，stage 源副本写 stage 里随 pull 带来的那份副本（#144 起 stage 内有）；
  边车**只作为 `params.sidecar` 传入，绝不进 `inputs` / `replaceInputs`**。stage 副本缺边车（旧 bundle 节点）→ 不派该会话，
  标注「缺会话边车，跳过转格式」（否则转后的 mkv 在 stage 里不被 `groupSessionsInDir` 认领，#143 同类）。
- `stageAfterDone=true` 时 stage 内边车副本已随 `stageVideoLeftovers` 删除，`survivingArtifacts` 不把它们列为留存。
- 规则使收尾后本机不留任何源视频 → 输出格式锁定，原因 `no-survivors`。`hub-managed` / `rolling` 仍锁。
- 网页「合成所选」产物扩展名跟随任务输出格式（`original` → mp4）。

## 3. 不变量映射

| 不变量 | 现在 | 第一期后 | 第二期后 |
|---|---|---|---|
| 校验通过才删原文件 | 仅 node-remux（`verifyRemuxed` 254） | remux 处理器唯一实现（搬移，`function verifyRemuxed` 全仓一处） | 所有 remux（节点侧、master 分段）都经它 |
| xml/ass 不删最后一份 | `xmlKeepRule`（`pipeline.ts` 97-99）+ `keepNodeXml`（276/291/371/687） | 契约层拒 xml/ass/边车进 `replaceInputs`；`survivingArtifacts` 从 `xmlKeepRule` 抽出（同一判定） | 同左；节点侧链以 `stageHasXmlCopy:false` 调用 |
| 录制中绝不转换（规则任务） | `hub-rule` 锁 → `original` | `shouldConvertAtSeal` 只对 enabled 规则返回 false；T9b 前后回归测试 | 不变 |
| 锁 ⇔ 封口不转（同源） | `resolveNodeOutputFormat = lock ? original : outputFormat`（`node-remux.ts` 514-520） | T8：lock 与 `shouldConvertAtSeal` 同样跳过 disabled 规则；T9b：lock 不再含 `hub-rule`，但封口转换仍只看 `shouldConvertAtSeal`，「锁 ⇒ 不转」仍成立 | 不变 |
| 收尾等待有总时限 | `SESSION_END_BUDGET_MS` 3min | 持有租约的 record 进程保留 3min 等待 + 同文案告警 | 不变 |
| 部署可打断性 | 重启杀 record → 封口转换中断，下次启动扫目录接管 | 重启 → remux 行 abort 回 pending，下次接管续跑（不扫目录）；guard 不变 | biliup 非 interruptible：关停等待 + guard 加 `running.biliup` |
| 一场一个 BV（#25）/ 只认返回码（#92）/ 结果未知不重传 | `workflow.ts` 241 `setBv`、`resumeAppends`（`pipeline.ts` 1018）、`UNSAFE_RETRY_NODES`（`reconciler.ts` 100） | **不动** | biliup job intent/confirm；回执 bv 即 setBv；换代前查旧代行；回落仅限「从未认领 + intent 空」 |
| 关水印 / copyright / 仅自己可见 | `app/upload/biliup.ts` 常量 | 不动 | 常量逐字搬入 `processors/src/biliup.ts`，argv 快照测试 |
| 重试上限 3 → needs_manual | `reconciler.ts` 92/596 | 不动 | 不变（按回执 failed 计数） |
| 磁盘准入（I12） | 分散 | remux 用 `freeBytesOf` + `resolveDiskMinGB` | runner 统一 |
| 同场不并发 | `withStreamLock` + `JobDispatcher` | 不动 | 不变；节点表靠 jobId 幂等 |

## 4. 混跑与回滚

第一期矩阵：

| master | worker | 行为 |
|---|---|---|
| 新 | 新 | 全走新路径 |
| 新 | 旧 | `processors` 缺失 → 该节点留存转格式跳过 + 标注；worker 封口转换仍是旧链（对 master 透明） |
| 旧 | 新 | 新 worker 封口转换走本机表，对 master 透明；旧 master 扫描期间节点上可能同时有 `*.drec-remux` tmp 与新文件 —— `groupSessions` 不认未知扩展名、tmp 不被聚类（T6 用例钉住，F14） |
| 新→回滚旧 | 任意 | 旧 master 不派留存转格式；已入队的节点 remux 行照常被节点执行（无害） |
| 任意 | 新→回滚旧 | `proc-queue.db` 被忽略；未完成 remux 的 tmp 保持旧命名 `{final}.{owner}-{pid}.drec-remux`，旧 `recoverNodeRemux` 照常清理；原文件在校验通过前从不删除，**不丢数据**，只是留存文件停在原容器；新 master 对已入队行 `_proc-status` 得未知命令 → 标注「节点已回滚，留存转格式未执行」、停止轮询，不进 needs_manual（N7） |

第二期的混跑（`dispatchedVia` 钉死、`ProcLost`、回滚前提「各节点无 pending/running biliup 且 done 行 bv 已入账」）沿用原设计，开工前细化。

## Global Constraints

- 只有 `accept` 的 issue 才实施；一 issue 一分支；PR base `feat/hub-optimization`；不部署。
- 每个 `feat`/`fix` PR bump 根 `package.json` version 并 `pnpm bundle`（确认 `dist/douyin-rec.mjs` 已更新）。
- 验证门：`pnpm test`、`pnpm typecheck`、`pnpm arch:check`；动前端加 `cd packages/web && pnpm build` + tsc。
- 处理器与 proc-queue 内**禁止** `readdirSync` / `groupSessions*` / 任何目录推导（grep 验收）。
- 不得删除 `recordings/` 下最后一份 `.xml` / `.ass`；契约层拒绝 xml/ass/边车进 `replaceInputs`。
- 每步可独立合并、可独立回滚；旧路径保留到 T18。
- **新包接线清单（只做两次：T3 的 proc-queue、T6 的 processors）**：`packages/<pkg>/package.json`（仿 post-process）；
  依赖方 package.json 加 `workspace:*`；`pnpm install` 提交 `pnpm-lock.yaml`；`vitest.config.ts` alias + `tsconfig.json` paths；
  `RANKS` 登记；补 `scripts/gen-architecture.mjs` 的 `RANK_LABEL` 0.3 / 0.4 两行（N9，否则架构图标签回落 `rank 0.3` 字样）；
  `pnpm arch:gen` 提交生成物；`pnpm bundle` 后 grep `dist/douyin-rec.mjs` 含该包符号。第二期加处理器**不再新增包**。
- 行为变化的任务同 PR 更新 `AGENTS.md` 对应段落（T6：输出格式段的封口转换/接管描述；T9b：输出格式段的锁定与收尾后转换；
  第二期 T15：部署 guard 判定依据，见 §2.3 拟改文本）。

## 第一期 Tasks

顺序：**T1 → T3 → T6 → T8 → T9a → T9b → T11**（T8 可与 T3/T6 并行；T9a 依赖 T3；T9b 依赖 T6/T8/T9a；T11 只依赖 T8 的锁原因类型，
可与 T9a/T9b 并行）。

- [ ] **T1 core Processor 契约 + 注册表 + 状态机**（~260 行，无行为变化）
  - 做什么：§2.1 全部类型；`registerProcessor/getProcessor/listProcessors/_resetProcessors`（对齐 `platform.ts`）；
    `jobIdOf/parseJobId`；`assertJobInvariants(job,{allowedRoots})`；`PROC_TRANSITIONS`（含「未认领 pending → cancelled」）；
    `cancelOutcome`；`EnqueueRequest/Response`（`results[].state` 含 `stale`/`rejected`，`stale` 附 `nextGeneration?`，N1）、`ProcessReceipt`、`decodeEnqueue`；`NodeCapabilities.processors?`。
  - 文件：core 新模块 `processor` + 同名测试（`test/core/`）；`core/src/index.ts`、`core/src/api-types.ts`。
  - 测试：重复注册抛错；xml / 会话边车进 `replaceInputs` 被拒；路径不在 allowedRoots 被拒；`jobIdOf`↔`parseJobId` 往返；
    `uncertain→pending` 不允许；`cancelOutcome('biliup',true)==='uncertain'`；`decodeEnqueue` 拒 v≠1。

- [ ] **T3 `@drec/proc-queue`：`ProcQueueStore` + `ProcRunner`**（~600 行，含原 T3+T4；feat，bump —— serve 每次启动会新建
  `<root>/db/proc-queue.db` 并起常驻循环，N10）
  - 做什么：新包（接线清单）；store：幂等迁移、`enqueue`（jobId 幂等、回填 bigint fileTag（N8）、done 但目标缺失 → `stale` 并附 `nextGeneration`、`inputs[0]` `stat` 失败 → `rejected`）、`nextGeneration`、
    按 kind 租约（含 `handoverRequested`）、`claim(kinds, resource, lane, owner)`（`BEGIN IMMEDIATE`）、`heartbeat`、`finish`（校验持有者 +
    合法迁移）、`requeue`、`ackUncertain`、`requestCancel`、`cancelIfUnclaimed`、`list/get/active`、`gc`。
    runner：租约/心跳/fencing、`(resource,lane)` 限额（第一期内置简单计数器，接口留给 T2 的 `ResourceLimiter`）、磁盘准入
    （`freeBytesOf` + 注入的 `diskMinGB`）、接管时 recover、`stop()` 关停语义（§2.3）、`active()` 快照。
    包导出纯函数 `procQueueDbPath(dataRoot)`；app `paths.ts` 的 `procQueueDbPath()` 转发（N4）；serve 启动 runner（无注册处理器时空转）+ shutdown 首步 `runner.stop()`；`GET /api/proc/active`；
    `_node-status` 附 `procActive`；`_proc-gc` + `POST /api/proc/purge`；GC 7 天。
  - 测试（假处理器）：同 jobId 二次入队不改 done 行；目标缺失 → stale 且 `nextGeneration` 递增；两连接并发 claim 只一个成功；
    `cancelIfUnclaimed` 对已认领行返回 false；持有者心跳停 → 30s 内被接管；`handoverRequested` → 持有者跑完当前 job 后让出；
    关停时 interruptible job 回 pending 且 attempts 不变、tmp 删、inputs 不变；被接管的卡住持有者 `assertLease` 失败 → 不删 inputs；
    磁盘不足保持 pending 只告警一次；gc 不删 failed/uncertain；迁移在两进程同时首开时幂等。
  - 风险：中（新常驻循环）。缓解：本任务无处理器注册、无入队方。

- [ ] **T6 `@drec/processors` remux 处理器 + 录制封口转换迁到任务表**（~550 行，含原 T6+T7；feat，bump）
  - 做什么：新包（接线清单）；`src/remux` 模块逐字搬入 `verifyRemuxed`（254）、`convertSegmentInPlace`（300）、tmp 命名
    `remuxTmpPath/parseRemuxTmpName`（170-178，**命名不变**，保证回滚兼容）、阈值常量、`markSessionNodeFormat/readNodeFormat`；
    导出 `remuxProcessor`（cpu，lane=copy，retryable，interruptible）；`recover`：只有 tmp → 删 tmp → rerun；目标存在且校验通过 →
    done 并删原文件；存疑 → uncertain + `.drec-suspect`，绝不删最后一份。磁盘取值改 `freeBytesOf`。
    `providers-register.ts` 加 `registerProcessor(remuxProcessor)`。`node-remux.ts` 改薄封装：封口钩子 → 入队
    `jobIdOf("remux", task…@fileTag, g)`（入队前写边车 `nodeFormat`，同现在）；record 进程按 §2.3 租约规则宿主 runner，
    收尾保留 3min 总时限等待；store 打开失败 → **回落现有进程内串行链 + 告警**（稳定版兜底）。
    `recoverNodeRemux` 保留，只兜底「不在表里」的旧 tmp（一个版本）。同 PR 改 AGENTS.md 输出格式段。
  - 测试：既有 node-remux 测试全过；仓内 `function verifyRemuxed` 只一处；封口 3 段 → 3 行 pending 且边车已写；
    serve 持有时 record 子进程只入队、收尾不等待；独立 record 持有时收尾等本任务行、3min 超时告警文案不变；
    serve 启动遇 record 持有 → handover 后接管；record 收尾等待中被 serve 接管 → 立即停等、无超时告警（N5）；runner 中途被杀 → 重启续跑，原文件只在校验通过后删；
    store 打不开 → 走旧链；旧 master `_inventory` 期间 tmp 与新文件并存 → 聚类不收 tmp（F14）；
    VPS 真实录制一场（人工、用户安排的场次）。
  - 回滚：旧 bundle 按旧 tmp 命名照常接管。

- [ ] **T8 留存判定 + 锁定原因（纯逻辑，除禁用规则外锁定结果不变）**（~200 行）
  - 做什么：core `survivingArtifacts(rule, { stageHasXmlCopy })` 从 `xmlKeepRule`（`pipeline.ts` 97-99）与 `cleanupSourcesShared`
    （259-332）抽出，pipeline 改用它（`keepNodeXml` 即 `stageHasXmlCopy:false`）；清单区分「源分段 / 三分 P 成品 / xml / 边车副本」，
    `stageAfterDone=true` 时 stage 边车副本归入「随 stage 删除」（与 `stageVideoLeftovers` 73-84 一致）。
    拆出 `shouldConvertAtSeal`（enabled 规则才算绑定）作 `resolveNodeOutputFormat` 唯一输入。锁原因联合类型收到 `core/api-types.ts`
    一处（现 920、`app/web/api/types.ts` 152、`node-remux.ts` 528 三处重复），增 `no-survivors`；`room-form-rules.ts`（100）加文案。
    `nodeOutputFormatLock` 同步跳过 `enabled=false` 的规则（N2，与 `shouldConvertAtSeal` 同源）。**除禁用规则绑定的任务外，本步锁定结果
    与现在相同**（`hub-rule` 仍在）；禁用规则绑定的任务现状本就是「锁住、hub 也不处理」的静默无效，改为不锁 + 封口转换。
  - 测试：cleanSource × stageAfterDone 四组合 × 两种交付模式；stage 边车副本归属；节点侧 × stageAfterDone=false → 节点 xml 留存；
    绑定 enabled 规则且选 mkv → `resolveNodeOutputFormat()==='original'`；**规则 disabled + 选 mkv → 返回 mkv（封口转换）**（F3）；
    **规则 disabled → `nodeOutputFormatLock` 返回不锁**，且对每种规则状态断言「锁 ⇔ `resolveNodeOutputFormat()==='original'`」（N2）；
    既有清理测试不变；web build。

- [ ] **T9a 第一期远端通道：节点侧命令 + capabilities + Transport（无调用方）**（~220 行，feat，bump）
  - 做什么：`_enqueue` / `_proc-status` 隐藏命令（第一期只受理 kind=remux；节点侧 `assertJobInvariants` 用本节点 allowedRoots，
    含本机 `effectiveHubConfig().stageDir`，N3）；`EnqueueResponse.results[]` 对 `stale` 附 `nextGeneration`、remux done 后原输入
    `stat` 失败 → `rejected`（N1）；`_node-capabilities` 报 `processors`；`Transport.enqueue?/procStatus?`（ssh + local，local 用
    `procQueueDbPath(cfg.dataRoot)`；未知命令 → `ProcUnsupported`）。本步无派发方，线上行为不变（仅新命令可被调用）。依赖 T3。
  - 测试：`_enqueue` 拒数据根外且不在 allowedRoots 的路径；**stageDir 在数据根外仍可入队**（N3）；stale 回执带 `nextGeneration`
    且等于节点 store 的下一代；remux done 后同 logicalKey 再入队 → `rejected`；fileTag 用 bigint `ino`（N8，构造 > 2^53 的 ino 断言
    字符串精确）；旧 bundle 节点（未知命令）→ `ProcUnsupported`；local / ssh Transport 往返一致。

- [ ] **T9b 收尾后对留存源分段派发 remux，解锁规则任务**（~250 行，feat，bump）
  - 做什么：orchestrator 新模块 `finalize-format` 的 `planSurvivorRemux()`，pipeline / segment-pipeline 在 done + 清理之后调用
    （fire-and-forget，jobId 记入 `sync_jobs` 新列 `followups` JSON，供对账轮询与展示）；对账轮询回执，`pending && !leaseAlive ≥ 60s`
    告警一次（F4）；stale → 以回执 `nextGeneration` 重发一次（N1）；`rejected` 只标注不重试；`_proc-status` 未知命令（节点已回滚）→
    标注「节点已回滚，留存转格式未执行」、停止轮询、不进 needs_manual（N7）；stage 副本缺边车 → 跳过并标注；
    `nodeOutputFormatLock` 去掉 `hub-rule`，`no-survivors` 生效；同 PR 改 AGENTS.md 输出格式段。依赖 T6/T8/T9a。
  - 测试：全清理 → 不派发；只转容器不一致的**源分段**、不转三分 P（D6）；边车只在 params、不在 inputs；节点不支持 → done 不变、标注一次；
    节点无 runner → 60s 后告警一次、不重派；stale 回执 → 以 `nextGeneration` 重发恰一次；节点回滚（未知命令）→ 标注、停轮询、
    job 状态不变；T9b 前后绑定 enabled 规则任务 `resolveNodeOutputFormat` 均为 `original`；转换后 `groupSessionsInDir` 仍认得该会话
    （节点目录与 stage 目录各一例）；stage 源副本派到本机且 stageDir 在数据根外 → 入队成功（N3）。
  - 验收：处理中途从不转换；上传仍用 mp4。

- [ ] **T11 任务页「合成所选」跟随输出格式**（~120 行，fix，bump）
  - 做什么：`app/src/web/api/merge.ts` 52-54 产物扩展名改由任务 `outputFormat` 决定（`original` → mp4），`merge_jobs` 记录实际路径；
    前端零改动（`MergeJobView` 已显示路径）。原 T11 第一项（cli 424/539 补 `nodeFormats`）**已由 #144 完成，删除**；
    「CLI merge/burn 直接调处理器」移入第二期 T12a。
  - 测试：outputFormat=mkv → 产物 `.mkv` 可被 ffprobe 读、弹幕 xml 同名；`original` → mp4；老 merge job 可查。

第一期结束：用户意图 1 全部落地；意图 2 的「侧进程 / 按序接取」在 remux 上成立；merge/burn/上传路径零改动。

## 第二期（粒度到可评审，开工前再细化为子任务）

- **T2 core `ResourceLimiter`**：从 `workflow.ts` 抽 `Semaphore`（411）+ cpu 内存闸（645-666）；`ResourcePool` 委托，API 与 `PoolSnapshot`
  不变；runner 改用它。`withNet`（668）现无调用方：T2 验收 grep 确认其唯一调用方将是 T12b 的 pull（否则删除）（F12）。
- **T5 完整派发通道**：`_proc-cancel`、`dispatchAndAwait`、`sync_jobs.dispatchedVia`、§2.4 第二期回落规则、旧路径钉死。
- **T12a master 整场 merge/burn 改派发 + 唯一输入推导点（并入原 T10）**：在 `processors` 包加 `merge.ts` / `burn.ts`（包装
  `mergeSessions` / `renderXmlToAss` / `burn`，写出走 `runFfmpegAtomic`，recover 用 `isCompleteMedia`）+ 注册两行；
  `planStageJobs(b, pulledPaths, cfg)`：输入 = pull 清单中的视频 + xml，**`sessionJsonPath` 副本不作输入**，仅用于在派发方按
  `readNodeFormats` 解析该会话的容器以组装显式分段序列；处理器吃显式路径、不再分组 → `unclaimedStageSegments`（`pipeline.ts` 55-62、
  812-829）的目的（防 merge 静默漏段）由「`planStageJobs` 断言 pull 清单中每个视频分段都落入某个 job 的 inputs，否则 needs_manual」
  在派发方取代，同 PR 删除该守卫并迁移其测试（`orchestrator/src/pipeline.test.ts` 1990 起「issue #143」describe 的 2011/2027 两例改钉新断言）。CLI merge/burn 改为组装显式 job 后
  直接 `getProcessor(kind).run`（golden 对拍）；网页「合成所选」入队 merge job；`sync_node_states.generation` + `retryHubNode` 递增。
- **T12b 分段管线改派发 + pull 进 net 限额**。
- **T13 节点侧 `produceParts` 改用本机表**（`_node-pipeline` 协议不变；`awaitLocalJobs` 无租约 60s → failed）。
- **T14 biliup 处理器 + 上传闸统一**（`processors` 的 biliup 模块；上传凭据路径参数化牵动 `node-pipeline`、`pipeline.ts`、web 调用方，估算按 ~500 行）。
- **T15 master 上传改派发**（needs-decision；同 PR 改 AGENTS.md 部署 guard，§2.3 拟改文本）。
- **T16 节点侧作业链 `_enqueue` + `after`** —— **推迟**：`_node-pipeline` 走 ssh 长命令（`transport-ssh.ts` 315-317，30 分钟硬超时）、
  不依赖 worker serve，现状稳定；先让 T13 在 worker 内部用表、协议不变，观察一个月再定。
- **T17 队列页** —— **推迟**：先只在 `/api/hub/queue` 露出本机 runner 的 active 行；节点分组等 T16 定了再做。
- **T18 删除旧路径**（D4 门槛通过后）。

## 决策点

需要拍板的是 D2、D4、D6、D7、D8；D1、D3、D5 审查已同意，按推荐执行，仅备案。

1. **D1 任务表位置（已定）** —— 独立 `<root>/db/proc-queue.db`；任何进程首开都跑幂等迁移（`IF NOT EXISTS` + `user_version`，`BEGIN IMMEDIATE`）。
2. **D2 runner 宿主** —— 要决定：record 进程是否也可宿主 remux。不决定：独立 record 时转换无人执行。
   **推荐**：serve 持有全部 kind；record（含 serve 子进程）只在无存活持有者时持有 remux；serve 用 `handoverRequested` 主动接管；
   持有租约的 record 收尾保留 3min 总时限等待。理由：保持独立 record 现有行为，又不让长时录制霸占租约。
3. **D3 节点并发上限来源（已定）** —— 节点本地 settings；默认复用现行口径（copy 1、cpu 1、net 1），磁盘水位复用 `resolveDiskMinGB`。
4. **D4 第二期上传迁移与旧路径删除门槛** —— 要决定：T14/T15 是否实施、T18 门槛。不决定：上传仍两套代码。
   **推荐**：第一期稳定 ≥ 2 周后再开 T14/T15；T18 门槛 = 两节点均报告全部 processors，且新路径 14 天内**每条** uncertain/needs_manual
   都可归因于人工操作（有 issue 链接）—— 不用「零新增」，因为上传中部署本身就会产生 uncertain（F6）。
5. **D5 留存转格式时机（已定）** —— 跟随任务，不阻塞 done；失败告警、原文件保留。
6. **D6 stage 三分 P 成品是否也转容器** —— 要决定：`stageAfterDone=false` 时 plain/danmu/livechat 是否随任务格式转换。不决定：T9b 范围不清。
   **推荐不转**：它们就是已上传的稿件文件，保持 mp4 便于核对与重传；用户诉求针对的是源录像归档。真有需要再加规则级开关。
7. **D7 队列包归属** —— 要决定：`ProcQueueStore`/`ProcRunner` 放哪。不决定：T3 开工即撞分层。
   **推荐新包 `@drec/proc-queue`（rank 0.3，只依赖 core + `node:sqlite`）**：app、orchestrator、cli 都能直接用，orchestrator 不必依赖 app、
   也不必新增注入口；core 保持纯契约（理由见 §2.2）。
8. **D8 处理器一包还是多包** —— 要决定：一个 `@drec/processors` 还是每处理器一包。不决定：接线成本与 RANKS 形态不定。
   **推荐一个包 `@drec/processors`（rank 0.4，依赖 core + post-process）**：插件性来自 core 契约 + 注册表，不来自包数；
   加处理器 = 一个文件 + `providers-register.ts` 一行；接线清单只做一次。不放进 post-process，是为保持 post-process 为无状态纯函数库
   （处理器带 tmp 命名、recover、租约断言等作业语义）。

## AGENTS.md 硬约束在新模型里如何成立

- **recordings/ 下 xml/ass 不删最后一份**：契约层拒 xml/ass/边车进 `replaceInputs`；处理器只删 `replaceInputs` 列出的视频；
  清理仍只由 master `cleanupSourcesShared` 按 `survivingArtifacts`（即原 `xmlKeepRule` + `keepNodeXml`）执行；第一期 remux 只替换视频分段。
- **部署安全 guard**：第一期 remux 可安全打断（abort 回 pending、原文件不动），`recording===true` 判定不变；第二期 biliup 进表时
  同 PR 把 guard 扩到 `running.biliup>0`（拟改文本见 §2.3），并有关停等待兜底。
- **部署由人**：所有任务 PR 只合并不部署；混跑矩阵保证任意顺序部署安全。
- **上传规则**：第一期不碰上传。第二期硬常量逐字搬入 `processors/src/biliup.ts` 并有 argv 快照测试；人工投稿仍用 `upload-recording-today` skill。
- **不破坏 VPS 生产录制**：T6 的真实验证只在用户安排的场次做，不重启、不删文件。
- **版本规则 / 提交规范**：每个 feat/fix bump + bundle；plan 与代码分开 commit；无 AI trailer。

## 回滚

每个任务单独 `git revert`。数据侧：`proc-queue.db` 对旧 bundle 不可见；remux tmp 保持旧命名；原文件在校验通过前从不删除。
第一期回滚无前置条件。第二期 T15 回滚前提：各节点 proc-queue 无 pending/running biliup 且 done 行 bv 已入账（`_proc-status` 实测贴 PR）。

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
| 新包接线、AGENTS.md / 文档同步未列入任务 | 主要 | Global Constraints 新增接线清单与文档同步要求 |

**第 2 轮**：verdict = revise，分 72；阻断 1、主要 4、次要 3。已全部修订（`dispatchedVia` 意图先写、generation 换代查旧代行、
`stageHasXmlCopy`、fencing `assertLease`、租约按 kind 分行、退出删租约行 / `procQueueDbPath()` 单点等）。

### 返工 R1（PR #147 独立审查，结论 REWORK；用户同意按报告返工，含 §3 砍/推迟）

基线 rebase 到 `a208cc5`（含 #144），§1 全部行号重新实测。F1–F15 处置：

| # | 级别 | 处置 |
|---|---|---|
| F1 #144 推翻 §1.3、T11/T12a 未吸收 | blocking | 采纳。§1.1/§1.3 按 a208cc5 重写（`groupSessionsInDir` 收口、`sessionJsonPath`、`unclaimedStageSegments`、边车随 stage 清空）；T11 删已完成项；T12a 写明 `sessionJsonPath` 只用于派发方解析容器、不作输入，`unclaimedStageSegments` 由派发方断言取代并同 PR 删除、迁测试；T8 把 stage 边车副本纳入留存/删除分类；T9 边车只经 `params.sidecar`、缺边车跳过 |
| F2 队列归属违反分层 | blocking | 采纳选项①：新包 `@drec/proc-queue` rank 0.3（core + node:sqlite）；依赖方向逐包核对见 §2.2；列为 D7 |
| F3 规则 disabled 静默不转 | major | 采纳。`shouldConvertAtSeal` 只认 enabled 规则，disabled 回落封口转换（证据 `cli.ts` 1048 禁用规则 hub 不处理）；T8 加用例 |
| F4 无存活执行者判定 | major | 采纳。回执带 `leaseAlive`；第一期 remux：不等待、60s 告警一次、不回落；第二期：先 `cancelIfUnclaimed` 原子取消成功才回落，biliup 另需 intent 空 |
| F5 record 霸占 remux 租约 / 收尾倒退 | major | 采纳。`handoverRequested`；持有租约的 record 收尾保留 `SESSION_END_BUDGET_MS` 等待与告警文案；D2 更新 |
| F6 关停语义 / 部署 guard | major | 采纳。`Processor.interruptible`；`runner.stop()` 接入 `serve.ts` 395-422 的 shutdown；`GET /api/proc/active` + `_node-status.procActive`；AGENTS.md guard 拟改文本写入 §2.3，随第二期 T15 落地（第一期 remux 可安全打断，不需改）。注：报告引的 `cli.ts` 285-298 是 record 命令的 shutdown，serve 的在 `app/src/serve.ts` 395-422 |
| F7 四个薄包过度设计 | major | 采纳。处理器合一包 `@drec/processors`；契约+注册表在 core；`providers-register.ts` 注册一行；列为 D8 |
| F8 jobId 不一致 | major | 采纳。唯一 `jobIdOf(kind, logicalKey, generation)`；logicalKey 含节点回填的 `fileTag=${ino}-${size}`；stale → `nextGeneration` 重派，写入 T6/T9 验收 |
| F9 plan↔TODO 双向引用 | major | 采纳。文首「TODO：T-N 待分配（合入时补）」；本轮不改 `TODO.md` |
| F10 stage 三分 P 是否转 | minor | 采纳，列为 D6（推荐不转） |
| F11 inputs 路径前缀 | minor | 采纳。`assertJobInvariants` 加 `allowedRoots`（数据根 recordings/stage + 本节点任务 outDir —— 任务目录可在数据根外，故不只认数据根） |
| F12 `withNet` 无调用方 | minor | 实测确认（workflow 节点只用 cpu/upload，`withNet` 仅 `workflow.ts` 903 分派分支可达）；T2 验收：唯一调用方为 T12b pull，否则删 |
| F13 GC 30 天偏长、缺 purge | minor | 采纳。done/cancelled 7 天；`_proc-gc` + `POST /api/proc/purge` |
| F14 旧 master 看到 tmp 与新文件并存 | minor | 采纳。写入 T6 测试与 §4 混跑矩阵 |
| F15 两套磁盘阈值 | minor | 采纳。runner 用 `freeBytesOf` + `resolveDiskMinGB`（与 daemon 同源），删除自造的 1 GiB 常量 |

审查 §3 砍/推迟：四包 → 一包（采纳）；T16、T17 推迟（采纳）；T6+T7 合并、T10 并入 T12a（采纳）；最小可交付序列采纳，
**唯一偏离**：第一期纳入「仅 remux 的 `_enqueue` / `_proc-status`」（并入 T9），因为留存源分段大多在远端节点上，没有远端入队
T9 无法覆盖节点源；remux 无不可逆外部动作，不需要第二期的 `dispatchedVia` / 取消回落机制。

**R1 自批**（以独立审查者视角重读后发现并已修）：

1. 初稿把 `ProcRunner` 的并发直接依赖 T2 `ResourceLimiter`，而 T2 已推到第二期 → 第一期不可独立交付。改为 runner 内置简单计数器、接口留给 T2。
2. 初稿 T11 仍写「CLI 直接调处理器」，但 merge 处理器在第二期 → 第一期 T11 只做网页产物扩展名，CLI 部分移到 T12a。
3. fileTag 初稿用 mtime：remux 写边车会不改视频 mtime，但 `ino-size` 更稳且跨进程一致，改用 `ino-size`；并明确由执行节点回填（master 拿不到远端 inode）。
4. 初稿 `allowedRoots` 只认数据根，会误拒配置了自定义 `outDir` 的任务录像 → 加本节点任务 `resolveOutputDir`。
5. 初稿 F3 处置是「加 `rule-disabled` 锁原因」：会让禁用规则的任务既锁又无人收尾。改为禁用规则回落封口转换（hub 确不处理该房间）。
6. 初稿打算把 `procActive` 塞进 `GET /api/tasks`：它返回 TaskDTO 列表，加顶层字段会破坏形状且与 guard 判定混淆 → 独立端点。
7. 初稿第一期 T6 若 store 打不开则 remux 全停 → 加「回落现有进程内串行链 + 告警」兜底，保证不破坏稳定版。
8. 注意到行为变化：封口转换从「每 record 进程各自串行」变成「节点 copy 通道共享」，已在 §2.3 写明并给出默认值理由。

残余风险：T6 的租约在 serve 与多个 record 进程间的交接只能靠单测 + VPS 一场人工验证覆盖；`volumeFreeBytes`（`disk-gate.ts` 69-73，
`bavail*bsize`）仍被新一场准入闸（110）使用，本计划只让 remux 改用 `freeBytesOf`，准入闸的口径统一应另开 fix issue（行为变化不宜夹带）。

### 返工 R2（PR #147 复审，结论 APPROVE_WITH_CHANGES，无 blocking；逐条落实 N1–N11，不改架构、不扩范围）

| # | 级别 | 处置 |
|---|---|---|
| N1 远端 stale 重派不闭合 | major | `EnqueueResponse.results[]` 对 `stale` 附 `nextGeneration`，master 以该值重发一次；remux done 后原输入已替换、再入队 `stat` 失败 → `rejected` 不重试。写入 §2.1 / §2.4 / T9a / T9b |
| N2 T8 锁与封口转换对 disabled 规则不同源 | major | T8 同时让 `nodeOutputFormatLock` 跳过 `enabled=false` 规则；T8 文案改「除禁用规则外锁定结果不变」+ 「锁 ⇔ original」用例；§3 不变量表加「锁 ⇔ 封口不转」一行 |
| N3 `allowedRoots` 漏可配 stageDir | major | §2.1 加 master 本机 `effectiveHubConfig().stageDir`；T9a / T9b 用例「stageDir 在数据根外仍可入队」 |
| N4 `procQueueDbPath` 放 app，orchestrator 拿不到 | major | 纯函数 `procQueueDbPath(dataRoot)` 由 `@drec/proc-queue` 导出，app `paths.ts` 转发，orchestrator 用 `cfg.dataRoot`；写入 §2.3 / T3 / T9a |
| N5 收尾等待中被接管 | minor | §2.3：等待中发现持有者变为 serve → 立即停等、无超时告警；T6 加用例 |
| N6 TODO 双向引用悬空 | minor | 本 PR 内 `TODO.md`「待办（Next）」新增 T-55（单独 commit），文首回填 T-55 |
| N7 第一期节点回滚后 `_proc-status` 未知命令 | minor | 标注「节点已回滚，留存转格式未执行」、停止轮询、不进 needs_manual；写入 §2.4 / §4 / T9b |
| N8 64 位 inode 精度 | minor | fileTag 用 `statSync(p,{bigint:true})` 后 `String(ino)`；T9a 加用例 |
| N9 `RANK_LABEL` 缺 0.3/0.4 | minor | 接线清单加「补 `gen-architecture.mjs` `RANK_LABEL` 两行」 |
| N10 T3 标「无行为变化」不准确 | minor | T3 改标 feat + bump，写明 serve 启动建库与常驻循环 |
| N11 T9 偏大 | minor | 拆 T9a（节点侧命令 + capabilities + Transport，无调用方）/ T9b（派发 + 解锁）；第一期顺序改为 T1 → T3 → T6 → T8 → T9a → T9b → T11 |
