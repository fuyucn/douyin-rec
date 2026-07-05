# Workers 管理（多节点 hub）设计

> 状态：设计稿（2026-07-05，brainstorming 产出，待实现）。
> 关联：[multi-node-sync.md](../../multi-node-sync.md)（心智模型：多副本冗余 + read-repair）、
> [architecture.md](../../architecture.md)「多节点 hub」。

## 目标

给多节点 hub 的**录制 worker**（当前代码称 "tenant"、手改 `hub.config.json`）加一套 **Web UI 管理 + 连接测试 + 实时重载**，并把代码里的 **`tenant → worker` 全量改名（含 ledger 列名）**。后处理 / 选优逻辑不变——本设计只改「worker 是谁」和「怎么管理 worker」。

**非目标（YAGNI）**：不改选优 / 合并 / 上传逻辑；不做 worker 的 CLI 子命令或 TUI 屏（= 下文「档 B」，本期不做，见「多端一致」）。

## 多端一致（config 或 UI，两边同步）

worker 用 **file-as-truth**（不是 task 那样的 DB-as-truth）：

| | 真理源 | CLI/TUI/UI 如何同步 |
|---|---|---|
| Task | DB（`douyin-rec.db`） | `task add`/TUI/Web 都打同一个 DB 文件 |
| Worker | 文件（`hub.config.json`） | UI 与手改都打同一个文件，**读时不缓存** + 实时重载 |

**本期做「档 A」**：纯 CLI / headless = 直接手改 `hub.config.json`（无需浏览器）；Web UI 读写同一文件；两者天然同步 + 运行中 hub ≤8s 生效。TUI 现在不管 hub，保持不受影响。
**档 B（延后）**：`hub worker add/list/rm` CLI 子命令 / TUI Workers 屏——以后有需要再做，本期不实现。

## 数据模型

worker 存在 `hub.config.json` 的 `workers` 数组（由 `tenants` 改名），与既有全局字段（`stageDir`/时序/`uploadDefaults` 等）并存、**写时逐字保留其余字段**：

```jsonc
{
  "workerSeq": 2,                 // 新增:持久单调计数器(分配 id 用,绝不复用)
  "workers": [                    // 由 "tenants" 改名
    { "id": "local",    "name": "本机",     "kind": "local",        "dataRoot": "/output-data" },
    { "id": "worker-1", "name": "香港 VPS", "kind": "ssh",          "host": "100.x", "dataRoot": "/home/ubuntu/drec" }
  ],
  "platform": "douyin", "cookies": "...", "cleanMaxGapSec": 30,
  "stageDir": "...", "settleMs": 90000, "pollMs": 3000,
  "reconcileIntervalMs": 8000, "uploadDefaults": { ... }   // 全部原样保留
}
```

- **`id`**：内部稳定主键，正常使用中不展示。旧 `local`/`vps2` **grandfather 保留原值**；新建 = `worker-${++workerSeq}`（单调、删除后也不复用 → 不会把历史 ledger 行错配给新 worker）。`local` 为 master 自身保留 id。
- **`name`**：友好名，**各处展示**（UI + 选优日志）、可编辑、创建时自动默认（缺省用 host，无 host 用 `Worker N`）。
- **`kind`**：不改名（这是 transport 类型，与 tenant/worker 概念正交）：`local` / `ssh` / `tailscale-ssh`。`ssh`/`tailscale-ssh` 需 `host`+`dataRoot`；`local` 需 `dataRoot`。
- **`apiUrl`**：既有可选字段，保留。
- **向后兼容读**：`workers ?? tenants`（旧文件继续能跑；首次写入迁移成 `workers` + 补 `workerSeq`）。

## `tenant → worker` 改名（全量，含 ledger 列）

| 层 | 改动 |
|---|---|
| orchestrator | `TenantConfig`→`WorkerConfig`（+`name`）、`NodeInventory.tenantId`→`workerId`、`getTransport(cfg)` 形参、pipeline/select/reconciler 里所有 `m.tenantId`/`winner.tenantId`/`perNode` |
| ledger（sqlite） | `sync_jobs.winnerTenant`→`winnerWorker`；`sync_candidates.tenantId`→`workerId`（PK 列）。用**幂等** `ALTER TABLE … RENAME COLUMN`（try/catch，与既有迁移同模式，SQLite ≥3.25 支持 PK 列改名）。**值不变**（`local`/`vps2` 保留） |
| app | `hub-jobs.ts` 读改名后的列；`HubJobView.winnerTenant`→`winnerWorker` |
| web | DTO + `RunCard`「选优: …」由展示 raw id 改为**按 id 查 name 展示**（查不到回落 id） |
| config | `hub.config.json` `tenants` 键 → `workers`；`paths.ts` 的 example 文本同步 |

## 配置 = 文件，实时重载（Approach A）

- **真理源**：`hub.config.json`（已确认 `settings.hubConfig` 未设 → 文件生效）。CRUD 走 read-modify-write，**保留其余字段**；原子写（temp + rename，仿 `hub-store.ts`）。
- **实时重载**：CLI 把一个 `loadWorkers(): WorkerConfig[]` thunk（经 app 的 worker-store 读新鲜文件）注入 `Reconciler`。**两条触发路径**（周期 `reconcileAll` + master 自身 `recordEnd`）在跑之前都**用 `loadWorkers()` 重建 transports Map**。transport 无状态 → 重建极廉价。≤1 个 reconcile 周期(~8s)生效。无需重启、无 file-watcher。

## 组件（守分层：app L4 不 import orchestrator L4.5；CLI L5 装配）

- **`app/src/worker-store.ts`（新，仿 `hub-store.ts`）**：`listWorkers` / `createWorker` / `updateWorker` / `deleteWorker`——纯文件 CRUD，无 orchestrator 依赖。负责 id 分配（`workerSeq`）、默认 name、`tenants→workers` 迁移、字段保留、原子写。
- **REST**（`app/web`）：
  - `GET /api/hub/workers` → 列表
  - `POST /api/hub/workers` → 新建（body：`name?`,`kind`,`host?`,`dataRoot`）
  - `PATCH /api/hub/workers/:id` → 改（name/host/dataRoot/kind）
  - `DELETE /api/hub/workers/:id` → 删
  - `POST /api/hub/workers/test` → 连接测试（body = 待测 worker 配置，支持存前先测）
- **连接测试**：`WebServerDeps.testWorker?(cfg): Promise<TestResult>` 由 **CLI 注入**（CLI 能 import orchestrator：`getTransport(cfg)` → `listInventory()` 带超时）。返回 `{ ok, reachable, dataRootExists, recordingCount?, error? }`——一次验证 SSH 可达 + dataRoot + inventory 可解析。hub 未启用 → 端点返回「hub 未启用」。
- **Web UI**：Hub 页顶部（规则列表之上）加一张 **"Workers" 卡**——每行显示 name / kind / host / 状态点；每行 **测试** + 编辑 + 删除；Add/Edit 弹窗（name、kind 下拉、host、dataRoot）带**存前测试**按钮。`id` 不展示。沿用现有 3s 轮询。

## 错误处理 & 安全

- **校验**：`kind` 枚举；ssh 类需 `host`+`dataRoot`；`local` 需 `dataRoot`；name 空则自动默认。
- **`local`（master 自身）保护**：不可删（master 必须有自己）、不可改 `kind`；`name`/`dataRoot` 可改。
- **删除**：远端 worker 可删；若删时有 in-flight sync 引用它 → 下一轮 reconcile 重建 transports 时自然剔除，该 job 优雅失败→重试（文档说明，不硬阻断；worker 是设一次的低频操作）。
- **连接测试**：硬超时，返回结构化错误，绝不挂起 UI。
- **文件写**：读-改-写保留所有非 worker 字段；原子写（temp+rename）。

## 测试

- **`worker-store` 单测**：create → `worker-N` 单调 + 默认 name；update 补丁；delete 移除；**`local` 保护**（拒删/拒改 kind）；保留非 worker 字段；`tenants→workers` 读迁移；`workerSeq` 单调不复用。
- **ledger 迁移**：RENAME COLUMN 幂等、旧 `local`/`vps2` 值保留、新行写新列名。
- **改名连带**：更新引用 `winnerTenant`/`tenantId` 的既有测试。
- **web api**：worker 端点（仿 hub-rules 测试）；`testWorker` 注入假实现。
- **实时重载**：reconciler 测——改变 `loadWorkers()` 返回 → 下一轮用的 transports 随之变（证明 Approach A）。

## 建议任务拆分（供 writing-plans）

1. **改名 `tenant→worker`**（代码 + ledger 迁移 + config 键 + 连带测试）——面广但机械；先做、先绿。
2. **worker-store + REST + 实时重载 thunk**——后端 CRUD + reconciler 重读。
3. **连接测试**（注入 `testWorker`）。
4. **Web UI** Workers 卡 + 弹窗。
