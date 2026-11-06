# 046 按分 P 的任务链：封口 → 上传 → 清理，节点队列驱动、自动重试、把人工干预降到最低

> **状态：设计定稿（2026-11-05）。§7 的三个决定已按各条「建议」执行（用户指示「完成设计，开始分配」）；分期见 §10，从 PR0 起开工。**
> 承接 plan 036（proc-queue / 处理器）与 plan 038（节点上传队列）；补上它们没覆盖的「按分 P 的链式驱动」与「不确定态自动对账」。
> 隐私：本文不写 streamKey、房间号、BV、主播名、主机名；事故细节只留本地台账。

## 1. 目标

用户的模型（原话提炼）：

- 录制 worker **封口一个分 P** → 往队列放一个**上传任务**；
- 上传任务**确认成功** → 创建一个**清理任务**（删源 / 留 stage，按规则）；
- 另有 worker 从队列**认领**执行；**失败自动重试**，总能做完，不靠人手动 `requeue` / `ack`；
- 上传失败**绝不删源**；
- hub 模式下，节点侧这些任务在队列里记为 **skip**。

验收口径：**「需要人处理」的状态只剩真正无法自动判定的极少数**，其余都自动收敛到 done。

非目标：不换运行时；不动录制引擎；不改 B 站硬标准（关水印、仅自己可见等）；直播直传（zero-disk，无落盘文件）不在本链内（见 §9）。

## 2. 现状（2026-11-05 在 main `294ccc7` 实读，纠正此前口头说法）

已经有的（不要重造）：

| 能力 | 位置 |
|---|---|
| 每节点持久队列：租约 / fencing / `orderKey+generation+seq` 保序 / `notBefore` 退避 / 场间轮转游标 / `enqueueBatch` | `packages/proc-queue/src/store.ts`（`nextOrderGeneration`、`enqueueBatch`、`retryTransfer`、`cascadeOrderBlocked`） |
| 处理器：`remux`、`upload-prep`、`biliup`（含停滞判死、`gate_wait→transfer→submit` 阶段） | `packages/processors/src/*` |
| **B 站稿件对账（无稿旁证）**：三种状态过滤取并集，`unknown` 绝不当「无稿」；时长 / 分 P 数复核（注意：B 站数据滞后，查不到 ≠ 没有） | `processors/src/archive-lookup.ts`、`biliup.ts` |
| **有界自动重试**：`transfer` 失败且确认进程已停、旁证无稿 → 退避重入（5 分钟起，封顶 1 小时，最多 3 次） | plan 038 §4.3 |
| master 经 `_enqueue` / `_proc-status` 派发并轮询（整场一条 prep→biliup 链，`sync_jobs.uploadPlan` 持久化） | `orchestrator/src/node-upload-queue.ts`、`node-upload-poll.ts` |
| 恢复工具（人工）：`hub-recover-order --bv / --prep / --restart` | `packages/cli/src/hub-recover-order*.ts` |

**没有的（本计划要补）：**

1. **按分 P 的链**：现在的队列链是「整场」粒度（prep 一条 + biliup 一批），由 master 轮询推进；**不是**「一个 P 封口就入队上传、确认后入队清理」。
2. **边录边传（rolling-upload）不经队列**：录制子进程自己跑 biliup，靠节点槽（plan 038 方案 B）与队列共用并发 1；确认后「只删该段」的逻辑写在 `rolling-upload.ts` 里，状态在 会话旁的边录边传 sidecar。plan 038 当时否决了方案 A（子进程只入队）：要把 sidecar 状态与删源语义搬进队列，改动面大。**本计划就是方案 A。**
3. **清理不在队列里**：master 管线 `cleanupSourcesShared` / `survivingArtifacts` 直接执行；队列 biliup 处理器按设计「绝不删源」（`node-upload-complete.ts` 头注释）。
4. **不确定态一律转人工**：`uncertain`、`needs_manual`、`order-blocked`、`ambiguous` 目前都要人 `ack` / `hub-recover-order` / 看稿件。设计初衷是「重试可能造成重复稿」，所以保守——但对账能力已经有了，只是没接到「自动收敛」上。
5. 失败重试**次数耗尽即停**，而且停的位置不统一（`failed` / `needs_manual` / `uncertain`）。
6. **前置缺陷（2026-11-05 在 VPS 上实测，biliup 1.2.11 与 1.3.4 同）**：`archive-lookup.ts` 的 `parseArchiveList` 要求 `biliup list` 输出 JSON，而真实输出是**带日志行的制表符文本**（`BV号<TAB>标题<TAB>状态`）。用代码里完全相同的参数（`list <过滤> -m 3`）实测，JSON 解析必然失败 → `listAllArchives` 返回 `null` → `findRecentArchive` **恒为 `unknown`**。现有单测只用手写的假 JSON，所以没暴露。后果：plan 038 的「无稿旁证」在线上从未生效，所有「不确定」都落到人工。本计划的 `reconciling` 依赖它，所以**修它是 PR0（前置）**。（`countVideoParts` 走网页接口，是 JSON，不受影响。）

## 3. 设计原则

1. **删除只由确认触发**：`cleanup-part` 只能由 `upload-part` 的 `done` 创建，且执行时再校验一次（§5.4：只校验自己这边的 ctx，不查 B 站）。
2. **不确定 ≠ 失败 ≠ 成功**：不确定态走**自动对账**，只有对账给出明确的「有」或「无」才推进；`unknown` 只重新对账，**永不重传、永不删源**。
3. **链的下一步与上一步完成在同一个事务里落库**（outbox 思路）：`upload-part` 标 done 与插入 `cleanup-part` 同一 `BEGIN IMMEDIATE`；崩在中间要么两者都在、要么都不在，不存在「传完没人删」的丢步。
4. **jobId 确定性 + 幂等入队**：沿用 `jobIdOf(kind, logicalKey, generation)`；重复入队返回已有行。
5. **失败不吞噬数据**：任何路径下，源文件保留到「确认 + 清理任务执行」为止；磁盘告急由已有的拒绝新开录闸门兜住，不靠删未确认源腾空间。
6. **人只被叫一次**：同一故障只告警一次（带冷却），且告警文案给出下一步，而不是「请检查」。

## 4. 架构

```
录制进程（只写文件 + 入队，不再自己上传）
   │ 封口一个分 P（已有封口判定：core.sealedSegmentIndices）
   ▼
 enqueue  upload-part(P_k)        orderKey = 同场键, seq = k
   │                               （room 为 hub 托管 → 记为 skipped，见 §6）
   ▼ 节点 ProcRunner 认领（serve 进程，一个节点同一 kind 只有一个执行者）
 upload-part  ── P1：建稿，写 bv；P2..：append（单文件一次提交）
   │ 成功 = 拿到确认（BV / append ack），同一事务插入 ↓
   ▼
 cleanup-part(P_k)                 校验 → 按规则删该段源（xml/ass 永不删，沿用 xmlKeepRule）
   ▼
  done
```

要点：

- **队列仍是每节点一张 `proc-queue.db`**；master 本机也是一个节点（`local`），同一套机制。不新建第二张队列表。
- **新增两个处理器 kind**：`upload-part`（由 `biliup` 处理器收窄为单分 P 语义，复用 argv / 硬常量 / 停滞判死 / slot）、`cleanup-part`（`resource=cpu/io` 轻量、`retryable=true`、幂等：文件已不在 = 成功）。`upload-prep` 在「已是 mp4/ts 单段直传」的常见路径可省略，保留给需要合并的场景。
- **保序**：同场沿用 `orderKey + generation + seq` 与既有 claim 门控。分 P 按封口顺序逐条入队（不是整场原子入队）；因为 seq 小的先封口先入队，claim 的 `NOT EXISTS 更小 seq 未 done` 仍成立。**空分 P / 被丢弃的分 P 必须显式入一条 `skipped` 占位行**，否则 seq 出洞会让后面的永远等（详见 §8 风险 1）。
- **同场续稿**（相邻会话间隔 ≤ `SAME_BROADCAST_GAP_MS`，#148）：后会话继承前序 BV 并 append——`orderKey` 取「同场键」而不是会话键，BV 从同 `orderKey` 同 `generation` 的 `seq` 更小的 done 行读（plan 038 已有此机制）。

### 4.1 ctx 契约：链上每一步只靠它指向「哪一个 P、哪个文件、哪份稿件」

`upload-part` 与 `cleanup-part` 是**同一个 ctx 往下传**，各自是一个纯函数：`step(ctx) -> ctx'`。ctx 持久化在队列行里（不靠内存），所以换进程、换 worker、重启都不影响。

| 字段 | 含义 | 现有对应 |
|---|---|---|
| `v` | ctx 版本（先写 1，便于以后加字段） | `uploadPlan.v` |
| `orderKey` | 同场键（不是会话键，见 §4 同场续稿） | `ProcessJob.orderKey` |
| `index` | 分 P 序号，从 1 起 | `ProcessJob.seq` |
| `file` | 该分 P 的**绝对路径**，只此一个视频文件 | `ProcessJob.inputs[0]` |
| `fp` | 文件指纹 `{size, mtimeMs}`，入队时取 | **新增** |
| `bv` | 稿件号；**空 = 本场还没有已确认的稿件**，有值 = 继承 | `job.bv` / seq 更小的 done 行 |
| `meta` | 投稿参数（标题、tid、tag 等）；整场共用，放 `params`，不逐 P 复制 | `params` |

传递规则：

- **`upload-part(ctx)`**：`bv` 空 → 建稿；有值 → append。返回 `ctx'`，其中 `bv` 一定非空（拿到确认才返回）。
- **`cleanup-part(ctx')`**：直接用 `ctx'` 的 `file / index / bv / fp` 完成校验与删除，**不重新扫目录、不重新推导路径**。
- **后一个 P 的 ctx**：入队时 `bv` 可为空，认领前由 runner 从同 `orderKey`、同 `generation`、`seq` 更小的 `done` 行读出 `bv` 填入；前序未 done 则不被认领。
- **同场续稿**：后会话的第一个 P，ctx 里的 `bv` 来自前序会话的 done 行，不是空。

三条约束（把「更容易指向」变成「不会指错」）：

1. **路径必须显式、绝对、且经过校验**：沿用 `assertJobInvariants` 与 `allowedRoots` + realpath 校验；ctx 里**只放视频文件**，xml / ass / 会话边车永不进 `file`。
2. **删除前核对指纹**：`cleanup-part` 先比 `fp`，不一致（同名文件被替换、重命名后复用路径）→ 不删，转 `skipped(source-changed)` 并告警一次。防止「按路径删到另一个文件」。
3. **biliup 为改分 P 标题会在 `.upload/` 下硬链接别名**：别名随 `cleanup-part` 一并清掉，但别名路径不进 ctx，由处理器按 `file` 推出（单一规则，不另存一份）。

### 4.2 工作流模板：三种模式只差「何时入队」与「删除粒度」

任务类型（`upload-part` / `cleanup-part`）与 ctx 对三种模式**完全一样**；差别只在两个触发点，写成一张模板表（单一真理源，处理器与钩子都读它，不在各处各写一份）：

| 模式 | `upload-part` 何时入队 | `cleanup-part` 何时入队 | 清理范围 |
|---|---|---|---|
| 0 落盘直传（live-pump） | 不入队：进程内边收流边传（流式，无法交给别的 worker 认领） | 每个 P **确认后** | 该 P 的 spool 缓冲（`spoolMode=full` 时才有） |
| 边录边传（rolling） | 每个 P **封口时** | 每个 P **确认后** | 该 P 的视频源 |
| 整场上传（含 master 管线） | **下播确认后**一次创建整场（受同场口径 `SAME_BROADCAST_GAP_MS` 约束） | **最后一个 P 确认后**（整场全部 done） | 整场源与 stage，沿用 `survivingArtifacts` |

两点说明：

- **清理粒度**用 `scope = part | order` 表达：`part` 由单个 P 的 done 触发；`order` 由「同 `orderKey` 同 `generation` 下全部 P 都 done 或 skipped」触发。两者共用同一套校验（§5.4），不另写第二份。
- **0 落盘模式下队列的角色只剩两件事**：确认后清 spool；进程崩溃后接管「未确认的 P」（现有 `livePumpHasUnconfirmed` 一类状态）。流式上传本身不改，不并入队列认领。

### 4.3 两层视图：分 P 的 ctx（看不到后面）与整场视图（只给界面看）

- **分 P 的 ctx**（§4.1）只含自己的 `index / file / fp` 与前一个 P 留下的 `bv`。**当前任务不知道后面还有没有 P**，也不知道自己是不是最后一个；上传只有一个判断：`bv` 空则建稿、有值则 append。
- **整场视图**由界面从队列行**统计**得出（同 `orderKey`、同 `generation`）：已 done / 进行中 / 待办的 P、`sealed`（已封口数）、`final`（本场是否已确认结束）。**不存成一份大家都改的 ctx**（多 worker 并发写会互相覆盖，也会和队列行对不上），不参与任何上传决策。
- 「整场是否完成」= `final` 且 seq 1..`sealed` 全部为 `done` 或 `skipped`；`final` 在相邻会话间隔超过 `SAME_BROADCAST_GAP_MS` 后才为真（断流重连还会 append 到同一稿件）。
- **第一版不做 `finalize-order` 任务**：加入合集已在 P1 建稿成功后做（`addArchiveToSeasonIfConfigured`）；写台账 / 通知 hub 与 0 落盘各有现成做法；B 站分 P 数滞后，不能当作「完成」的核对依据。确有「整场只做一次」的动作时再加。

## 5. 自动重试与「不确定」自动对账（本计划的核心）

### 5.1 分类（每个 kind 一张表，写进处理器契约，不散落）

| 失败类型 | 判定 | 动作 |
|---|---|---|
| 传输失败 / 停滞（确认子进程已停） | 现有判定 | 先**对账旁证无稿**，再退避重入；**次数不设「耗尽即停」**，见 5.2 |
| 限流 / 槽被占（601、21566、`slot-busy`） | 现有判定 | 不算尝试，`notBefore` 后重入 |
| `submit` 阶段中断 / 进程被杀 | `step=submit` | **进入 `reconciling`**（5.3），不是 `uncertain` 终态 |
| 租约丢失 / 节点重启 | recover | 沿用：传输阶段对账后回 pending；`submit` 阶段进 `reconciling` |
| `cleanup-part` 失败（IO、权限） | 抛错 | 幂等，退避重试；永不影响 upload 终态 |
| 入队失败 / ssh 抖动（master 侧） | 现有 | 沿用 `uploadPlan` 重入，指数退避 |

### 5.2 退避与「总能做完」

- 退避：5 分钟起，翻倍，**封顶 1 小时**（沿用 038 常量）。
- **不再以「3 次」终止**：在源仍保留、磁盘水位正常的前提下，**以封顶间隔无限重试**；每个任务只在「首次连续失败满 `stuckAlertMs`（建议 6 小时）」时告警**一次**，之后静默重试，恢复时发一条「已恢复」。
- 保护阀：磁盘低于水位 → 沿用拒绝新开录；账号被限流 → 全局冷却，不逐任务狂重试。
- 取消的来源只有：用户显式停止 / 规则被删 / 源文件被人为移走（此时转 `skipped(source-gone)` 而不是失败）。

### 5.3 `reconciling`：把 `uncertain` 从「等人」变成「定时自己查」

新的非终态 `reconciling`（取代绝大多数 `uncertain` / `needs_manual` 出口）：

1. 对该分 P 向 B 站对账：P1 用「时间窗 + 标题 + 时长」查三种状态的稿件；append 用 `countVideoParts` 看分 P 数。**B 站的列表与分 P 数是滞后的**：查到 = 可靠的正面证据；查不到 = **不可靠**（可能只是还没出现）。所以对账只对「有」放行，对「无」要特别保守（见下）。
2. 结果三态：
   - **有（对得上）** → 记 done（写 bv），触发 cleanup 链；
   - **无（三个过滤都明确查到且不含）且已过 settle 窗口** → 回 `pending` 重传（一次、带 generation 保护）。**settle 窗口不拍脑袋定，用实测的 B 站延迟分布推出**（见 PR3 的影子测量）；测量完成前**不启用**这一分支，「无」一律按 `unknown` 处理；
   - **unknown（查询失败 / 解析失败 / 窗口内）** → 保持 `reconciling`，下一轮再查（退避同 5.2）。
3. **settle 窗口**（自最后一次可能提交的时间起；数值由实测延迟的高分位数加余量得出，**此前文档里的 30 分钟只是占位，不是结论**）：窗口内查不到只能是 `unknown`，防止重复稿。
4. **时间盒**：`reconciling` 超过 `reconcileMaxMs`（建议 24 小时）仍 `unknown` → 才转 `needs_manual`，**告警一次并写明具体怎么处理**（去创作中心看哪个时间窗），并保留源。这是**唯一**需要人的出口。
5. 对账本身是一个很轻的处理器 kind（`reconcile-part`，`resource=net`），**不占 `lane=biliup` 上传槽**。

> 这一步的残余风险（重复投稿）是本计划最需要人拍板的点，见 §7 决定 2。

### 5.4 「成功」的定义与清理前再校验（防误删）

**`upload-part` 只有同时满足以下三条才算成功**（不能只看进程返回码 0，也不依赖 B 站列表）：

1. biliup 给出**明确的成功结果**：建稿解析出 `bv`；append 收到 ack 且没有 `APPEND_AMBIGUOUS_MARKER`。退出码 0 但没拿到 `bv` / ack → 不算成功（现有行为，保持）。
2. **本地字节核对（有样本才精确比对，#532 返工 1 定的口径）**：只有「边界那一刻读到完整字节样本」时才用它精确比对 ——
   biliup 已确认发送的字节数（`readTcpAcked`）≥ 文件大小，且文件指纹 `fp` 与入队时一致。**无样本（null）等于未知，不是 0 字节**：
   此时仍要求第 1 条（biliup 明确成功信号）+ `fp` 一致，并写一条可检索的退化日志（`byte check unavailable`）；
   **字节证据未知**包括没有任何正值 `bytes_acked`（清单为空、全 0 或缺少数字 token）以及传输期间见过的 socket 在边界前已消失（累计值只是下界）。
   **已批准的产品决定**：字节证据未知本身不导致上传失败；若 biliup 给出明确成功信号（建稿 `bv` / append 无歧义 ack）且 `fp` 一致，确认成功并照常链出 `cleanup-part`（会删源）；只有缺少明确成功信号、`fp` 不一致或确实采到样本且小于文件大小时才不确认、不清理并保留源。多连接（`--limit 3`）下分块 socket 提前关闭是常态，字节核对多数退化，把关落在 `fp` 一致和明确成功信号上；退化时用稳定日志串 `byte check unavailable` 统计比例。挡住「文件仍在写入、传的是截断版本」的能力由此变为
   「`fp` 一致 + biliup 明确成功信号 + 有完整样本时严格比对」三层。
3. 满足前两条才创建 `cleanup-part`。

可选的更保守做法 **「延迟删除 + 正向核对」**（配置项，默认关）：确认后过一段时间再删，到点向 B 站查，**查到才删**；一直查不到 → 不删、保留源并告警一次。它只在「查到」时放行，B 站滞后只会让删除变晚，不会误删。代价是源文件多占一段磁盘，不适合磁盘紧张的边录边传。是否默认开，看 PR3 影子模式统计的「已确认但迟迟没在 B 站出现」的比例；实测≈0 就不需要。


`cleanup-part` 执行时：

- 读同 `orderKey` 的 `upload-part` 行，必须 `state=done` 且 `bv` 非空（append 另需 ack 记录）；
- **不查 B 站列表 / 分 P 数**：B 站数据滞后，用它做删除前置条件会把清理无故拖慢，查到「无」还可能误判。删除的依据只有上传自己的明确成功信号（建稿拿到 `bv`、append 拿到 ack），即 `upload-part` 行 `done`；
- 文件已不存在 → 视为成功（幂等）；
- 只删视频类扩展名（沿用 `assertJobInvariants`：xml / ass / 会话边车永不进 inputs）。

### 5.5 持久化与重启恢复

队列已经是持久化的：每节点 `<root>/db/proc-queue.db`（`node:sqlite` WAL），任务、ctx、状态、`notBefore` 都在库里。重启语义沿用现有机制（plan 036 / 038）：

- `pending` 原样保留；`running` 的行等租约过期后由新持有者 `recover()` 接管，判定重跑 / 已完成 / 无法判定；
- 关停：可中断的任务直接回 `pending`；上传在传输阶段被打断 → 先对账无稿再回 `pending`；提交阶段被打断 → **进 `reconciling`（§5.3）**，不再落人工；
- “上传 done + 入队 cleanup”同一事务（原则 3）。两个 kind 在**同一节点同一个库**，所以能同事务；
- 录制子进程只入队、serve 进程执行，沿用「每 kind 本机至多一个存活持有者」的租约规则；serve 未起时行留在库里，起来后继续。

**缺口（本计划要补）：封口与入队不是原子的。** 录制进程在文件封口之后、写入队列之前崩溃 → 磁盘上有文件、队列里没有任务，这个 P 永远不会被上传。对策：

- **孤儿文件扫描**：节点启动时与之后定期，扫描已封口的视频文件（封口判定沿用 `core.sealedSegmentIndices`），队列里没有对应 jobId 的，用确定性 jobId 补入队。重复补入队幂等。（现有 `recoverNodeRemux` 只兜 remux 的孤儿，不覆盖上传。）
- **队列库丢失**（数据目录被清空）：同一道扫描按磁盘文件重新入队；已确认过的 P 由对账发现稿件已存在而直接记完成，不重复上传。
- 扫描只补入队，**不删任何文件**。
- master 侧台账 `sync_jobs` 是另一个库，不属于节点队列，本计划不改。

### 5.6 并发：一个队列、多路同时完成

一个节点仍是一张队列、一个 serve 进程里的 runner；「多路」= runner 同时认领多行、起多个子进程（biliup 是子进程），不是多个队列也不是多个持有者。

可并发的边界：

- **同一场（`orderKey`+`generation`）内部必须串行**：P2 需要 P1 的 `bv`（ctx），同一稿件被多路 append 会冲突、分 P 顺序会乱；现有 claim 的「更小 seq 未 done 则不认领」已保证。
- **不同场之间可并发**，由现有场间轮转游标保证公平。
- 并发限额沿用现有 `(resource, lane)` 机制：上传 `lane=biliup` 用 `nodeUpload.concurrency`（默认 1，与边录边传共用节点级槽，plan 038 PR4）；`cleanup-part` 默认 2（纯本地 IO）；`reconcile-part` 自成一个 lane（轻量联网查询），**不占上传槽**。
- **账号限流冷却（601 / 21566）必须全节点共享**，不能每路各管各的（已有 account gate），否则多路只会更快触发限流。

并发上传不一定更快，**先实测再调**：plan 038 记录过同节点两路上传抢带宽、速度只有 0.1–0.2MB/s 而判停滞。上行带宽已被一路占满时，多路只会互相拖慢；只有单路受限于 B 站单连接速度而非上行带宽时才有收益。VPS 机器很小（曾内存紧张、CPU steal 高），每路 biliup 子进程也要占内存。

做法：并发数做成可配置；上传默认保持 1；在 VPS 上**只读实测一次**（同时传两个不同场，比较总速度与单路），总速度确实高才把该节点调到 2。验收里的测试：同场串行、不同场并行、账号冷却全节点共享、并发数为 1 时与现状行为一致。

#### 调度算法（每轮 tick，沿用现有 claim，只增通道与配置）

1. 对每个通道，正在跑的数量未达并发上限则继续认领。
2. 可认领的行 = `pending` 且 `notBefore` 已到，且：同 `orderKey`+`generation` 里 `seq` 更小的行都已 `done`（保序）；依赖的前置（如 prep）已 `done`；上传类另需节点上传名额有空、账号限流冷却未开。
3. 候选按场间公平排序：每场的「上次被认领时间」最久者优先（现有游标），同一场内按 `seq`。
4. 认领成功即起子进程并开租约心跳。

通道与默认并发：`biliup` 上传 1（实测总速度提升不少于 30% 且无停滞 / 限流增加才调 2）；`cleanup` 2；`reconcile` 2（不占上传名额）；`copy`（prep / remux）1。账号限流冷却全节点共享。并发数为 1 时行为与现状一致。第一版为固定配置；是否做自动调节等拿到测量数据再定。

#### 同一场内「上传一条线、删除一条线」并行

并行由依赖关系决定（边录边传模式）：

| 时刻 | 正在跑 | 说明 |
|---|---|---|
| 上传 P1 时 | `up P1` | 本场再无可跑的：`up P2` 需要 P1 的 `bv`，`del P1` 尚不存在 |
| P1 确认后 | `up P2` + `del P1` | **同时跑**：一个占网络、一个占本地 IO，互不依赖 |
| P2 确认后 | `up P3` + `del P2` | 同上 |
| 任意 | `up P2` + `up P3` | 不行（同一场上传串行） |
| 任意 | `del P1` + `del P2` | 可以（不同文件，独立） |

**实现要点：`cleanup-part` 行不带 `orderKey` / `seq`。** 上传行在 P 封口时就入队（此时前序可能还在传），靠 `seq` 挡住；删除行只在对应上传 `done` 的同一事务里创建，依赖已由「创建时机」保证，不再需要排队。若误给删除行加 `seq`，`del P2` 会被「更小 seq 未 done」规则挡在 `del P1` 后面，两条线就并不起来。验收测试：`up P2` 运行中时 `del P1` 可被认领；删除行没有 `orderKey` / `seq` 的断言。

0 落盘直传：流式上传在进程内运行，P1 确认后队列删它的 spool，同时进程已在传 P2，天然并行。整场上传模式：整场传完才删，同一场内没有并行，只有不同场之间并行。

## 6. hub 模式下的 skip

当前 hub 的整体流程是：master 汇总各节点清单 → 选优 → pull 到 stage → merge/burn/upload → 清理（`orchestrator/src/pipeline.ts`）。此时**节点自己上传会造成双传**，所以：

- 规则里新增归属：`uploadOwner = node | master`（由「该房间是否被 enabled 的 hub 规则绑定」推出，**唯一判定点**，沿用 `shouldConvertAtSeal` 一类的单一函数风格，不在两处各写一份）。
- `uploadOwner=master` 时，节点封口钩子仍会为每个分 P 写一条 **`skipped(hub-owned)`** 行：终态、无副作用、**不链出 cleanup**。目的：队列里有完整时间线（UI 看得到「这个 P 被谁负责」），且 seq 不出洞。
- master 侧的 merge / burn / upload / cleanup **第一期保持现状**（`sync_jobs` 状态机）。把它们也收进 master 本机队列、让 hub 对账器只负责「选优 + 入队」，是第二阶段的统一方向（§9），不在本期。
- 规则之后才绑定 / 解绑时的边界：沿用 `outputFormat` 的先例——**下一个封口的分 P 起生效**，已入队的行不改。

## 7. 需要人拍板的决定（「决定三行」）

**决定 1：失败后是否「无限重试」（封顶 1 小时间隔、首告警 6 小时）而不是现在的「3 次即停」？**
- 不决定会怎样：任何持续性故障（B 站限流、网络、登录凭证过期）都会在 3 次后落到人工，这就是现在的人工干预来源。
- 建议：是。登录凭证过期这类**确定性错误**单独识别，立即告警并暂停该账号的上传（不空转）。

**决定 2：`reconciling` 对账得出「无稿」后，是否允许自动重传？（B 站数据滞后，「无」不可靠）**
- 不决定会怎样：`submit` 阶段被打断的分 P 永远等人看稿件。
- 建议：**先只自动处理「有」**；「无」在拿到 B 站延迟的实测分布、据此确定 settle 窗口之前，一律当 `unknown`（继续定时对账，超时盒后转人工）。数据到位后再决定是否开启「无 → 重传」。残余风险：窗口不够 → 重复稿（可删稿，但**删稿需人工**）。

**决定 3：边录边传是否迁成「录制进程只入队」（plan 038 方案 A）？**
- 不决定会怎样：边录边传这条路径仍在录制进程里上传，上面所有自动化（对账、无限重试、统一告警）都覆盖不到它；而这正是节点磁盘压力最大的路径。
- 建议：迁，分阶段、带开关、老路径保留一个版本（见 §10）。

## 8. 风险与对策

1. **seq 出洞**：空分 P、一帧尾巴、被丢弃的分段会让后面的行永远等前序。对策：封口钩子对每个 seq 必写一行（`pending` 或 `skipped`），并有测试钉住「丢弃分段也占位」。
2. **录制进程只入队 → 状态搬家**：已确认段号、WAL 意图、BV 现在在 会话旁的边录边传 sidecar。迁移时队列行成为唯一真相，sidecar 只留向后兼容读取（老文件按「已确认段」导入为 `done` 行，缺字段按保守处理）。
3. **删除语义变化**：队列 biliup 处理器当前「绝不删源」；新增 `cleanup-part` 是**唯一**允许删源的队列处理器，且只由 done 触发（原则 1）。加架构守护测试：processors 包内除 `cleanup-part` 外禁止 `unlink/rm`。
4. **重试放大风控**：无限重试可能放大 B 站限流。对策：账号级全局冷却（已有 601/21566 gate）；退避封顶 1 小时；确定性错误立即停。
5. **旧节点 / 混跑**：新 kind 经 `_node-capabilities` 广播能力，master 见不到能力 → 回落旧路径；`_enqueue` 对未知 kind 返回 `ProcUnsupported`（已有先例）。
6. **盘满**：失败重试期间源保留，磁盘会涨。对策：沿用 `shouldRefuseNewRecording` 水位；水位告警同步给人（这类才是必须人处理的）。
7. **biliup 不能插入分 P**（1.2.11 / 1.3.4 的 `append` 只能追加到稿件末尾，无位置参数，也没有改序 / 删除分 P）：分 P 顺序完全由上传顺序决定，所以同一场必须串行；`reconciling` 里的重传**只对「当前稿件的最后一个分 P」安全**，否则补传的分 P 会排到后面造成顺序错乱——此时不自动重传，转人工。丢弃的分 P 仍用 `skipped` 占位（顺序不受影响）。
8. **biliup 版本**：VPS 已升到 1.3.4（回滚路径见本地记录）；1.3.x 改了「失败后重试分段」与「append 保留已有分 P 的 cid」，真实上传 / append 行为需在下一场真实上传后核对。

## 9. 范围外 / 后续

- 直播直传（zero-disk，plan 039 / 043）：**流式上传本身**留在录制进程内、不并入队列认领（见 §4.2）；其失败语义（看门狗、封口、追稿）单独治理。本计划只接管它的「确认后清 spool」与「崩溃后接管未确认 P」。
- master 侧 merge / burn / upload 进队列、hub 对账器退化为「选优 + 入队」：第二阶段，另立 plan。
- 前端：队列页按分 P 展示链（upload → cleanup）、`reconciling` 与 `skipped` 的徽标；只渲染后端字段，不自判状态。

## 10. 分期（每期可独立上线、可回滚）

- [ ] **PR0 修复对账解析器（前置，独立可上线）**：`archive-lookup` 按真实 `biliup list` 输出（带日志行的制表符文本，剥 ANSI、取 `BV<TAB>标题<TAB>状态` 行）解析；用**真实输出样本**做测试夹具（脱敏）；解析不出任何已知结构时仍返回 `null`（`unknown`），但**日志要写明原因**，不再静默；补一条测试：真实形态输入能得到 `yes/no`。影响所有现有 `findRecentArchive` 调用点（传输重试旁证、关停旁证、`hub-recover-order`），属上传类，PR 需写「决定三行」。
- [ ] **PR1 契约与状态机**：core 新增 kind 常量、`skipped` / `reconciling` 状态与迁移表、`upload-part → cleanup-part` 同事务链接口；proc-queue 迁移（按版本步进）；不接任何调用方。
- [ ] **PR2 `cleanup-part` 处理器 + 架构守护**：幂等、校验、`assertJobInvariants`；「只有它能删」的守护测试。
- [ ] **PR3 自动对账 `reconcile-part`**：接 `archive-lookup`；时间盒；先**只读 + 日志**（影子模式：把本来会转人工的场景记录「对账会得出什么」），并**测量 B 站延迟**：对每个已拿到 `bv` / ack 的上传，记录从确认到在列表里出现所用时间，得到分布后才定 settle 窗口。
- [ ] **PR4 重试策略统一**：5.1 / 5.2 表落进处理器契约；去掉「3 次即停」；确定性错误识别；告警去重。
- [ ] **PR5 master 整场链改为按分 P 链**（节点 `upload-prep` 之后）：复用现有 `uploadPlan` 持久化与 `_enqueue`。
- [ ] **PR6 边录边传迁移（方案 A）**：录制进程封口钩子只入队；sidecar 兼容导入；开关默认关；灰度后默认开，保留旧路径一个版本。
- [ ] **PR7 hub `skipped(hub-owned)` 与 `uploadOwner` 单一判定点**。
- [ ] **PR8 前端队列页**。

PR 顺序理由：先立契约和「只有一个地方能删」，再上对账（影子 → 生效），最后才动录制进程这条高风险路径。PR3 之前**不改任何线上行为**。

## 11. 测试清单（行为变更必须有测试）

- 链：upload 标 done 与 cleanup 入队同事务——故障注入「在两者之间崩」，重启后恰好一条 cleanup、不丢不重。
- 删除守卫：upload `failed` / `reconciling` / 无 bv → cleanup 不创建或拒绝执行；撤掉守卫测试必须红。
- 对账：`yes / no / unknown × settle 窗口内外` 全矩阵；`unknown` 永不重传；窗口内「查不到」不得判无稿；窗口参数未配置时「无」按 `unknown`。
- 清理：不调用 B 站查询（注入的查询函数被调用即测试失败）；upload 行 `done` 且 ctx 合法即可删。
- 重试：退避序列与封顶；确定性错误（登录凭证过期）立即停且只告警一次；恢复发一条「已恢复」。
- 保序：丢弃 / 空分 P 占位 `skipped`；同场续稿从前序读 BV；跨 generation 不级联。
- hub：`uploadOwner=master` → 只写 `skipped`、不链 cleanup、不双传；规则绑定 / 解绑边界。
- 迁移：老边录边传 sidecar（含 `ambiguous`、缺字段）导入；旧节点无能力时回落。
- 架构：`test/arch/layering.test.ts` 登记；processors 包「除 cleanup-part 外禁删」grep 守护。

## 12. 数据验证方案：哪些保险需要、哪些不需要（先定阈值再看数据）

| 问题 | 测什么 | 取数 | 需要（加保险） | 不需要（简化） |
|---|---|---|---|---|
| 延迟删除 + 正向核对 | 「已确认但迟迟没在 B 站出现」的比例 | 对已确认上传只读轮询列表（1/5/15/30/60/120 分钟） | 出现任何到 24h 仍没出现的 | 样本 ≥200、跑满 2 周，一个都没有 |
| settle 窗口 | 确认到「在列表出现」的耗时分布 | 同上 | 取最大值的 2 倍；样本少 / 长尾不稳则不开「无→重传」 | — |
| 「无」自动重传 | 影子判「无」的案例里之后才出现的占比（假阴性） | 影子对账日志 + 后续回查 | 假阴性 >0 | 选定窗口下假阴性为 0 且样本 ≥100 |
| 自动对账本身 | 每周落到 `uncertain / needs_manual / order-blocked` 的 P 数与原因 | proc-queue 库 + `sync_jobs` + 节点日志 | 每周多起且人工结论多是「其实已传好」 | 一个月内基本为 0 |
| 无限重试 | 失败原因占比与重试成功率 | 同上 | 瞬时类（停滞 / 限流）占多数且重试后多成功 | 多为确定性错误 → 只需立即告警 |
| 上传并发调 2 | 同时传两个不同场 vs 单路的总速度（各 ≥3 次、不同时段） | VPS 只读实测 | 总速度提升 ≥30% 且无停滞 / 限流增加 | 提升不足或出现停滞 |

通用规则：「0 个」不等于「不会发生」，必须写样本量；每个指标都有只读取数方式；影子模式只记录「系统本来会怎么判」，不执行。**PR0 之前，对账恒为 `unknown`，上表涉及对账的指标都无法测量**，所以 PR0 先行。

## 13. 待确认的开放问题

1. `reconcileMaxMs`（24h）、`stuckAlertMs`（6h）是否取这些默认值？settle 窗口**不预设**，待 PR3 的延迟测量结果。
2. 「清理」默认动作是删节点源，还是仅在 hub 规则 / 房间配置里显式开启才删（现状是显式开关，建议保持）？
3. 对账走 `biliup list`（现有，按时间窗全量三次查询）是否够用，还是要为分 P 级校验补一个按 BV 取分 P 列表的轻量查询？需在 VPS 实测延迟与限流后定。

## Global Constraints

- 上传 / 清理 / 删除 / hub 规则相关的实现 PR 一律 `needs-decision`，先按「决定三行」拿到人的结论；`pr-risk-scan` 命中 RISK 不自动合并（沿用 AGENTS.md）。
- 不改 B 站硬标准（关水印 `watermark.state=0`、copyright=1、`--is-only-self`）。
- `.xml` / `.ass` 永不进 `cleanup-part` 的 inputs；保护口径沿用「不得删掉最后一份」。
- 不在日志 / issue / PR 里写 streamKey、房间号、BV、主播名、主机名；每次开票与评论前跑 `python3 scripts/issue-guard.py <file>`。
- 版本规则：触及运行时路径的 PR 才 bump；本文件本身是 `plans/`，无需 bump。
- 部署仍由人做；任一节点 `recording===true` 或有上传在途就等（`scripts/deploy-precheck.sh`）。
