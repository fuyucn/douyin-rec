# 048 0 落盘 spool 清理入队（cleanup-spool）

> 状态：**设计 v2（按独立评审重写，尚未实现）**。上游：issue #538、`plans/047_queue_coverage.md` §5 G1。
> v1 的 11 处事实/设计错误由评审逐条指出并对照源码修正，见 §0。

## §0 v1 错在哪（保留记录，避免重犯）

| v1 说法 | 实际 |
|---|---|
| `inputs` 必须为空数组 | `assertJobInvariants` **直接拒空 inputs**（`processor.ts:375`）；且 `enqueue` 无条件 `fileTagOf(inputs[0])`（`store.ts:333`）、runner 磁盘准入取 `dirname(inputs[0])`（`runner.ts:514`）→ 空 inputs 根本入不了队 |
| `statePath` 派生 + `roomSlug`/`platform`/`confirmedAt` 校验 | state 字段是 `room` / `createdAt` / `updatedAt`，**没有** `platform`、`confirmedAt`（`live-pump.ts:306-345`）；文件名是 `livePumpStatePath` 派生的会话状态文件名（`:366`） |
| 「state mtime 晚于确认」证明确认已落盘 | 没有确认时间戳；mtime 受时钟/元数据影响，不可作为证据 |
| `partIndex >= 1`，用 `parts[partIndex]` 定位 | index 是 **0 基**（`nextPartIndex` = max(index+1)，`live-pump.ts:634`），且 parts 可能稀疏 → 位置 ≠ index |
| spool「没有 bv、不是视频扩展名」 | spool 用的是**视频扩展名**（录制中转态，`:2900`），state 里已有 `bvid`/`aid` |
| `jobId = cleanup-spool:{statePath}:{partIndex}` | 绕过 `#g` 视图契约（`processor.ts:318`）；state 按房间复用、归档后新场 index 从头 → 撞旧行 |
| `unavailable` → 回退本地 `rmSync` + 告警 | 这等于队列故障时删除回到**无租约/无重验/无排斥**的旧路径，与「无法判定即留存」冲突 |
| 「孤儿补偿在下次启动重试」 | `cleanupConfirmed()` 只在**恢复/确认**时调用（`:916/:948/:1032`），**finalize 无调用**；最后一段失败后长跑进程无机会 |
| 「队列页自动出现，无需前端改动」 | 047 已确认 `/queue` 没有节点散任务的 proc-job 列表（`plans/047:81`）；`/api/proc/active` 只有按 kind 的计数 |
| `estimateDiskBytes = 0` 即不受准入影响 | runner 低水位时**即使 need=0 也不认领**（`runner.ts:510`）→ 最需要释放空间时反而不删 |

仍未解决、必须在新设计里回答的一条：**没有 writer 排斥协议**。租约只约束队列持有者，不约束 `live-pump`、手动 CLI、另一个 state 写进程。

## §1 分三个交付阶段（不一次上删除）

| 阶段 | 内容 | 是否删文件 | 上线门槛 |
|---|---|---|---|
| **A. 观察 + shadow** | 只读统计「confirmed 且 spool 仍存在」的条目：数量 / 字节 / 最老年龄 / 拒绝原因分布；shadow 模式下记录 `would-delete` 而不删 | **否** | 无（纯只读） |
| **B. 真删** | `cleanup-spool` kind + 所有权协议 + outbox 补偿 + 状态机 | 是 | A 阶段数据证明「全部 would-delete 都有可信 confirmed/session/文件身份证据」，且拒绝原因可解释 |
| **C. canary** | 单节点、少量任务开启 | 是 | B 阶段零误删、零漏清理 |

本文件描述 A 与 B 的设计；C 是运营动作。

## §2 事实基线（写代码前必须先对照确认）

```
state 文件：<spoolDir>/<livePumpStatePath 派生的会话状态文件>   (live-pump.ts:366)
归档文件：  <state path>.archived-<epoch ms>                   (:412)
state: { schemaVersion:1, room, createdAt, title, tid, tag, desc?, private,
         bvid?, aid?, parts[], pending?, seasonState?, updatedAt }
parts[]: { index(0 基), spoolPath, filename, stem, title, bytes, durationSec, confirmed }
pending?: { kind:"create"|"append", partIndex, stem, title, bytes, durationSec, spoolPath }
spool 文件：录制期间的临时中间扩展名（视频容器）              (:2900)
```

- `updatedAt` 仅在 `persist()` 时更新（确认/恢复/标记 pending），**没有周期心跳** → 不能用「state 陈旧」判定会话已死。
- `parts` 里的条目是**封口后**写入的（`noteUnconfirmedPart`），即 `parts[].spoolPath` 指向的文件此时已不再被 `live-pump` 写入。**活跃写者（正在写的 spool）不在 `parts` 中**——这是本设计最重要的安全依据。
- `state.parts` 与 `state.pending` 是「保留集」的唯一定义（`spoolPathsToKeep`，`:359`）。

## §3 所有权协议（解决「谁有权删」）

删除证据必须同时满足，任何一条不满足 → **留存 + 记录原因**：

1. **同一会话**：`state.room === job.room` 且 `state.createdAt === job.sessionCreatedAt`（sessionId = `room + createdAt`，不可变）。当前 state 不匹配 → 尝试匹配归档 state；归档也找不到 → 留存并标注 `stale-session`。
2. **会话已结束**：当前 state 不匹配即视为会话已结束（新场会复用 statePath 但 `createdAt` 必不同）。这项替代「活跃写者排斥」：**活跃会话的 parts 全部记在当前 state 里，永远走不到第 1 条**。
3. **精确 confirmed**：`find(p => p.index === job.partIndex)?.confirmed === true`（0 基，稀疏数组按 `find` 而非下标）。
4. **路径身份**：`resolve(p.spoolPath) === resolve(job.inputs[0])`；且 `params.spoolPath` 逐字等于 `inputs[0]`。
5. **唯一引用**：把 `parts` 与 `pending` 的全部 `spoolPath` 做 `resolve` 后统计，该路径**必须恰好出现 1 次**（自身那条）；出现 ≥2 次（含 pending 别名指向）→ 留存 `ambiguous-reference`。
6. **根校验**：`realpath(inputs[0])` 与 `realpath(statePath)` 都在 `allowedRoots` 内（拒绝符号链接逃逸；`realpath` 失败 → 留存）。
7. **文件指纹**：入队时快照 `{size, mtimeMs}`，执行时比对；不符 → 留存 `fingerprint-mismatch`（路径被复用）。
8. **执行临界区**：`ctx.assertLease()` **之后**重新读一遍 state 并重跑第 1–7 条，再 `unlink`。窗口无法完全消除（无跨进程锁），但把「读旧快照 → 删」压缩到「紧邻 unlink 的重验」；且第 2 条决定了**只有非活跃会话**才会进入。

**明确不做**：不引入新的跨进程锁协议（`live-pump` 不参与，单边锁只会制造虚假安全感）。代价：仍存在极窄 TOCTOU 窗口——用第 2/5/7/8 条把窗口内容限定为「同一非活跃会话内、路径唯一、指纹未变」。这个残余风险在 A 阶段用 shadow 数据量化。

## §4 阶段 A：观察 + shadow（先做，零风险）

- 新增只读汇总函数（`@drec/zero-upload` 或 `app`，纯函数，不做 IO 之外的事）：
  ```ts
  inspectConfirmedSpools(state): Array<{
    partIndex; spoolPath; bytes; ageMs;
    verdict: "would-delete" | "stale-session" | "ambiguous-reference" | "not-confirmed" | "missing-file";
    reason: string;
  }>
  ```
  规则即 §3 的 1–7（不含 8，因为不删）。
- 指标暴露：节点 `/api/proc/active` 增 `cleanupSpool` 段（`inspected` / `wouldDelete` / `wouldBytes` / `oldestAgeMs` / `reasons`），**按 kind 聚合计数**（与现有形态一致，不加行级枚举）。
- shadow 模式：`recordNodeRemux` 风格的 dry-run —— 只写日志（脱敏，不写房间号/主播名/BV/文件名），不删。
- **A 阶段不上队列行**，因此不需要 ProcRunner 改动。

## §5 阶段 B：真删（在 A 的数据支持下）

### 5.1 kind 与契约

- `PART_KINDS.cleanupSpool = "cleanup-spool"`。
- `inputs = [spoolPath]`、`outputs = []`、`replaceInputs = false`。
- `params = { spoolPath, room, sessionCreatedAt, partIndex, fp: { size, mtimeMs } }`；`params.spoolPath === inputs[0]`（与 `cleanup-part` 同一写法）。
- `statePath` **不来自 params**：处理器用 `livePumpStatePath(dirname(spoolPath), params.room)` 自己派生，消除「调用方给错 state」这一整类风险。
- jobId 走 `core.jobIdOf("cleanup-spool", logicalKey, generation)`；`logicalKey` = `${room}:${sessionCreatedAt}:${partIndex}`（含不可变会话身份，避免跨场撞行）。
- `resource:"cpu"`、`lane:"copy"`、`retryable:true`、`interruptible:true`、`estimateDiskBytes(): 0`。

### 5.2 回执状态机（不是 queued/unavailable 二元）

| 入队结果 | 含义 | 行为 |
|---|---|---|
| `queued` | 已持久化、身份已验证、有 runner 会认领 | 本进程不再删 |
| `deferred` | 当前 state 不匹配 / 会话仍活跃 / 指纹暂不一致（可恢复） | 写 outbox，`notBefore` 退避后重试（有界：最大重试次数 + 最大年龄后转 `stale`） |
| `rejected` | 契约或确定性校验失败（如引用的 spool 从未 confirmed） | 终态，**留存文件**，告警一次 |
| 入队抛出（IO/DB 临时失败） | 未落库 | 写 outbox，本地**不删**，按退避重试 |

关键：`store.enqueue` 的 `rejected` 是**返回值**不是异常（`store.ts:328/333`），处理器必须按上表分派，不能统一当 queued。

### 5.3 持久 outbox（解决「长跑进程不再重启」）

- state 新增可选字段 `spoolCleanupOutbox?: Array<{ partIndex; spoolPath; fp; sessionCreatedAt; attempts; lastAttemptAt }>`（可选、缺省空 → 向后兼容，不改 `schemaVersion`）。
- 写入点：`cleanupConfirmed()` 遇到 `deferred`/抛出时 append（同一 part 幂等）。
- 重放点：①下一次 `persist()` 后；②`finalize()` 结束时**再跑一次**（v1 缺这一条）；③进程重启时（`recover` 已有入口）。三者都失败 → 保留 outbox，A/B 阶段的指标可见。
- 成功入队即从 outbox 移除。**outbox 只记录意图，不删文件**。

### 5.4 低水位豁免

`cleanup-spool` 必须在磁盘低于水位时**仍被认领**（它唯一的作用就是释放空间）。需要 runner 准入判断加一个按 kind 的豁免（`need === 0 && kind === "cleanup-spool"` 放行）；这条要单独测试，否则「最需要清理时反而不清理」。

### 5.5 与 sweep 的分工（不变）

- `sweepOrphanSpools` **本设计不动**（它缺 active-writer 锁，是 047 G1 的独立风险项）。
- 本设计只处理 **state 明确引用 + confirmed + 唯一引用** 的 spool。

## §6 观察面（上线门槛，不是「自动出现」）

- `/api/proc/active` 增 `cleanupSpool: { inspected, wouldDelete, wouldBytes, oldestAgeMs, queued, deferred, rejected, failed, reasons: Record<string,number> }`。
- `/queue` 不改行级列表（那是 047 G4 的事）；先接入上面的聚合数字。
- 告警：`rejected` 与 `stale` 各告警一次（去重）。

## §7 任务（按阶段）

**A 阶段（本 PR，可先只做这一半）**
- [ ] A1 `inspectConfirmedSpools`（§4 判定表，纯函数）+ 单测矩阵：首段 index=0 / 稀疏 parts / pending 别名 / 非 confirmed / state 不匹配 / 文件缺失 / realpath 逃逸。
- [ ] A2 `/api/proc/active` 增 `cleanupSpool` 聚合段 + 测试。
- [ ] A3 shadow 日志（脱敏）+ 开关（默认只观察）。
- [ ] A4 在一台节点上跑一天，汇总 `would-delete` 与拒绝原因分布。

**B 阶段**
- [ ] B1 `core`：`PART_KINDS.cleanupSpool` + 契约分支（`inputs` 必须恰 1 个、`params.spoolPath === inputs[0]`、`replaceInputs=false`）。
- [ ] B2 `processors`：`makeCleanupSpoolProcessor`（§3 八条 + §5.2 状态机）；导出并注册（`providers-register.ts`）；同步精确删除站点白名单（`test/arch/processors-deletion-guard.test.ts`），**不放宽整个 guard**。
- [ ] B3 `zero-upload`：`cleanupSpool` 交付式回调（与既有 display-only `onPartConfirmed` **分开**）+ `cleanupConfirmed()` 三路分派 + `finalize()` 重跑 + outbox。
- [ ] B4 `runner`：低水位豁免（§5.4）。
- [ ] B5 补偿：outbox 重放（persist 后 / finalize / 重启）；测试「确认落盘后、入队前崩溃」与「入队后、执行前崩溃」两个不同窗口。
- [ ] B6 文档：`plans/047` G1 标记为「A 完成 / B 待 canary」，`plans/046 §4.2` 更新。

## §8 验收

- 变异验证：撤「唯一引用」→ 别名用例红；撤「会话匹配」→ 跨场复用用例红；撤「指纹」→ 路径复用用例红；撤「低水位豁免」→ 认领用例红；撤「finalize 重跑」→ 最后一段用例红。
- A 阶段的 shadow 数据必须能解释**每一条** `would-delete`（有 confirmed + 会话匹配 + 唯一引用 + 指纹一致）。
- B 阶段 on-canary：done 后文件消失；任何拒绝路径文件仍在且告警一次。
- 全量 `pnpm test` / `typecheck` / `bundle`；版本 0.0.311 → 0.0.312。

## §9 剩余风险（明示）

- **无跨进程锁**：残留 TOCTOU 窗口，靠 §3 的条件组合收窄；A 阶段量化、B 阶段 canary 验证。
- **state 归档后的证据**：只在归档 state 里匹配；找不到即留存（不猜）。
- **旧版本节点**：不认识 `cleanup-spool` → 该 kind 的行在旧节点上不会被认领；上线顺序必须是「先升级节点，再开 shadow，再开真删」。
