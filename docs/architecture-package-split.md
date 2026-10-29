# 包拆分与架构整理设计

> **部分内容已过期**：执行计划以总票 #49（含评论修订）为准，边传韧性以 #57 为准。本文保留为设计参考。
> S1、S3、S4 已由 #40/#42/#50/#54 完成；其余步骤状态见下方「步骤状态映射」。
> 状态：设计稿（仅文档，不改代码）。对应计划 [plans/032_package-split.md](../plans/032_package-split.md)。
> 基线：本文撰写于 `feat/hub-optimization` 的 `633edbe`。`main` 为稳定版，本文所有改动只以开发分支为 base。
> 引用约定：`路径:行号` 省略 `.ts` 后缀（隐私闸门会把源码文件名当作文件名命中）。**行号属 `633edbe` 基线，仅作历史证据，不代表当前代码位置。**

## 步骤状态映射

| 步骤 | 状态 | 对应总票 #49 的 U 编号 | #57 的 R 编号 / 备注 |
| --- | --- | --- | --- |
| S1 会话命名收口 | 已完成（#50 / #54） | U1 | — |
| S2 manager 通用化为 `SegmentSink` | 仍有效，待 #57 R2–R5 落地后再做 | — | R2–R5 |
| S3 `resolveRollingPolicy` 唯一判定 | 已完成（#40 / #42） | — | — |
| S4 规则 `mode="rolling"` | 已完成（#40 / #42） | — | — |
| S5 抽出 `@drec/uploader` | 仍有效 | U4 | — |
| S6 执行体搬入 orchestrator | 仍有效，待 #57 R2–R5 落地后再做 | U9 | R2–R5 |
| S7 拆分 cli 的 hub 装配 | 仍有效 | — | — |
| S8 hub 状态存储搬入 orchestrator | 仍有效 | — | — |
| S9 master 下发 `rollingUploadMeta` | 仍有效 | U8 | — |
| S10 孤儿清理搬迁 / 分段事件化 | 部分被取代：与 U2、U12 重叠，以 #49 为准 | U2 / U12 | — |

## 0. 结论先行：为什么 rolling upload 开关挂在 task 内是错位的

「边录边传」回答的是**什么时候上传、什么时候删源**。这是后处理策略，与「怎么录」无关，本应和 `pipeline.upload` 同属 hub 规则。它现在挂在 task 上，是执行位置带来的历史捷径，不是职责划分：

- 上传发生在录制子进程内：manager 的会话钩子在每个新分段产生时触发（`packages/manager/src/index:275`），所以开关必须能传进 `record` 子命令，最顺手的通道就是 task 参数（`packages/app/src/process/record-args:47`）。
- 计划 031 为避免「两处入口漂移」，明确只做任务开关、不暴露 hub 规则开关（`plans/031_rolling_segment_upload`「落地方式」一节）。代价是策略散在三处判定（见 1.1），且判定所需信息（规则勾选了几个节点）只存在于 master。
- 结果：task 同时承载了「录制参数」和「上传策略」两种职责；录制端子进程为了补齐策略信息，反过来去读 hub 规则文件。

目标：task 只保留录制参数；rolling 成为 hub 规则 `pipeline.upload.mode = "rolling"` 的一种策略；master 一次性算出**派生字段**下发，录制端只读不判。

## 1. 现状职责图与串层证据

### 1.1 职责归属

| 域 | 现在的代码 | 所在包 |
| --- | --- | --- |
| 录制：取流/分段/弹幕/会话落盘 | `PollingRecorder` + 引擎；平台取流与弹幕；`RecordingSession`（重连、drain、会话 sidecar） | record-engine / douyin-live 等 / manager |
| 任务管理（节点本机） | TaskStore、daemon、scheduler、子进程管理、web | app |
| 编排 | 选优、聚类、台账、对账、pipeline 工作流、Transport | orchestrator |
| 后处理（纯函数） | concat / burn / ass / ffmpeg | post-process |
| 上传执行 | biliup 封装 `uploadPlain/appendGroup/countVideoParts` | **app**（`packages/app/src/upload/biliup`） |
| 节点侧上传执行体 | 节点内 remux→上传 | **app**（`packages/app/src/node-pipeline`，814 行） |
| 边录边传执行体 | `RollingUploader` | **app**（`packages/app/src/rolling-upload`，647 行） |
| 清理 | 孤儿清理 | **app**（`packages/app/src/orphan-cleanup`） |
| hub 状态存储 | hub-store / hub-jobs / worker-store / hub-config-store | **app** |

后处理、上传、清理的执行体都落在 app，编排在 orchestrator，两者靠 cli 注入粘合。

### 1.2 串层之处（含证据）

1. **【历史（已修复，#42）】rolling 开关挂 task，且在三处判定**
   - 存储：`packages/app/src/store:70`（Task 字段）、`packages/app/src/db:59,114`（DB 列）、`packages/core/src/api-types:131,493,515,692,789`（DTO）、`packages/web/src/modals/CreateEditTaskDialog:287`（UI 在任务弹窗）。
   - 判定 A（master 下发）：`packages/cli/src/cli:1069-1071`。远端节点按 `rollingUploadSingleNode` 收窄，**本机 local 原样透传** `src.rollingUpload`。
   - 判定 B（录制子进程）：`packages/app/src/rolling-upload:609-620` 工厂内再次读 hub 规则并调用同一函数。同文件注释 `:586-590` 却写「本工厂只信 `o.enabled`，不在此重复判定」——注释与实现矛盾。
   - 判定 C（flag 解析）：`packages/cli/src/cli:231-233` 用字符串集合解析 `--rolling-upload`，与 `record-args:47` 的布尔翻译互为镜像。
   - 单一真理源其实只有一个函数：`packages/core/src/rolling:189`；但「何时调用、在哪一侧调用」没有单一入口。本机路径只靠判定 B 兜底。
2. **录制子进程读 hub 规则文件**：`packages/app/src/rolling-upload:547-575` 的元数据解析直接读本机规则与全局配置。该文件自己的注释承认远端 worker 上没有规则文件（`:611-613`）。按代码推断，远端边录边传会退回内置默认（标签、分区、私密性），丢掉规则里配置的标题模板与简介——**未实测，需在迁移前用只读方式核实**。
3. **上传执行在 app，编排在 orchestrator，靠 cli 注入粘合**
   - cli 动态导入 app 的上传函数（`packages/cli/src/cli:642`），再在 `:895-908` 注入 orchestrator 的 pipeline 依赖。
   - `biliup` 依赖 app 的路径模块（`packages/app/src/upload/biliup:5`），所以上传器无法脱离 app 单独存在。
   - 同一功能「节点侧上传」有两半：orchestrator 的派发（`packages/orchestrator/src/node-side-upload`、`pipeline:630-645`）与 app 的执行体（`node-pipeline`），也靠 cli 的隐藏子命令连接。
   - 后果：orchestrator 只依赖 core 与 post-process（包清单 实测），却被定在 rank 4.5，只因为「看起来在 app 之上」；实际耦合都在 cli。
4. **cli 入口 共 1712 行，其中 hub 装配占约 760 行**：`hubStarter` 从 `packages/cli/src/cli:627` 开始，到 `serve` 命令 `:1393` 之前才结束；内含传输层构造（`:1314-1358`）、资源池、对账器（`:979`）、上传接缝、任务同步 desired 计算（`:1030-1085`）。commander 入口与业务装配混在同一文件。
5. **【历史（已修复，#54）】会话基名/分段后缀规则重复 7 份（6 个文件）**
   - `packages/manager/src/index:596`
   - `packages/post-process/src/concat:19`、`:29`、`:35`、`:43`（含 `sessionBase`、`xmlSessionBase`、分段序号）
   - `packages/core/src/rolling:205`
   - `packages/app/src/node-pipeline:30`
   - `packages/app/src/orphan-cleanup:110`
   - `packages/orchestrator/src/session-plan:38`
   - `core/rolling` 的注释（`:201-203`）明确要求「避免在 app 侧再抄一份」，而 `node-pipeline:28` 恰恰抄了。
6. **【历史（已修复，#54）】manager 与 post-process 基名规则不一致**：manager 只剥 `-PART<n>` 与 `_<3+位>`（`manager/src/index:596`），其余五处还剥 `_PART<n>`。当前 ffmpeg 引擎不产生 `_PART` 命名，属**潜伏不一致**而非线上 bug；一旦引入该命名，弹幕 sidecar 路径会与合并侧推出的基名不同。
7. **hub-store 反向依赖 app 内部**：`packages/app/src/hub-store:3` 引入任务存储的 `normalizeRoom`，使 hub 规则存储无法独立搬出 app。

## 2. 目标架构

### 2.1 职责边界

- **录制侧（recorder）**：取流、分段、弹幕、会话落盘。对外只输出两样东西：会话 sidecar（身份+缺口，已有）与**分段就绪事件**（新增的通用接缝，不含任何上传语义）。不读 hub 规则、不知道上传。
- **hub 侧**：合并/烧录/上传/清理/选优/台账，以及 rolling 策略与其执行体。
- **节点应用（app）**：任务存储、daemon、子进程、web；hub 规则与任务的同步粘合（需要 TaskStore）。
- **cli**：只做 commander 与组合根。

rolling 的位置：hub 规则 `pipeline.upload.mode = "rolling"`。master 用唯一的纯函数 `resolveRollingPolicy` 算出 `rollingEffective`（并附上传元数据），随任务规格下发；录制端只读派生字段。

### 2.2 包清单与依赖方向

保持现有包名，**新增 1 个包**，其余是搬迁。

| 包 | 职责 | 目标 rank | 依赖 |
| --- | --- | --- | --- |
| core | 契约、纯判定、会话命名、sidecar 类型、规则类型 | 0 | — |
| post-process | 纯后处理 | 0 → **0.2**（历史，已完成，#54） | core（用会话命名，需新增依赖） |
| observability | 日志/通知实现 | 0.5 | core |
| **uploader（新）** | biliup 封装与上传限流接缝；去掉对 app 路径模块的依赖（路径由调用方传入） | **0.8** | core |
| record-engine / 各平台 live | 录制引擎与平台 | 1 / 1.5 | core |
| orchestrator | hub：编排 + 节点执行体（node-pipeline、rolling 执行体）+ 状态存储 | 4.5 → **2.5** | core、post-process、uploader |
| manager | 会话编排，通用 `SegmentSink` 接缝 | 3 | core |
| app | 节点应用壳 + 任务同步粘合 | 4 | 以上各包 |
| cli | 组合根 | 5 | 全部 |

说明：rank 只约束方向。orchestrator 降到 2.5 后仍低于 manager(3)，二者**互不依赖**，由新增的「侧向隔离」测试守护：录制侧（record-engine、各平台、manager）不得依赖 hub 侧（uploader、orchestrator），反之亦然。post-process 与 core 曾同为 rank 0（历史：#54 已将 post-process 上调至 0.2），同层不能互相依赖。需改 分层守护测试 的 `RANKS`，并重跑 `pnpm arch:gen` 更新生成物。

### 2.3 公共契约（放 core）

- `session-naming`：`sessionBaseOfFile`、`sessionBaseOfVideo`、`sessionBaseOfXml`、`segmentIndexOf`、`isVideoSegment`。唯一一份正则，其余全部引用。
- `session-sidecar`：会话 sidecar 与 rolling sidecar 的读写类型（现分散在 manager 写、scan 读两侧的匿名对象）。
- `segment-sink`：`SegmentSealedEvent`（会话基名、分段路径、序号、时间）与 `SegmentSink` 接口，取代 manager 内的 `RollingUploadHook` 命名。
- `rolling-policy`：`resolveRollingPolicy(rule, legacyTaskFlag) -> { effective, reason }`，吸收现有 `rollingUploadSingleNode`；`UploadMode = "stage" | "upload" | "rolling"`。
- 任务规格新增派生字段 `rollingEffective` 与 `rollingUploadMeta`（标签、分区、简介、标题模板、可见性）；旧字段 `rollingUpload` 继续下发同一个有效值，兼容旧节点包。

### 2.4 搬迁清单（from → to）

| 从 | 到 | 备注 |
| --- | --- | --- |
| 7 份基名正则 | core `session-naming` | 先统一再搬 |
| `app/upload/biliup` | `uploader` | 路径依赖改为入参 |
| `app/node-pipeline` | `orchestrator/node/` | 逻辑不变 |
| `app/rolling-upload` 的 `RollingUploader` | `orchestrator/node/rolling-uploader` | 由 cli 组合根注入 manager |
| `app/rolling-upload` 的工厂与元数据解析 | 删除；改为读下发的派生字段 | 见 S3、S10 |
| `manager` 的 `RollingUploadHook` | `SegmentSink`（保留旧名别名一个版本） | 通用化 |
| cli 入口 的 hub 装配 | `packages/cli/src/hub/*` 模块，后续可下沉 orchestrator | 先拆文件不改逻辑 |
| `app` 的 hub-store、hub-config-store、worker-store、hub-jobs | `orchestrator/state/` | `normalizeRoom` 先入 core；task-sync 留 app |
| `app/orphan-cleanup` | `orchestrator/cleanup/` | 删除逻辑，晚做 |

## 3. 渐进迁移计划

每步一个 PR，单独可回滚；向后兼容旧任务配置：**DB 列保留**，读取时迁移，不做破坏性迁移。

| 步骤 | 内容 | 风险类别 |
| --- | --- | --- |
| S1 | 会话命名收口到 core，7 处改引用；表驱动测试覆盖三种后缀与 `.xml/.mp4`；新增「仓库内不再出现第二份该正则」守护 | 低，纯重构（仅 manager 对 `_PART` 的行为与其余对齐） |
| S2 | manager 通用化为 `SegmentSink`；sidecar 类型入 core；行为不变 | 低 |
| S3 | `resolveRollingPolicy` 成为唯一判定；master 下发与本机 `startTask` 都调用它，下发 `rollingEffective`；录制子进程判定降为断言（与策略不一致时拒绝并告警），不再自有第二套规则 | **危险类：决定何时上传/删源，需人确认** |
| S4 | 规则 schema 增加 `upload.mode = "rolling"`；读取时迁移（旧规则 `upload` + 任务旧开关 → 有效 rolling）；API/DTO/UI 把开关移到规则弹窗，任务弹窗只读展示；任务列不再写入但保留 | **危险类：改 hub 规则语义，需人确认** |
| S5 | 抽出 `@drec/uploader`，登记 `RANKS` | 低 |
| S6 | node-pipeline 与 rolling 执行体搬入 orchestrator；删 cli 的注入粘合；orchestrator 降 rank，post-process 升 rank 并依赖 core；加侧向隔离测试 | 中；搬家不改逻辑，但触及上传执行体，部署前人确认 |
| S7 | 拆分 cli 入口 的 hub 装配为多个模块，commander 入口只留命令定义 | 低，纯重构 |
| S8 | hub 状态存储搬入 orchestrator；`normalizeRoom` 入 core；task-sync 留 app | 中 |
| S9 | 元数据由 master 下发（`rollingUploadMeta`），录制端不再读规则文件 | 中；涉及新旧节点包版本偏移，需能力门控 |
| S10（可选） | 孤儿清理搬迁；录制端改为输出分段事件而非进程内钩子 | **危险类（删源）；建议单独评估** |

依赖顺序（**以 #49 修订为准**）：S1、S2、S5、S7 互相独立可先行；S3 → S4 → S9；S6 依赖 S3、S5。S2、S6 待 #57 的 R2–R5 落地后再做。S1、S3、S4 已完成。

### 风险

- 版本偏移：节点 bundle 可能落后于 master，新增规格字段必须可被旧节点忽略，旧字段 `rollingUpload` 继续携带有效值。
- S3 收紧判定后，原先只靠判定 B 兜底的本机路径会改走 master 判定，需覆盖「规则勾选 0/1/多个节点」「无规则」「规则禁用」的全矩阵，防止意外放行重复投稿。
- 元数据现状（1.2 第 2 条）若属实，S9 之前远端节点边录边传的稿件信息与规则不一致；上线前先只读核实。
- 搬迁期间 import 路径变化会撞上并行 PR；每步保留旧路径 re-export 一个版本。
- `RANKS` 变更要同步重新生成架构图，否则漂移守护测试变红。

### 测试策略

- 纯重构步骤：既有测试全绿 + 新增表驱动用例；`pnpm test`、`pnpm typecheck` 全量。
- S3/S4：为策略函数补全矩阵用例（含向后兼容：旧任务开关、旧规则、无规则）；沿用 `pipeline` 的 rolling 短路四态用例；增加「旧节点收到新规格」的兼容用例。
- 分层：更新 `RANKS`，新增侧向隔离测试；`pnpm arch:check`。
- 前端改动：`cd packages/web && pnpm build` 并手动核对。
- 线上状态相关断言一律先用命令实测再写；部署前遵守「无录制中任务」守护。

## 4. 决定三行

1. **rolling 迁到 hub 规则 `mode="rolling"`**
   - 要决定：是否把上传时机策略从 task 移到 hub 规则。
   - 不做：三处判定继续漂移，录制子进程继续读规则文件。
   - 建议：做（S3、S4），读取时兼容旧任务开关。
2. **无 hub 规则的单机任务还能否使用 rolling**
   - 要决定：新建时是否仍允许。
   - 不做：保留一条「无规则」特例，策略函数多一个分支。
   - 建议：不再新增；旧开关兼容读取，若干版本后废弃。
3. **orchestrator 降到 rank 2.5、post-process 升到 0.2**
   - 要决定：是否接受 `RANKS` 调整与新增依赖。
   - 不做：节点执行体无法下沉，cli 粘合长期存在。
   - 建议：接受，并加侧向隔离测试。
4. **新增 `@drec/uploader` 包**
   - 要决定：上传封装是否独立成包。
   - 不做：orchestrator 仍须经 cli 注入上传函数。
   - 建议：做（S5）。
5. **orchestrator 是否改名 `hub`**
   - 要决定：改名与否。
   - 不做：名称与职责略有偏差，但零改动成本。
   - 建议：不改，文档中注明「orchestrator = hub 侧」。
6. **分段事件：保留进程内钩子，还是改为子进程输出事件**
   - 要决定：S10 是否纳入本轮。
   - 不做：录制子进程继续链接上传执行体。
   - 建议：本轮保留钩子（通用化为 `SegmentSink`），事件化另立 issue。
7. **元数据由 master 下发**
   - 要决定：是否接受规格新增字段与版本门控。
   - 不做：远端边录边传可能用默认元数据（待核实）。
   - 建议：做（S9），先只读核实现状。
