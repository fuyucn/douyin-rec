# TODO — Agent 工作台账

> 本文件是本仓库 **agent 工作的唯一待办台账**。管理规则见 `AGENTS.md`「任务与 TODO 管理」。
> 编号 `T-N` 稳定不变（引用/提交信息里用它指代条目）。
> 最后更新：2026-10-08

## 状态约定

- `[ ]` **待办** — 已明确、尚未开始
- `[~]` **进行中** — 同时最多 1–2 项；开始做才标
- `[!]` **阻塞** — 必须在该行写明阻塞原因与解除条件
- `[x]` **完成** — 完成后移到「已完成」，行尾补完成日期

每条至少写清：**做什么 + 为什么 + 验收标准**；有计划的挂 `plans/NNN_*.md` 链接。

## 进行中

- [!] **T-5 部署未上线改动** — **阻塞原因**：部署 guard 要求两节点 `recording===true` 为 0，
  当前 VPS1 正在录「yyoo」、VPS2 正在录「凌晴」（2026-10-07 实测）。**解除条件**：两节点都收播
  （周期性 `curl /api/tasks` 复查）。**内容**：弹幕重连熔断、`resolveDouyinLiveId` 三级回落、
  `updateTask` 变更即同步、`anchorName` 比对、web 移动端 nav、T-1 能力门控、T-3 弹幕选优、
  **T-24 快手取流修复(页面优先 + 递进退避,`0.0.38`)**。
  **验收**：重建 docker master + 更新 VPS worker 后，`pnpm test` / `typecheck` 全绿且线上生效；
  快手任务在干净出口能真正取到流（不再「等待开播」）。
- [~] **T-17 分区录制 A/B 对比（VPS1 vs VPS2）** — 2026-10-08 10:21 起：cookie 已复制到 VPS2；
  5 个房间（呆呆蒽/什么鱼/潘潘不困/yyoo/忘忧时枫）分到 VPS2 且**全开弹幕**，VPS1 保留 7 个（含任务 1）。
  每天 10:30 cron 自动分析 → `logs/split-analysis-YYYYMMDD.log`（`scripts/daily-split-analysis.sh`）。
  **验收**：明天对比两侧 .ts 数量/大小 + xml 空/满比例 + API blocked 频率 → 得出「哪台适合录视频、
  哪台能拿弹幕」的结论，据此决定弹幕是否必须收回家宽节点。

### T-17 明日检查清单（2026-10-09 10:30 分析时逐条核对）

- [ ] **两侧是否真在录**：`/api/tasks` 的 `recording` 有非空；`recordings/` 下 `.ts` mtime 是今天。
- [ ] **VPS2 视频**：`ts` 数与总字节较 12.5GB 基线是否增长（说明新分配的房间真在录）。
- [ ] **VPS1 视频**：是否仍为 `ts=0`。**若仍 0 → 新部署的均衡模式没解决它的取流问题**（P1 待查）。
- [ ] **弹幕成败**：两侧 `emptyXml` vs `fullXml`。预期 VPS2 视频有但 xml 全空 → 印证「出口 IP 被风控 →
  拿不到 liveId」。若 VPS2 也能拿到 full xml，说明 cookie 复制 + 均衡模式已解决弹幕（P0 结论反转）。
- [ ] **API 被禁频率**：`journalctl -u video-screenshot | grep -c "blocked"`。频繁 = 端点持续被风控。
- [ ] **liveId 是否拿到**：`grep "解析 liveId 失败\|拿不到本场 liveId"` 日志计数。
- [ ] **资源**：`free -h` 的 swap 使用量（持续接近满 = 956MB 内存不够）；`dmesg | grep -i oom`。
- [ ] **VPS2 稳定性**：`tailscale ping 100.115.69.88` 是否仍抖（公网 22 不稳但 tailscale 稳，属云侧问题）。
- [ ] **master 视角**：`/api/hub/workers/status` 三节点全 ok；`journalctl` 无「没有对应成员」幽灵 id 告警。
- [~] **T-12 抖音取流/弹幕切「均衡模式」（自动挑 api type）** — 见下。代码完成 + 本机/VPS1 实测通过；
  **待 VPS2 复测**（公网 SSH 超时，暂不可达）后并入 T-5 部署。
  - 自审发现①（真缺陷）：`getStream` 走 balance 时把 `webHTML` 留在候选里 → 它**恒返回 streams:0**
    （实测家宽/VPS 一致），选中必失败、白试一次。已修为取流 `exclude:["webHTML","userHTML"]`
    （与上游 `stream.ts` 强制 `webHTML→web` 同理）。**注意弹幕 liveId 路径相反**：那里 webHTML 可用
    （只要 id_str），故保留 —— 两处 exclude 不同是有意的。
  - 自审发现②（真缺陷）：均衡器把「不抛错但返回不可用结果」当成功 → VPS2 取流失败（`未找到对应的流`）。
    已加 `validate` 钩子（返回 falsy 即按失败处理、换下一个端点）。
  - 自审发现③（真缺陷）：上游 `getNextEndpoint()` 无参 → 单次调用可能重复选中同一失败端点。
    已加单次调用内去重（`tried` 并入 exclude）。
  - 自审发现④（认知修正）：`priority` **不影响选择概率**（weight 全 1 → 均匀随机；模拟 20000 次验证
    50/50，家宽实测 web7/webHTML3 印证）。真正影响概率的是 `weight`。所以「调 priority 让 web 优先」
    是无效操作 —— 要改概率得调 weight。本轮未改 priority。

## 待办（Next）

- [~] **T-31 `/rooms` 完整替代 Tasks + Hub**(2026-10-10 用户定调:「新的 room 是为了替换掉 tasks 和 hub,
  必须做到完整更改时有效,如果没有提升就没有意义」)。**做什么**:把 `/rooms` 从「并存实验页」推进到
  「可替代」—— ①录/处理两半的**每个字段都能配**(对齐 CreateEditTaskDialog + HubRuleDialog);
  ②列表页具备**日常操作**(启停/排空/删除/新建),不只是看;③任何保存都**真的落库**(不得静默丢弃)。
  **为什么**:此前 `/rooms` 配不全(缺定时窗口/webhook/清理开关/标题模板/能力门控)、也没有启停入口,
  替代旧页会让用户「改不了、存不住」。
  **验收**:两旧页的每个字段在 `/rooms` 都能读能写;改任一字段保存后 `/api/rooms/:key` 读回一致;
  行内可完成启停/排空/删除/新建;`pnpm test`/`typecheck`/web build 绿。
  **进度**(`0.0.69`):审计出并修掉三处 —— ①**P0 静默数据丢失**:`hub-store` 整体替换 pipeline,
  改一个步骤会抹掉 cleanup/标题模板(已改深合并 `mergePipeline` + 2 个回归用例,验证「还原旧实现即失败」);
  ②**P1 静默丢失**:`PUT /api/rooms` 漏读 schedule,房间页改窗口存不进去(已成对写入/成对清空/半窗 400 +
  回归用例);③**P1 能力缺口**:面板补齐定时窗口/webhook/三清理开关/三标题模板/能力门控 requires,
  列表页加行内动作(启停/排空/详情/编辑/删除)+ 新建房间。真实浏览器验证保存往返 + 未提交字段不被抹掉。
  **剩余**:是否把 `/rooms` 设为主入口、旧页降为只读/重定向(**待用户拍板**,即原 T20 的 ①②③④)。

- [~] **T-30 hub/tasks 协作 + 编排/队列/多节点优化**(分支 `feat/hub-optimization`;M1 进行中) — 计划 `plans/030_hub_tasks_optimization.md`
  (结构化任务 `plans/030_tasks.json`,唯一执行源;20 任务 / 8 组件,plan-loop 校验 ok)。
  **来源**:2026-10-09 用户三轮提问(队列/workflow 不实时、hub 与 tasks 是否融合、编排/队列/多节点优化)
  + **7 轮独立 principal-engineer 评审**(score 55 → 56 → 58 → 72 → 70;循环 11 次、blocking 6 项 / major 21 项
  逐条修完,末轮 file-level 自检 0 blocking 0 major)。评审台账:`/tmp/opt-plan/ledger.tsv`(过程记录,不入库)。
  **做什么**:①控制面安全阀(审计快照 + 骤减守卫 + force + 禁用≠删除);②SSE 实时状态(替换 3s 轮询,
  去竞态、本地计时、过期提示);③跨房间非阻塞派发(同房间串行、不重复建稿);④上传冷却跨重启持久化
  (master + 节点侧共用);⑤统一房间入口 `/api/rooms`(低风险版:既有 Hub 页内联 + 房间级动作,不新建页/不退役旧入口);⑥按**实际提交段数**
  核验分 P 再删源 + 清理可重试;⑦孤儿/空壳维护清理;⑧短命录制熔断;⑨并行度可配。
  **为什么**:近期实况已暴露数据丢失(节点任务被清空)、产物丢失(什么鱼 livechat 分 P)、
  状态失真(队列卡顿)、节点重连风暴(1650 次)四类问题。
  **验收**:master 配置不可读 → 节点任务一条不减;SSE 1s 内同步;后一场收播的 job 行立即可见;
  冷却跨重启保留;`PUT /api/rooms/:key` 一次改两半;分 P 不符不删源;短命录制退避递增。
  全程 `pnpm test`/`typecheck`/`bundle`/web build 绿 + 架构图一致 + 每个 `feat|fix` bump version。
  **取代** `plans/029` 的 P0/P2/C 工作(029 保留为历史;D4 内存决策仍未决)。
  **进度**:**M1 全部完成**(`0.0.50`,待部署验证):T1 节点审计快照 / T2 期望骤减安全阀 + force 通道 /
  T3 删除语义收敛(禁用≠删除)/ T11 产物完整性核验 + 延迟删源 / T12 清理独立化(可重试、失败不影响终态)/
  T13 孤儿与中间产物维护清理(可预览可审计)/ T14 录制健康(有效落盘判成功 + 短命录制熔断)。
  **M2 进行中**:`0.0.52` 已完成 T4(SSE 端点)、T5(队列读取批量化)、T6(前端推送驱动 + 过期提示 + 本地计时)、
  T7(非阻塞派发)、T8(上传冷却/滑动窗口跨重启持久化)、T9(统一房间 API)、T10(Hub 弹窗内联录制配置)。
  **用户最初报的「队列/workflow 卡卡的、不实时」到此闭环**:推送服务端(T4)+ 前端消费(T6)两侧都到位。
  `0.0.53` 追加 T17(录制侧状态实时化:状态变更主动推 SSE + 远端状态带「N 秒前核对」+ 探测周期自适应 2s/10s)、
  T19(节点侧上传共用持久化 601 冷却,判定下沉到 @drec/core 单一实现)。
  `0.0.54` 追加 T15(资源并行度可配 + **立即生效**:新增设置页「资源」页签,写回 master **实际在用的那份**
  hub 配置,内联 JSON 时明确 400 而不是假装保存成功)。
  `0.0.55` 追加 T18(房间级动作:排空 / 立即停止(二次确认) / 立即处理 / 重试清理,全在既有 Hub 房间详情)。
  **M1–M3 全部完成**;仅剩 T16(已 defer)、T20(需你确认需求反转后才立项)。
  其余任务见 plans/030_tasks.json 的 status 字段。
  跨任务审计抓到:子 agent 全局字符串替换导致 `openLedger` 自调用无限递归(局部测试全绿、全量崩 2 例)——
  教训:**局部跑通 ≠ 全量通过**,跨 agent 改同一批文件时必须以仓库根全量为口径。
  T19 落地后的跨任务审计又抓到:`UPLOAD_FAILCLOSED_MS` 的 30min 在 core 与 ResourcePool 各写一份,
  改一处不会报错、只会让两条路径的 fail-closed 悄悄分叉 → 已改为单一引用。
  M1 跨任务审计:核验接缝 `countParts` 由 cli 注入(orchestrator 不 import app,分层测试过);
  `clean_verify` 在 core/web/前端文案三处都已接上;xml「不得删最后一份」判据落在 orphan-cleanup 的
  非空副本索引上;T13 只动了 server.ts 的路由段,未覆盖 T2 的 `POST /api/hub/apply`。
  T2 自审修复记录:①TDZ(守卫引用未初始化的 upsert/writeSnapshot)→ 移到 upsert 之后、快照抽 `writeSnapshot`;
  ②空期望分支曾先跑「只停用」→ 「一个没删却全被停用」,比原 bug 更隐蔽 → 判定/执行按分支隔离;
  ③force 在同步在途时被合并丢失(用户点「强制应用」没反应且 master 侧无痕)→ 抽 `SyncGate` 累积标志 + 6 用例;
  ④`SyncGate` 化后 stop 未 unbind → 停机后请求打到旧 runner → 补 `unbind()`;⑤骤减阈值曾用严格小于,与 plans/030
  定稿(≤ floor(n/2))不一致 → 回归计划口径并加「下一轮真删」的收敛用例(证明不卡死)。
  **分四个里程碑发版**(避免大爆炸):M1 止血(T1-T3/T11-T14)→ M2 实时与吞吐(T4-T8/T15/T19)
  → M3 房间入口**低风险版**(T9/T10/T18:在既有 Hub 页一处配完 + 房间级动作,**不新建页/不退役旧入口**)
  → M4 可选/需确认(T16 运维可见性按需;**T20 完整单页合并属需求反转,需你确认后才立项**)。
  评审中据实下调了两处预期:T7 只交付「job 行立即可见 + net/upload 与 CPU 重叠」(`maxCpuParallel` 仍 1,
  merge/burn 依旧串行,真并行需 D4);房间入口改为在既有 Hub 页内联,风险与返工显著降低。

- [!] **T-26 节点韧性 + 房间配置统一 + 队列并行度** — 计划 `plans/029_room_config_and_resilience.md`(实施计划)。
  **来源**:2026-10-09 三轮审计 + 用户讨论。结论均以真实台账 + 实测验证(plan §9 附复现命令)。
  **三组工作(按优先级)**:
  - **P0 节点韧性(🔴 数据丢失)**:master `config/hub/` 丢失/不可读 → `listHubRules` 把「读不到」当「没有」
    → `desired=[]` → `applyRemoteTasks` **两阶段删除** → **所有节点受管任务被清空**(实测复现:第1轮停用、
    第2轮删除、剩余 0);节点**零规则副本**。**修**:① 期望状态副本(`config/managed/rooms.json`)
    ② 期望骤减安全阀(空期望拒绝 / 骤减只停不删)③ 删除改**显式意图**(缺席只停用)。
  - **P1/P2 配置统一(🟡)**:房间配置分两处(task + hub 规则)。历史 `6636952`(2026-06-29)显示是
    **按当时用户要求**拆的 → 需求反转,非设计事故。**目标**:一个房间一份配置(record/process/place),
    一个入口配完。分 Phase 1(清死代码 + 弹窗内联录制配置)→ 2(统一 `/api/rooms`)→ 3(合并存储,可选)。
  - **C 并行度(🟡)**:实测**单次 burn 只用 5.3/11 核(48%)**;`maxCpuParallel` 默认 1 且 **UI 改不了**;
    内存闸门 2048MB 卡住第 3 位(容器仅 4GB)。**注意**:7 天 burn 仅 5.6h → 提并行度**削峰不提吞吐**。
  **明确不做**:worker claim/lease 队列(Fleet 54 个 `.rs` 中 queue/claim/job/task **零命中**;
  房间是常驻监控,非一次性 job)。
  **⚠️ 阻塞原因**:4 个决策待裁决(plan §2 D1~D4)。**推荐**:D1=是(韧性最先)、D2=显式删除、
  D3=先做 Phase 1+2、D4=需你提供 master VM 配额能否调大。
  **解除条件**:用户答复 D1~D4 → 按 P0 → P1 → P2 →(可选 P3)+ C 组推进。

- [ ] **T-18 节点侧上传（experimental:不烧录房间跳过 rsync 回传）** — 计划 `plans/027_node_side_upload.md`。
  **做什么**：hub 规则加 `pipeline.steps.nodeSideUpload`（缺省 false）。为 true 且**该房间不烧录**时，
  winner 节点本地 remux → 节点 biliup 直接上传，master 只收 BV 号，**省掉整场录像 rsync 回传**。
  **⚠️ 2026-10-09 收益复核（真实台账 + 实测带宽，见 plan 文末「收益复核」）—— 原估算偏高**：
  ① T-18 只覆盖**总 pull 字节的 30%**（48GB/157.5GB，7 天）；② pull **不占端到端关键路径**
  （`maxNetParallel=1` 但实测净闸门并发度仅 **0.10x**，几乎不排队）→ 省 8h ≠ 快 8h；
  ③ 实测 master **下行 26Mbps / 上行仅 12Mbps** → 省的是「上行那一半」（约 24GB），不是全部；
  ④ **发现更大更便宜的目标**：local winner 的 pull 是**同盘 `copyFileSync`（7 天 51GB > 48GB）**，
  修法只是硬链接/跳过拷贝，零协议改动。
  **建议**：先做「local winner 硬链接」；T-18 若要做得**只做最小版**（就地 remux+上传，不做
  `_node-capabilities`/节点侧状态机）并只开 1 个房间；完整版暂缓。**待用户决策**。
  **验收**：见 plan 验收清单（flag off 零回归 / flag on 不烧录实测无 pull 步 / 缺能力回落不静默）。
- [~] **T-19 worker 安装脚本补 rsync 硬依赖** — ② **已完成(2026-10-08)**:`transport-ssh.ts` 的
  rsync 失败现带 stderr 尾部(新纯函数 `summarizeRsyncStderr` 丢弃进度行、留真错误、限长),错误形如
  `rsync rc=12: rsync: command not found(host:remote)`;+4 测试。① **待办**:合并 T-5 部署后
  **重建/重装 VPS** 验证 `install-worker.sh` 的 rsync 硬依赖 fail 行为。
  **背景**:2026-10-08 vps2 缺 rsync → 每场 pull `rc=12` → 后处理全卡 needs_manual,
  错误只报退出码无 stderr,排查成本极高。
- [x] **T-22 app 解耦 1–4 步(api.ts 拆域 / 修反向依赖 / tui 归位 / serve 归位)** — 2026-10-08 起。
  **背景**:T-21 原计划「先拆 web/ 成独立包」经复核**是错的** —— `web/api.ts` 值导入 12 个 app 模块
  (hub-store/hub-jobs/worker-store/store/scheduler/task-input/timezone/paths/version/upload/biliup/
  task-manager/merge-jobs),拆包必成 `@drec/app ↔ @drec/web-server` 循环,layering 测试必红。
  故改为**先拆文件、修反向依赖**,拆包(T-21 第 5 步)留到最后且可能不必做。
  **四步**(每步独立提交 + 全量验证):
  1. `app/src/web/api.ts`(1321 行,`makeApi` 单函数 909 行、51 方法)→ 按域拆 `web/api/*.ts`:
     tasks / hub-rules / hub-jobs / workers / cookies / settings / login / merge / events。`makeApi` 只做组装。
  2. `parseCookieExpiry` 从 `web/api.ts` 下沉(命令层 `cli-task.ts:674` 反向 import 了它)→ 消除反向依赖。
  3. tui 启动从 `app/cli-task.ts:813` 挪到 `cli` → 断掉 `app`(L4) → `@drec/tui`(L0) 的怪依赖。
  4. `serve` 命令从 `app/cli-task.ts`(508..805, 298 行)挪到 `cli` → 命令定义回归 cli。
  **验收**:`pnpm test`(现 119 个 web-api 用例 + 16 个 web-server 用例必须全绿)/ `typecheck` / `bundle`;
  `test/arch/layering.test.ts` 通过;`pnpm arch:gen` 重新生成架构图。**纯重构,行为零变更**。
  **完成(2026-10-08)**:
  - 步 1:`web/api.ts` 1321→45 行(纯组装),拆出 `web/api/{types,context,tasks,cookies,hub-rules,hub-jobs,workers,settings,merge,login}.ts`
  - 步 2:`parseCookieExpiry` 下沉 `app/cookie-utils.ts`,断掉 命令层→web 反向依赖
  - 步 3:`task tui` 挪到 cli,app 移除 `@drec/tui` 依赖(依赖边 27→26)
  - 步 4:`task serve` 命令定义回归 cli,运行时装配抽到 `app/serve.ts` 的 `runServe()`;
    `app/cli-task.ts` 878→约 560 行
  - 自审修复:重复常量 `DEFAULT_COOKIES_KEY` 去重(删新 consts.ts,统一从 login-manager 导入);
    删除 types.ts 残留死代码 `sanitizeSeg`
  - 验证:`pnpm test` 869 passed / typecheck / bundle / `task serve` 实测起服务 / `task tui` 在
  - **审计(2026-10-08,逐项实测,非自述)**:53 handler 函数体逐字节一致 / 域间零互相 import /
    serve 装配体与拆分前一致(仅多一行注入)/ tui·serve 命令定义一致 / 命令树完整 /
    app 对外导出仅 +3 行无删除。审计发现并修复:`sanitizeSeg` 多余暴露在 ApiCtx → 改私有。
- [ ] **T-21 拆分 app「上帝包」**(架构/认知税) — **问题**:`packages/app` 是 7215 LOC / 30 文件的
  单一包,同时承担 ≥8 个不相干职责:sqlite store、任务调度 daemon、子进程生命周期、hub 规则文件 CRUD、
  hub 台账读取、扫码登录(3 平台)、**web HTTP API(api.ts 1321 行,单个对象 51 个方法)**、biliup 上传、
  TUI 启动、时区、路径。它还是全仓依赖最宽的包(7 个 @drec + 5 个第三方)。
  **证据(2026-10-08 实测)**:见 `docs/architecture.html` 热图 —— app 与 web 并列改动热点(各 34 次/90 天);
  `app/src/web/` = 2005 行、`app/src/login/` = 686 行,均为**内聚、可独立**的子域。
  **另**:`app`(L4)依赖 `@drec/tui`(L0)只为 `cli-task.ts:813` 一处动态 import;
  `app` 里还有 `new Command("task")`(命令定义本应属 cli)—— 两个跨层味道。
  **建议顺序**(每步独立可验证):① 拆 `web/` → `@drec/web-server`(api+server+static);② 拆 `login/` →
  `@drec/login`;③ hub 领域(`hub-store`/`hub-jobs`/`worker-store`)考虑挪到 orchestrator 或独立包;
  ④ `cli-task.ts` 的命令定义回归 `cli`。**验收**:每拆一个包 `test/arch/layering.test.ts` 的 RANKS 登记 +
  `pnpm test`/`typecheck`/`bundle` 全绿 + 架构图重新生成。**注意**:纯重构,行为零变更。
- [ ] **T-16 节点「主动加入」+ ticket 机制**（架构级，暂不做） — 现状：master 主动 SSH 拨 worker，
  加节点要手填 host/dataRoot（id 现由 T-15 改为节点自报）。**要做的是 biliup Fleet 那套**：worker 侧
  `task join <ticket>` + master 签发一次性票据（+ 节点私钥）+ 节点主动连 master（可穿 NAT）+ ticket
  校验/撤销。**为什么暂不做**：需引入 master↔worker 常连控制通道（新协议 + 新状态），架构级改动；
  当前 tailscale 组网下 SSH 方案可用。**触发条件**：① 要频繁加节点；② worker 在 NAT 后 SSH 不可达；
  ③ 需要在线态/心跳实时性。**参考**：biliup Fleet（控制面/节点/relay,ticket 加入,私钥鉴权）。

- [ ] **T-6 docker tailscale 版本升级** — sidecar `1.98.4`（落后 5 个月），其他节点 `1.104.1`。
  `docker compose up -d --build` 不会拉新镜像，需 `docker compose pull && docker compose up -d --build`。
- [ ] **T-7 清理 VPS1 exit node 残留** — VPS1 曾 `advertise-routes 0.0.0.0/0`，健康检查报
  `IP forwarding is disabled`；Mac 侧已恢复家宽。**验收**：撤销 VPS1 的 advertise（`--advertise-exit-node=false`）。
- [ ] **T-8 轮换/清理 tailscale auth key** — 用户先后贴过两个 key，`kbnba6Qh4…`（带 tag）已弃用，
  `k6mrGoiS…` 在用。**验收**：旧 key 在 tailscale 后台撤销。
- [ ] **T-9 VPS2 弹幕 0 条深挖** — 干净 IP 仍 0 条，非纯 IP 因素（docker 同代码同 cookie 有 9109B/25 消息，
  VPS 首帧 286B/0 消息/`needAck=false`）。**验收**：定位 wss 层被拦的判定条件。

## 未来 / Backlog

- [ ] **T-31 角色模型重构：standalone / controller / node 三态**(2026-10-10 记录,待用户确认后立项)
  **问题**:现在只有一个 `--hub` 开关(hubEnabled),把「有没有控制台」和「本机是否录制节点」耦合在一起。
  导致单机用户也会看到「Worker 列表里只有一个 local」这种无意义概念 —— 单机场景根本不该有「节点」这个说法。
  **现状三种真实场景**:①**单机**(录+处理+上传全在本机,不需要节点) ②**controller**(只管编排,自己不录)
  ③**node**(纯录制,等下发)。目前 ①③ 都能跑,但 ① 的 UI 被迫显示节点概念。
  **期望**:引入 `role: standalone | controller | node`。standalone 的 UI **完全不显示节点/Worker 概念**;
  controller 显示节点管理/队列/选优;node 保持现状(无 Hub 页)。
  **触发条件**:/rooms 页(T20 第 1 步)稳定后,用户确认要做。
  **关联**:T-30 的 c5(hub/tasks 协作)。**不排期**。
- [ ] **T-2 负载分摊（placement / 按负载自动选点）** — 计划：`plans/026_worker_load_placement.md`。
  **注意**：与现有「多节点冗余录制 + coverage 选优」模型**二选一**（分摊=每房间派 1 台），
  属模型取舍，不是可顺手加的功能。**为什么**：冗余模型把轮询量乘了 N，是 VPS 被限流的根因之一。

## 已完成

- [x] **T-29 分段模式下多会话(断流重连)的烧录分 P 丢失(真缺陷)** — 2026-10-09 用户发现
  `douyin.63171491268`(什么鱼)稿件 P1-P6 齐全但 livechat 只有 P7-P9(会话1 的 3 段),会话2 的 3 段
  livechat 全丢。
  **根因(读源码 + 真实 xml 复现)**:`segment-pipeline.ts` 的弹幕窗口用**整场单一 `globalOffset`** 累计,
  而窗口是相对**该段所属会话**的 xml 切的(`video_start_time` = 该会话起点)。断流重连产生**新会话 + 新 xml**
  (时间轴从 0 重起),沿用整场 offset → 新会话各段窗口整体错位到该会话时长之外 → 窗口内 0 条弹幕 →
  `窗口内无弹幕,跳过` → 这些分 P 的 livechat 全不产出。实测复现:会话1 三段 10128s、会话2 三段;
  旧代码给会话2 的窗口是 [10128,13729]/[13729,17330]/[17330,20178],而会话2 xml 只覆盖 ~10050s → 0 命中;
  按会话累计后 [0,3601]/[3601,7202]/[7202,10050] → 命中 140/302/307 条。
  **同类风险(一并修)**:分组计划可能把**跨会话**的段合进同一个分 P(只有一份 xml,窗口并集却用其中一个 xml)
  → 同样错位。已按会话边界切开分组。
  **修**:抽两个纯函数 `sessionWindowOffsets()`(按 xml 路径分桶累计)与 `splitGroupsBySession()`(按会话切组),
  pipeline 接入;删除整场 `globalOffset`。
  **验收**:新增 `packages/orchestrator/src/segment-pipeline.test.ts`(7 用例;已验证「还原旧实现即 2 例失败」);
  `pnpm test` **902 全过**、`tsc --noEmit`、`pnpm bundle`(`0.0.47`,产物已无 `globalOffset`)。
  **部署**:`0.0.47` 已上线 master + VPS1 + VPS2(三节点 ok)。
  **受影响的历史稿件**:`63171491268` 10-07 与 10-09 两场(10-07 稿件 `BV12ipK6HEBb` 3 个 livechat 全丢)。
  源 `.ts` 已被 cleanup 删除 → **无法补烧**,只能保留现状(弹幕 xml 仍在节点,但视频已删)。
  **另一类同症状但不同根因**:`68133201791`(凌晴)10-09 两场 `danmuCount:0`(xml 全空,取不到弹幕)
  → livechat 也无产物;那是弹幕采集问题(见 T-9),非本 bug。（2026-10-09）
- [x] **T-27 hub 上传撞 `21566 投稿过于频繁` → 整场转人工（真缺陷）** — 2026-10-09 实况:
  `douyin.76601480575`（汪汪想不到）hub 建稿两次均报 `code: 21566`,重试 1 次后转 `needs_manual`,
  白等一场;人工补传成功（`BV12Zp86sEN2`,3 分 P）。
  **根因(读源码 + 实测双向确认)**:`packages/app/src/upload/biliup.ts` 调 `biliup upload` **未指定
  `--submit`** → biliup CLI **默认走 app 提交接口**(`entry.rs`:`submit.unwrap_or(SubmitOption::App)`),
  而 app 接口(`member.bilibili.com/x/vu/app/add`)**更易触发 21566 风控**(biliup 自己的 server 端因此
  在 `server/common/upload.rs` 把默认改成 web;issue biliup#1609 / #1762)。叠加第二处缺陷:
  `core/src/upload-contract.ts` 的 `isUploadRateLimited` 只认 `601`,**不认 21566** → 命中后只退避
  60s 重试(仍处风控窗)→ 二次失败 → 转人工。
  **修**:①`buildUploadArgs`/`buildAppendArgs` 显式 `--submit web`(env `BILIUP_SUBMIT` 可覆盖,
  非法值回落 web);②`isUploadRateLimited` 加认 `code: 21566`/`投稿过于频繁`;③compose/.env.example
  加 `BILIUP_SUBMIT` 透传;④`upload-recording-today` skill 同步加 `--submit web`(唯一权威)。
  **验收**:`pnpm test` 894 全过(+6 用例:submit 默认/覆盖/非法回落 + 21566/601/普通错误识别)、
  `tsc --noEmit` 通过、`pnpm bundle` 产物含 `BILIUP_SUBMIT` 与 21566;本机实测
  `biliup ... --submit web upload P1 P2 P3` 建稿成功拿 `BV12Zp86sEN2`(水印 `state:0` 已确认)。（2026-10-09）

- [x] **T-28 `{title}` 渲染为空的真凶 = 录制节点跑的是**旧 bundle**(非代码缺陷)+ 跨场标题串台(真缺陷)**
  — 2026-10-09 实况:`BV12Zp86sEN2` 稿件名 `汪汪想不到_2026-10-09_ 直播回放`(双下划线 = `{title}` 空),
  当天 12 场 hub 上传**全部**如此。
  **根因 ①(部署滞后,非代码 bug)**:T-20 的侧car `title` 修复(`f8e7543`,10-08 23:00 PDT)**只存在于
  master 容器 + VPS 源码**,而该场由 VPS2 录制;VPS2 当时跑的进程 `PID 465892` **启动于 10-08 20:09 UTC**
  (早于修复),直到 10-09 15:59 UTC 才重启换新 bundle。该场(UTC 12:36:30→15:32:31)整段落在旧进程上 →
  `session.json` 无 `title`。**证据**:同一 VPS2 重启后新录的场(如 15:59 之后的 session)已带 title;
  VPS1 当前录制中(新 bundle)`不想卷了` 的 session.json `title:"天蝎"` 与抖音 API 一致。
  **根因 ②(真缺陷,已修)**:同一录制进程**跨场**(下播 → 主播重新开播)时,`RecordingSession.liveTitle`
  不清空 → 第二场的 `session.json` 沿用**第一场**的标题。**复现**:`video-rec-2 task 11` 20:36 那场收播后
  进程继续轮询等下一场(日志 15:32:50「主播已下播…等待下次开播」),若第二场开播即张冠李戴。
  **修**:`packages/manager/src/index.ts` 的 `onLive` 里,`offlineNotified`(onOffline 已查权威
  `getLiving=false` 确认下播)时清空 `liveTitle`;抖动断流(仍在播)不清,保留同场首值。
  同时删掉 onLive 里的 sidecar 补写(onLive 恒先于 onSegment,补写会误用 `lastXmlPath` 覆盖**上一场**
  的 sidecar —— 实测踩到)。
  **验收**:`pnpm test` **895 全过**(+1 用例 `T-20b`:下播→第二场用第二场标题;已验证「移除修复即失败」)、
  `tsc --noEmit` 通过、`pnpm bundle`(`0.0.46`,产物含 `offlineNotified&&(this.liveTitle="")`)。
  **线上修复**:`BV12Zp86sEN2` 稿件名经 web edit 接口改为
  `汪汪想不到_2026-10-09_养着不烧心 直播回放`(`{title}=养着不烧心`,与抖音 API 一致;水印仍 `state:0`,
  仅自己可见未变)。
  **遗留**:其余 11 场当天上传(10-09)同样 `{title}` 空,均系旧 bundle 所致 → 待 `0.0.46` 部署后不再复现;
  **已完成(2026-10-09)**:① 11 场标题全部修正(`{title}` 用抖音 API 当场标题填充);② `0.0.46`
  已部署到 master + VPS1 + VPS2(三节点 `0.0.46`,hub worker status 全 ok)。批量改标题的实现注意点:
  `x/vupre/web/archive/view` 对本机 IP 返 **412 风控** → 改走 biliup 同款 **app 接口**
  (`x/client/archive/view` 读 + `x/vu/app/edit/full` 写,access_key 签名);payload 只传 Studio 字段
  且必须带 `aid`(否则 21001/-400)。水印 `state:0` 逐稿复核未被 edit 改动。（2026-10-09）

- [x] **T-10 本机抑制也要走能力门控** — `localSuppressedSourceTaskIds` 原只看 `workers` 勾选,不看
  `requires`:若远端缺能力(reconciler 会排除它)而本机又被抑制 → **两头都不录**的静默漏录。
  **修复**:能力门控纯函数(`satisfiesCapabilities` 等)**从 orchestrator 下沉 @drec/core**(app L4 不能依赖
  orchestrator L4.5,且两处判定必须同一真理源;orchestrator 保留 re-export);本机抑制改为「远端存在 +
  能力 ⊇ requires」才算有人接;拿不到能力信息时**不抑制**(安全默认)。
  **验收**:hub-store +2 用例 / `pnpm test` 886 全过 / typecheck / bundle(`0.0.43`);layering 通过。(2026-10-08)

- [x] **T-20 直播间标题未采集 → 稿件 `{title}` 渲染为空**（bug） — **根因(2026-10-08 实测)**:
  ① 录制侧 `session.start` 只传 anchorName(平台 `getStream` 只在 living 时才有 title,开播前无从得知);
  ② manager 的 `onLive` 收到 `ev.onLive({title})` 但**不更新 `liveTitle`** → `<recordings>/*.session.json`
  永远无 `title` 字段;③ `scan.ts` 读不到 → pipeline `titleCtx.liveTitle` 空 → `{title}` 渲染为空。
  **修复**:manager `onLive` 里接收 `i.title`,首个非空值写入 `liveTitle` 并**立刻刷新 sidecar**;
  保留首值(重连不被空值清掉)。全链路 `getStream().title → probe.title → onLive({title}) → sidecar` 打通。
  **验收**:`test/session.test.ts` +2(开播时才拿到标题 / start 时已知标题 → sidecar 均有 title);
  `pnpm test` 884 全过 / typecheck / bundle(`0.0.42`)。(2026-10-08)

- [x] **T-23 仓库状态对齐(HEAD 断裂 / 生产跑未提交代码)** — 计划 `plans/028_repo_state_reconciliation.md`。
  **实测确认**:HEAD 单独 checkout 有 7 个真实类型错误(`requires`/`capabilities`/`ensureNodeIdentity`/
  `douyinApiMode` 定义侧全在 WIP);生产 `0.0.32-661663` 跑的是仓库里不存在的构建。
  **做法(按 plan 的「定义侧→消费侧」切分,实测每个 commit 都 typecheck 绿)**:
  ① `dfc659e` 定义侧(能力门控/节点身份/API 模式类型与实现 + 新模块);
  ② `552d792` 消费侧(reconciler/cli/web/danmu 引用 + 测试);
  ③ `f10e25b` 归档(审计文档/plans/026/运维脚本/架构图再生成/AGENTS.md 可提交)。
  **用户裁决 3 个未决问题**:脚本提交(非 gitignore)、`plans/026` 提交、T-17 脚本现在提交 —— 均按「提交」处理。
  **验收**:干净 worktree(真实 `pnpm install`)`tsc` ✅ / `pnpm test` **869 全过** ✅ / `pnpm bundle` ✅;
  工作区干净(`git status` 空);TODO 每个 `[x]` 可追溯。(2026-10-08)

- [x] **T-24 快手「无法获取直播」根因修复(取流改回页面优先 + 递进退避)** — **真凶与 IP 无关**:
  `livedetail` API **已被平台下线**(2026-10-08 实测:对真房间号/主播 id/乱码/空参数都返回同一 634 字节桩,
  `result:2`+`living:false`+`playUrls` 全空)→ 旧「API 优先且说没在播就不回退页面」让**任何节点**
  (含 IP 干净的 VPS1/VPS2)都报 `living:false`、永不回退页面 → 任务 75 一直「等待开播」。
  **修复**(`9db3d31`):`getStream`/`getLiving` 改回**页面优先、API 仅兜底**;API 只认「拿到可播流 URL」,
  拿不到一律 `null`(绝不 `{living:false}`);页面失败+API 桩 → **抛错**(未知,不静默);HTML 含限流文案 → `throttledReason`;
  持续风控探测间隔**递进退避** 5→10→20→30 分钟封顶(record-engine)。
  **实测**:同一在播房间,旧代码在 VPS1/VPS2 = `{living:false}` → 新代码 `{living:true, url:hw-origin...flv}`;
  本机(被限流)= `{living:false, throttledReason:"请求过快，请稍后重试"}`。
  **验收**:`pnpm test` 876 全过 / typecheck / bundle(`APP_VERSION 0.0.38`);文档 `docs/kuaishou-rate-limit.md` 补「修复 3」。(2026-10-08)

- [x] **T-25 快手限流:对照外部同类问题 + 补全浏览器请求头** — 参考 48tools#128(症状与我们 task 75
  一致,作者判定风控/被拉黑、建议国内 IP + 不要频繁刷新)、48tools v4.17.0(称「浏览器 fetch 替代 got
  解决请求过快」)、ordinaryroad live-chat-client(`livedetail` 的 `result:2`=请求过快、`400002`=需要验证,
  仅 1 正常 / 671·677 未开播,其余抛异常)。
  **我们的 A/B 实测(同一被限流出口,证伪)**:浏览器 fetch 的收益**不可复现**(第 2/3 轮 Node 与浏览器
  均被限流)→ 决定性变量是**请求速率**(48tools 是点击时请求一次,不轮询;我们已用 5 分钟 + 递进退避覆盖)。
  **采纳**:补全真实 Chrome 请求头(`Accept`/`Accept-Language`/`sec-ch-ua`/`sec-fetch-*`/
  `Upgrade-Insecure-Requests`,不手写 `Accept-Encoding`)。**未采纳**:浏览器 fetch 兜底(收益不可复现 + 成本高)。
  **验收**:`pnpm test` 878 全过 / typecheck / bundle(`0.0.40`);文档补「外部同类问题与解法对照」。(2026-10-08)

- [x] **T-15 节点自报稳定身份（nodeId）** — worker 首次 `serve`/`_node-id` 时生成并持久化
  `<root>/config/node.json`（**nodeId = 16 字符 hex 短 hash**（8 字节随机）+ hostname + createdAt），
  **此后永久不变**（跨重启/换 master/迁移）。短 hash 而非 uuid v4：36 字符在 UI/日志/URL 偏长；
  8 字节 hex 碰撞概率 2^-64 量级足够，且只含 `[0-9a-f]` 满足 worker id 路由字符集。
  master 经隐藏命令 `_node-id` 读它，UI「添加节点」的**测试连接**顺带返回 nodeId → 新建 worker 用它
  作 id（不再自分配 `worker-N`）。**为什么**：旧 id 由 master 按 seq 分配 → 删了重建就换号，规则里引用的
  id 变幽灵、身份丢失。**验收**：`pnpm test` 854 全过（+节点身份 4 用例、显式 id 3 用例）；真机 VPS1
  实测生成 `node.json` 且幂等（复跑同一 nodeId）。（2026-10-08）
  - 自审发现：`process.env.HOSTNAME` 在 ssh 非登录 shell 里为空 → 改用 `os.hostname()` 兜底;
    并给 `ensureNodeIdentity(root?)` 加可选 root（master 探测 local worker 时 dataRoot 可能 ≠ 自身 drecRoot）。
  - 兼容：旧 bundle 无 `_node-id` → `nodeId()` 返回 null,UI 回落旧的自分配行为(不阻断)。

- [x] **T-14 对照上游 1.17.4 查漏补缺（vendored 副本）** — 把上游 1.17.4 的 TS 逐个转译后与我们的
  vendored JS 做归一化 diff，补齐缺失的上游修复。**补入**：① 电台判活（`room_status===1` /
  `enter_mode==1`）；② `isLiveRadio` 全链路透传（`douyin_api.js` 4 处 + `stream.js` `getInfo` +
  `index.d.ts`）；③ 电台优先 `mobile` 取流；④ `userHTML` 的 `stream_url` 构造（`flv_pull_url` 重建、
  `or4`→`origin`）；⑤ `getFormatPriorities`（`preferAlternativeStream`）。**顺带修掉我们的历史 bug**：
  `getRoomInfoByUserWeb` 误标 `api:"webHTML"`（应为 `userHTML`），会让 `getRoomInfo` 的返回分支错判。
  **为什么**：这些缺失会导致**电台直播判活失败 → 漏录**、`userHTML` 路径取不到流。
  **验收**：`pnpm test` 847 全过；实测普通直播间取流/弹幕仍正常、`isLiveRadio` 正确透传；
  对照清单写进 `packages/douyin-live/src/stream/SOURCE.md`「上游修复对照」。（2026-10-07）
  - 自审发现：`isLiveRadio` 是**主播属性**而非「正在播」——实测未开播电台房间 `isLiveRadio:true` 且
    `living:false`。上游把 `room_status===1` 当 living 是「宁可多判也不漏录电台」的取舍，照抄并记入
    SOURCE.md 备忘。
  - 仍未同步（不影响我们路径，已在 SOURCE.md 记录）：`getRoomInfoByUserWeb` 的早退结构差异（功能等价）。

- [x] **T-13 抖音 API 模式加入 UI 设置（可选）** — 全局设置 `settings.douyinApiMode`，UI「设置 → 引擎」
  下拉可选 `balance`(默认)/`web`/`webHTML`/`mobile`/`random`。链路：设置 → `GET/POST /api/douyin-api-mode`
  → spawner 读 getter 注入子进程 `DOUYIN_REC_API_MODE` → `douyin-live` 的 `resolveApiMode()` 消费（取流/
  判活/主播名/弹幕 liveId 全走它）。契约常量在 `core`（`DOUYIN_API_MODES`/`normalizeDouyinApiMode`）。
  **为什么走 env 而非 Platform 参数**：`getStream(channelId,quality,cookies)` 是三方平台契约，不该加抖音
  专属参数；且这是全局设置、非 per-task。**验收**：`pnpm test` 847 全过（+4 API 用例）；真子进程实测
  `DOUYIN_REC_API_MODE=web node dist/douyin-rec.mjs probe` 取到流；非法值回落 balance。（2026-10-07）
  - 自审发现①（真缺陷）：UI 可选 `webHTML` 但取流用它**恒失败**（streams=0）。已补上游 1.17.1 修复
    —— `stream.js` 把 `webHTML` 与 `userHTML` 一并改回 `web`（取流路径），弹幕 liveId 路径不受影响。
  - 自审发现②：`setDouyinApiMode` 应存**归一后**的值（而非原样），否则设置里留非法串、UI 回显与生效值
    不一致。已改。
  - 自审发现③：`server.ts` 的路由名联合类型需同步加 `getDouyinApiMode`/`setDouyinApiMode`（typecheck 抓到）。

- [x] **T-11 单一真相源：`AGENTS.md` 为准，`CLAUDE.md` 变 `@AGENTS.md` 指针** — 把 `CLAUDE.md` 独有且
  仍有效的实质内容并入 `AGENTS.md`（弹幕健康监控/onLive 契约、数据根 `DOUYIN_REC_ROOT`、时区
  `applyTimezone`、hub 角色/数据流/选优/pipeline/SyncLedger/硬标准常量、`_recording-status`、
  `DownloadEngine`、ffmpeg `Opening` 解析、`patches/`+`bin/` 布局）；修掉失效引用（`plans/030` 不存在 →
  指向 `packages/core/src/platform.ts`；`Platform` 字段更正为 `defaultQuality/defaultEngine`）；
  修掉署名矛盾（实况：全仓 87 提交均用 `Co-Authored-By: Codex Opus 4.8`）。`CLAUDE.md` 压成 10 行指针
  （含 `@AGENTS.md`）；**取消 `.gitignore` 对 `AGENTS.md` 的忽略**，使规则可被提交。（2026-10-07）
  - 自审发现：反向 diff 出 24 个旧文档独有标识符，逐一核实 → 13 个确为过时项（`merge-recording-today`
    技能已不存在、`danmuProvider`/`live_poll` 字段已删、`Claude-Session` 废弃），其余全部补入。
- [x] **T-1 能力门控（capability gating）** — worker `capabilities` + 规则 `requires`，reconciler 与任务同步
  按「能力 ⊇ 要求」硬过滤（与 `workers` 取交集，不改冗余语义）；`explainRejections` 给排除理由；
  UI：WorkerDialog 能力标签输入 + WorkersPanel 展示 + HubRuleDialog 门控多选（含「会被排除」预警）。
  新增 `packages/orchestrator/src/capabilities.ts`（+8 测试）、reconciler 3 个门控场景。（2026-10-07）
  - 自审发现①：`gateWorkers` 未按 worker 去重 → 同一 worker 多会话（断流重连）会让 `rejected` 重复，
    警告文案刷 N 遍。已修（按 id 去重）+ 2 用例；修时一度引入 `requires` 为 undefined 时 `filter` 崩，
    随即修正并加回归用例（无要求也要去重）。
  - 自审发现②：`localSuppressedSourceTaskIds` 未走门控（本机可能白跑）→ 记为 `T-10`。
- [x] **T-3 选优补「弹幕完整度」维度** — `scan.ts` 统计 xml 条目数（`danmuCount`，仅表头空 xml=0）；
  `selectWinner(..., requireDanmu)` 在「要烧弹幕」时让有弹幕者优先（`clean` 仍是第一优先级）；
  落库 `sync_candidates.danmuCount` + UI 候选 tooltip 显示。7+3 测试。（2026-10-07）
  - 自审发现①：正则误命中风险 → 实测 `RECORDER_XML_STYLE` 里 `<d `/`<gift `/`<member ` 均 0 命中（`<d`
    无空格的 3 次不会命中带空格正则），真实 1MB xml 数出 13074 条正确。
  - 自审发现②：分段模式（`mergeSegments=false`）是否也受益 → 核对 `segment-pipeline.ts:206` 取的正是
    `winnerMembers` 自己的 xml，选优同点覆盖，无需另改。
- [x] **清理 10 月前台账** — master `douyin-rec-sync.db` 删 7–9 月 30 场（备份 `/tmp/douyin-rec-sync.before-2026-10.db`）。（2026-10-07）
- [x] **清理 VPS1 历史 xml** — 删 1444 个空 xml + 1444 个孤儿 session.json（~4.27MB），保留活跃会话「潘潘不困」。（2026-10-07）
- [x] **hub 上传模板统一** — 12 条 `mode:upload` 规则改为分段不合并 + `{name}_{date}_{HH}-{mm}-{ss}` 等模板（备份 `/tmp/hub-backup-20261007-200148/`）。（2026-10-07）
- [x] **VPS2 部署** — `video-rec-2` 装 worker + tailscale，master→VPS2 同步通。（2026-10-07）
- [x] **Dockerfile SSH 通配化** — `Host 100.97.21.80` → `Host 100.* *.ts.net`，修新 worker 走 `root@` 的 Permission denied。（2026-10-07）
- [x] **Web UI 移动端 nav** — 窄屏第二行显示「录制任务 / Hub / 处理队列」。（2026-10-07）
