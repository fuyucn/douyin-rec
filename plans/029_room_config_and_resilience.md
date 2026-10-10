# 029 — 节点韧性 + 房间配置统一 + 队列并行度(实施计划)

> 状态:**待用户裁决后执行**。台账条目 `T-26`(见 `TODO.md`)。
> ⚠️ **已被 `plans/030_hub_tasks_optimization.md`(台账 `T-30`)取代**:本计划的 P0-1/P0-2/P0-3 →
> 030 的 T1/T2/T3(**设计已修正**:删除以「节点 store − 期望」为准,快照降级为审计;
> 显式删除开关默认关),P2-1/P2-2 → 030 的 T9/T10/T18/T20,C-1/C-2 → 030 的 T15。
> 本文件保留为历史与证据来源(§9 复现命令仍有效);**D1–D3 由 030 承接执行,D4(内存配额)仍未决**。
> 执行请以 `plans/030_tasks.json` 为准。
> 来源:2026-10-09 三轮审计 + 用户讨论。**结论均以真实台账 + 实测验证**(§9 附复现命令)。
> 文档结构:§1 目标 → §2 决策(需你拍板) → §3 全局约束 → §4 组件 → §5 任务(PR 级) →
> §6 验收 → §7 风险 → §8 明确不做 → §9 证据与复现。

---

## 1. 目标 / 非目标

### 目标(按优先级)

1. **消除数据丢失风险(P0)**:master 配置异常时,**节点不得被自动清空**。
2. **房间配置收敛**:一个房间一份配置(录制 + 处理 + 节点),一个入口配完。
3. **并行度可达**:`resources` 暴露到 UI;单次 burn 的核利用率从 48% 提上去。

### 非目标(明确不做,见 §8)

- 不做 worker claim/lease 队列;不做「任务入队 → 认领」。
- 不动 `selectWinner` / 冗余选优(T-2 / `plans/026`)。
- 不引入新的消息中间件 / 常连控制通道。

---

## 2. 决策(需你拍板 — 我的推荐在右列)

| # | 决策点 | 选项 | 我的推荐 + 理由 |
|---|---|---|---|
| **D1** | Phase 0(韧性)是否排在所有重构之前 | 是 / 否 | **是**。它修的是**数据丢失**;其余是性能与体验。且改动小、可独立验证。 |
| **D2** | 删除语义 | (a) 保留自动删除 + 骤减安全阀兜底<br>(b) **改显式删除**(缺席只停用) | **(b)**,与 Fleet 同构(`deleted_at` 显式)。自动删除把「master 读不到」误判成「用户要删」,正是 P0 根因。 |
| **D3** | Phase 3(合并存储为 `config/rooms/*.json`)是否做 | 做 / 停在 Phase 1+2 | **先做 1+2,Phase 3 视 Phase 2 使用体验再定**。Phase 3 碰 19 个模块 + 110 个 handler,风险最高、收益边际。 |
| **D4** | master 机器物理配置 | — | **需你提供**:Docker VM 现为 **11 核 / 4 GB**。若 VM 配额能提到 8 GB+,并行度天花板从 2 提到 3。 |

> **若你全部同意推荐**,我按 §5 顺序执行,不再逐项确认。

---

## 3. 全局约束(每个任务都必须满足)

1. **行为零变更**除声明处:重构类任务(Phase 1/2)必须保证旧路径行为完全一致(回归用例守护)。
2. **向后兼容**:旧 `config/hub/*.json`、旧 DB schema、旧 bundle(无新隐藏命令)都必须继续可用。
3. **不静默失败**:任何「降级/回落/跳过」都要落日志(job.log 或 serve 日志)+ 可观测。
4. **验证门**(每任务):`pnpm test` 全量 + `pnpm typecheck` + `pnpm bundle`;动前端加
   `cd packages/web && pnpm build`;动架构边跑 `node scripts/gen-architecture.mjs`。
5. **提交规范**:`feat|fix|chore(scope): 中文描述`;`feat`/`fix` bump 根 `package.json` version;
   计划文件与代码分开提交。
6. **部署 guard**:任何部署前两节点 `recording===true` 必须为 0(AGENTS.md 硬性约束)。

---

## 4. 组件

| id | 名称 | 位置(现有) | 职责 |
|---|---|---|---|
| C1 | 期望状态副本 | 新增 `packages/app/src/managed-state.ts` + `paths.ts` | 节点落盘/读取上次成功下发的期望状态 |
| C2 | 骤减安全阀 | `packages/app/src/task-sync.ts` | 拒绝「期望骤减」,防误删 |
| C3 | 显式删除 | `task-sync.ts` + `packages/core/src/api-types.ts`(`RemoteTaskSpec`) | 用显式标记替代「缺席即删」 |
| C4 | 死代码清理 | `packages/app/src/db.ts` | 删 `hub_rules` 表、`tasks.pipeline` 列 |
| C5 | 房间弹窗合一 | `packages/web/src/modals/HubRuleDialog.tsx` | 内联录制配置(读写 task 字段) |
| C6 | 统一房间 API | 新增 `packages/app/src/web/api/rooms.ts` | `GET/PUT /api/rooms/:key` 一次读写两半 |
| C7 | 资源设置 UI | `SettingsDialog.tsx` + `web/api/settings.ts` | `resources` 可视化 + 推荐值 |
| C8 | 内存闸门联动 | `packages/orchestrator/src/workflow.ts` | `minBurnFreeMemMB` 与并行度联动 |
| C9 | burn 核利用率 | `packages/post-process/src/burn.ts` | 单次 burn 从 5.3 核提到更高 |

---

## 5. 任务(PR 级,拓扑序)

### Phase 0 — 节点韧性(必须最先)

#### P0-1 期望状态副本(C1)
- **做什么**:节点每次**成功应用** master 期望状态后,把该快照原子写入
  `<root>/config/managed/rooms.json`(`{version, savedAt, desired: RemoteTaskSpec[]}`)。
  节点 serve 启动时:先读副本 → 若存在则**照常按本地 DB 跑**(现有行为已如此,副本用于
  可观测与 P0-2/P0-3 的判定基准)。新增 `paths.rootManagedStatePath()`。
- **文件**:新增 `packages/app/src/managed-state.ts`;`packages/app/src/paths.ts`(+1 函数);
  `packages/app/src/task-sync.ts`(apply 成功后落盘);`packages/app/src/index.ts`(导出)。
- **测试**:`test/app/managed-state.test.ts` —— 落盘/读回/坏 JSON 容错/原子写。
- **验收**:应用一次期望后 `config/managed/rooms.json` 存在且内容 = 期望;
  删掉该文件不影响录制(仅丢失判定基准)。
- **依赖**:无。**估**:~150 LOC。

#### P0-2 期望骤减安全阀(C2)
- **做什么**:在 `applyRemoteTasks` 入口加守卫(用 P0-1 的副本或本地受管数做基准):
  - `desired.length === 0 && 本地受管数 > 0` → **拒绝执行**,返回
    `{ applied:[], removed:[], pending:[], rejected: "empty-desired" }` + 日志告警;
  - `desired.length < 本地受管数 * 0.5` → **只停用、不删除**(全部进 `pending`);
  - 正常范围 → 现行逻辑。
  新增 `ApplyTasksResult.rejected?: string`(core 契约扩展,向后兼容:旧消费方忽略该字段)。
- **文件**:`packages/app/src/task-sync.ts`;`packages/core/src/api-types.ts` 或
  `worker-contract.ts`(`ApplyTasksResult` 加可选字段);`packages/cli/src/cli.ts`
  (`_apply-tasks` 与 local 同步路径打印 `rejected`)。
- **测试**:`task-sync` 新增 3 用例(空期望拒绝 / 骤减只停用 / 正常删除仍生效)。
- **验收**:`applyRemoteTasks(store, [])` 在本地有受管任务时**不删任何任务**;
  且 `rejected` 透出到 serve 日志。
- **依赖**:P0-1。**估**:~120 LOC。

#### P0-3 删除改显式意图(C3)
- **做什么**:`RemoteTaskSpec` 增加可选 `deleted?: boolean`。
  `desiredFor()`(master 侧)不再靠「缺席」表达删除 —— 改为**在期望里带 `deleted: true`**
  下发待删房间(一轮:停用;下一轮:移除)。`applyRemoteTasks` 只在 `deleted === true` 时删除;
  「缺席但未标 deleted」的受管任务 → **保留并告警**(不再删)。
  > 过渡期兼容:提供开关 `DREC_EXPLICIT_DELETE=1`(缺省开)。关闭时回落旧「缺席即删」+ P0-2 兜底。
- **文件**:`packages/core/src/api-types.ts`(`RemoteTaskSpec.deleted?`);
  `packages/app/src/task-sync.ts`(删除条件);`packages/cli/src/cli.ts`(`desiredFor` 生成 deleted);
  `packages/orchestrator/src/reconciler.ts`(如需同步语义)。
- **测试**:`task-sync` 新增(缺席不删 / deleted 才删 / 过渡开关两种行为)。
- **验收**:master 删规则 → 节点任务按两阶段删除;**master 读不到规则 → 节点任务保留**。
- **依赖**:P0-2。**估**:~200 LOC。

> **Phase 0 整体验收**:清空 master `config/hub/` 目录 → 节点任务**一条不减**、
> 录制**不中断**、serve 日志有 `rejected: empty-desired` 告警;恢复目录后自动对账。

### Phase 1 — 清死代码 + 单弹窗配两半(低风险,可并行于 Phase 0 之后)

#### P1-1 删死代码(C4)
- **做什么**:`db.ts` 迁移里 `DROP TABLE IF EXISTS hub_rules`;`tasks.pipeline` 列在
  SQLite 3.35+ 可 `ALTER TABLE ... DROP COLUMN`,否则保留列但停止读写(记 TODO)。
  删除 `db.ts` 里对该表的注释残留。
- **文件**:`packages/app/src/db.ts`;`packages/app/src/hub-store.ts`(若有 hub_rules 残留引用)。
- **测试**:`test/app/db*.test.ts` —— 迁移幂等、旧库(含该表/列)打开不报错。
- **验收**:新库无该表/列;旧库打开后功能正常。
- **依赖**:无。**估**:~60 LOC。

#### P1-2 房间弹窗内联录制配置(C5)
- **做什么**:`HubRuleDialog` 增加「录制」区块(quality / engine / danmu / segmentSec /
  useCookie),读写**绑定的 task**(经现有 `updateTask`);`CreateEditTaskDialog` 保持不变
  (仍可独立建任务)。两处都补「录制开关 vs 处理开关」的说明文案。
- **文件**:`packages/web/src/modals/HubRuleDialog.tsx`;`packages/web/src/lib/i18n.tsx`;
  可能 `packages/app/src/web/api/hub-rules.ts`(返回绑定的 task 摘要)。
- **测试**:前端无 vitest → `pnpm build` + `tsc` + 手动核对(AGENTS.md 允许)。
- **验收**:在 Hub 弹窗里能改 quality/danmu 并生效;保存后 task 字段确实变更。
- **依赖**:无。**估**:~200 LOC。

### Phase 2 — 统一房间 API / 页面(中风险)

#### P2-1 统一 `GET/PUT /api/rooms/:key`(C6)
- **做什么**:新增 `rooms.ts` 域:一次请求读写「task + hub 规则」两半(存储不合并,
  内部调 `store.*` + `hubStore.*`)。旧 `/api/tasks` 与 `/api/hub/rules` **保持不变**(兼容)。
- **文件**:新增 `packages/app/src/web/api/rooms.ts`;`web/api.ts`(组装);
  `web/server.ts`(路由);`core/api-types.ts`(`RoomDTO`/`RoomPayload`)。
- **测试**:`test/app/web-api.test.ts` 增 `rooms` 用例(读两半 / 写两半 / 不存在 404)。
- **验收**:一个 PUT 同时改录制与处理;旧接口仍可用。
- **依赖**:P1-1。**估**:~300 LOC。

#### P2-2 Web 房间页(可选)
- **做什么**:新增 `/rooms` 页(合并「任务 + Hub 规则」入口);旧页保留一个版本周期。
- **文件**:`packages/web/src/pages/RoomsPage.tsx`;`App.tsx`;`TopNav.tsx`;`i18n.tsx`。
- **验收**:390/768/1440 三档可用(参考 `plans/025` 的响应式口径)。
- **依赖**:P2-1。**估**:~350 LOC。

### Phase 3 — 合并存储(高风险,视 D3 决定)

#### P3-1 `config/rooms/*.json` + 一次性迁移
- **做什么**:落地 §4 的 `record/process/place` schema;`tasks` 降为运行时投影;
  一次性幂等迁移(19 task + 16 rule → rooms/*.json,保留备份)。
- **前置**:**Phase 0 必须已完成**(否则加重单点)。
- **文件**:新增 `packages/app/src/room-store.ts`;`paths.ts`;`store.ts`(降级);
  `hub-store.ts`(读侧切到 rooms);`cli.ts`/`web/api/*`(消费侧)。
- **测试**:迁移幂等 + 往返 + 回滚(删 rooms/*.json 恢复)。
- **验收**:迁移后行为零变更;`/api/rooms` 为唯一写入口。
- **依赖**:P2-1。**估**:~800 LOC(最大)。

### 并行度(C 组,独立于 A/B)

#### C-1 `resources` 暴露到 UI(C7)
- **做什么**:`hub.config.json` 的 `resources` 加到设置 API + SettingsDialog;
  显示「推荐值 = floor(核数 / 5.3)」并提示当前核数(经 `/api/hub/workers/status` 或新端点)。
- **文件**:`packages/app/src/web/api/settings.ts`;`packages/web/src/modals/SettingsDialog.tsx`;
  `packages/cli/src/cli.ts`(类型);`packages/core/src/api-types.ts`。
- **测试**:web-api 用例(读写 resources / 非法值回落)。
- **验收**:UI 改 `maxCpuParallel=2` 后 `GET /api/settings` 反映;重启后 `ResourcePool` 生效。
- **依赖**:无。**估**:~150 LOC。

#### C-2 内存闸门联动(C8)
- **做什么**:`minBurnFreeMemMB` 默认改为「并行度 × 单次峰值(实测 ~512MB)」下限,
  或 UI 提示「并行度 > 可用内存/峰值 时会有位排不上」。
- **文件**:`packages/orchestrator/src/workflow.ts`;`cli.ts`(默认值)。
- **测试**:`workflow.test.ts` 增联动用例。
- **验收**:设 `maxCpuParallel=2` 且内存充足时两位真并行(不再被闸门卡住)。
- **依赖**:C-1。**估**:~80 LOC。

#### C-3 burn 核利用率(C9)
- **做什么**:实测调参(不动默认行为,先量化):`-threads`、`preset`、
  `-x264-params sliced-threads`;目标 48% → 80%+。
- **文件**:`packages/post-process/src/burn.ts`(若确认收益再加可选参数)。
- **测试**:性能实测(非 vitest);结论写入文档。
- **验收**:同素材编码耗时下降 ≥20%,输出质量不变(crf 不变)。
- **依赖**:无。**估**:~50 LOC + 实测。

---

## 6. 验收标准(整体)

- [ ] **P0**:master `config/hub/` 清空 → 节点任务**一条不减**、录制不中断、有 `rejected` 告警。
- [ ] **P1**:Hub 弹窗可改录制参数;`hub_rules` 表与 `tasks.pipeline` 列不再存在(或已停用)。
- [ ] **P2**:`PUT /api/rooms/:key` 一次改两半;旧 API 兼容。
- [ ] **C**:UI 可配 `maxCpuParallel`;两位并行不被内存闸门卡;burn 单次核利用率提升(有实测数据)。
- [ ] 全程:`pnpm test` / `typecheck` / `bundle` 全绿;架构图一致;每个 `feat|fix` bump version。
- [ ] 部署后:三节点版本一致、hub workers 3/3、任务数不丢、无 error 日志。

---

## 7. 风险与缓解

| 风险 | 缓解 |
|---|---|
| P0-3 显式删除改动跨 master/节点协议 | 过渡开关 `DREC_EXPLICIT_DELETE`,先默认关灰度,观察后再开 |
| P0-2 骤减阈值误伤(用户真的一次删一半) | 阈值可配 + 只停不删 + 告警;提供「强制应用」入口 |
| P1-2 弹窗改 task 引入竞态(同时改两半) | 后端 `rooms` 写接口做单事务(Phase 2 提前到 Phase 1 后) |
| P2/P3 消费面大(110 handler / 19 模块) | 旧接口保留一周期;逐域迁移 + 每步全量验证 |
| C 组误判收益 | C-3 先量化再改;并行度按 7 天数据说明「削峰不提吞吐」 |
| 部署中断录制 | 严格走 guard;每节点独立 stage;失败只跳过该节点 |

---

## 8. 明确不做

- **worker 主动 claim / lease 队列** —— Fleet 54 个 `.rs` 中 `queue`/`claim`/`job`/`task` **零命中**;
  房间是**常驻监控**(VPS1/VPS2 各 5~9 个 running),不是一次性 job。
- **「任务一次性入队 → 认领」** —— 同上,语义冲突。
- 不动 `selectWinner` / 冗余选优模型(T-2 / `plans/026`)。
- 不做消息中间件 / 常连控制通道(T-16 已评估,暂不做)。

---

## 9. 证据与复现(审计结论)

### 9.1 现状数据模型

| 存储 | 数量 | 角色 |
|---|---|---|
| `tasks` 表 | 19 | 录制配置 **+ 运行时**(status/running/anchorName/managedBy 混在一行) |
| `config/hub/*.json` | 16 | 后处理配置 + 节点分派 + `enabled` + `sourceTaskId` |
| `sync_jobs` 台账 | 45 | 运行历史 —— **`/queue` 与 `/hub` 共读此表** |
| `hub_rules` 表 | 1 | **遗留死表**(代码已不读写) |
| `tasks.pipeline` 列 | **0 有值** | **死列** |

**历史脉络**:`git show 6636952`(2026-06-29)—— pipeline **原本就在 task 上**,是按当时的用户
要求「**录制只管录、hub 是另外的页面**」拆出去的;`git show 2d3ba7c` 又把规则从 DB 迁到文件。
→ 现状是**两次需求演进的结果**,不是设计事故;**B 是「需求反转」,不是「修 bug」**。

### 9.2 P0 缺陷链路(已实测复现)

```
master hub/ 空或不可读
  → listHubRules(dir) = []          # hub-store.ts: catch → []（把「读不到」当「没有」）
  → desiredFor() = []               # cli.ts 循环体不执行
  → applyTasks({ desired: [] })     # 无「空期望」守卫
  → applyRemoteTasks: 受管且不在 desired → 两阶段删除
      第 1 轮: setEnabled(false) + pending
      第 2 轮: removeTask          ← 任务被清空
```

实测输出(探针已删):

```
删除前: [ '1:https://live.douyin.com/111 en=true mb=hub' ]
第1轮(启用中): {"pending":["douyin:111"]} 剩余: 1
第2轮(已停):   {"removed":["douyin:111"]} 剩余: 0   ← 清空
```

**节点零副本**:VPS2 `config/hub/` 为空(规则只在 master)。

### 9.3 已做对的部分(无需改)

| 能力 | 证据 |
|---|---|
| 节点本地持久化任务 | VPS2 `db/douyin-rec.db` 有 **10 个 task,全部 `managedBy=hub`** |
| daemon 不依赖 master | `daemon.ts` 的 `decide()` 只读本地 `t.enabled` |
| 节点重启不依赖 master | 节点无 `--hub` → `hubEnabled=false` → 不发起任何同步 |
| master 不可达不误删 | `cli.ts` 同步循环 `catch → warn` → 下轮重试 |

### 9.4 并行度实测(C 组依据)

| 项 | 值 |
|---|---|
| 容器可见 | **11 核 / 4.18 GB** |
| 单次 x264 编码(180s 1080p,veryfast crf18,同 burn 参数) | CPU ≈ **5.3 核**;耗时 17.7s ≈ 10x 实时 |
| `maxCpuParallel` 默认 | **1**(`hub.config.json` 未配 `resources`) |
| → 闲置 | **约一半核(48% 利用率)** |
| UI 能否改 | **不能**(全前端 grep 零命中) |
| 内存闸门 | `minBurnFreeMemMB = 2048`;容器可用 2.5 GB → **第 3 位进不来** |
| master 上行带宽 | **12 Mbps**(不可压缩 50MB 实测) |
| 7 天 burn 总量 | **5.6 h / 0.8 h 每天** → 提并行度**削峰不提吞吐** |

### 9.5 复现命令

```bash
# 配置分布
python3 -c "import sqlite3;c=sqlite3.connect('docker-data/db/douyin-rec.db');
print('tasks',c.execute('SELECT COUNT(*) FROM tasks').fetchone()[0]);
print('hub_rules(死表)',c.execute('SELECT COUNT(*) FROM hub_rules').fetchone()[0]);
print('tasks.pipeline 有值',c.execute(\"SELECT COUNT(*) FROM tasks WHERE pipeline!=''\").fetchone()[0])"
ls docker-data/config/hub/*.json | wc -l

# 节点本地持久化 / 零副本
ssh video-rec-2 'ls /home/ubuntu/drec/config/hub/; node -e "const{DatabaseSync}=require(\"node:sqlite\");const db=new DatabaseSync(\"/home/ubuntu/drec/db/douyin-rec.db\",{readOnly:true});console.log(db.prepare(\"SELECT managedBy,COUNT(*) c FROM tasks GROUP BY managedBy\").all())"'

# 并行度与资源
docker info --format '{{.NCPU}}核 {{.MemTotal}}B'
rg -n 'maxCpuParallel|minBurnFreeMemMB' packages/orchestrator/src/workflow.ts packages/cli/src/cli.ts

# 历史脉络 / 队列同表
git show 6636952 --stat; git show 2d3ba7c --stat
rg -n 'buildQueueView|listHubJobs' packages/app/src/hub-jobs.ts
```
