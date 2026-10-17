# 038 节点侧上传队列：biliup 作为 proc-queue 处理器，按「进度停滞」判死、不按总时长

> **TODO：T-62**（`TODO.md`「进行中」）。承接 plan 036 第二期 T14 / T15（biliup 处理器 + master 上传改派发），
> 并取代 plan 033 的 W1-2 与 issue #25 ①（节点侧上传超时预算）。

状态：PR0/PR1 已合并，PR2 起未实施。执行顺序以 swe-loop swe-loop 任务表（sandbox 下） 为准：先合 PR2（不含停滞判死，`mode=blocking`），停滞实测后才由 `biliup-queue` 能力打开 queue；每个任务一个子 issue 链 #207，PR base 保持 `feat/hub-optimization`。基线 `feat/hub-optimization` = `c2c48ff`；PR0/PR1 之前的行号在 `bb353c0` 实测。
隐私：本文与关联 issue 一律不写 streamKey、房间号、BV、主播名、主机名；事故细节只留本地台账。

## 1. 起因（脱敏）

某场节点侧上传（P1 约 443MB + P2 约 300MB）：

- master 按**胜出方第一会话**的字节数（约 0.47GB）估预算 → 30 分钟（下限）。
- 同一节点当时还有另一路 append 在并发上传，biliup 实测仅 0.1–0.2MB/s。
- ssh 到点 SIGKILL，master 随即 `_node-abort`；节点结果文件停在 `phase=uploading`、无 BV；B 站「投稿中」为空 → 确认**未建稿**。
- 事后人工补投：443MB 用 87.8s、300MB 用 60.4s（约 5MB/s），一次多文件 upload 建稿成功。

结论：不是网络坏，是**预算算错 + 同节点并发抢带宽 + 用总时长判死**。

## 2. 现状（bb353c0 实测；标注 c2c48ff 的行为合并后行号）

| 事实 | 位置 |
|---|---|
| 预算只取 `winner.rec.totalBytes`（胜出方第一会话）；其它会话字节未求和。**已修（#203）**：`sumUploadBytes(winnerMembers)` | `orchestrator/src/node-side-upload.ts:404`、`:297`；`select.ts:129-130`（c2c48ff） |
| 保守带宽 1MB/s。**已修（#203）**：0.1MB/s；下限 30 分钟、上限 6 小时不变 | `node-side-upload.ts:284-315`（c2c48ff） |
| 总时长到点 ssh SIGKILL | `orchestrator/src/transport-ssh.ts:72-81` |
| 超时后先 `_node-abort` 再回读结果 | `node-side-upload.ts:183-261`（abort `:197-205`） |
| 节点侧 `uploading` 在上传闸之前就写，语义过宽 | `app/src/node-pipeline.ts`（PR1 已加 `step=gate_wait`；`:783` 才带 `intentPart`），**已由 #205 缓解** |
| `UploadGate.run` 只串行「等配额」，`fn` 本身并发执行；串行链只在进程内 | `core/src/upload-gate.ts:320-328,412-420` |
| 部署 guard 只看 `recording===true` | `scripts/deploy-precheck.sh`（实际判定在 `scripts/deploy-precheck.py`） |
| master 重启 → `sweepStale` 标 failed → 重入 → abort | `orchestrator/src/ledger.ts:357`、`reconciler.ts:516` |
| `-N` 后缀 runNow 新建 key，只拦 `done+bv` | `reconciler.ts` runNow 段（实现时重新定位行号） |
| 慢不换线：`--line` 只在开传前指定 | `app/src/upload/biliup.ts:113`（`--line`；`:179` 是 `upload()` 本身） |
| 失败原因被「不确定」覆盖。**已修（#203）**：note 保留原始失败，error 上限 400 | `node-side-upload.ts:239` 起（c2c48ff） |

**已有、可直接复用**（plan 036 第一期已合并）：`packages/proc-queue`（每节点 `proc-queue.db`、租约、fencing、`uncertain`、
`cancelOutcome`）、`@drec/processors`（目前只有 remux）、`_enqueue` / `_proc-status`、`/api/proc/active`、`(resource, lane)` 限额。
**还没有**：biliup 处理器、`_proc-cancel` / `dispatchAndAwait`、`running.biliup` 进部署 guard（均在 036 第二期）。

## 3. 决定（用户已确认）

1. **选项 1**：一直传到成功或失败；**只按进度停滞判死**；速度只用于 ETA 与告警。不中途换节点（日后可用速度数据在**开传前**选节点，仅双录房间）。
2. **队列放节点，不放 master**：上传数据在节点，master 只下发意图、轮询结果。
3. **不新建 `upload_items` 表**：队列项 = proc-queue 的 `kind=biliup` job，复用其租约 / fencing / `uncertain`。
4. 同一场严格保序（P1 建稿 → append 按 seq），场与场之间轮转；节点并发默认 1。
5. SSH 只做短 RPC；SSH 失败 = 状态未知，**不改状态、不 abort**。

## 4. 设计（相对 plan 036 第二期的增量）

### 4.1 biliup 处理器（对应 036 T14）

- `processors/src/biliup.ts`：硬常量（关水印、copyright、仅自己可见）从 `app/src/upload/biliup.ts` 逐字搬入，argv 快照测试。
- `resource="upload"`、`lane="biliup"`，**默认并发 1**（节点 settings，可调）。`retryable=false`（重试由下面的阶段规则决定，不走通用重试）、`interruptible=false`。
- 阶段 `step`：`gate_wait → transfer → submit`，写进 job 的进度字段（不新增 phase 词表）。
- **预处理用新的 `kind=upload-prep`（共享 helper 从 node-pipeline 行为保持不变地抽出），不复用现有 `kind=remux`**：现有 remux 处理器只接受单个原生分段、`replaceInputs=true`，转完会删源（`processors/src/remux.ts:354,380-397`），用它会把 `recordings/` 的源录像删掉，也无法做组内合并。
  - `upload-prep`：`resource="cpu"`、`lane="copy"`、`replaceInputs=false`；输入是显式分段清单，输出到 stage 的 `.work/`，支持组内 `mergeSession` 与 `.ts` 直传硬链接（复用 `node-pipeline.ts:453-520` 的现有实现并搬入处理器）。
  - **整场的 biliup 行一次性原子入队**（同 `orderKey`、`generation`、`seq=1..N`），不按 prep 完成顺序逐条入队——否则 seq=2 可能在 seq=1 之前被 claim，读不到 BV 而误转 `uncertain`。
  - `upload-prep` 仍可由 master 逐条/批量入队；biliup 行入队后，claim 的门控同时要求「同序号的 prep 已 done」。prep 失败 → 同 `orderKey`、同 generation 的**全部** biliup 行转 `cancelled(order-prep-failed)`（prep 不按 seq 编号），源文件不动。
  - 这样转码不占 `lane=biliup`，也不会删源。
- **`gate_wait` 期间保持 `running` 并持有 `lane=biliup` 槽**（不再写「拿到配额才置 running」）：`step=gate_wait` 不传数据，但串行化提交本身正是账号级限流想要的；代价是冷却期（最长 30 分钟）其它场要等，这与「同账号并发 1」一致。等配额期间不参与停滞判定。
  节点结果文件 `phase` 取值**保持** `started|uploading|done|failed`（白名单 `NODE_RESULT_PHASES` 在 `core/src/api-types.ts:771`，旧 master 不认新值会归 null → 当成「确认没成」→ 重投），新信息只加可选 `step` 字段。
- `runBiliup` 增加 `onSpawn(pid)` / `onLine(line)`（**已合并 #205**）。`step="remux"` 只出现在现有 blocking 路径，biliup job 只会出现 `gate_wait/transfer/submit`；看到 `All files uploaded successfully` 即切到 `submit`。该行缺失或文案变化 → 一律按「submit 不确定」处理（宁可转人工，不重传）。
- **顺序不变量**：`step=submit` 必须在「可能已发生提交」之前落盘；落盘失败 → 不继续提交，按 `uncertain` 处理（宁可转人工）。恢复时若看到 `submit` 而没有 BV → `uncertain`，绝不当 transfer 重跑。
- **关停超时的 `hasIntent` 按 step 推导**：`runner.ts:488` 目前写死 `hasIntent:true`；PR2 改为 `hasIntent = step === "submit"`。
  - **扩展已有的 `releaseForShutdown(jobId, owner, interruptible)`**（`store.ts:497`），不新增第二个入口：新增可选 `step` 参数。对 `step∈{gate_wait,transfer}` 的 biliup job 放行 `running→pending`（`reason="shutdown-abort"`），因为此时已确认子进程被 SIGKILL、尚未提交；`step=submit` 不走这里，仍落 `uncertain`。
  - 只在 `runner.ts:481-488` 的**关停等待超时**后触发；正常关停仍先等最多 `procShutdownWaitMs`（默认 15 分钟）。
  - **回 pending 前必须过两道闸**：①确认子进程真的死了（现有 runner 超时后只 `abort()` 就 `finish`；PR2 先等退出，宽限后 SIGKILL，再用 `childPid + childPidStartedAt` 核验）；②**旁证无稿**（与 §4.3 同一规则：`seq=1` 按时间窗查**全部状态**的稿件 + 时长复核，append 查 `countVideoParts`）。任一无法确认 → `uncertain`，绝不回 pending。
  - 该回退回退 `attempts`（关停不算一次尝试，沿用现有实现），且**不触发** order-blocked 级联；重启后同 `orderKey` 从该 seq 继续。
  - `canTransition` 的 `shutdown-abort` 分支放宽为：`interruptible===true` **或** `kind=biliup && step∈{gate_wait,transfer}`（由 store 传入；缺省仍 fail-closed）。

### 4.2 停滞判定（只按字节进度）

- biliup 在非 TTY 下进度条被隐藏，日志在 `pre_upload` 后静默，**不能把输出当心跳**。
- 候选信号（**先在 VPS 实测选定一条，把命令与输出贴回 #202**）：① biliup 进程树 `/proc/<pid>/io` 的 `wchar` 增量；② checkpoint 文件 mtime/size；③ 套伪终端让进度条输出。
- 判死条件：`transfer` 步内字节增量为 0 持续 `stallMs`（默认 15 分钟）。`gate_wait` **不参与**（无传输）；`submit` **永不 kill**；进程消失给宽限。预处理由 `upload-prep` 承担，不在本判死逻辑内。
- **`submit` 卡住**：`step=submit` 超过 `submitAlertMs`（默认 30 分钟）只告警一次，不 kill；超过 `maxWallMs`（24 小时）转 `uncertain` 并告警，绝不自动重传。**transfer 核验失败时 `hasIntent` 视为 true → `uncertain`**（不能因为 step 不是 submit 就当没传）。**转 `uncertain` 时若子进程仍活着，必须保持 `lane=biliup` 占用直到进程退出**（slot 绑定 pid，不随 job 终态释放），否则会与下一场并列上传，破坏并发 1。告警里给出 pid 与 `_proc-cancel --kill` 操作；人工确认后可强制释放 slot。
- 租约心跳（`heartbeatStaleMs`，按时间）与传输进度（按字节）是**两个信号**，只有后者能判死。
- `gate_wait` 期间不参与字节停滞判定（没有传输），但仍占 `lane=biliup` 槽（串行化提交；见 §4.1 的取舍）。
- 慢（< `slowAlertBps` 持续 `slowAlertWindowMs`）只告警，不 kill。`maxWallMs` 只用于告警 + 停止重试，不 kill。

### 4.3 重试与保序

- `transfer` 失败或停滞、且**确认进程已停** → **先旁证无稿**（与重启恢复同一规则：`seq=1` 按时间窗查**全部状态**的稿件 + 时长/分 P 复核；append 查 `countVideoParts`）；确认无稿才回 `pending` 并带 `notBefore`（5 分钟起指数退避，封顶 1 小时，最多 3 次）；查不到/无法确认 → `uncertain`，不重试。重试重传该 job 的文件（biliup checkpoint 只在单次调用内有效，跨调用不保证续传，ETA 按整段算）。退避期间让出轮转给其它场。
  - **状态机迁移（PR2 必须一起改）**：core `TransitionReason` 新增 `transfer-retry`；`canTransition(running→pending)` 放行 `reason="transfer-retry"`（仅 biliup、仅 `step∈{gate_wait,transfer}` 且进程已确认停止时由 store 使用）。`ProcQueueStore` 新增 `retryTransfer(jobId)`，原子写 `state=pending, notBefore`；**不再加 `attempts`**（claim 时已 `attempts+1`，`store.ts:447`）。「最多 3 次」按 claim 次数计：第 3 次仍失败即不再 `retryTransfer`，转 `failed`。`retryable=false` 继续拦住 `failed→pending` 的通用人工重试。
- `submit` 失败或结果不确定 → 先自动核对（append 用 `countVideoParts`，建稿用按时间窗查**全部状态**的稿件作旁证）；核对不出 → `uncertain`，人工处理。
- 保序：job 带 `orderKey=streamKey`、`seq`、`generation`；**保序只在同一代内成立**（`orderKey + generation`）。
- **generation 按 orderKey 统一分配**：现有 `nextGeneration(kind, logicalKey)` 是按单个 logicalKey 取 MAX+1（`store.ts:277-282`），seq=1..N 会各算各的。PR2 新增 `nextOrderGeneration(orderKey)`：`MAX(generation) WHERE orderKey=?` +1（无则 1），整场共用；`hub-recover-order` 的 `--bv`/`--restart` 也用它，**不按单行算**。换 generation 重入队后，旧代的 failed/cancelled 行不参与新代的 claim 判定，也不会被新代的级联取消波及。
- **claim 改法（PR2 必须一起改）**：现有 `claim` 只按 `createdAt` FIFO（`store.ts:430-433`），也没有 `notBefore` 过滤。改为在同一事务内：
  1. `WHERE state='pending' AND (notBefore IS NULL OR notBefore<=now)`；
  2. 用 `NOT EXISTS` 排除**同 `orderKey` 且同 `generation`** 中更小 `seq` 且 `state != 'done'` 的行；
  2b. 要求 `prepJobId` 指向的 `upload-prep` 行 `state='done'`（`NOT EXISTS` 查 `proc_jobs` 同表）；prep 未 done → 保持 pending；
  3. 场间轮转用**显式游标**，不靠 `updatedAt`（claim 只刷新被认领那一行，同场后续行仍是入队时间，按时间排序会饿死新场）：新增表 `proc_order_cursor(orderKey, generation, lastClaimedAt, PRIMARY KEY(orderKey, generation))`；claim 时对候选按 `(cursor.lastClaimedAt ?? 0) ASC, seq ASC` 排序，成功后更新该 orderKey 的游标。退避中的场因 `notBefore` 被过滤，不占位。
- **store 迁移（按版本逐步）**：现有 `migrate()` 在 `v>=SCHEMA_VERSION` 时直接返回，DDL 只有 `CREATE TABLE IF NOT EXISTS`（`store.ts:225-228`，`SCHEMA_VERSION=1`）——照原样加列，**已有 v1 库不会补列**。PR2 改为按版本执行迁移步骤数组：`v0→v1` 建表、`v1→v2` 逐条 `ALTER TABLE ADD COLUMN` + 建 `proc_order_cursor`，全部在同一 `BEGIN IMMEDIATE` 内。`proc_jobs` 新增 **8 列**：`notBefore`、`orderKey`、`seq`、`step`、`bv`、`childPid`、`childPidStartedAt`、`prepJobId`（`generation` 已在表内，不新增）。另建一张表 `proc_order_cursor(orderKey TEXT, generation INTEGER, lastClaimedAt INTEGER, PRIMARY KEY(orderKey, generation))`。现有 `proc_jobs` 只有 `note/error/resultOutputs`，没有进度、BV 与子进程身份的落点：
  - `step`：runner 在阶段切换时原子更新（与节点结果文件同源，单一写入口）。
  - `bv`：`seq=1` 建稿成功后写入；append 行执行前读同 `orderKey` 的 `seq=1` 行。
  - `hasIntent` 映射：`step="submit"` 即 `hasIntent=true`；`gate_wait/transfer` 为 false。**但 transfer 阶段若核验子进程/无稿失败，调用方必须把 `hasIntent` 强制视为 true**，落 `uncertain`，不得落 `cancelled`。
  - `childPid` / `childPidStartedAt`：`onSpawn(pid)` 落盘。重启恢复时「进程已停」= pid 不存在，或 pid 存在但 cmdline 不匹配，**或** `startedAt` 不匹配（pid 复用）。只有确认已停才清理孤儿（SIGTERM→宽限→SIGKILL）并回 pending；无法确认 → `uncertain`，不起第二个进程。
  - **append 的 BV 来源**：append job 入队时 `bv` 可为空；runner 执行前从 store 读同 `orderKey` **且同 generation** 的 `seq=1` done 行取 BV。`seq=1` 尚未 done → 保持 pending（由 claim 门控，不算失败）；`seq=1` 已 failed/uncertain 而走到这里 → `cancelled(order-blocked)`，不转 `uncertain`。
  - **前序不可完成的处置**：`seq` 更小的行进入 `failed`/`uncertain`/`cancelled` 时，同 `orderKey` **且同 generation** 下所有更大 `seq` 的 pending 行原子转 `cancelled`（reason=`order-blocked`）并告警一次；跨代不级联。既不静默卡住，也不越过前序乱序上传。
  - **`upload-prep` 的重试**：`retryable=true`（纯本地文件操作），失败按 `notBefore` 退避重试，最多 3 次；耗尽后转 `failed`，同 `orderKey` 的 biliup 行落 `cancelled(order-prep-failed)`。
  - **order-blocked / order-prep-failed 的恢复路径**（均走 PR6 工具（`hub-recover-order`，本计划 T11）的 dry-run→`--apply`，默认不改库）：
    - **已建稿**：人工用 `biliup list` / 台账补齐 BV → `hub-recover-order <streamKey> --bv <BV>`：给后续项**换 generation**（`nextOrderGeneration`）重新入队，并把 `seq=1` 行绑定该 BV；新 jobId 不撞 `cancelled` 终态。
    - **prep 失败**：先人工确认 prep 可重跑，`hub-recover-order <streamKey> --prep` 把 `order-prep-failed` 的 biliup 行与对应 prep 一起换 generation 重新入队。
    - **确认未建稿**（`seq=1` transfer 重试耗尽且无 BV）：`hub-recover-order <streamKey> --restart`：从 `seq=1` 起整体换 generation 重新入队。执行前必须按时间窗查**全部状态**的稿件旁证无稿；查不到就不允许 `--restart`。
- 重启恢复：`pending` 原样保留；`running` 且在 `gate_wait/transfer` → 确认子进程已停后回 `pending`；在 `submit` → `uncertain`；已有 BV → 记 done，继续 append。
  - **`transfer` 回 pending 之前必须先旁证无稿**：biliup 打印 `All files uploaded` 后会在同一进程直接提交，落 `step=submit` 挡不住这个窗口。恢复时：`seq=1` 先按时间窗查**全部状态**的稿件并核对标题，再核对稿件时长与本次产物一致（`{name}_{date}` 同日可能撞标题，单靠标题会误判）；append 先 `countVideoParts`。已存在且时长/分 P 对得上 → 记 done/续传；任何「查不到 / 无法确认」→ `uncertain`，**不回 pending**。

### 4.4 master 侧（对应 036 T5 + T15，`needs-decision`）

- **批量原子入队（PR2/PR3 必须一起改）**：现有 `handleEnqueue`（`app/src/node-enqueue.ts:115-135`）逐个 `store.enqueue`，单个被拒不回滚。新增 `store.enqueueBatch(jobs)`，单事务「要么全进、要么全不进」；远端 `_enqueue` 对 biliup 批次返回每条结果，任一条 `rejected` → 整批不落库并回报原因。
- **入队幂等**：首次入队前把 `(orderKey, generation, seq→jobId)` 写进 `sync_jobs`（新列 `uploadPlan` JSON），重入**原样复用**、绝不重新算 generation。SSH 超时（受理结果未知）→ 下轮用同一批 jobId 重发 `_enqueue`；节点的 jobId 幂等回执会把它识别为 `pending/running/done`，不会产生第二份。
- 入队**钉住执行节点**（winner 每轮可能不同，重入不得换节点）；`mode: queue`，回退 `blocking`；回退前要求节点队列无 pending/running biliup（或先取消）。blocking 遇到 `pending/running/uncertain` 队列项返回 409（`uncertain` 在 proc-queue 是终态、但结果未知，必须人工先处理）；`done(无 BV)`/`failed`/`cancelled` 不拦。已认领且 `interruptible=false` 的行最多等 `procShutdownWaitMs`（默认 15 分钟），到点 abort；落点统一走「先核验子进程已死 + 旁证无稿」：确认无稿 → `cancelled`（允许回退），否则 → `uncertain`，**不得按 `hasIntent=false` 直接当没传**。
- 队列模式下 master **不调 `_node-abort`**；轮询 `_proc-status`（每节点 60s）；SSH 失败 = 未知。
- **SSH 失败时一律拒绝放行**：`-N`/`runNow` 若无法确认节点队列状态 → 返回 409（`force` 才放行，且日志写明「状态未知」）。
- 部署 guard 分三态（**唯一口径**，`deploy-precheck` 与 AGENTS.md 同文）：`running.biliup>0` → 等待；端点明确不支持（旧 bundle / 404 / 未知命令）→ 再查节点结果文件有无**未陈旧**的 `phase=uploading`（`atMs` 在 `uploadingStaleMs` 内，或对应 pid 仍存活）——blocking 路径的上传不在 proc-queue 里；有则等待，陈旧/无 → 记录「该节点无法确认」后放行；不可达 / 超时 / 503 → fail-closed 等待。
- `sweepStale` 对「远端队列中」的 job 豁免：以**持久化的 `sync_jobs.uploadPlan`** 为准（master 重启后内存里的 `pool.hasStreamLock` 是空的）。轮询 `_proc-status` 有在途行 → touch `updatedAt`；`uploadPlan` 存在且有非终态 jobId → 即使重启后首次 sweep 也不标 failed。
- `-N` / `runNow`：按**去掉后缀的原 key** 查台账，任一 job 有 BV，或存在 `pending/running/uncertain` 队列项 → 409（`force` 才放行）。
  - **语义变更（needs-decision）**：现有语义是「每次立即执行都是独立任务」，只拦本 key 的 `done+bv`；改成按原 key 拦会挡住「删稿后重传」。删稿后重传必须显式 `force`，并在日志写明旧 BV。该条需在 PR3 开工前由人确认。`biliup list` 只作旁证，不做自动判定。
- `_proc-cancel`（036 T5 的一部分）**必须随 PR2 一起交付**：回退 blocking 前先取消该节点所有 pending 行；已认领的行只能等其收口或转 `uncertain`，不能回落旧路径。

### 4.5 边录边传共用并发槽

边录边传现在在录制子进程里自己跑 biliup（`manager/record-args` + `rolling-upload`），不经队列。目标：入队 `kind=biliup`、与整场上传共用 `lane=biliup` 并发 1。
在落地前不得宣称「节点并发为 1」。**实现方式需单独定**（子进程只入队 vs 带 pid 心跳的跨进程槽），PR4 开工前补设计。

**PR4 设计（2026-10-17 补，待人选定）**

现状实测：两台 worker 都有启用边录边传的任务（一台 6 个、一台 8 个）。`decideUploadMode` 在节点上有边录边传时一律回落 blocking，所以**不做 PR4，`nodeUpload.mode=queue` 在这两台上不会生效**。

- **方案 A：录制子进程只入队。** 每个封口分段变成一条 `biliup` 队列行，由 serve 进程的 runner 统一执行。
  好处：一套执行器，停滞判死/重试/进度全部复用。代价：要把边录边传的 sidecar 状态（已确认段、WAL 意图、BV）和「确认后删该段源」搬进队列；队列目前按设计不删源（T13c），需要新增删源语义。改动面大，回归风险高。
- **方案 B（建议）：节点级跨进程上传槽。** 节点库里一张槽表（持有者 pid + 进程启动时间 + 类型 + 心跳），`BEGIN IMMEDIATE` 内抢占；持有者进程已死（pid+启动时间核对）或心跳过期即视为空闲。边录边传在现有 `gate.run` 处、队列 biliup 处理器在 `gated()` 处各自按**单个分 P**抢槽，传完即放。
  好处：边录边传逻辑与 sidecar 一行不动；槽数取 `nodeUpload.concurrency`（默认 1）。节点广播新能力 `biliup-slot` 后，`decideUploadMode` 不再因边录边传回落。
  注意：槽按分 P 抢，整场上传最多占一个分 P 的时长，边录边传的分段可以插在两个分 P 之间，不会被一整场上传饿住；空出槽时边录边传优先，避免录制盘堆积。停滞判死只覆盖队列上传，边录边传仍走现有路径。
- 两个方案都不改删源口径，都属上传类 `needs-decision`。

### 4.6 参数（`hub.config` 的 `nodeUpload.*`）

| 键 | 默认 | 说明 |
|---|---|---|
| `mode` | `blocking` | T15 之前保持 blocking；节点上报 `biliup-queue`（由 T15 发出）且显式配置后才启用 queue |
| `concurrency` | 1 | 每节点 biliup 并发 |
| `stallMs` | 900000 | transfer 字节停滞判死 |
| `heartbeatStaleMs` | 180000 | 租约心跳过期 |
| `maxWallMs` | 24 小时 | 仅告警 + 停止重试 |
| `maxAttempts` / `retryBackoffMs` | 3 / 300000 | transfer 重试 |
| `pollIntervalMs` | 60000 | master 轮询 |
| `slowAlertBps` / `slowAlertWindowMs` | 262144 / 1800000 | 慢速告警 |
| `submitAlertMs` | 1800000 | submit 卡住告警（不 kill） |
| `uploadingStaleMs` | 3600000 | 部署 guard 判旧结果文件是否陈旧 |
| `unreachableAlertMs` | 1800000 | 节点不可达告警 |

## 5. PR 拆分

| PR | 内容 | 依赖 | 标签 |
|---|---|---|---|
| PR0 | ✅ 已合并（#203）：止血（现有 blocking 路径）：预算对 **winnerMembers** 全部会话求和、保守带宽下调到 0.1MB/s（上限仍 6h）、超时报错带 stderr、不覆盖原始错误、修测试 | 无 | 上传类，`needs-decision`（本次由用户确认开工） |
| PR1 | ✅ 代码已合并（#205）：`runBiliup` 的 `onSpawn/onLine` + 结果文件加可选 `step`；**停滞信号 VPS 实测仍未做** | PR0 | 同上 |
| PR2 | `upload-prep` 处理器 + biliup 处理器 + 阶段/退避/保序 + claim 改造 + store 迁移 + 重启恢复 + `_proc-cancel` + core 迁移 reason + 关停回 pending。**不含停滞判死** | PR1、036 T2 | 同上 |
| PR2b | 停滞信号实测（人工授权一次真实上传）+ 停滞判死 / submit 告警 / `biliup-queue` 能力 | PR2 | 同上 |
| PR3 | master 入队/轮询/不 abort/sweep 豁免/原 key 409（含 SSH 失败）/部署 guard（fail-closed）/回退保护 | PR2，**且 `hub-recover-order` 已合并在内** | 同上（改部署 guard） |
| PR4 | 边录边传接入共享并发槽 | PR2 | 同上 |
| PR5 | ✅ 已合并（#217，0.0.170）：队列页（`/api/hub/queue` 露出节点 biliup 行、最后心跳、ETA） | PR3 | `enhancement` |
| PR6 | 只交付 `hub-recover-order`（T11）：只写队列行，不删源、不上传。`hub-attach-bv` / `hub-clean-sources` 不在本计划。 | PR2 | `needs-decision`（写队列） |
| PR7 / PR8 | Phase 2：传输/提交拆分 + 已传分 P 复用（含许可证决策）；审核通过后才删源（默认关） | PR3 | `needs-decision` |

回滚：每个 PR 单独 revert；PR3 之后切回 `blocking` 的前提是节点队列已空（`_proc-status` 实测贴 PR）。

## 6. 本场处置（不写代码）

冻结 `run`、带 `-N` 的新建任务与 `retry-node`；之后用不在本计划的 `hub-attach-bv`（需另开票）先 dry-run 再 `--apply` 绑定 BV 并标 done；源文件由不在本计划的 `hub-clean-sources`（需另开票）单独确认后删除，保留 xml。

## 7. 测试清单

- 队列模式下 `handleNodeFailure` **不调** `abortNodePipeline`（原始错误保留已由 #203 覆盖）。
- `sweepStale` 对远端在途 job 不标 failed（含 master 重启）。
- 排队等配额超过 `heartbeatStaleMs` 不会被回队；字节停滞才判死；字节在涨 / 进程刚消失不判死；`submit` 无字节增长不杀。
- 出现 `All files uploaded` 之后失败 → 不会第二次 upload；该行缺失 → 按 submit 不确定。
- **PR0 已完成**（#203）：预算对 `winnerMembers` 求和、原始错误不被覆盖，保留既有用例即可，本 PR 不重复实现。
- `submit` 卡住超过 `submitAlertMs` → 只告警、不 kill；超过 `maxWallMs` → `uncertain`，不重传。
- claim：`notBefore` 未到不取；同 orderKey 小 seq 未 done 不取大 seq；场间轮转按 `proc_order_cursor.lastClaimedAt ASC`（不是 `updatedAt`）。
- 重启恢复矩阵：`running` × {gate_wait, transfer, submit} × {有 BV, 无 BV}（remux 不在 biliup job 内）；崩在「写 intent」与「spawn」之间 → 回 pending，不 append。
- 崩溃恢复经 `settleOrphan(rerun)` 回 pending 时 `attempts` 保持（那次尝试已发生），与关停回退不同；连续重启不得额外消耗「最多 3 次」的额度以外的次数（以 claim 次数为唯一口径）。
- 子进程身份：pid 存活但 cmdline/startedAt 不匹配 → 不当作自己的孤儿；无法确认 → `uncertain`，绝不并列起第二个 biliup。
- 关停：`transfer` 核验通过（子进程已死 + 无稿）→ 回 pending 且**不**级联 order-blocked；核验失败 → `uncertain`（不能落 cancelled）。同 orderKey 的后续项保持 pending。
- 无稿核验覆盖全部状态：稿件已过审（不在投稿中）→ 仍判定已存在，不重传。
- v1→v2 迁移：已有 v1 库补齐 8 列与 cursor 表；两进程同时升级幂等。
- `order-prep-failed`：prep 重试成功后 biliup 行可恢复；`--prep` 只跑一次。
- 关停时子进程仍未退出（孤儿 biliup 存活）→ 核验失败 → `uncertain`，重启后不得重新 claim 该 job。
- 重试计数：claim 1 次 + retry 2 次 = 最多 3 次；第 3 次失败后不再 retryTransfer。
- 关停超时：`step=transfer` → `hasIntent=false` → 回 pending；`step=submit` → `uncertain`。
- `hub-recover-order --bv` 与 `--restart` 各自只跑一次；`--restart` 在 `biliup list` 无法确认时拒绝执行。
- 两进程同时入队只产生一条；CAS 认领；`orderKey` 保序（seq 小的未 done 不放行大的）。
- generation：整场 seq=1..N 共用 `nextOrderGeneration` 的值；master 重入不重算（`uploadPlan` 原样复用）；SSH 超时后用同一 jobId 重发只得到一条 job。
- `hub-recover-order --bv/--restart` 的新 generation = 同 orderKey MAX+1，且新代可被 claim（旧代终态不挡）。
- `transfer-retry`：只有 `step∈{gate_wait,transfer}` 且进程已停才允许 running→pending；`submit` 不允许；`failed→pending` 仍被 `retryable=false` 拒绝。
- append 时 `seq=1` 未 done → 保持 pending（claim 门控）；`seq=1` 已 failed/uncertain → 后续 pending 全部 `cancelled(order-blocked)` 且只告警一次（**不**转 `uncertain`）。
- 崩溃在「打印 All files uploaded」与「落 submit」之间 → 恢复先旁证：查到稿件 → done；查不到/无法确认 → `uncertain`，不再发起 upload。
- 场间轮转：A 场连续 claim 时，B 场的 pending 行在下一次 claim 被优先（游标生效）。
- SSH 失败时 -N/runNow 返回 409；`/api/proc/active` 503 时部署 guard 等待。
- `-N` 兄弟 job / 原 key 已有 BV → 409。
- 旧节点无 `_enqueue` kind=biliup（远端只受理 `remux`，`REMOTE_ENQUEUE_KINDS`）→ 按 `_node-capabilities.processors` 判能力后回落 blocking，且只上传一次；回滚演练：队列清空 → blocking，只产生一个稿件。
- `transport-ssh.ts` 注入 `run` 时 `timeoutMs` 被忽略的现有缺口补断言；`node-side-upload.test.ts` 的 fake 方法名写错一并修。
- 部署 guard：`running.biliup>0` 时 precheck 返回等待。

## 8. 审核记录

本方案在落笔前经两路独立审核（Fable 5.1；DeepSeek 用的是 V4.1 Flash，因 V4 Pro 额度用尽、可用列表无 4.1 Pro）。已采纳项落在上文，不采纳项：

- 「租约按账号而非节点」：账号级限制主要卡提交频率而非传输并发，跨节点互斥需节点反连 master，现架构不支持 → 记为已知风险，用告警观察。
- 「节点主动推心跳」：节点通常无外部通知通道、ssh 只能 master → 节点，保留轮询。
- 「把 PR7 提前」：`All files uploaded` 已能分出边界；PR7 牵涉 GPL 许可证决策，留 Phase 2。

已知风险：审核后发现 `origin/feat/hub-optimization` 已有 `proc-queue`，原方案的 `upload_items` 表与 `_upq-*` 命令与之重复，故改为本稿的「biliup = proc-queue 处理器」。

## Global Constraints

- 只有 `accept` 的 issue 才实施；一 issue 一分支；PR base `feat/hub-optimization`；不部署，部署仍由人做。
- 每个 `feat`/`fix` PR bump 根 `package.json` version 并 `pnpm bundle`。
- 验证门：`pnpm test`、`pnpm typecheck`、`pnpm arch:check`；动前端加 `cd packages/web && pnpm build`。
- 不得删除 `recordings/` 下最后一份 `.xml` / `.ass`；上传、删源、删稿、部署、改 hub 规则一律 `needs-decision`。
- 人工投稿仍用 `upload-recording-today` skill；本计划不直接上传任何文件。
