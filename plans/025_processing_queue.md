# 025 — 处理队列视图(做了什么 / 正在做什么 / 下面做什么)

## 背景与问题

直播间一多,「现在总共在跑几场、每场卡在哪一步、还要多久」没有一处可见。现状:

- 台账(`sync_jobs` / `sync_job_events` / `sync_job_steps` / `sync_node_states` / `sync_candidates`)
  已经把每场的状态、子步骤 start/done、耗时、detail 都落库了(`packages/orchestrator/src/ledger.ts`)。
- 读取层 `listHubJobs`(`packages/app/src/hub-jobs.ts`)已算好 `currentStepSec` / `etaSec`。
- 前端 `HubJobs.tsx` 的 fork/join 流程图已能画 ✓/进行中/待运行。

**缺口**:

1. **没有跨房间的全局队列** —— `/hub` 是「左房间列表 + 右单房间详情」,要一间间点进去看。
2. **分不清「在跑」和「在等锁」** —— `ResourcePool` 的 cpu/net/upload 是 `max=1` 信号量,
   后收播的场 job 状态已是 `merging`,实际阻塞在 `withCpu()` 排队;UI 显示「合并中 · 已运行 8m」
   但其实一分钟都没开始,ETA 也随之失真。信号量无 introspection。
3. **没有明确的「下面做什么」** —— DAG 是确定的,`nodeStates` 里 pending 的节点就是「下面」,
   但没有 callout 明确陈述;全局资源池的排队位次也没有。

## 目标

新增一个 **处理队列页**(`/queue`),一屏回答三个问题:

- **做了什么**:每场已完成的步骤(带耗时 / 大小 detail)。
- **正在做什么**:当前步骤 + 已运行时长 + ETA;**区分「执行中」与「排队等锁(第 N 位)」**。
- **下面做什么**:本场后续步骤(按 DAG 推导)+ 全局队列位次。

## 非目标(本期不做)

- 步骤内百分比进度(ffmpeg `-progress` / rsync `progress2` / biliup 分块流式回传)—— 留待 P3。
- 不改动 pipeline / reconciler 的执行逻辑,只加「可观测」,零行为风险。

## 设计

### 1. 后端:资源池状态暴露(orchestrator)

`ResourcePool` 增加只读快照,暴露 cpu / net / upload 的占用与排队:

```ts
interface PoolSnapshot {
  cpu: { active: number; queued: number; max: number };
  net: { active: number; queued: number; max: number };
  upload: {
    queued: number;          // 等待进入上传链的提交数
    cooldownUntil: number;   // 601 冷却截止(0=无)
    windowUsed: number;      // 当前窗口内已提交次数
    windowLimit: number;     // 窗口上限
    windowResetAt: number;   // 最早一次提交滑出窗口的时刻(0=无)
  };
}
```

`Semaphore` 暴露 `active` / `queued` / `max`;`withUpload` 用一个计数器记录在途提交数
(进入链即 +1、结算 -1),配合已有的 `uploadTimes` / `uploadBlockedUntil` 得出窗口与冷却。

**「在等锁」标记**:`runWorkflowNodes` 的 `runNode` 在进入资源闸门前后写节点 detail ——
进入前 `syncNodeState(node, "running")` 但 UI 侧靠 **PoolSnapshot 的 queued>0 + 节点 steps
尚未 start** 判定「排队中」。为让单场也能精确显示,增加:节点进闸门前 `ledger.logStep(step, "queued")`?
—— 不加新 phase(会污染契约),改用「running 但无 step start 事件」= 排队中。

> 决定:保持 `sync_job_steps.phase` 只有 `start` / `done` 两值(契约稳定);
> 「排队中」由后端在聚合时用 `PoolSnapshot` + 当前 step 是否有 start 事件**推导**。

### 2. 后端:聚合端点 `GET /api/hub/queue`

复用 `listHubJobs`(不过滤 room,只取非终态)+ `listHubRules`(拿主播名 / 房间映射),
聚合成按状态分组的有序视图:

```ts
interface QueueItemDTO {
  streamKey: string;
  platform: string;
  roomSlug: string;
  anchorName: string | null;
  state: string;                 // 当前 step
  phase: "queued" | "running" | "waiting_settle" | "waiting_manual";
  queuePosition: number | null;  // 同资源等待队列中的位次
  resource: "cpu" | "net" | "upload" | null;
  doneSteps: HubJobStepDTO[];    // 已完成(做了什么)
  currentStep: HubJobStepDTO | null;
  nextSteps: string[];           // 按 DAG 推导(下面做什么)
  currentStepSec: number | null;
  etaSec: number | null;
  winnerWorker: string | null;
}
interface HubQueueDTO {
  active: QueueItemDTO[];        // 进行中(含排队)
  recent: HubJobDTO[];           // 最近完成(终态,复用 listHubJobs)
  pool: PoolSnapshot;            // 资源池全局占用(CPU 谁在占、上传窗口配额)
}
```

`nextSteps` 由 core 的 DAG 推导(与 `flow-build.ts` 同一份拓扑:`merge → {burn_danmu,
burn_livechat, upload_plain}` → append 链)。放 orchestrator 里用 `buildWorkflow` 的
`edges` 推导,或在前端按同样的常量推导(更简单,避免后端依赖)。

> 决定:`nextSteps` 在**后端**推导(单一真理 = workflow 的 edges),后端暴露
> `deriveNextSteps(state, cfg)`;前端只渲染。

### 3. 前端:队列页

新增路由 `/queue` + 导航项(仅 master)。三栏:

- **进行中**:每行一场,`① ② ③` 显式标已完成 / 当前 / 下一步;`⏳ 排队中(第 N 位)` 区分等锁。
- **待处理**:`settling`(等待收播)/ `needs_manual`(待人工)。
- **最近完成**:终态(复用 RunCard 精简版)。

顶部一条资源条:`CPU 占用 1/1 · 上传窗口 3/5 · 冷却中(剩 12m)`。

### 4. 收敛轮询(顺带修审计 §5.4)

HubPage / RoomDetail / WorkersPanel 各自 3s 轮询同批端点。队列页新增前,把
`listHubJobs` / `listHubRules` / `listWorkers` 提升到 jotai atom + 单一轮询,各页订阅。
本期内做最小版:队列页自己 3s 轮询,不强行重构既有页面(避免大改)。

## 任务拆分

1. **orchestrator**:`Semaphore` / `ResourcePool` 暴露 `snapshot()`;导出 `PoolSnapshot` 类型。
2. **app**:`hub-jobs.ts` 加 `buildQueueView`(聚合 + 排队位次推导);`api.ts` 加 `hubQueue()`;
   `server.ts` 加路由 `GET /api/hub/queue`。
3. **cli**:`hubStarter` 暴露 `poolSnapshot`(读同一 ResourcePool 实例),注入 web deps。
4. **web**:`api/client.ts` 加 `getHubQueue`;新增 `pages/QueuePage.tsx`;`App.tsx` 路由;
   `TopNav.tsx` 导航;`i18n.tsx` 文案(zh/en)。
5. **test**:`hub-jobs.test.ts` 加 queue 聚合用例;`workflow.test.ts` 加 pool snapshot 用例。
6. **docs**:AGENTS.md 补队列页说明。

## 验收

- 多场同时收播时,队列页能区分「执行中」与「排队等锁(第 N 位)」。
- 每场显示:已完成步骤、当前步骤(+已运行/ETA)、后续步骤。
- 资源条显示 CPU/上传窗口占用与冷却。
- 无 hub / 无台账 → 空态不炸;旧库(缺表)回落不崩。

## 审核后的修复(2026-10-07,子 agent 审核 + 实测复现)

审核发现 3 个 P1,均已修并补回归测试(799 tests):

1. **`waiting` 以 streamKey 单键存储 → 同场多节点互相覆盖**(核心缺陷,恰是本功能要修的失真)。
   同一场常同时有多个节点等不同闸门(burn_* 在 cpu 队列 + upload_plain 在上传链,
   `runWorkflowNodes` 同 tick 派发)。`set(streamKey)` 顶掉前一条,任一 `clear()` 又误删同伴
   → 实测 `cpu.queued=1` 但 `waiting=[]`,排队位次丢失,UI 显示「执行中」而实际在等锁。
   **修**:键改 `resource:streamKey`,值为数组 + `Symbol` token,`clear()` 只删自己那条。
2. **`listHubJobs(limit:500)` + 客户端过滤 → active 场从队列页消失**。
   `ORDER BY updatedAt DESC` 会把「正在处理但 updatedAt 旧」的场挤出结果
   (实测 1 active + 520 done → `active=[]`)。**修**:给 `listHubJobs` 加 `states`/`excludeStates`
   过滤(占位符参数,无注入面),`buildQueueView` 改三条精确查询(非终态 / needs_manual / 终态最近 N)。
3. **`_FLOW_NODE_CHECK` 类型断言恒真**(注释宣称能挡「新增步骤漏登记」,实测加 `brand_new_step` 仍编译通过)。
   `HubFlowNode extends Extract<HubStepName, HubFlowNode>` 右边⊆左边,恒真。**修**:改成
   `Exclude<HubFlowNode, HubStepName> extends never`(单向依赖,只挡拼写错误),注释对齐真实能力。

同时修的 P2:

- `resumeAppends`(`pipeline.ts`)**绕过全局上传队列**直调 `appendGroup` → 无提交限速、无 601 冷却
  (既存缺陷,非本次引入)。改走 `pool.withUpload(…, streamKey)`。
- `nextSteps` 对未开跑的场列全 6 个节点(settling 场会一直挂着「下一步:传 plain / 追 P2 / 追 P3」,
  读起来像马上要跑)。改:未在跑用 `readyNodes`(只列立即可跑),在跑才列其余节点。
- `needs_manual` cap(stage 模式正常收口也是它,长期 master 会堆积淹没进行中区)→ `manualLimit` 缺省 20。
- 排序注释与实现相反 + `queuePosition ?? 0` 把 null 排到最前 → 注释对齐 + null 兜底到末尾。
- `syncing`(pull)不占资源闸门却显示「执行中」→ 独立 `pulling` 相位。
- 清理死代码:`readyNodes`/`nextNodesOf` 曾零调用(现 `readyNodes` 已用)、`isResourceState`
  删除、`hub-jobs.ts` 的 re-export 删除。
- `HUB_FLOW_EDGES` 里 `append_danmu→append_livechat` 在 `buildWorkflow` 中是**条件边**
  (仅 upload+burnDanmu),注释已标注差异来源。

## 追加:真实 FIFO 排序 + datatable 筛选(2026-10-07)

用户反馈:队列要按**实际队列时间**排序,并像 datatable 一样能 filter。

### 排序
原按 `phase` 分组(running → queued → waiting_settle → waiting_manual),组内 `updatedAt` 倒序。
问题:这不是真实队列顺序 —— 用户要的是「谁先进队列谁排前」。

改为 **FIFO**:`QueueItemDTO` 新增 `enqueuedAt`(= 该场首个事件 `pending` 的时刻,取 `startedAt`),
`buildQueueView` 按 `enqueuedAt` **升序**;缺失(极老 run 无事件表)回落 `updatedAt`;完全同刻用
`streamKey` 字典序兜底,保证多次轮询顺序稳定不跳动。

> 实测证明:构造 `updatedAt` 与入队序**完全相反**的数据(3400000→3100000),
> 返回仍按 `enqueuedAt` 升序 —— 旧的 updatedAt 排序会得到相反结果,回归测试已锁死。

### 筛选(datatable)
- `GET /api/hub/queue?phase=&states=&platform=&q=`(均可重复或逗号分隔)。
- **服务端筛选**:phase/states/platform/q 在 `buildQueueView` 里过滤,前端拿到即所见
  (不必全量回前端再筛)。phase/states 走**契约白名单**(`QUEUE_PHASES` / `HUB_JOB_STATES`),
  非法值被丢弃 → 不过滤,防前端拼错静默返回空。
- 「拉取中」是**前端派生相**(`state=syncing` 且不占资源闸门),不在 `QUEUE_PHASES` 里,
  故筛选它用 `states=syncing`。
- 前端:筛选栏(相位 chip / 平台 chip / 搜索框 250ms 防抖 / 清除)+ `<table class="tasks">` 五列
  (`#` 行序=入队序,排队行带橙色 `等N` chip=资源队列位次 / 直播间·场次 / 状态 / 做了什么→正在做→下面做 /
  入队时间)。复用 TaskList 的 `.table-shell` + `table.tasks` 样式,视觉与既有表格一致。

### 测试(802)
FIFO 排序、三类筛选各自生效与叠加、`q` 命中主播名(大小写不敏感)。全部反向验证过
(改回旧排序 → 测试 fail)。
