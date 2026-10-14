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

| 步 | 内容 | 风险 | 验收 |
|---|---|---|---|
| F1 | fleet 视图（只读）：节点 `_recording-status` 额外扫 `*.rolling.json` 与节点结果文件，返回每房间的 已确认/未知/BV；master 现有 5 秒状态轮询缓存它；`HubQueueDTO` 增 `delivering` 列表；队列页渲染一行 | 低 | dev 里边录边传时队列有实时行；旧节点 bundle 不带字段时不报错 |
| S1 | core 新增 Delivery 类型 + 纯状态机 + 全分支测试；不接线 | 无 | 崩溃/重入/乱序测试 |
| S2 | 节点三处双写（旧文件照写） | 低 | 双写一致性断言 |
| S3 | master 删源前核对（先告警不拦截，观察期） | 低 | 线上无误报 |
| S4 | 删源收口：推广 `canDeleteRollingSource`；新增 `_release-source` 隐藏命令；3 条路径逐条改调，每条一个 PR | **高，需人** | 变异：绕过 confirm 的删除必须转红；旧 bundle 回落有记录 |
| S5 | DeliveryPlan：master 一处解析并下发，移除 `rollingEffective` 派生 | 中 | 子进程/serve/手动启动读到同一份 |
| S6 | 拆命令行入口装配；分段管线与整场管线共用交付记账 | 中 | 入口行数下降 |

F1 只读、不碰上传和删源，可立即开始；S1 起等 F1 上线后再定。

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
- 仍未验证：烧录版（弹幕/互动版）如何记入 Delivery（rolling 目前只传 plain），S1 前必须定；独立 Opus 复审未做（当前会话无子代理工具）。
