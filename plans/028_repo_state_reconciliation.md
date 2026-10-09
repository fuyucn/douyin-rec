# 028 — 仓库状态对齐(git 与「已部署/已声明完成」对齐)

> 状态:**待审阅(计划,未执行)**。台账条目 `T-23`。
> 本计划的目的不是加功能,而是**消除一个正在累积的高危不一致**。

## 问题(实测证据,2026-10-08)

### P0:HEAD 单独 checkout 无法通过 typecheck

```
$ git worktree add --detach /tmp/realchk HEAD && pnpm install && npx tsc --noEmit
7 个真实类型错误(2026-10-08 用**真实 pnpm install** 实测;早先 27/25 的数字含 symlink 假阳性)
```

**验证方法说明**:必须用 `pnpm install` 的真实 worktree。若只 symlink `node_modules`,
`@drec/*` 解析失败会把下游类型塌成 `any`,凭空多出 ~17 个 TS7006 假错误。

典型:
- `app/src/web/api/context.ts(65)`: `Property 'capabilities' does not exist on type 'WorkerConfig'`
- `app/src/hub-rules.ts(46)`: `'requires' does not exist in type {...}`
- `app/serve.ts(88)`: `'douyinApiMode' does not exist in type 'NodeRecordSpawnerOpts'`
- `app/serve.ts(15)`: `Module './paths.js' has no exported member 'ensureNodeIdentity'`

### P0 根因:定义侧的改动从未提交

| 字段/函数 | 在 HEAD? | 在 worktree? | 被谁引用(已提交) |
|---|---|---|---|
| `HubRule.requires` | ❌ 无 | ✅ 有 | `web/api/*.ts`(已提交) |
| `WorkerConfig.capabilities` | ❌ 无 | ✅ 有 | `web/api/*.ts`(已提交) |
| `NodeRecordSpawnerOpts.douyinApiMode` | ❌ 无 | ✅ 有 | `cli-task.ts`/`serve.ts`(已提交) |
| `paths.ensureNodeIdentity` | ❌ 无 | ✅ 有 | `serve.ts`(已提交) |

即:**消费方已提交,生产方未提交** → HEAD 必然断裂。这是 `d71435c`(Hub 双层标题)
把 `api.ts` 的 WIP 片段一并提交时留下的。

### P0:生产跑的是「未提交」的构建

```
生产 GET /api/version → 0.0.32-661663   (bundle 内含 satisfiesCapabilities/requires)
本地 dist            → 0.0.37-82af3b   (含全部 WIP)
```

**结论:线上正在运行 HEAD 里不存在的代码。** 若有人 `git clone` + `pnpm bundle` 重建,
会得到**功能更少**的产物(丢失 T-1/T-13/T-15)。

### P1:台账与代码不符

`TODO.md` 把 **T-1 能力门控 / T-13 抖音 API 模式 / T-15 节点身份** 标为 `[x]` 已完成(2026-10-07),
但三者的**定义侧代码全部未提交**:

```
git show HEAD:packages/app/src/hub-store.ts | grep -c requires          → 0
git show HEAD:packages/app/src/process/spawner.ts | grep -c douyinApiMode → 0
git show HEAD:packages/app/src/paths.ts | grep -c ensureNodeIdentity     → 0
```

### P1:61 个未提交文件,按主题可分 5 组

| 主题 | 文件数 | 状态 |
|---|---|---|
| T-1 能力门控 | 9 | 代码完成、测试通过、**未提交** |
| T-15 节点身份 | 9 | 同上 |
| T-5 弹幕熔断/取流回落 | 6 | 同上 |
| T-13 抖音 API 模式 | 4 | 同上 |
| 其它(audit 文档/脚本/UI 整改/plans) | 33 | 混杂 |

### 风险

1. **任何人 clone 都拿到坏的 HEAD**(CI/新同事/未来自己)。
2. **一次误 `git clean -fd` 会永久删除 12 个未跟踪文件**(含 `capabilities.ts` 等**实现**)。
3. 生产与仓库不一致 → 无法从 git 重建线上。
4. `TODO.md` 的 `[x]` 是**假的完成**(代码不在版本控制里)。

## 目标(end state)

1. `git clone` 后 `pnpm install && pnpm typecheck && pnpm test && pnpm bundle` **全绿**。
2. 生产运行的代码 = 仓库 HEAD(可复现)。
3. `TODO.md` 的每个 `[x]` 都有对应 commit 可追溯。
4. 工作区干净(或仅剩明确标注的、有主的 WIP)。

## 非目标

- 不新增任何功能、不改行为。
- 不做 T-21 第 5 步(拆 `web/` 包)——那是独立议题,与本计划无关。
- 不重构 WIP 的既有设计(它已测试通过,只做「提交」这件事)。
- 不部署(除非用户明确要求;且受部署 guard 约束)。

## 组件

| id | 名称 | 说明 |
|---|---|---|
| C1 | 主题归类 | 把 61 个 WIP 文件按 T-1/T-13/T-15/T-5/其它 精确分组,处理「一文件多主题」 |
| C2 | 提交序列 | 每组一个语义化 commit,顺序保证**每个 commit 后 HEAD 都能 typecheck** |
| C3 | 验证门 | 每个 commit 后跑 typecheck+test;全部完成后在干净 worktree 上验证 |
| C4 | 台账对齐 | 修正 TODO 的 `[x]` 指向真实 commit;记录本次事故与防复发规则 |
| C5 | 防复发 | 加一个「HEAD 必须 typecheck」的守护(CI 或 test) |

## 任务(PR-sized,拓扑序)

### T-A 主题归类与「一文件多主题」裁决
- **做什么**:逐文件读 diff,产出 `主题 → 文件 → 具体 hunk` 的映射。难点是**一个文件含多主题**
  (如 `cli.ts` 同时含 T-15 `_node-id`、T-13 `--hub` 相关、T-1 `satisfiesCapabilities`)。
- **裁决原则**:优先「能让每个 commit 独立 typecheck」的切法;若一个文件的多主题无法干净拆分
  (hunk 交错),则**合并为一个 commit**(宁少勿裂)。
- **产出**:`plans/028_file_map.md`(归类结果,供审阅)。
- **依赖**:无。**估**:~0 LOC(纯分析)。

### T-B' 提交「定义侧」全部(requires/capabilities/ensureNodeIdentity/douyinApiMode + 新模块)
- **文件**:`paths.ts`(ensureNodeIdentity)、`worker-store.ts`/`.test.ts`(capabilities 无关部分)、
  `worker-contract.ts`、`transport*.ts`、`cli.ts` 的 `_node-id`、`WorkerDialog.tsx`、`test/app/node-identity.test.ts`。
- **验收**:commit 后 `npx tsc --noEmit` 通过 + `pnpm test` 全绿。
- **依赖**:T-A。**估**:~250 LOC(多为已写好的搬运)。

### T-C' 提交「消费侧」全部(引用上述定义的所有文件)
- **文件**:`hub-store.ts`/`.test.ts`(`requires`)、`worker-store.ts`(capabilities)、`core/worker-contract.ts`、
  `orchestrator/capabilities.ts`/`.test.ts`、`reconciler.ts`/`.test.ts`、`web/api/*.ts`、`HubRuleDialog.tsx`、
  `WorkersPanel.tsx`、`i18n.tsx`、`cli.ts` 的 `satisfiesCapabilities`。
- **注意**:与 T-B 在 `worker-store.ts`/`cli.ts` 有重叠 → 必须按 T-A 的裁决拆分或合并。
- **验收**:同上。**依赖**:T-B(或与之合并)。**估**:~300 LOC。

### T-D 提交其余(UI 整改 / 脚本 / 文档 / Dockerfile / .gitignore)
- **文件**:`douyin-live/src/api-mode.ts`(新)、`stream/*.js`、`probe.ts`、`spawner.ts`、`SettingsDialog.tsx`、
  `web/api/settings.ts`、`test/app/web-api.test.ts`。
- **验收**:同上。**依赖**:T-C。**估**:~200 LOC。

### T-E (已并入 T-B'/T-C',留空占位)
- **文件**:`douyin-live/src/index.ts`、`danmaku/client.ts`、`listener-base.ts`/`.test.ts`、
  `orchestrator/scan.ts`/`.test.ts`、`select.ts`/`.test.ts`、`ledger.ts`。
- **验收**:同上。**依赖**:T-D。**估**:~300 LOC。

### T-F (已并入 T-D,留空占位)
- **文件**:`web/src/**`(TopNav/TaskList/App/index.css…)、`scripts/*.sh|mjs`、`docs/audit-*`、`plans/026`、
  `hub-jobs.ts`、`web/server.ts`、`Dockerfile`、`.gitignore`、`CLAUDE.md`。
- **注意**:`.gitignore` 去掉 `/AGENTS.md` 忽略是 T-11 的遗留 → 单独说明。
- **验收**:同上。**依赖**:T-E。**估**:~200 LOC。

### T-G 干净 worktree 全量验证
- **做什么**:`git worktree add --detach /tmp/verify HEAD` → `pnpm install`(或复用)→ `typecheck`+`test`+`bundle`。
- **验收**:三步全绿,**无一个 WIP 残留**。**依赖**:T-B..T-F。**估**:0 LOC。

### T-H 台账对齐 + 防复发
- **做什么**:① TODO 的 T-1/T-13/T-15 `[x]` 补上 commit hash;② 记录本次事故(「消费方先提交、
  生产方后提交」)与规则;③ 加守护:`test/arch/head-typecheck.test.ts`? 不可行(测试本身在 worktree 跑)。
  **改为**:在 `AGENTS.md` 加一条硬规则 —— 「**每个 commit 必须 HEAD 可 typecheck**」+ 提交前自查清单。
- **验收**:TODO 的完成项可追溯到 commit;AGENTS.md 有规则。**依赖**:T-G。**估**:~20 LOC(文档)。

## 顺序(经实测修正)

**关键约束**:HEAD 里**已提交**的 `web/api/*.ts`(我 T-22 拆出的)就引用了
`HubRule.requires` / `WorkerConfig.capabilities` / `douyinApiMode` / `ensureNodeIdentity` ——
这些定义全在 WIP 里。**所以"先提交 T-15 再 T-1"是错的**:只要 `requires` 或 `capabilities`
任一未提交,HEAD 就断。

**结论:定义侧必须先行,且 T-1 与 T-15 无法各自独立成 commit**(它们在 `worker-store.ts`/
`cli.ts` 上交错)。

**已实测验证(2026-10-08)**:
- HEAD + 定义侧 8 个文件 → `npx tsc --noEmit` = **0 错误** ✅
- 再叠加消费侧 4 个域文件 → 仍 **0 错误** ✅

即该切法**经实测保证每个 commit 都绿**,不是推测。

修正后的顺序:

```
T-A 归类(只产出分析,不改代码)
 → T-B' 提交「定义侧全部」:hub-store.requires + worker-store.capabilities +
        worker-contract + paths.ensureNodeIdentity + spawner.douyinApiMode
        + orchestrator/capabilities.ts + douyin-live/api-mode.ts(新增文件)
 → T-C' 提交「消费侧全部」:web/api/*、reconciler、cli、UI、测试
 → T-D 提交其余(UI 整改/脚本/文档)
 → T-G 干净 worktree 全量验证
 → T-H 台账对齐 + AGENTS.md 防复发规则
```

即:**从「按主题切」改为「按「定义侧 / 消费侧」切」** —— 因为 typecheck 断裂只关心
「引用的东西存不存在」,不关心主题。这是本计划唯一能保证「每个 commit 都绿」的切法。

若 T-B' 或 T-C' 过大(>400 LOC),允许按**文件**再拆,但**不得跨「定义/消费」边界拆**。

## 验收标准(整体)

- [ ] `git clone <repo> && pnpm i && pnpm typecheck && pnpm test && pnpm bundle` 全绿
- [ ] `git status` 干净(无 WIP 残留)
- [ ] 生产 `/api/version` 的 commit 前缀 ∈ 仓库历史
- [ ] TODO 每个 `[x]` 可追溯
- [ ] 61 → 0 未提交文件

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| 拆错主题 → 中间 commit 断裂 | T-A 先出 `file_map.md` 供审阅;**拿不准就合并 commit** |
| 误删未跟踪文件(12 个) | **全程禁止 `git clean -fd`**;先 `git add` 保住 |
| WIP 里混有未完成的实验代码 | 逐个 diff 复核;不确定的标为「保留待定」而非提交 |
| 提交后才发现行为变更 | 每个 commit 后 `pnpm test`;T-G 在干净 worktree 复验 |

## 未决问题(需人工裁决)

1. **61 个 WIP 里,是否有「故意不提交」的?**(如本地调试脚本 `scripts/auto-deploy.sh`、
   `verify-douyin-balance.mjs`、`analyze-split-recording.sh`)—— 若有,应加进 `.gitignore` 而非提交。
2. **`plans/026_worker_load_placement.md`(未跟踪)** 是 T-2 的未来计划,应提交还是保留本地?
3. **T-17 A/B 对比**仍在进行(依赖 VPS 数据),其脚本是否现在提交?
