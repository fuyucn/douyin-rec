# Hub 规则按 Worker 选择执行 Pipeline 设计

> 状态：设计稿（2026-07-06，brainstorming 产出，待实现）。
> 前置依赖：Workers 管理（[2026-07-05-workers-management-design.md](./2026-07-05-workers-management-design.md)，已实现）+ Hub 区域 i18n（已实现，commit 9bb4cb1）。
> 关联：[multi-node-sync.md](../../multi-node-sync.md)（心智模型：多副本冗余 + read-repair，本特性是**读侧**过滤，非写侧任务下发）。

## 目标

让每个 hub 规则（每房间 `config/hub/{platform}.{roomSlug}.json`）能**选择哪些 worker 参与**，pipeline 只对选中的 worker 执行（聚类/拉取/选优/上传）。这是**读侧硬过滤**：worker 仍各自独立录制，本特性只收窄 hub 对该房间**考虑哪些 worker 的录像**。

**非目标（YAGNI）**：不做写侧任务下发（master 不把任务推给 worker）；不改选优算法本身；worker 的增删改仍由已有的 Workers 管理负责。

## 语义（硬过滤）

- 规则新增字段 `workers?: string[]`（worker id 列表）。
- **`workers` 有值（≥1 个 id）→ 硬过滤**：只对 `workerId ∈ workers` 的录像做聚类/拉取/选优/上传；**非选中 worker 的那份录像被完全忽略**（不拉取、不选优、不上传），在选中的 worker 里选最完整一份。
- **选中的 worker 都没录到该场 → 不建 job（跳过）**，与今天"没人录到"行为一致。
- **`workers` 缺省或空数组 → 全部 worker**（向后兼容）。这是"硬过滤"与"新规则必须显式选"的调和点：硬过滤**只在 `workers` 显式设置时生效**；老规则不写该字段 = 全选，绝不因升级停摆。
- 选中的 id 指向已删除的 worker → 该 id 自然不在 inventory/members 里 → 被忽略，无需特判。

## 过滤在哪生效（reconciler）

- `reconciler.ts` 的 `reconcileAll`：`resolveCfg(platform, roomSlug)` 拿到规则后，**在 select 之前**把该场 broadcast 的 `members` 过滤为 `workerId ∈ rule.workers`（仅当 `workers` 非空时；否则不过滤 = 全部）。过滤后照常 select → runPipeline。
- **`settleAll`（等各节点收播）也用同一过滤**：只等选中的 worker 收播，不被"没选中但仍在录"的节点拖住 settle。
- 单一插入点 = 聚类之后、settle/select 之前。不改 clusterBroadcasts、select、pipeline 内部逻辑。

## 配置 & DTO

- `config/hub/{platform}.{roomSlug}.json` 顶层加 `workers?: string[]`（与 `room`/`enabled`/`pipeline` 并列）。
- `hub-store.ts` 的读写保留该字段（read-modify-write 已 spread 全字段，确认 `workers` 一并往返）。
- `HubRuleDTO`（`@drec/core` api-types）加 `workers?: string[]`；`hubRuleView` 透出。

## 向后兼容 / 迁移

- 老规则（无 `workers`）= 全选，**不强制迁移**、照常运行。
- **编辑**老规则时，UI 选择器**预勾"全部当前 worker"**（把隐式 all 显性化）；保存即写成显式列表。
- **新建**规则：UI 必须选 ≥1（见下）。

## UI（HubRuleDialog）

- 加一个 **worker 多选**（勾选框），显示 worker 的 **name**（底层存 id），经现有 `api.listWorkers()` 拉列表。
- **新建**：默认不勾，**必须选 ≥1 才能保存**（保存按钮禁用 + 后端 400 兜底）——满足"必须显式选"。
- **编辑**老规则（无 `workers`）：预勾全部当前 worker，让用户看到并确认。编辑已有显式列表：回显已选。
- worker 列表为空（hub 未配 worker）或拉取失败：给出提示，不崩。
- i18n：新增文案进 `hub` 词典组（zh/en），复用已就绪的 i18n（commit 9bb4cb1）。

## 错误处理

- 后端 `createHubRule`/`updateHubRule` 校验：若 body 带 `workers`，必须是非空 `string[]`（元素为 worker id 字符串）；缺省允许（兼容读/老规则）。UI 建的规则总带显式非空列表。
- reconciler 过滤对未知/已删 id 宽容（集合交集，取实际录到的）。

## 测试

- **reconciler**：① `workers=[local]` 时即便 vps2 也录了该场，vps2 member 被过滤掉、winner 只能是 local（硬过滤）；② 无 `workers` → 全 members 参与（兼容）；③ 选中的 worker 都没录该场 → 不建 job；④ `settleAll` 只等选中的 worker（一个没选中的节点仍在录不阻塞）。
- **hub-store**：`workers` 字段创建/更新往返 + 其余字段（room/enabled/pipeline）保留。
- **web api**：`createHubRule` 带空 `workers` → 400；带非空 → 201 且回显；`updateHubRule` 改 `workers` 生效。
- **UI**：`cd packages/web && pnpm build` 绿 + typecheck 0；手动核对清单（新建必须选、编辑老规则预勾全部、保存后 reconciler 按选择过滤）。

## 任务拆分（供 writing-plans）

1. **后端**：规则 `workers?` 字段（config + hub-store + `HubRuleDTO`/`hubRuleView`）+ reconciler `reconcileAll`/`settleAll` 过滤 + create/update 校验 + 单测。先绿。
2. **UI**：HubRuleDialog worker 多选（拉 `listWorkers`、显示 name）+ 新建必选校验 + 编辑老规则预勾全部 + i18n 文案。
