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

改为按**入队时刻**排:`QueueItemDTO` 新增 `enqueuedAt`(= 该场首个事件 `pending` 的时刻,取 `startedAt`),
不再按 phase 分组(用户要的是队列顺序,不是状态分类)。

**方向可切换**(datatable 惯例,点表头「入队时间」切):
- `newest`(**缺省**):入队时间**倒序** —— 最新进队列的排最前,像日志一样看最新动态。
- `oldest`:**升序** —— 真正的 FIFO 视角,谁等最久谁排最前。

> 修正记录:最初实现为「只按 FIFO 升序」,用户指出应为「最新在前」→ 改为 newest 缺省 + 可切换。
> 两种方向都**确定性**(同刻用 `streamKey` 兜底),否则前端每次轮询顺序会跳动。
> 缺失(极老 run 无事件表)回落 `updatedAt`,不排到最前/最后造成误读。

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

## 追加 2:已完成与进行中同表(日志式,2026-10-07)

用户:「finish 的应该在同一个 table 就和日志一样」。

原实现:进行中一张表 + 「最近完成」另一张表(区块式)。改为**一张表连续排列**。

### 后端
- `QueuePhase` 扩 `done` / `failed`(加入 `QUEUE_PHASES` 白名单,前端可筛)。
- `QueueItemDTO` 补三个字段供终态行渲染:`bv`(B 站号)、`videoDurationSec`、`finishedAt`(收尾时刻)。
- `buildQueueView` 抽出 `toRow(job)` —— active 与 finished **共用同一构造**,避免两份字段漂移;
  终态行的 `nextSteps` 强制 `[]`(已完成的事没有「下面要做」)。
- **新增 `rows` 字段** = active + finished 合并的单一时间轴(按 sort 方向排好)。
  `active` / `recent` 保留为兼容字段(RoomDetail 等旧调用方仍用)。
- **排序键分两段**(关键):finished 行用 `finishedAt`(收尾时刻),进行中用 `enqueuedAt`。
  否则「今天早上录、刚上传完」的稿会因入队早沉到列表底 —— 用户关心的是「刚刚发生了什么」。
  > 实测:`NEWLY_UPLOADED` 入队 2h 前但 8s 前才 done → newest 下排第 1 行。

### 前端
- 单表五列不变;`QueueRow` 按 `finished` 分支渲染:
  终态行:✓/✗ 图标 + 已完成步骤串 + BV 可点链接,**不显示「正在做/下面做」**
  (否则会出现「Not started → Preparing」这种对已完成行的误导文案);
  时间列显示 `finishedAt`(日志视角:刚刚发生的时间)而非入队时间。
- 筛选栏加 `Done` / `Failed` 两个 chip;表上方加「进行中 N · 已完成 M」摘要。
- 删掉独立的「最近完成」区块(及其 4 列表格)。

### 测试(806)
`rows` 含完成行且字段正确(bv/finishedAt/nextSteps 空/currentStepSec null)、
完成行按 finishedAt 排最前、`phase=done`/`failed` 各自筛选与叠加。

## 追加 3:审核反馈整改(2026-10-07)

用户要求对整体流程/UI 认真审核并给反馈。审核用**生产数据实测**(docker master 的真实台账),
发现的核心问题是「状态语义」与「可操作性」,按优先级整改:

### P0 · 会误导判断
1. **正常收口被渲染成告警**:10 条 `needs_manual` 全显示红色 ⚠,但台账里 8 条 `error=''`
   (stage 模式正常收口,`pipeline.ts` 只 setState 不置 error + 发 `stageReady`),
   只有 2 条是真故障(`用户停止` / `进程重启中断`)。同色 → 告警疲劳,真问题被淹。
   **修**:`QueuePhase` 细分 `waiting_upload`(正常收口,中性色)/ `stopped`(灰)/ `waiting_manual`(红)。
2. **`error` 没透出**:`HubJobView` 有 `error` 但 `QueueItemDTO` 没有 → UI 只显示「待人工」不知为何。
   **修**:`QueueItemDTO.error` 透出,行内显示原因。

### P1 · 影响使用
3. **筛选延迟 3s**:`usePolling` 只按 `[ms, enabled]` 重建,换闭包不立即重跑 → 点筛选干等一个 tick。
   **修**:QueuePage 用 `queryKey` + 独立 `useEffect` 变更即拉(首次跳过避免 mount 双请求)。
   > 注意:不能改 `usePolling` 依赖 `fn` —— 其它 6 处调用方传内联箭头(每帧新引用)→ 会无限重拉。
4. **同锚点多场分不清**:4 条「爱馬人士」只有 11px 小字日期不同。
   **修**:场次时间提到主行(`sessionTime()` 解析 `_HHMM`)。
5. **`fails` 丢了**:重试 5 次的场看不出来(旧版 RunCard 有)。
   **修**:行内显示「已重试 N 次」。
6. **没有出口**:队列页只读死胡同。
   **修**:每行加操作列 —— 查看日志(复用 `JobLogDialog`)+ 跳 Hub 房间页。

### P2 · 打磨
7. **移动端溢出**:390px 实测表格横向溢出、行高爆炸。
   **修**:`<sm` 改卡片式布局(`QueueCard`),表格 `hidden sm:block`。
8. **摘要不准**:「进行中 10」但 0 条在跑(全是待人工)。
   **修**:拆「处理中 N / 待上传 N / 需处理 N / 已停止 N / 已完成 N」。
9. **`winnerWorker` 没显示** → done 行补「Winner: vps2」。
10. **「做了什么」一长串灰字** → 加 ✓ 前缀 + 绿色,与当前步/后续区分层次。
11. **筛选栏无分组** → 加「状态 / 平台」标签。

### 顺带修
- 终态/待人工行不再显示「Not started → Preparing」(已完成的事没有「正在」)。
- 筛选 chip「失败待处理」与 state=failed 的「失败」撞名 → 改「需处理」。

### 测试(807)
新增「needs_manual 三态细分」用例;两处旧用例按新语义更新。
反向验证:改回不细分 → 3 个测试 fail。

## 追加 4:全 App 审核 + 响应式整改(2026-10-07)

用户要求审核**整个 app** 并「同时考虑 responsive」。用生产数据(15 任务 / 14 hub 规则 / 61 run)
在 390 / 768 / 1440 三档视口实测,发现 3 个真 bug + 一批一致性问题,全部整改。

### P0 真 bug
1. **任务列表窄屏 NAME 列被压成一字一行**:Status(262px)+Actions(178px) 固定宽不收缩,
   窗口一窄唯一有弹性的 Name 被挤到 62px(实测 768px 下表宽 803 > 视口)。
   **修**:Name 列 `sm:min-w-[200px]`;Quality/Danmu(<md)、Schedule/ID(<lg/<sm) 响应式隐藏,
   隐藏项以紧凑 meta 行补进名称单元格(信息不丢);<sm 操作列只留「详情」入口。
   实测 390px 表宽 356 ≤ 390,无溢出。
2. **Hub 窄屏(≤1024px)右侧详情面板完全消失**:`lg:grid-cols-[288px_1fr]` 在 lg 以下退化成单列,
   列表占满全宽、点房间看不到详情 → 整页不可用。
   **修**:改 master-detail —— <lg 未选中只显列表;选中后列表让位、详情带「返回列表」按钮。
3. **Hub「Active」指标口径错(恒为 0)**:`activeRuns` 基于 `listHubJobs()` 默认 limit=20,
   生产 61 条 run 时最近 20 条恰好全终态 → 恒 0(与队列页的 10 条待处理自相矛盾)。
   **修**:新增 `states` 精确过滤 + 读后端 `total` 权威计数(不受 limit 截断)。

### 顺带发现的同类 bug(第 3 处)
4. **Hub 房间列表「No runs yet」误报**:房间徽标用「最近 20 条 run 再按房间过滤」→
   有历史 run 的房间(如「一勺小苏打」18 runs)显示「尚无运行」。
   **修**:新增 `latestRunPerRoom()`(SQL 窗口函数,每组取最新一行,单条查询不 N+1)
   + `GET /api/hub/latest-runs` 端点。

### P1 一致性/可用性
5. 按钮 title 暴露内部术语(`Stop (disable)`/`Start (enable)`)→ 改「停止录制 / 开始录制」。
6. 任务列表看不到 hub 关联 → `TaskDTO.hubRule` 摘要(步骤/上传模式/上次结果),
   名称下方显示可点的 hub chip,直达房间页。
7. 队列筛选 chip 无障碍:`role="button"` + `aria-pressed`。
8. 顶栏登录 pill 点开设置语义意外 → title/aria-label 明确「账号与设置」。

### P2 打磨
9. Hub 标题「Hub」→「Hub 编排」(与「录制任务」「处理队列」并列,不再笼统)。

### 响应式验收
390 / 768 / 1440 × 3 页面 = 9 组,全部 `scrollWidth ≤ innerWidth`(零横向溢出)。

### 测试(810)
新增 `latestRunPerRoom`(每房间最新一条 + roomKey 无尾冒号 + 无库不炸)、
`states` 过滤(非终态被更新的终态挤出 limit 窗口时 total 仍正确)。
