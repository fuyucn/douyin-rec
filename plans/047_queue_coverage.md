# 047 队列系统全景与覆盖矩阵（给 reviewer 的现状快照）

> 状态：现状快照 + 设计意图 + 已知缺口。**只描述与记录，不含未合入的实作**。
> 前置：plan 036（proc-queue / 处理器）、plan 038（节点上传队列）、plan 039（0 落盘直传）、
> plan 046（按分 P 任务链，已全部合并）。隐私：本文不写房间号、主播名、BV、主机名。

## 1. 为什么要这份文档

plan 046 是「分期计划」，已完成并关闭。但真实生产里上传方式有三种，队列只覆盖其中一部分；
reviewer 需要一份**一眼看清覆盖关系与缺口**的快照，而不是去读 046 的九个分期。

## 2. 三个执行主体（这是理解一切的前提）

| 执行主体 | 位置 | 能做什么 | 不能做什么 |
|---|---|---|---|
| **节点 proc-queue**（`<root>/db/proc-queue.db`） | 每个录制节点 | 认领/执行/重试/对账/清理**文件型**任务 | 接管与录制进程绑定的流式上传 |
| **master 台账**（`sync_jobs` in `douyin-rec-sync.db`） | master | 选优 → pull → merge → burn → upload → 清理 | 直接执行节点上的任务 |
| **录制进程内**（`live-pump`） | 录制子进程 | 0 落盘的流式上传（块与 ffmpeg 并行） | 交出自己的上传给别的 worker |

**硬约束（不可绕过）**：
1. 流式上传与 ffmpeg 同生共死（块来自 stdout，进程一死块就断）。
2. 分层规则：`@drec/zero-upload`（rank 0）只依赖 `core` + `post-process`，**不能**依赖 `proc-queue`（rank 0.3），`test/arch/layering.test.ts` 会拦。
   → zero-upload 若要与队列协作，**只能通过 app 层注入的回调**，不能直接入队。

## 3. 三种上传方式 × 队列覆盖矩阵

| | **边录边传**（rolling） | **直播直传**（0 落盘 + spool） | **整场上传** |
|---|---|---|---|
| 数据源 | 分段文件（`segmentSec` 封口） | ffmpeg stdout（按字节/时间切 P） | 录制完成后的文件集合 |
| 上传时机 | 段封口**后**才开始传 | **边写边传**（块与 ffmpeg 并行） | 收播 + settle 之后 |
| 上传入队 | ✅ `upload-part` | ❌ 不入队（进程绑定） | ✅ `upload-prep` + `biliup` / master 管线 |
| 成功判据 | ✅ 明确信号 + `fp` + 字节核对（采样缺失降级为 unknown） | ⚠️ UPOS 块 ack + `spooledBytes`（口径未与 rolling 统一，见 §6） | ✅ biliup 建稿/append ack |
| 不确定态对账 | ✅ `reconciling`（PR3） | ❌ 无（靠整文件回退） | ⚠️ master `needs_manual` |
| 清理 | ✅ `cleanup-part` 删源 | ❌ **`live-pump` 自己 `rmSync`**（缺口，见 §6） | ✅ master 清理 + `cleanup-part` |
| 跨 worker 认领 | ✅ | ❌ | ✅（节点侧）/ master 侧自管 |

图例：✅ 已入队并可用；⚠️ 部分/不一致；❌ 不入队或缺失。

## 4. 已完成的队列能力（截至 0.0.310）

| 项 | 交付 | 状态 |
|---|---|---|
| 每节点持久队列：租约 / fencing / 保序 / `notBefore` / 场间轮转 / 原子批量入队 | plan 036 + 038 | 已合并 |
| `upload-part`（单 P 上传，确认后同事务链出 cleanup） | plan 046 PR1/PR5 + #518 | 已合并 |
| `cleanup-part`（唯一允许删源的队列处理器 + 架构守护） | PR2 #515 | 已合并 |
| `reconcile-part`（对账，**影子模式**，默认不写库） | PR3 #516 | 已合并（出边已落地，生产写入方待接线） |
| 重试策略统一（去掉 3 次即停、确定性错误即停、告警去重） | PR4 #514 | 已合并 |
| 对账解析器适配真实 `biliup list` 输出 | PR0 #513 | 已合并 |
| 边录边传只入队模式（默认关） | PR6 #529 | 已合并 |
| hub 托管房间写 `skipped(hub-owned)` + `uploadOwner` 单点判定 | PR7 #520 | 已合并 |
| 前端队列页展示链式上传/状态徽标 | PR8 #523 | 已合并 |
| `upload-part` 字节采样不可用的误判修复 | #533 | 已合并（0.0.310） |
| 禁止 `streamUploadSpool=false`（真 0 落盘无回退） | #537 | **进行中** |
| 统一「P 确认成功」口径 + spool 清理入队 | #538 | **待细化（见 §6）** |

## 5. 不变量（任何改动都必须保持）

1. **不双传**：同一场的上传只能有一个执行者。判据是 `uploadOwner`（单点判定）+ 队列 `orderKey/generation/seq` 保序。
2. **不双删**：`.xml`/`.ass` 不得删掉最后一份；删除只经 `cleanup-part`（+ 计划的 `cleanup-spool`）。
3. **删除只由确认触发**：没有「明确成功信号 + 可核对证据」就不删源。
4. **降级必须显式**：采样缺失 → unknown（不判失败，但必须打可检索日志 `byte check unavailable`），不许静默。
5. **开关默认关**：`rollingQueueMode` 默认 `false`，关闭时旧路径字节级不变。
6. **不确定不重传**：`reconciling` 的「无稿」在 settle 窗口未实测前一律按 unknown。

## 6. 已知缺口（按优先级）

### G1（高）直播直传的 spool 清理不在队列里
- 现状：`live-pump` 在 P 确认后 `rmSync(spoolPath)`，清理逻辑与 `cleanup-part` 各自一套。
- 不能硬塞进 `cleanup-part`：它的安全校验要求 `params.sidecarPath === rollingSidecarPathOf(ctx.file)`（`<base>.rolling` 边车），
  而 spool 的 sidecar 是 `live-pump-<room>` 状态文件，规则对不上。放宽校验会重新打开 #533 修掉的任意文件写入面。
- **拟定方案**：新增 `cleanup-spool` kind，校验规则 = `spoolPath` 必须属于该房间 `live-pump-<room>` 状态文件 的 `parts[].spoolPath`；
  `live-pump` 新增 `onPartConfirmed` 回调（依赖方向不变），由 cli/app 注入 → 入队；队列不可用时回退本地删除 + 告警；
  孤儿处理复用已有 `sweepOrphanSpools` / `spoolPathsToKeep` 底座，补「state 已 confirmed 但队列无行 → 补入队」。
- 代价：异步删除，磁盘短暂多占 1 个 P。

### G2（中）0 落盘与 rolling 的「确认成功」口径未统一
- rolling 有 `bv/ack + fp + 字节核对（含 unknown 降级）`；直传有 `UPOS 块 ack + spooledBytes`。
- 语义相同（「明确成功信号 + 可核对本地证据」），表达与实现两套，容易漂移。
- 拟定：抽共用纯类型/纯函数表达三态（`confirmed` / `unknown` / `rejected`），**迁移期不改执行路径**。

### G3（中）`reconciling` 尚无生产写入方
- 出边（`startReconciliation` / `settleReconciling`）已落地，但 `upload-part` 仍未在「提交阶段被打断」时调用 `startReconciliation`。
- 现状：该情形仍落 `uncertain`（人工）。

### G4（中）master UI 看不到节点散任务的队列状态
- `/queue` 只渲染 hub 台账（`sync_jobs`），节点上非 hub 的散任务及其 `upload-part` 链在 master UI 完全不可见。
- 影响：在节点上做队列模式实测时，master 端没有任何观察面。

### G5（低）重试状态持久化与账号暂停接线
- 退避/告警去重状态只在 runner 内存（重启后从头计时，行仍 pending 不丢）；`pauseUploadAccount` 生产未接线。
- 台账 `T-156` 跟踪。

### G6（低）`streamUploadSpool=false` 的存量
- 已确认三节点 35 个 0 落盘任务全部 `true`，无在用 `false` → #537 收紧为零迁移。

## 7. 生产现状数据（2026-11-06 实测，用于判断影响面）

| 节点 | 任务数 | 0 落盘（spool 全开） | rolling 生效 | 在录 |
|---|---|---|---|---|
| master | 28 | 18 | 25 | 0 |
| worker-1 | 11 | 6 | 10 | 2 |
| worker-2 | 17 | 11 | 16 | 3 |

hub 规则：25 条 `rolling` / 2 条 `stage` / 1 条 `upload`。

**结论**：生产以「0 落盘 + spool」为主（35/56 任务）。因此：
- plan 046 的 rolling 队列化**只覆盖少数任务**；
- #533 那个 `acked bytes` 误判只发生在 rolling 分支，不会打到 spool 生产；
- G1（spool 清理入队）才是「队列覆盖全部清理」的关键一步。

## 8. reviewer 需要重点看的三个问题

1. **G1 的方案是否成立**：`cleanup-spool` 的校验（spoolPath ∈ state.parts）是否足够防任意删除？孤儿补入队是否会误删仍在写的缓冲？
2. **G2 的「统一口径」会不会变成第二套判定**：只抽类型是否够，还是应该让直传也走队列？（本文档的立场：**不应该**，理由是 §2 的两条硬约束）
3. **G3/G4 的优先级**：`reconciling` 没接线意味着「自动对账」目前只是空转；`/queue` 看不到节点散任务意味着队列模式的线上观察盲区。这两项是否应先于 G1？
