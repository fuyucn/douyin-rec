# 029 — 房间配置统一 + 队列并行度 + 节点韧性(审计与设计)

> 状态:**设计文档(未执行)**。台账条目 `T-26`(见 `TODO.md`)。
> 来源:2026-10-09 三轮审计 + 用户讨论。**本文是审计与方案,不含实现**。
> 结论均以**真实台账 + 实测**验证,每条附复现命令(见文末「附录」)。

## 0. TL;DR

| # | 结论 | 严重度 | 状态 |
|---|---|---|---|
| A | **master 配置丢失 → 所有节点受管任务被自动清空**(数据丢失) | P0 | 缺陷,待修 |
| B | 房间配置分两处(task + hub 规则),`enabled` 两个语义未说明 | P1 | 现状,需求已反转 |
| C | **单次 burn 只用 5.3/11 核(48%)**;并行度默认 1 且 UI 改不了 | P1 | 能力在、够不着 |
| D | 队列与 hub **不是两套系统**,是同表(`sync_jobs`)两个视图 | — | 澄清(非问题) |
| E | 房间是**常驻监控**,不是队列项;**不做 worker claim/lease** | — | 结论 |

**建议顺序:A(韧性) → C(并行度) → B(配置统一)。**

---

## 1. 现状数据模型(实测)

| 存储 | 数量 | 角色 |
|---|---|---|
| `tasks` 表 | 19 | 录制配置 **+ 运行时**(status/running/anchorName/managedBy 混在一行) |
| `config/hub/*.json` | 16 | 后处理配置 + 节点分派 + `enabled` + `sourceTaskId` |
| `sync_jobs` 台账 | 45 | 运行历史 —— **`/queue` 与 `/hub` 共读此表** |
| `hub_rules` 表 | 1 | **遗留死表**(代码已不读写) |
| `tasks.pipeline` 列 | **0 有值** | **死列**(历史遗留) |

**历史脉络(重要,决定了 B 的定性)**:
- `git show 6636952`(2026-06-29):pipeline **原本就在 task 上**,是按当时的用户要求
  「**录制只管录、hub 是另外的页面**」拆出去的。
- `git show 2d3ba7c`:hub 规则又从 DB 迁到文件。

→ 当前形态是**两次需求演进的结果**,不是设计事故。**B 项不是「修 bug」,而是「需求已反转,该合回来」。**

---

## 2. 韧性审计(结论 A — P0)

### 2.1 已做对的部分(实测,无需改)

| 能力 | 证据 |
|---|---|
| 节点本地持久化任务 | VPS2 `db/douyin-rec.db` 有 **10 个 task,全部 `managedBy=hub`** |
| daemon 不依赖 master | `packages/app/src/daemon.ts` 的 `decide()` 只读本地 `t.enabled` |
| 节点重启不依赖 master | 节点无 `--hub` → `hubEnabled=false` → 不发起任何同步 |
| master 不可达不误删 | `cli.ts` 同步循环 `catch → warn` → 下轮重试,期望状态原样保留 |

**→「master 掉线,节点继续录」成立。这部分设计是对的。**

### 2.2 缺陷:配置丢失会**主动清空**节点

**触发**:master 的 `config/hub/` 目录丢失/不可读(磁盘故障、误删、备份恢复、
容器重建时 `DATA_ROOT` 指错、卷挂载失败)。

**链路(已实测验证)**:

```
master hub/ 空或不可读
  → listHubRules(dir) = []          # hub-store.ts: catch → []（把「读不到」当「没有」）
  → desiredFor() = []               # cli.ts 循环体不执行
  → applyTasks({ desired: [] })     # 无「空期望」守卫
  → applyRemoteTasks: 受管且不在 desired → 两阶段删除
      第 1 轮: setEnabled(false) + pending
      第 2 轮: removeTask          ← 任务被清空
```

**实测输出**(探针跑完已删):

```
删除前: [ '1:https://live.douyin.com/111 en=true mb=hub' ]
第1轮(启用中): {"pending":["douyin:111"]} 剩余: 1
第2轮(已停):   {"removed":["douyin:111"]} 剩余: 0   ← 清空
```

**加剧因素**:
1. 无「期望状态骤减」安全阀(`applyTasks` 对空数组无守卫)。
2. master 是规则的**唯一存储**;**节点零副本**(实测 VPS2 `config/hub/` 为空)。
3. 两阶段删除**全自动**,无人工确认。

**与 Fleet 对比**:Fleet 从不靠「不在快照里」删房间 —— 它用 `deleted_at` + `releasing_node_id`
+ `Ack` 三阶段显式确认。

### 2.3 修复设计(三条)

1. **节点落盘期望状态副本**
   `<root>/config/managed/rooms.json` —— 节点启动**先按副本起 daemon**,再连 master 对账
   (master 不可达也能跑)。
2. **期望状态骤减安全阀**
   - `desired.length === 0 && 本地受管数 > 0` → **拒绝执行 + 告警**(要求人工确认);
   - `desired.length < 本地受管数 * 0.5` → **只停用、不删除** + 告警。
3. **删除改为显式意图**
   - 「不在期望里」→ **只停用**;
   - 只有 master 显式标记删除(或 `epoch` 递增)才真删。

**验收**:master `config/hub/` 清空后,节点**继续录**且**任务不被删除**;恢复后自动对账。

---

## 3. 队列与并行度(结论 C、D、E)

### 3.1 澄清:不是两套系统(D)

`/queue` → `buildQueueView()` → `listHubJobs()` 读 `sync_jobs`;
`/hub` → `listHubRules()` + `listHubJobs()`(同一张表)。
**同一个台账,两个视图。** 队列**没有**认领/派发动作,派发由 master 的 `desiredFor()` 主动推。

### 3.2 澄清:不做 claim/lease 队列(E)

biliup Fleet 54 个 `.rs` 全扫:**`queue` / `claim` / `job` / `task` 均 0 命中**。
Fleet 用**声明式期望状态 + 长期房间分派**;队列只在节点内部(下载池/上传池)。
我们的房间是**常驻监控**(VPS1 5 个 running、VPS2 9 个 running),不是一次性 job。
→ **「放队列 → worker 认领」与场景不符,不做。**

### 3.3 并行度:实测结论(C — 用户判断正确)

**实测(容器内)**:

| 项 | 值 |
|---|---|
| 容器可见 | **11 核 / 4.18 GB** |
| 单次 x264 编码(180s 1080p,veryfast crf18,同 burn 参数) | CPU ≈ **5.3 核**;耗时 17.7s ≈ 10x 实时 |
| `maxCpuParallel` 默认 | **1**(`hub.config.json` 未配 `resources`) |
| → 闲置 | **约一半核(48% 利用率)** |
| UI 能否改 | **不能**(全前端 grep 零命中) |
| 内存闸门 | `minBurnFreeMemMB = 2048`;容器可用 2.5 GB → **第 3 个并行位进不来** |
| master 上行带宽 | **12 Mbps**(不可压缩 50MB 实测)→ 网络并行收益有限 |

**修正此前的错误**:曾用「净闸门并发度 0.10x」否定并行度 —— 那是 **`net` 闸门**(pull)的指标,
**与 CPU 并行无关**,指标取错了。

**修复方向**:
1. `resources` **暴露到 UI**,含按核数给的推荐值(推荐 = `floor(核数 / 5.3)` → 11 核 = 2);
2. **内存闸门与并行度联动**:`minBurnFreeMemMB >= 并行度 × 单次峰值`(否则并行位形同虚设);
3. **先优化单次 burn 核利用率**(48% → 目标 90%):测 `-threads` / `preset` / `-x264-params`;
4. 立即可用(不改代码):`hub.config.json` 加 `"resources":{"maxCpuParallel":2,"maxNetParallel":2}`,
   **并把 Docker VM 内存提到 8 GB**,否则第 3 位永远排不上。

**注意**:按 7 天数据,burn 总量仅 **5.6 h / 0.8 h 每天** → 提并行度**不提升平均吞吐**(无积压),
只降**尾延迟**(如那个 11074s 的离群场)。故 C 的价值在「削峰」,不在「提吞吐」。

---

## 4. 配置统一设计(结论 B)

### 4.1 目标模型(与 Fleet 同构)

```
<root>/config/rooms/{platform}.{roomSlug}.json    ← 唯一配置源(文件,热改)
{
  "platform": "douyin", "roomSlug": "767116735823", "room": "https://...",
  "enabled": true,                                   ← 唯一开关
  "record":  { "quality","engine","danmu","segmentSec","useCookie","outDir","schedule" },
  "process": { "steps","upload","cleanup" },         ← 缺省 = 只录不处理
  "place":   { "workers","requires" }
}
```

**要点**:
1. `process` 缺省 = 只录不处理 → 统一现在「有规则(16) / 无规则(3)」两种情况;
2. `enabled` 收敛为 1 处(原 task.enabled + rule.enabled 合并);远端副本仍由它派生;
3. `tasks` 表降级为**运行时投影**(status/running/anchorName/pid);
4. `process`/`place` 沿用**文件**存储(现在 hub 规则就是文件:热改、无迁移);
5. 删除:`hub_rules` 死表、`tasks.pipeline` 死列、`config/hub/*.json`。

### 4.2 分阶段(风险递增)

| Phase | 内容 | 风险 | 依赖 |
|---|---|---|---|
| **0** | **韧性修复**(§2.3 三条) | 中 | 无 —— **必须最先** |
| **1** | 清死代码(`hub_rules` / `tasks.pipeline`)+ `HubRuleDialog` 内联录制配置 | 低 | 无 |
| **2** | 统一 `GET/PUT /api/rooms/:key`(存储暂不合并) | 中 | Phase 1 |
| **3** | 合并存储为 `config/rooms/*.json` + 一次性迁移 | **高** | **Phase 0** |

> **Phase 3 必须在 Phase 0 之后**:把配置进一步集中到 master 会**加重单点**;
> 没有节点副本与安全阀就合并 = 放大结论 A 的风险。

### 4.3 消费面规模(改动量评估)

| 面 | 规模 |
|---|---|
| web API handler | **110** 个(8 个域文件) |
| cli 子命令 | 15 个 |
| 前端 tsx | 27 个 |
| 引用 `TaskStore` 的模块 | 19 个 |

→ Phase 2 / 3 是**大改**,需单独立 plan 与逐步验证。

---

## 5. 明确不做

- **worker 主动 claim / lease 队列** —— 与常驻监控语义冲突;Fleet 实证不做(§3.2)。
- **「任务一次性入队 → 认领」** —— 房间是持续监控,不是 job。
- 不动 `selectWinner` / 冗余选优模型(另一议题,`plans/026` / T-2)。

---

## 6. 待用户决策

1. **Phase 0(韧性)** 是否排在所有重构之前?——建议**是**(数据丢失 > 性能)。
2. **删除语义**:保留自动删除(靠骤减安全阀兜底)还是改**显式删除**(更安全、多一步)?
3. **Phase 3(合并存储)** 是否要做?还是停在 Phase 1/2(单弹窗配两半 + 统一 API)即可?
4. **master 机器物理配置**?Docker VM 当前 11 核 / 4 GB —— VM 配额能否调大(决定并行度天花板)。

---

## 附录:复现命令

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

# 历史脉络
git show 6636952 --stat        # pipeline 从 task 拆出(用户要求)
git show 2d3ba7c --stat        # hub 规则 DB → 文件

# 队列 = 同一台账
rg -n 'buildQueueView|listHubJobs' packages/app/src/hub-jobs.ts
```
