# 026 — Worker 负载分摊（placement / 按负载自动选点）

> 状态：**未来计划（未排期）**。台账条目 `T-2`（见 `TODO.md`）。
> 参考实现：biliup **Fleet** 的 `placement.rs`（`choose()` / `check()` / `explain()`）。

## 背景与动机

我们当前的 hub 模型是**冗余录制 + 收播后 coverage 选优**：一个房间勾选 N 个 worker，
每个 worker 都录同一场，收播后由 `select.ts` 选覆盖率最高的一份进 pipeline。

代价：**轮询/取流请求量是 N 倍**（每个 worker 各自 30s 轮询开播、各自取流）。
这是 VPS 出口 IP 被抖音风控限流的根因之一 —— 一次太多录制查询砸在同一个出口 IP 上。

分摊模型则是：**每个房间只派 1 台**节点，由控制面按负载挑选。请求量回到 1 倍。

## 核心取舍（必须先决策，不是能顺手加的功能）

| | 冗余（现状） | 分摊（本计划） |
|---|---|---|
| 每房间录制节点数 | N（勾选的全部） | 1 |
| 请求量 | N 倍 | 1 倍 |
| 抗单点断流 | 强（coverage 选优） | 弱（单点失败即丢） |
| 抗出口风控 | 差（N 倍请求） | 好 |

**两者对同一房间互斥**。可行的是**按房间分开用**：重要房间走冗余，冷门房间走分摊
（`workers` 已是 per-rule，天然支持）。

> 决策点：哪些房间愿意放弃冗余换省 IP？未定 → 本计划不排期。

## 设计草案（来自 biliup Fleet `placement.rs`）

### 1. 选点时机

只在**分配时刻**计算，已在录的房间**不因负载变化被挪走**（biliup 注释 D9「不漂移」）：

- 新建房间且模式 = `auto`
- 移除节点时的自动改派

### 2. 硬过滤（资格）

任一不满足即淘汰（与 `T-1` 能力门控共用这套过滤）：

- 不在移除中、在线、协议/版本够新
- 登记了模板要用的 B 站账号（`accounts` 含该 mid）
- 带钩子的房间只派给允许钩子的节点（`allow_hooks`）
- 带齐房间要求的标签（`required_labels`）

### 3. 软排序（挑最轻的一台）

全平才用下一个键：

1. 下载池空位多（`capacity - occupied`）优先
2. 已分派房间少的优先
3. 录制目录剩余空间大的优先
4. id 小（保证结果可复现）

### 4. 不双录的状态机（biliup `assignments.rs`）

- `node_id` = 该在哪台录；`releasing_node_id` = 上一台还没确认释放。
- **只要 `releasing_node_id` 非空，该房间就不在任何节点的期望状态里** → 先让旧节点停、
  收到它的 Ack（不再持有该房间）才交给新节点。
- 每次改派 `epoch + 1`，节点重连时按 epoch 对账。
- `force_release` 才允许跳过等待（可能短暂双录，直到旧节点连回来按期望状态停下）。

## 与现有代码的接点

- 规则：`packages/app/src/hub-store.ts`（`HubRule.workers`）
- 下发：`packages/app/src/task-sync.ts`（`applyRemoteTasks` / `desiredFor`）
- 选点：新增 `packages/orchestrator/src/placement.ts`（对齐 biliup `choose()`/`check()`/`explain()`）
- 对账：`packages/orchestrator/src/reconciler.ts`
- 遥测输入（下载池占用 / 磁盘剩余 / 已分房间数）：需节点上报，当前 `NodeTasks`/`NodeInventory` 不含

## 非目标

- 不做「已在录房间的动态再平衡」（biliup 明确不做，会造成双录/断流）。
- 不替代 `T-1` 能力门控 —— 门控是过滤（保留冗余语义），本计划是选一（放弃冗余）。

## 前置

- `T-1`（能力门控）先落地，本计划复用其 `check()`/`explain()` 与 worker 能力声明。
- 需要节点遥测（下载池/磁盘/房间数）上报，否则软排序无输入。
