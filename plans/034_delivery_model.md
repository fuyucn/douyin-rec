# 034 交付模型梳理：把「一场直播怎么送到 B站、什么时候能删源」收成一个模块

状态：设计稿（未实施）。依据：2026-10-14 对代码的实测盘点；与 plan 033 的不变量 I1–I12 兼容，本文是 033 的**结构性前置**。

## 1. 现状：问题不在功能多，在「同一个问题被回答了 N 遍」

「这一场送到了吗？源能删吗？」是全系统唯一重要的问题，现在由下面这些地方各自回答：

| 维度 | 现状（实测） | 后果 |
|---|---|---|
| 执行路径 | 4 条：master 整场管线（整场管线模块（1125 行））、master 分段管线（分段管线模块）、节点侧一次性（节点侧执行体模块）、边录边传（边录边传模块）。上传调用点分散在 5 个文件 | 同一个 bug 要修 4 次；每加一个功能都要问「4 条路径各自怎么办」 |
| 「已送达」的证据 | 4 处：台账 `sync_jobs.bv`、节点 节点结果文件、录制端 边录边传进度文件、B站分 P 数回读 | 彼此可不一致（#25：B站已建稿、台账无 BV） |
| 删源（视频） | 3 条路径：①master 的共享清理函数（整场/分段/节点侧三条管线都调它，远端经 ssh `rm -f`）②节点执行体收尾自删 ③边录边传的封口+确认删源（已有 core 三重证据闸 `canDeleteRollingSource`）。孤儿清理只删中间产物/空壳 xml，不删视频 | 同一场节点侧上传会被 ① ② 各删一遍；闸门只有 ③ 有 |
| 策略/配置 | 任务表（旧 `rollingUpload`）、hub 规则、hub 全局配置、settings 表、环境变量，再加派生字段 `rollingEffective` | 子进程与 serve 读到不同水位（#96 审计发现的就是这类） |
| 可见性 | master 只看得见流经台账的东西；边录边传、节点侧上传在收口前对 controller 不可见 | 你问的「fleet 模式应该显示节点记录」做不到，不是缺 UI，是缺数据源 |
| 装配 | 命令行入口模块（1725 行），把 hub、传输、管线、通知全接在一起 | 改任何东西都要进这个文件 |

结论：**不是要加功能，是要收口。** 每个新需求（磁盘安全、fleet 视图、重试分类）现在都得在 4 条路径、4 份证据、5 个删除点上各做一遍。

## 1.5 两种运行模式（本文所有步骤都要标适用范围）

- **单机模式**：`task serve` 不带 `--hub`。一台机器自己录、自己传、自己删，没有 controller。
- **fleet 模式**：controller（`--hub`，可兼 local worker）+ N 个节点。节点本身就是单机模式的进程，只是策略由 controller 下发。

| 维度 | 单机 | fleet 节点 | fleet controller |
|---|---|---|---|
| 策略来源 | 任务自身 | controller 下发（DeliveryPlan） | hub 全局配置 + 房间规则 |
| 可见性 | 本机网页 | 仅首次配置时看；日常不看 | **唯一观察入口**（F1 已做进度，F2 做节点健康，F3 做日志） |
| 上传 | 边录边传 | 边录边传 / 节点侧批量 | 整场管线（烧录/多节点选优） |
| 删源 | 只由边录边传闸门删 | 同左，另有 master 经 ssh 删 | 经 ssh 或 `_release-source` |

约定：单机模式只保证「边录边传 + 本机可见 + 删源有闸门」，**不**做整场合成上传（用户未反对此建议，若要改需单独决定）。步骤表「范围」列写明 单机 / 节点 / controller。

## 2. 目标：一个深模块 + 三个适配器

按 codebase-design 的词汇：

### 2.1 Delivery（深模块，放 core，纯逻辑 + 节点本地落盘）

一场直播（session）一条交付记录，唯一的写入口：

```
begin(session, plan)                 // 登记：期望分 P、策略
intent(part)                         // 调 biliup 之前先写（崩溃时能说「这一段结果未知」）
confirm(part, { bv })                // biliup 返回 0 才调（#92：只认返回码）
releaseSource(part)                  // **全系统唯一**删源入口：只允许删 confirmed 的分 P
snapshot(session) -> Delivery        // 只读：状态、BV、已确认/未知/待传分 P、锁定字节
```

- 不变量由它保证，不靠各路径自觉：未 `confirm` 不能 `releaseSource`；`intent > confirm` 视为「未知」，只能人工或按 D8 规则处理；一场一个 BV。
- 取代 边录边传进度文件 与 节点结果文件（先双写，见 §4）。
- 删源闸门不是新概念：边录边传已有 core 的 `canDeleteRollingSource`。S4 的做法是把它推广为通用闸门，而不是新建一套。
- **远端删源缺口**：master 经 ssh `rm -f` 删节点源，节点本地模块拦不住；要收口必须新增节点隐藏命令 `_release-source`（校验 confirmed 后才删），并兼容旧 bundle（旧节点回落现行 `rm -f`，且标记为未受闸门保护）。
- 删除测试：删掉它，复杂度会回到 4 条路径里——它值得存在。

### 2.2 Executor（真 seam：已有 ≥2 个实现）

三个适配器，都只通过 Delivery 记账、只通过 `releaseSource` 删：

- `RollingExecutor`：录制进程内，每封口一段即传。
- `NodeBatchExecutor`：收播后在节点本地 remux + 上传。
- `MasterExecutor`：pull → merge → burn → upload（需要烧录/多节点选优时用）。

分段管线（master 分段管线）与上面三者重叠：**先查线上是否还在用，再决定并入或删除**（本文未验证，不下结论）。

### 2.3 DeliveryPlan（策略只算一次）

master 解析一次 `{ mode: stage|batch|rolling, executor: rolling|node|master, cleanup }`，随任务下发；录制端与节点只读、不再自行推导。取代 `rollingEffective` 与散落的判定，旧 `task.rollingUpload` 仅作迁移来源。配置来源收敛为：hub 全局配置（全局）+ 房间规则（每房间）；子进程通过下发值取配置，不再各读各的。

### 2.4 Fleet 视图是推论，不是新功能

controller 的队列 = 台账 job ∪ 各节点上报的 `Delivery.snapshot`。节点现有的 5 秒状态轮询（`_recording-status`）顺带返回这份快照即可，UI 一行显示「边录边传：已确认 N / 未知 M / 待传 K，BV=…」。无论哪种执行路径都看得到——这正好回答「controller 应该显示节点记录」。

## 3. 这能解决你的目标

- **磁盘不满**：锁定字节 = 所有未 `releaseSource` 的分 P 之和，直接来自 Delivery，容量账本（033 P3）有了数据源；删除只有一个入口，「传对、删对」可以只在一处证明。
- **#25 一类问题**：BV 与进度在 `intent/confirm` 时落盘，被杀也读得到（#98 已是这一思路的局部实现）。
- **新需求成本**：加重试分类、加 fleet 视图、加新平台上传，都只动 Delivery 或某个 Executor，不再乘 4。

## 4. 迁移：绞杀式，每步一个 PR，不重写

顺序依据第 2 轮审计调整：fleet 视图不依赖 Delivery，提到最前。

| 步 | 内容（含范围） | 风险 | 验收 |
|---|---|---|---|
| F1 | fleet 视图（只读）：节点 `_recording-status` 额外扫 边录边传进度文件与节点结果文件，返回每房间的 已确认/未知/BV；master 现有 5 秒状态轮询缓存它；`HubQueueDTO` 增 `delivering` 列表；队列页渲染一行 | 低 | dev 里边录边传时队列有实时行；旧节点 bundle 不带字段时不报错 |
| L1 | 停止路径不再 SIGKILL 掉进行中的末段上传（范围：节点+单机）。**根因已定位**（第 3 轮审计）：会话 `stop()` 本已「封口→传末段」，但进程管理器 `stop()` 发 SIGTERM 后 10 秒无条件 SIGKILL 整个进程组，末段上传超过 10 秒必被杀，留下「上传中」意图，10 分钟后 master 建 job 为 `needs_manual`（源保留、无重复建稿，安全但需人工）。排空（SIGUSR2）路径本就没有 SIGKILL 计时器。做法：任务开了边录边传时，硬停的 SIGKILL 宽限改为上传超时预算（上限内），其余任务保持 10 秒 | 低 | 回归测试：rolling 任务 stop 宽限 > 默认；非 rolling 不变；dev 停任务后无 `needs_manual` |
| F2 | controller「节点」视图（只读，范围：controller）。**已有数据**（实测）：`/api/hub/workers/status` 已返回 `ok/error/appVersion/appliedVersion/appliedAt`（类型里的 `syncError` 全仓无人写入，不算已有），`WorkersPanel` 已显示版本漂移；`Transport.diskFreeGB()` 已存在但只在对账轮（默认 30 分钟）由看门狗用、没进 UI。**缺**：磁盘剩余、被未确认分段锁定的字节、各节点录制数。做法：**复用 `Transport.diskFreeGB()`**（ssh 走 `_disk`、local 走 LocalTransport，不再造第三处磁盘来源）；`lockedBytes` 由 `_recording-status` 的 rolling 进度（节点本地读进度文件 + stat，不扫清单）顺带返回；二者并入 `WorkerStatus`。注意轮询范围：现有 5 秒轮询只探「被规则选中」的节点，且 local worker 不经 cli 隐藏命令——F2 要显式覆盖本机与未绑定节点（磁盘探测按较低频率，如 60 秒）。`WorkersPanel` 加两列 | 低 | 旧 bundle 缺字段不报错；磁盘接近水位时该节点标黄 |
| F3 | 日志代查（范围：controller）：节点隐藏命令 `_log-tail <taskId> <n>`，controller 经 ssh 取最近 n 行（限长、过滤凭证类字段）。是「节点网页可降级」的前置 | 低 | 不泄露凭证；旧 bundle 回落「不支持」 |
| S1 | core 新增 Delivery 类型 + 纯状态机 + 全分支测试；不接线 | 无 | 崩溃/重入/乱序测试 |
| S2 | 节点三处双写（旧文件照写） | 低 | 双写一致性断言 |
| S3 | master 删源前核对（先告警不拦截，观察期） | 低 | 线上无误报 |
| S4 | 删源收口：推广 `canDeleteRollingSource`；新增 `_release-source` 隐藏命令；3 条路径逐条改调，每条一个 PR | **高，需人** | 变异：绕过 confirm 的删除必须转红；旧 bundle 回落有记录 |
| S5 | DeliveryPlan：master 一处解析并下发，移除 `rollingEffective` 派生 | 中 | 子进程/serve/手动启动读到同一份 |
| S6 | 拆命令行入口装配；分段管线与整场管线共用交付记账 | 中 | 入口行数下降 |

F1 已上线（#103）。F2/F3 只读、可立即开始；L1 先在 dev 实测再定方案；S1 起等 F2 与 L1 落地后再定。推荐顺序：L1 实测 → F2 → F3 → S1 → S2 → S3 → S4 → S5 → S6。

## 5. 已知未验证项

- 删除点数量来自 `rmSync/unlink/cleanup` 全文检索，其中含与交付无关的（凭证文件、托管状态），实际与交付相关的以 S4 前的逐点审计为准。
- 分段管线 线上使用情况未查。
- 本稿未覆盖烧录（弹幕版/互动版）如何记入 Delivery（rolling 目前只传 plain）；S1 设计状态机时必须先定。

## 6. 审计记录

**第 2 轮（对照代码核实）**
- 删源口径：原稿「5 处」夸大。实测视频删源 3 条路径；孤儿清理不删视频；rolling 已有三重证据闸。已修正 §1、§2.1。
- 分段管线：是 `mergeSegments=false` 的正常分支，原稿「并入或删除」不成立。已修正。
- 远端删源：master 经 ssh `rm -f` 删节点源，原稿的「唯一入口」做不到，需 `_release-source` + 旧 bundle 兼容。已补 §2.1、S4。
- fleet 视图：生产 `reconcileIntervalMs` 默认 30 分钟，若靠清单扫描则进度最多滞后 30 分钟，必须走 5 秒状态轮询。已补 F1，并提到最前。
- 仍未验证：烧录版（弹幕/互动版）如何记入 Delivery（rolling 目前只传 plain），S1 前必须定；独立复审已由第 3 轮完成。

**第 3 轮（独立审计：fable-5.1，只读，对照代码）** 结论：可开工 L1/F2/F3；S1 前须补两项设计决定。
- L1 根因定位（见上）：不是缺封口，是硬停 10 秒 SIGKILL 与上传时长冲突。已改写 L1。
- `syncError` 论断错误（类型有声明、无人写入）：已修正 F2。
- F2 轮询范围缺口（未绑定节点、本机）与磁盘来源重复：已修正 F2，复用 `diskFreeGB()`。
- **S1 前置决定 A**：stage 模式（只合成不上传）现在「无 BV 即删节点源」（交付物在 stage）。Delivery 若只认 BV 为确认，S4 后 stage 模式要么永不删源要么绕闸门；S1 必须把「交付物已落 stage 且校验通过」定义为一种确认。
- **S1 前置决定 B**：烧录版（弹幕/互动版）如何记入（已知，原已列）。
- S1 不另造状态机：抽取边录边传的 intent→confirm 与节点执行体的落盘结果两处语义的并集。
- S3 须定义核对时点（以进度文件 `updatedAt` 为准，过期即保守），否则与节点删源并发有 TOCTOU。
- S5 移除 `rollingEffective` 时须继续下发旧字段 `rollingUpload`（旧 bundle 只认它）；单机模式没有 master，「一处解析」的来源在单机是任务自身，验收需分别写。
- S4 拆分顺序调整：边录边传（已有闸门）→ 节点执行体 → master 共享清理函数（需 `_release-source` 与旧 bundle 回落），每条一个 PR。
- 单机模式的 rolling 异常（`ambiguous`/转人工）目前无人看：§1.5 的「本机可见」需落到具体步骤（候选：单机任务页显示交付状态），列为 S1 之后的待办。
- 顺手：边录边传短路处的注释与代码自相矛盾（注释说按 sourceAfterDone 删源，代码明示不删）；同场节点执行体与 master 清理函数会各删一遍（幂等，但清理记账有虚数）。
- 论断复核属实：视频删源 3 条路径、`_recording-status` 返回结构与旧 bundle 回退、`WorkerStatus` 无磁盘/锁定字节字段。
