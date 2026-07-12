# 动态 Hub 流程图（dynamic flow）设计

**日期**: 2026-07-11
**分支**: feat/multi-node-sync
**状态**: 已批准，待写实现计划

## 目标

把 Hub 运行记录里的 `PipelineFlow` 从「固定布局 + 关掉的步骤灰显 skipped」改成**动态图**：

1. **按功能开关只画相关节点**——没配的步骤根本不出现（不再画一个灰 skipped 占位）。
2. **节点携带真实有效信息**——文件数/大小/段数/BV/删除计数等，而非只有耗时。

## 当前状态（改动前）

- `packages/web/src/components/HubJobs.tsx`：`STEP_DEFS`（固定 11 节点 + 终点）+ `FLOW_EDGES`（固定连线）。
  `stepStatuses(job)` 按 `job.steps`（start/done 事件配对）给每个固定节点定状态；关掉的步骤（done 态无事件）显示 `skipped`。
- `ledger.logStep(streamKey, step, phase)`：写 `sync_job_steps(streamKey, step, phase, at)`，**无 detail**。
- `HubJobDTO.steps: {step, phase, at}[]`；`candidates`（含 winner/coverage/durationSec/complete）；`winnerWorker`；`bv`；`videoDurationSec`。
- 节点面板：图标 + 名称 + 耗时；hover：状态 + 耗时。candidate 节点：worker + 覆盖 + 时长。

## 关键决定（brainstorming 已定）

1. **节点可见性来源 = 混合**：
   - **进行中 / 未开始的 run** → 按**当前 hub 规则配置**（`rule.pipeline`）画「计划图」（提前看到会跑哪些步）。
   - **已完成（终态 done/failed/needs_manual）的 run** → 按**实际 `job.steps`**（真跑过哪些步）画。
2. **信息丰度 = 真实计数/大小**：给 ledger 的 step 事件加 `detail` 字段，pipeline 每步 done 时写真实数据。
3. **信息位置 = 节点面板一个关键数据 + hover 看完整 detail 行**。
4. **图构造策略 = 模板 + 剪枝/重排（Approach A）**：声明式模板，按谓词剪枝到「存在集」，重排 x，按 lane 重连边。无新依赖。

## 架构（5 部分）

### Part 1 — 后端：per-step `detail` 元数据

**ledger（`packages/orchestrator/src/ledger.ts`）**
- `StepEvent` 增 `detail?: string`。
- `logStep(streamKey, step, phase, detail?)` 增可选第 4 参；INSERT 时写入。
- `sync_job_steps` 表加列 `detail TEXT`；迁移用幂等 `try { ALTER TABLE sync_job_steps ADD COLUMN detail TEXT } catch {}`（与既有 fails/rename 迁移同风格）。
- 读取 step 的地方（`getSteps`/查询）带出 detail。

**pipeline（`packages/orchestrator/src/pipeline.ts`）** 每步 **done** 事件计算并传 detail（start 事件不带）。detail 是**短中文串**（前端直接展示，不再翻译；与既有 job.log 中文一致）：

| step | detail 串（示例） | 计算来源 |
|---|---|---|
| `pull` | `2 文件 · 1.9GB ← vps` | `filesToPull.length` + `statSync` 累加 stageSub 里拉来的文件字节 + `winner.workerId` |
| `merge` | `4 段 → 90MB · 1h38m` | `winner.rec.tsFiles.length` + `statSync(plain)` + `videoDurationSec`（= winner.rec.durationSec） |
| `burn_danmu` | `→ 24MB` | `statSync(danmuMp4)` |
| `burn_livechat` | `→ 31MB` | `statSync(livechatMp4)` |
| `upload_plain` | `90MB` | `statSync(plain)`（BV 已在卡片元信息显示，不重复） |
| `append_danmu` | `2 段 · 12GB` | `danmuParts.length` + 累加 `statSync` |
| `append_livechat` | `1 段 · 8GB` | `livechatParts.length` + 累加 `statSync` |
| `clean_stage_src` | `删 4 文件` | 待删 stage 文件数 |
| `clean_source` | `删 2 节点 · 4 文件` | `candidates.members.length` + 各 `sourcePathsOf` 总数（远端大小拿不到，不显示 size） |
| `clean_stage` | `删 6 文件` | products 数组长度 |

- `select` **不加后端 detail** —— 其信息（winner/候选数/覆盖率）已在 `job.candidates` + `winnerWorker`，前端派生。
- 计算 detail 的 `statSync` 失败要吞掉（拿不到大小就省略该部分，绝不反噬管线）；用一个小工具 `humanBytes(n)`（B/KB/MB/GB）。
- detail 只影响展示，计算放在**已经 stat/已知**的地方，不额外多跑重活。

### Part 2 — 契约 + 读取

- `packages/core/src/api-types.ts`：`HubJobStepDTO` 增 `detail?: string`。
- `packages/app/src/hub-jobs.ts`：查询 `sync_job_steps` 时 `SELECT ... , detail`；`HubJobStep` 接口 + 映射带上 `detail`（旧库无列 → `try/catch` 回落不选 detail，值为 undefined）。
- **计划图不需要后端改动**：`RoomDetail` 已持有 `rule: HubRuleDTO`（含 `rule.pipeline.{steps,upload,cleanup}`）。`RoomDetail` 把 `rule.pipeline` 传给 `RunCard` → `PipelineFlow`。

### Part 3 — 前端：动态图构造器

新函数 `buildFlow(job, ruleCfg, opts)` 取代固定 `STEP_DEFS`/`FLOW_EDGES`，返回 `{ nodes: FlowStepDef[], edges: [string,string][], termX: number }`。

**模板**（声明式，每节点标 lane + 谓词 + 顺序）：

```
spine:   select → pull → merge → [FORK] → [JOIN] → append_danmu → append_livechat → clean_source → clean_stage → __term__
burn 轨:  merge ⇒ burn_danmu → burn_livechat → clean_stage_src ⇒ (join at append_danmu)
upload 轨: merge ⇒ upload_plain ⇒ (join at append_danmu)
```

**存在集判定**（`present(nodeKey)`）：
- base 恒有：`select`、`pull`、`merge`、`__term__`。
- 终态 run：`present = job.steps` 里该 step 有任意事件。
- 进行中 run：`present` 按 `ruleCfg` 谓词：
  - `burn_danmu` ⟸ `steps.burnDanmu !== false`
  - `burn_livechat` ⟸ `steps.burnLivechat !== false`
  - `upload_plain` / `append_danmu` / `append_livechat` ⟸ `upload.mode === "upload"`（且对应 burn 开：append_danmu 需 burnDanmu、append_livechat 需 burnLivechat）
  - `clean_stage_src` ⟸ `cleanup.stageSourceAfterMerge`
  - `clean_source` ⟸ `cleanup.sourceAfterDone`
  - `clean_stage` ⟸ `cleanup.stageAfterDone`
  - 兜底：任何**已有事件**的 step 也强制 present（防规则改动后进行中 run 与实际不符）。

**重排 + 重连**：
- 有没有「并行段」取决于是否**同时存在** burn 轨（burn_danmu/burn_livechat 任一）**和** upload 轨（upload_plain）。
  - 都在 → fork/join：merge 分叉到 burn 轨（上 y=10）和 upload 轨（下 y=130），两轨在第一个 append（若无 append 则在 `clean_source`/`__term__`）join。
  - 只有 burn 轨（stage 模式，无 upload/append）→ **线性**：merge → burn... → clean... → term，全在 y=70。
  - 只有 upload 轨（两个 burn 都关，罕见）→ 线性：merge → upload_plain → term。
- x 位置：按每条 lane 的存在节点从左到右等距（列宽常量 ~170）；spine 与并行段列对齐。`termX` = 最右列 + 一列。
- 边：沿每条 lane 连相邻存在节点；fork 边 merge→(每轨首节点)；join 边 (每轨末节点)→首个 join 目标。
- 输出喂给现有 `<ReactFlow>`（节点类型 `step` 复用；candidate fan-in 逻辑不变，仍挂在 select 左侧）。

**纯函数、可单测**：`buildFlow`（+ `pickMetric`）不 import React / 平台代码（无 sm-crypto 等坑），只吃普通对象，放 `packages/web/src/components/flow-build.ts`。单测就近 `packages/web/src/components/flow-build.test.ts`，用根 vitest 跑；因是纯 TS 无 web 专属依赖，vitest 可直接 import。若根 `vitest.config` 的 include 未覆盖 `packages/web/**`，在实现任务里把该 glob 加进 include（仅纳入这一个纯函数文件）。

### Part 4 — 前端：节点信息

- `StepNode` 的 `data` 增 `metric?: string`（面板显示的关键数据）+ `detail?: string`（hover 完整行）。
- **detail 是完整串**（后端产出，如 `2 文件 · 1.9GB ← vps`），原样进 hover。
- **面板 metric 由前端按 step 类型从 detail 里挑一段**（`pickMetric(step, detail)` 纯函数）：
  - `pull`/`merge`/`burn_danmu`/`burn_livechat`/`upload_plain`/`append_danmu`/`append_livechat` → 取大小段（正则 `/\d[\d.]*\s?[KMGT]?B/` 命中的第一处，如 `1.9GB`/`90MB`）。
  - `clean_stage_src`/`clean_source`/`clean_stage` → 取计数（正则 `/删.*文件/` 或 `删 N …`）。
  - `select` → winner 名（从 candidates 派生，不走 detail）。
  - 挑不出（detail 空 / 无匹配）→ 回落耗时 `humanSec(sec)`（= 旧行为）。
  - `pickMetric` 与 `buildFlow` 同文件、同样单测。
- **hover**：现有 tooltip 追加 detail 行（在「状态 · 耗时」下面再一行完整 detail）。detail 为空 → 只显示状态 · 耗时（旧行为，向后兼容）。
- `select` 节点：面板 = winner 名（或候选数）；hover = `winner=vps · 2 候选 · 覆盖 100%`（从 candidates 派生）。

### Part 5 — 测试 + 上线

- **buildFlow 单测**（重点）：给定不同 (ruleCfg / job.steps / 终态) 组合，断言存在集 + 边：
  - stage 模式 + 只 danmu → 线性 select…merge→burn_danmu→clean_source→term，无 upload/append/livechat 节点。
  - upload 模式 + danmu+livechat + 全清理 → fork/join 全节点。
  - 进行中(计划图) vs 终态(按 steps) 两路径。
  - 旧 run（steps 无 detail）→ 节点无 metric，回落耗时。
- **ledger 迁移测**：`sync_job_steps` 加 detail 列幂等；`logStep` 带 detail 写入 + 读回。
- **pipeline detail**：现有 pipeline 测（如有）补断言某步 done 事件带 detail 串（可注入假 stat）。
- **上线**：`pnpm bundle` + docker rebuild（master 跑管线）。VPS 是纯录制 slave，不涉及本改动，不部署。
- **向后兼容**：老 run 的 steps 无 detail → 前端回落；动态图对老 run 用 `job.steps` 存在集（老 run 都跑过固定那几步 → 图与原来基本一致，只是关掉的步骤现在**消失**而非灰显）。

## 影响文件

- `packages/orchestrator/src/ledger.ts` — StepEvent.detail、logStep 第4参、schema 加列 + 迁移、读取带 detail
- `packages/orchestrator/src/pipeline.ts` — 每步 done 传 detail + `humanBytes` 工具
- `packages/core/src/api-types.ts` — HubJobStepDTO.detail
- `packages/app/src/hub-jobs.ts` — 查询/映射带 detail
- `packages/web/src/components/flow-build.ts`（新）— `buildFlow` 纯函数 + 单测
- `packages/web/src/components/HubJobs.tsx` — 用 buildFlow 取代固定 defs；StepNode 加 metric/detail；hover 加 detail 行
- `packages/web/src/components/RoomDetail.tsx` — 把 `rule.pipeline` 传进 RunCard/PipelineFlow

## 不做（out of scope）

- 不改上传/清理的实际行为，只改「怎么在图里体现 + 带信息」。
- 不引入图自动布局库（dagre 等）。
- 不做节点点击下钻（hover 足够）。
- 远端删除文件的字节大小不统计（拿不到；只计数）。
