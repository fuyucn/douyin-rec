# 项目定位与精简审计（2026-11-08，第二版）

> 触发：用户判断「项目越做越大，开始不符合定位。我们只是视频录制上传的工具」。
> 本文只做审计与建议，**不改代码**。数字来自 `main@7a4c3e75` 与三节点线上实况。
> 第二版按顾问卡点 1 的挑刺修正：最大的一块不是 Stats，而是**遗留的 `/hub` 第二套入口**。

## 1. 定位基线

**核心链路**：取流（抖音/快手/B站）→ 录制（分段/边录边传/零磁盘直传）→ 合并转码烧弹幕 → 上传 B站 → 失败可单步重跑。

**支撑面**：房间与 hub 规则、节点与任务下发、处理队列、日志与排障。

**判定口径**：删掉后「录制或上传做不成 / 看不见失败原因」= 在范围里；删掉后只是「少一个看板 / 少一种入口」= 范围外。

## 2. 生产使用数据（2026-11-08）

| 维度 | 实测 | 含义 |
|---|---|---|
| 房间 | 20（抖音 18 / B站 1 / 快手 1） | 多平台是真实需求 |
| 直播直传 spool | 20/20 | `zero-upload` 是主路径 |
| 边录边传 rolling | 16/20 | 「实验性」徽标名不副实 |
| 弹幕 danmu | 6/20 | 弹幕管线在用 |
| 分段 segmentSec | 1800/3600 各半 | 分段是主模式 |
| 节点绑定 workers | 20/20 | 多节点调度是核心 |
| 引擎 engine | ffmpeg 20/20 | 其它录制引擎未被使用 |
| 时间窗 schedule | **0/20** | 零使用（但只占表单一行） |
| 输出格式 outputFormat | **20/20 original** | 非 original 的处理链在空跑 |
| Discord webhook | 未配置 | 通知通道闲置（代码极小） |

> **重要前提**：线上没有请求访问日志（`docker logs` 里没有任何 HTTP 命中记录）。因此「/hub 页没人用」「/stats 没人看」目前**都是推断，不是证据**。删入口前必须先能证伪（见第 4 节步骤 0）。

## 3. 逐项审计（修正版）

### A. 无风险清理 / 归档

| # | 项 | 体量 | 先决条件 | 说明 |
|---|---|---|---|---|
| A1 | 已合并的 `codex/*` 分支 | 225 个 refs | `git branch --merged main` 逐个确认 + 已 push | 有独有提交的分支会被漏删；删前必须核 |
| A2 | `.hallmark/`（4KB）、`.orka/`（0B） | 空壳 | — | agent 残留目录 |
| A3 | `dev/*.html` 原型（9 个） | 5335 行 | 12 次近期改动，可能仍在当设计稿 | 移到 `docs/design-archive/`，别直接删 |
| A4 | `docs/` 29 + `plans/` 37 篇 | 66 篇 | **不能整目录归档**：`docs/multi-node-sync.md` 是现役运维手册，代码注释还引用 `plans/036/041/047` | 只归档已完成的设计/审计，保留现役文档并修引用 |
| A5 | `remote/` 旧 Python 管线 | 606 行 + `vps.key` 私钥 | **不是仓库清理项**：`.gitignore:45` 已忽略，删它不会让 clone/bundle 变小 | 独立安全任务：私钥移出并轮换、留 `pull_recordings.sh`（仍指向现数据根 `~/drec/recordings`）、只删确认无用的 merge/burn Python |

### B. 真正的「第二套真相」：遗留 `/hub` 栈（建议第一阶段删）

| 组成 | 行数 | 现状 |
|---|---|---|
| `HubPage.tsx` | 292 | **不在导航**（`lib/nav.ts` 只有 rooms/nodes/queue/stats），仅剩路由 `/hub`、`/hub/:key` |
| `RoomDetail.tsx` | 417 | Hub 页的房间详情；`RoomRunsPanel` 注释明写「/rooms 要替代 Hub 页」 |
| `HubRuleDialog.tsx` | 426 | **第二套房间编辑器**：与 `RoomEditor` 写同一份规则、同一个字段 |
| `WorkersPanel.tsx` | 243 | 已被 NodesPage 卡片取代（#549 撤掉 slide-in 面板） |
| 合计 | **1378 行** + 一批 i18n | README 第 227 行仍教人「Web『Hub』页增删改规则」——文档与导航已矛盾 |

**为什么它是第一优先**：删掉它之后，`outputFormat` / `schedule` 这类字段才只剩一个编辑入口；否则任何「隐藏字段」的改动都会出现「/hub 能设、Rooms 看不到也改不了」的漂移，且 `room-editor-form.ts:240-244` **无条件**发送 `...sched`（`splitSchedule("")` = 两个 null），从 Rooms 保存会**清掉 /hub 设的窗口**。

### C. 出界功能

| # | 项 | 代码 | 测试 | 依赖 | 近 90 天 | 影响谁 | 建议 |
|---|---|---|---|---|---|---|---|
| C1 | **Stats 统计页** | 页 377 + API 79 + 引擎 538 = 994 | 333 | — | **20 次** | master 想看复盘的人 | 删**整条链**：页面 + API + `reconciler.recordStats()` 采集钩子 + `cli.ts` 注入 + 47 个 i18n key；**保留 `room-stats.db` 文件做取证**。只删页面会留下空跑的写库路径 |
| C2 | **Hub 流程图视图**（xyflow） | `HubJobs.tsx` 内 ~235 行 | — | `@xyflow/react@12.11`（≈150KB） | 18 次 | 需要单步重跑的运维 | **不能直删**：单节点重跑只存在于流程图（`RunTree.tsx:2` 注释自证）。顺序：重跑（含 upload 类二次确认）做进 RunTree → `presentSet` 从 `flow-build` 挪出（`run-tree.ts:12` 依赖它）→ 再删 xyflow |
| C3 | **TUI**（`task tui`） | 376 + 30 命令 | — | `@drec/tui` + 根 `ink/react` | 4 次 | 终端用户（无证据） | **删**。纯 REST 客户端，serve 挂了它也连不上，无应急价值；顺带摘掉 ink/react 依赖与 esbuild 的 TUI 构建目标 |
| C4 | `finalize-format` 子系统 | 494 行 + 3 个测试文件 + `cli.ts` 注入 | 生产 20/20 original ⇒ 整条 fire-and-forget 链在空跑 | — | — | 想输出非 original 的人（0 使用） | 若确认不要非 original：**删这条子系统**，而不是只隐藏一个下拉 |
| C5 | 时间窗 `schedule` | 一行输入（`RoomEditor.tsx:293`）+ 引擎 gate | 0/20 | 73 个文件牵连（daemon、drain、hub 同步） | — | 想按时间开录的人 | **不动**。删/藏的收益是一行输入，代价是清空窗口数据的风险 + 73 文件手术 |
| C6 | 录制引擎选择 | 候选来自平台注册表 | ffmpeg 20/20 | mesio 是**录制引擎**（`record-engine/src/engines/mesio.ts`），不是合并依赖 | — | 想换引擎的人 | **不动**；只在前端隐藏不解决问题（两处渲染） |

### D. 明确不动（核心）

`record-engine`（含 mesio 引擎）、`douyin-live`、`kuaishou-live`、`bilibili-live`、`zero-upload`、`orchestrator` + `fleet-*`（三节点下发）、`proc-queue`、`post-process`、`processors`（弹幕）、`manager`、`app`/`cli` 骨架、Web 的 Rooms / Nodes / Queue / Room 详情 / 日志 / hub 规则（**规则**保留，**旧规则编辑页**删除）。

> 代码重复（`ffprobe` 4 份、`sanitizeKey` 4 份、`cli.ts` 里 590 行起步流程等）在 `docs/audit-2026-10-06/` 已列，属于重构与加固，不属于范围裁剪，本审计不重复。

## 4. 建议顺序

| 步骤 | 内容 | 预估 | 风险 |
|---|---|---|---|
| **0** | 加 10 行访问日志中间件（只记 `method path`），观察 3–7 天，拿到 `/hub`、`/stats`、`/task` 的真实命中 | 1 小时 | 零（可空跑）* |
| 1 | A1/A2（分支、空壳） | 20 分钟 | 零 |
| 2 | A3/A4 选择性归档（原型进 docs、已完结设计归档、修注释引用） | 半天 | 零 |
| 3 | **删 legacy `/hub` 栈** + `/hub` 路由重定向到 `/rooms` | 1–2 天 | 中（书签、规则排序） |
| 4 | C2：重跑进 RunTree → 删 xyflow / flow 视图 | 1–2 天 | 中（重跑体验要先做对） |
| 5 | C1：Stats 整链删除 + 保留 db | 1 天 | 中（复盘能力消失） |
| 6 | C3：TUI 删除 + 依赖清理 | 半天 | 低 |
| 7 | A5：`remote/` 私钥轮换与脚本迁移 | 半天 | 安全（不是"清理"） |
| 8 | C4：`finalize-format` 子系统删除（可选，需确认永不输出非 original） | 1 天 | 中 |

\* 步骤 0 是唯一能让「删」从推断变成证据的动作。若日志显示 `/hub`、`/stats` 确有访问，则步骤 3/5 改为「保留但冻结」。

## 5. 执行进度（2026-11-08 晚）

| 项 | 状态 | 版本 |
|---|---|---|
| 访问计数取证（`<root>/config/access-stats.json`，只记路由名） | **已上线三节点**，观察中 | 0.0.333 |
| 死文案清理 261 条（1478 → 1217），并修复详情页两枚裸 key | **已完成** | 0.0.334 |
| TUI 删除（376 行 + ink/react 依赖 + `dist/tui.mjs` + release 打包位） | **已完成** | 0.0.335 |
| 设计原型 8 个（5335 行）移入 `docs/design-archive/` | **已完成** | 0.0.336 |
| 已合并 `codex/*` 分支 222 个（逐个核对已在 origin/main） | **已完成** | — |
| 死导出 24 个 + 3 个无引用组件/助手（`DanmuBadge`、`RollingProgressRows`、`NotifySection` 等） | **已完成** | 0.0.338 |
| 26 个带独有提交的未合并分支 | **保留**（未合并，删了会丢提交） | — |
| `/hub` 栈、Stats、`finalize-format` | 等访问计数一周结果 + 拍板 | — |

## 6. 需要拍板

1. **步骤 0 要不要做**（加访问日志观察一周）？不做的话，删 `/hub`、`/stats` 就是拿推断当证据。
2. **`/hub` 栈**（1378 行）是删，还是「保留但冻结（从 README 移除指路）」？
3. **Stats** 整链删（含采集钩子）还是只从导航隐藏？
4. **C4 `finalize-format`**：确认永不输出非 original 吗？（20/20 是现状，不是承诺）
