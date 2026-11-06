# 048 0 落盘 spool 清理入队（cleanup-spool）

> 状态：设计（待实现）。上游：issue #538、`plans/047_queue_coverage.md` §5 G1。前置已合并：plan 046（按分 P 任务链）、#540。
> 术语：**runner** = 每节点 serve 进程内的 ProcRunner；**spool** = 直传时每个分 P 的临时落盘文件；**state** = `live-pump-<room>.json` 会话状态（含 `parts` 与 `pending`）。

## Goal

0 落盘直播直传的 spool 清理从「录制进程内 `rmSync`」改为「入队 `cleanup-spool`」，同时**不放弃**两条既有安全性质：

1. 队列不可用时**仍能清理**（回退本地删除 + 告警），不能因为队列故障把磁盘占满；
2. 删除授权**不低于**现状——现状是「确认已持久化后才删」，队列化不能放宽这一点。

## 为什么不是直接把 `cleanup-part` 复用

`cleanup-part` 的契约是「单个视频输入 + `params.ctx.file === inputs[0]` + `bv` 非空 + `fp` 匹配 + 视频扩展名」（`packages/processors/src/cleanup-part.ts:54-73`）。spool 是**临时文件**：它没有 `bv` 语义（bv 属于稿件，不是这个文件）、扩展名是录制期间使用的临时中间扩展名（不是正式产物名）、且它不在 `recordings/` 视频清单里。

强行复用会要求放宽 `bv` 校验或伪造 bv，等于把「删除证据」变成调用方自证——这正是 047 G1 指出的真实障碍。

> 注意：早期说法「不能复用是因为 `assertSidecarPath` 命名冲突」**是错的**：`assertSidecarPath` 只在 `kind ∈ {upload, reconcile}` 时调用（`packages/core/src/processor.ts:401-403`），`cleanup-part` 走 `assertJobInvariants` 并不校验 sidecar。真实障碍只是上述契约。

## 设计

### 1. 新 kind：`cleanup-spool`

- `PART_KINDS.cleanupSpool = "cleanup-spool"`（`packages/core/src/processor.ts`）。
- 输入：`params.spoolPath`（绝对路径，**唯一输入**，`inputs` 必须为空数组，避免与 `replaceInputs` 混淆）。
- 证据（全部必需，缺一不删）：
  - `params.statePath`：会话状态文件绝对路径（canonical，处理器**自己**派生并重读，不信调用方给的 parts 快照）；
  - `params.partIndex`：≥1 整数，用于在 state 里定位该 part；
  - `params.fp = { size, mtimeMs }`：入队时快照，执行时比对。
- 附加校验（对应 047 G1 的 7 条前置）：

| # | 前置 | 实现 |
|---|---|---|
| 1 | canonical statePath 派生 | `statePath` 必须是 `<dataRoot>/recordings/<...>/live-pump-<room>.json` 形状，且 `spoolPath` 必须与 state 内该 part 的 `spoolPath` **逐字相同**（不信任调用方另给的路径） |
| 2 | room/session 匹配 | `state.roomSlug` / `state.platform` 与 job 的键一致；session 变化（重连新场）不得命中旧 state |
| 3 | 精确 confirmed 且已持久化 | 重读 state，`parts[partIndex].confirmed === true`；state 文件 mtime 必须晚于确认（或含 `confirmedAt`），证明确认已落盘而不是内存态 |
| 4 | 非 pending 引用 | `state.pending?.spoolPath` 若等于该路径 → **不删**（未决上传的唯一恢复副本） |
| 5 | 受限根 realpath | `realpath(spoolPath)` 与 `realpath(statePath)` 都在 `allowedRoots` 内；拒符号链接逃逸 |
| 6 | fp 防路径复用 | 执行前 stat 比对 `size`/`mtimeMs`；不符 → 保留 + 抛错（runner 告警一次） |
| 7 | 执行前重验 + 租约 | `ctx.assertLease()`，且在 assertLease **之后**再读一次 state（缩小 TOCTOU 窗口） |

- 幂等：spool 已不存在 → 成功；state 已不存在 → **不删**（无法证明确认，抛错让 runner 标 failed 并告警）。
- `resource: "cpu"`、`lane: "copy"`、`retryable: true`、`interruptible: true`（与 `cleanup-part` 一致，不与上传抢槽）。
- `estimateDiskBytes()` 返回 0（删除只释放空间）。

### 2. 注入点：`live-pump` 新增可交付回调（不是 observer）

现状：`packages/zero-upload/src/live-pump.ts:2503` 的 `onPartConfirmed?: (info: { count: number; bvid?: string }) => void` 是 **display-only**（载荷不含路径、抛错被吞、CLI 已用于进度，`cli.ts:638`）。**不能**把它改成不可丢投递——那会改变既有语义。

新增**独立**可选回调：

```ts
/** 交付式清理钩子：返回 "queued" 表示队列已接手（本进程不再删）；"unavailable" 表示回退本地删除。 */
cleanupSpool?: (info: { statePath: string; spoolPath: string; partIndex: number; fp: { size: number; mtimeMs: number } }) =>
  "queued" | "unavailable";
```

- 注入方：`packages/cli/src/cli.ts`（与 `--task-id` 同一处，仅在 task/serve 场景注入），`@drec/zero-upload` **不依赖** `@drec/proc-queue`（保持现有依赖集合；rank 允许但设计上仍走回调倒置）。
- `cleanupConfirmed()`（`live-pump.ts:1173`）改为：对每个 confirmed 且 spool 存在的 part，先调 `cleanupSpool`：
  - `"queued"` → 不删（等队列）；
  - `"unavailable"` / 未注入 → 现有 `rmSync` 路径 + 一条告警日志（本机队列不可用，已回退本地删除）。
- `cleanupConfirmedSpool === false` 的既有开关语义不变。

### 3. 队列不可用与入队失败的区分

| 情况 | 行为 |
|---|---|
| 未注入 / 返回 `unavailable`（任务表打不开） | 回退本地 `rmSync` + 告警一次（每 part） |
| 入队抛出（如契约校验失败） | **不删**，告警一次；由孤儿补偿在下次启动时重试 |
| 入队成功 | 本进程不再删；行由 runner 执行 |

回退是**安全兜底**，不是主路径：主路径必须让队列成为唯一删除者（047 §4 的局部不变量）。

### 4. 孤儿补偿（不新增扫描器）

复用现有底座：`live-pump` 启动时已经按 state 的 `parts` / `pending` 判定保留集（`spoolPathsToKeep`）。补偿点就是**同一处**：

- 启动后遍历 state 中 `confirmed === true` 且 spool 存在、但队列中无对应 jobId 的条目 → 入队（幂等 jobId）。
- 与 `sweepOrphanSpools`（`packages/app/src/live-pump-spool.ts:24`，凭名字 + mtime>10 分钟 + keep-set）**分工明确**：
  - **本 PR 不动 sweep**（它没有 active-writer 锁，属于 047 G1 的独立风险项）；
  - 补偿只处理 **state 明确 referenced + confirmed** 的 spool，不碰「名字像 spool 但 state 不认识」的文件。

### 5. jobId 与去重

`cleanup-spool:{statePath}:{partIndex}` —— 同一 (state, part) 永远同一个 jobId，重复入队由任务表幂等键吸收；spool 路径变化（同 part 重建）由 `partIndex` 相同但 `fp` 不同体现 → 执行时 fp 不符 → 保留 + 告警，不会误删新文件。

### 6. 观察面

- 队列页（`/queue`）与节点 `/api/proc/active` 已按 kind 聚合 → `cleanup-spool` 自动出现，无需前端改动。
- 失败/保留事件走既有告警通道（`notify({kind:"error",stage:"清理"})`）。

## Global Constraints

- **不依赖 `@drec/proc-queue`**：`zero-upload` 包依赖集合保持 `core` + `post-process`；队列能力只经回调注入。
- **不改 `cleanup-part`**：它是源录像删除的唯一队列者，契约不放宽。
- **不迁移**：不改 `cleanupConfirmedSpool` 开关语义、不改 state schema 版本（新增字段必须可选、向后兼容）。
- **不新增扫描器**：孤儿补偿复用 `live-pump` 启动的既有 state 遍历。
- **任何「无法判定」→ 保留文件**（不删）。
- 版本 bump：触及 `packages/` → 0.0.311 → 0.0.312 + 重新 `pnpm bundle`。

## 任务

- [ ] T1 `core`：`PART_KINDS.cleanupSpool` + `assertJobInvariants` 分支（校验 `params.spoolPath` 为绝对路径、`inputs` 为空、扩展名允许录制期间的临时中间扩展名）。
- [ ] T2 `processors`：`makeCleanupSpoolProcessor`，按 §1 表 7 条前置实现；单测覆盖：happy path / spool 已不存在 / state 缺失 / 非 confirmed / pending 引用 / fp 不符 / realpath 逃逸 / 租约失效。
- [ ] T3 `zero-upload`：`cleanupSpool` 可选回调 + `cleanupConfirmed()` 三路分派（queued / unavailable / 未注入）+ 回退告警；单测覆盖三路。
- [ ] T4 `cli`/`app`：注入 `cleanupSpool`（taskId 场景），队列打开失败时明确返回 `"unavailable"`；日志脱敏（不写房间号/主播名/BV）。
- [ ] T5 孤儿补偿：启动时对 confirmed+存在+队列无行 的 spool 幂等入队；测试「进程在入队后、执行前被杀 → 重启后仍会入队且不重复」。
- [ ] T6 端到端：0 落盘任务跑一场，确认 `cleanup-spool` 行出现 → done → 文件消失；再模拟任务表打不开 → 回退删除 + 告警。
- [ ] T7 文档：`plans/047` G1 标记为已交付；`plans/046 §4.2` 的模板表更新。

## 验收

- `pnpm test`、`pnpm typecheck`、`pnpm bundle` 全过；动到前端则 `packages/web && pnpm build`。
- 变异验证：撤掉「pending 引用检查」→ 对应用例红；撤掉「fp 比对」→ 用例红；撤掉「realpath 校验」→ 用例红；撤掉回退分支 → 队列不可用用例红。
- 队列行与文件状态一致：done 后文件不存在；failed/保留时文件仍在且告警一次。

## 风险

- **误删**（最高）：靠 §1 的 7 条前置 + 「任何无法判定即保留」兜底；处理器拒绝路径**永不**删。
- **TOCTOU**：assertLease 后重读 state；fp 比对在 unlink 前。
- **队列故障导致磁盘涨**：回退本地删除 + 告警；孤儿补偿保证重试。
- **与 sweep 重叠**：本 PR 不碰 sweep；若两者同时存在，sweep 的 keep-set 已包含 state referenced 的 spool，不会互相删。
