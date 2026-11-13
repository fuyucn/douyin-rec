# plans/051 — 管线步骤注册表（审计 P1-2 / 组 F）

> 状态：**设计待评审，未开工**。按 AGENTS.md：纯搬迁与行为变更分开 PR，每个阶段单独 PR。

## §1 现状（2026-11-13 核实）

**事实 1：步骤词表只有一份，执行写法有五种。**

- 词表在 `packages/core/src/hub-ledger-contract.ts` 的 `HUB_STEP_NAMES`（14 个）：
  `select` / `pull` / `node_upload` / `merge` / `burn_danmu` / `burn_livechat` /
  `upload_plain` / `append_danmu` / `append_livechat` / `clean_verify` /
  `clean_stage_src` / `clean_source` / `clean_stage`。
- **合并模式**：`packages/orchestrator/src/workflow.ts` 的 `buildWorkflow` 在数组里内联构造 6 个节点，
  `WorkflowNodeKey` 是 `Extract<StepName, "merge" | "burn_danmu" | ...>` 的封闭 union；
  `select` / `pull` 是图外前奏、`clean_*` 是图外收尾（源文件注释自己写着「均不进节点表」）。
- **分段模式**：`packages/orchestrator/src/segment-pipeline.ts` 又手写一遍状态机——`logStep` 与
  `syncNodeState` 成对出现十余处，顺序由函数体决定，不走执行器的 ready 集合。
- **节点模式**：`packages/app/src/node-pipeline.ts` 再写一遍，并各自复制了 `splitGroupsBySession`
  （三份：node-pipeline / segment-pipeline / `processors/src/upload-prep.ts`）与 `linkOrCopySync`（两份）。
- **直传两条**：`app/src/rolling-upload.ts` 与 `zero-upload/src/live-pump.ts` 各自维护建稿与追 P
  （live-pump 已于 plans/049 阶段 2b 改走驱动，rolling 仍是自己的循环）。

**事实 2：DAG 不是数据。** 节点集合是类型层面的封闭 union，边在执行函数里内联返回；
加一个步骤要同时改词表、union、buildWorkflow、执行器与 UI 映射五处。

**事实 3：拓扑有两份。** `packages/core/src/hub-flow.ts` 的 `HUB_FLOW_EDGES`（web 队列页展示）与
`buildWorkflow` 返回的 `edges`（执行）。该文件注释明确：`append_danmu → append_livechat`
在执行侧是**条件边**，展示侧无条件收录。两份迟早漂移，现在只靠人工同步。

**事实 4：上传调用散在五个实现文件**（非测试的 `createArchive` / `appendArchive` 出现 14 处：2 处定义在 `core/upload-call.ts`，其余 12 处是调用）：
`orchestrator/src/workflow.ts`（合并模式建稿 + 追 P）、`orchestrator/src/pipeline.ts`（追 P）、
`orchestrator/src/segment-pipeline.ts`（四处）、`app/src/node-pipeline.ts`（两处）、`app/src/rolling-upload.ts`（建稿 + 追 P）；
`zero-upload` 那条已于 plans/049 阶段 2b 改走驱动。

## §2 目标

1. **步骤是数据**：14 个步骤各有一份 `StepSpec`（输入、输出、资源类别、幂等依据、重试与禁用条件、
   run），加步骤 = 在表里加一行 + 在图里连一条边，不改类型 union。
2. **三种模式 = 同一执行器上的三张图**：合并 / 分段 / 节点三张 `StepGraph` 由同一张表声明，
   执行器（幂等、blocked/skipped 派生、资源池、续跑）只有一份。
3. **拓扑单一真相**：`hub-flow` 从注册表生成（生成物 + 漂移守护），不再手抄第二份边表。
4. **上传步骤只调驱动**：`upload_plain` / `append_*` 的 run 只调 `UploadDriver`
   （`ensureArchive` / `appendParts` / `verify`，plans/049），不直接 `createArchive`。

## §3 非目标

- 不改台账 schema、不改 `HUB_STEP_NAMES` 里的名字（它们是 UI 与旧库的外部契约）。
- 不改节点协议（`_node-*` 命令、能力上报）。
- 本计划不重写 `rolling-upload` 与 `live-pump` 的循环（方向已定：rolling 走驱动排在阶段 2d，
  另有 needs-decision）。
- 不追求「一步到位把三张图合成一张」：分段与节点模式的分组/限流语义差别大，先各自成图。

## §4 契约

### 4.1 StepSpec

```ts
// new package @drec/pipeline (rank 0.6, depends on @drec/core only)
export type StepResource = "cpu" | "net" | "upload" | "none";

export interface StepSpec {
  id: HubStepName;                 // ledger + UI vocabulary, never renamed
  resource: StepResource;          // selects the pool slot, same meaning as today's ResourceKind
  inputs: ArtifactSpec[];
  outputs: ArtifactSpec[];
  /** How a rerun decides the step is already done.
   *  - "state": node state table says done (today's behaviour)
   *  - "path": artefact already exists on disk
   *  - "none": always run  */
  idempotency: "state" | "path" | "none";
  /** Whether the executor may auto-retry after a failed attempt (today: the autoRetry set). */
  autoRetry: boolean;
  /** Step is declared but not applicable to this job (today's node.disabled). */
  disabledWhen?(ctx: StepContext): boolean;
  run(ctx: StepContext): Promise<void>;
}
```

约束：`id` 必须来自 `HUB_STEP_NAMES`（编译期 `satisfies` 断言）；新增名字要先改 core 词表与 UI 映射，
这是有意的摩擦。

### 4.2 StepGraph

```ts
export type PipelineMode = "merge" | "segments" | "node";

export interface StepGraph {
  mode: PipelineMode;
  /** Declared steps for this mode, in display order. */
  order: HubStepName[];
  /** Directed edges; a step runs when every parent is done or skipped. */
  edges: Array<[HubStepName, HubStepName]>;
  /** Conditional edges: same shape as edges, but only added when the predicate holds. */
  conditionalEdges?: Array<{ from: HubStepName; to: HubStepName; when(ctx: StepContext): boolean }>;
}
```

三张图在 `packages/pipeline/src/graphs/` 下声明，纯数据；条件边写在这里，执行器按当前 ctx 展开。

### 4.3 执行器下沉

现在的执行器 `runWorkflowNodes` 在 `@drec/orchestrator`（rank 4.5），而节点模式在
`@drec/app`（rank 4）——**app 不能 import orchestrator**，这是三份状态机的根因。

方案：新建 `@drec/pipeline`（rank **0.6**，只依赖 `@drec/core`），放：

- `StepSpec` / `StepGraph` 类型与执行器（从 `runWorkflowNodes` 原样搬迁，行为不变）；
- 三张图的声明（纯数据 + 谓词）；
- 产物校验（`checkArtifact` / `validateArtifacts`）；
- 生成 `hub-flow` 的纯函数（`graphToFlowEdges`），供生成脚本调用。

orchestrator 保留 `PipelineDeps` 装配与调用点，改为 `runGraph(deps, graphOf("merge", cfg))`；
app 的节点模式改为 `runGraph(deps, graphOf("node", cfg))`。三份状态机删掉两份。

层守护：`@drec/pipeline` 只能依赖 core；RANKS 登记 0.6；orchestrator/app 各加一条依赖。

### 4.4 hub-flow 派生

core 是叶子（rank 0），不能反向 import pipeline。做法与 `docs/architecture.html` 相同：

- `scripts/gen-hub-flow.mjs` 读注册表，在 core 里生成一份「只含两张常量」的数据文件
  （`HUB_FLOW_EDGES` / `HUB_FLOW_ORDER`，与手写逻辑分文件）；
- 守护测试：生成物与注册表不一致 → FAIL（照 `test/arch/architecture-docs.test.ts` 的写法）；
- `hub-flow.ts` 保留手写部分（`readyNodes` / 侧车前缀判定），只把两张常量换成生成物。

## §5 步骤声明（每步的归属）

| 步骤 | 资源 | 幂等 | 自动重试 | 说明 |
|---|---|---|---|---|
| `select` | none | state | 否 | 前奏；选源会话（合并模式在 reconciler 里做） |
| `pull` | net | state | 是 | 从节点拉回产物；节点模式被 `node_upload` 替代（二者互斥） |
| `node_upload` | upload | state | 是 | 节点本地 remux + 上传，不回传 |
| `merge` | cpu | state | 否 | 合并 / 分段切分；两模式 run 不同实现，同一步骤 id |
| `burn_danmu` | cpu | state | 否 | 烧弹幕；`disabledWhen` = 未开启 |
| `burn_livechat` | cpu | state | 否 | 烧弹幕（livechat 样式） |
| `upload_plain` | upload | state | 是 | 建稿；只调 `driver.ensureArchive` |
| `append_danmu` | upload | state | 是 | 追 P；只调 `driver.appendParts` |
| `append_livechat` | upload | state | 是 | 追 P（顺序在 danmu 之后） |
| `clean_verify` | none | state | 否 | 上传后核验分 P 数 |
| `clean_stage_src` | none | state | 否 | 删 stage 暂存 |
| `clean_source` | none | state | 否 | 删源录像（判决后才允许） |
| `clean_stage` | none | state | 否 | 删 stage 产物 |

注意：**步骤的 run 里不允许再写 `logStep` / `syncNodeState`**——状态迁移回到执行器，
这与今天合并模式的做法一致，分段/节点模式要向它靠拢。

## §6 三张图

| 项 | 合并（merge） | 分段（segments） | 节点（node） |
|---|---|---|---|
| 入口 | select → pull → merge | select → pull → merge（切分） | select → node_upload |
| 上传粒度 | 整场一个稿件，burn 后追 P | 每组一个稿件，逐组追 P | 节点侧上传，主线程只收结果 |
| 收尾 | clean_verify → clean_source → clean_stage | clean_stage_src → clean_verify → clean_source | clean_stage_src |
| 条件边 | `append_danmu → append_livechat`（仅 danmu 轨存在） | 批次内顺序 | 无 |

图声明示例（合并模式，节选）：

```ts
export const MERGE_GRAPH: StepGraph = {
  mode: "merge",
  order: ["select", "pull", "merge", "burn_danmu", "burn_livechat",
          "upload_plain", "append_danmu", "append_livechat", "clean_verify", "clean_source", "clean_stage"],
  edges: [
    ["select", "pull"], ["pull", "merge"],
    ["merge", "burn_danmu"], ["merge", "burn_livechat"], ["merge", "upload_plain"],
    ["upload_plain", "append_danmu"], ["burn_danmu", "append_danmu"],
    ["upload_plain", "append_livechat"], ["burn_livechat", "append_livechat"],
    ["upload_plain", "clean_verify"], ["append_livechat", "clean_verify"],
    ["clean_verify", "clean_source"], ["clean_source", "clean_stage"],
  ],
  conditionalEdges: [
    { from: "append_danmu", to: "append_livechat", when: (c) => c.burnDanmu && c.willUpload },
  ],
};
```

## §7 分阶段落地

| 阶段 | 内容 | 行为变化 | 验收 |
|---|---|---|---|
| P1 | 新建 `@drec/pipeline`（rank 0.6），搬类型与执行器；合并模式改用注册表 | 无（纯搬迁） | orchestrator 用例全绿；归一化对比 nodes/edges 与旧 `buildWorkflow` 完全一致；层守护通过 |
| P2 | `select` / `pull` / `clean_*` 入图；hub-flow 改生成物 + 漂移守护 | 无 | 生成物与注册表一致；web 队列页「下一步」用例全绿；手写边表删除 |
| P3 | 分段模式接入同一执行器（先搬状态机，再合图） | 无（对拍） | `test/e2e/segments.test.ts` 全绿；分段路径不再手写 `logStep` / `syncNodeState` |
| P4 | 上传步骤改走驱动（`ensureArchive` / `appendParts` / `verify`） | 有（失败分类更保守） | 依赖 plans/049 阶段 2b 的实机验证；五条上传路径收敛 |
| P5 | 节点模式接入（app 用同一执行器），删两份副本 | 无 | 节点侧用例全绿；`splitGroupsBySession` 只剩一份 |

P1–P3 是纯搬迁；P4 改失败语义，单独评审；P5 动 worker 执行体，需要一轮部署观察。

## §8 验收

- 三张图的 `order` / `edges` 与今天实际执行序列对拍一致（P1/P3 各一次，记录在 PR 里）。
- hub-flow 生成物漂移守护：改注册表不改生成物 → 测试红；反之亦然。
- 全仓 `createArchive` / `appendArchive` 调用点：P4 之后只剩驱动与 `core/upload-call.ts` 定义。
- 全量 `pnpm test` / `pnpm typecheck` / `arch:check` / `pnpm bundle`。
- 每个阶段单独 PR，纯搬迁 PR 必须写明「对拍方式」。

## §9 风险

1. **词表是外部契约**：`HUB_STEP_NAMES` 被 web 队列页、旧库行、清理逻辑按字符串判断。改名 = 破坏旧数据可读性；
   本计划一律不改名，必要时加新名并保留旧名读取兼容。
2. **幂等语义变化会重复上传**：今天所有步骤的「已完成」都来自节点表；若某步改成 `path` 判定，
   PR 里必须列出「产物缺失时会怎样」。P1 阶段字段只声明不生效，避免顺手改行为。
3. **三张图合成时容易丢分段的分组语义**：分段模式的「一批 N 段」属于执行体内部，
   注册表只描述步骤，不描述批次——分批留在 run 里。
4. **执行器下沉可能改变初始化顺序**：今天 `deps` 是闭包注入，搬到 `@drec/pipeline` 后必须保持
   「运行期只读注入」，不能 import 任何具体实现包。

## §10 未决问题（评审时逐条回答）

1. `@drec/pipeline` 与 `@drec/upload-runtime` 的边界：驱动属于 upload-runtime，
   步骤执行器属于 pipeline，二者谁依赖谁？（当前设计：pipeline 不依赖 upload-runtime，
   驱动由调用方注入，与今天 `UploadTarget` 的注入方式一致。）
2. `select` 目前在 `reconciler.ts` 里完成，入图意味着把候选选择也搬进执行器；
   是否只把 `select` 作为「已完成的占位步骤」记录，实际选择仍留在 reconciler？
3. `clean_*` 在收尾里带「删除源录像」这种不可逆判定，入图后失败语义（`recordCleanFailure`）
   要不要保留为旁路告警而不是 fail 步骤？（当前倾向：保留旁路，图里只标 done/skipped。）
4. 分段模式最终是否也统一成「一组一图」（每组一张小图，而不是一张大图里循环）？
