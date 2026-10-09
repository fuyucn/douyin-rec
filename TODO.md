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
  `updateTask` 变更即同步、`anchorName` 比对、web 移动端 nav、T-1 能力门控、T-3 弹幕选优。
  **验收**：重建 docker master + 更新 VPS worker 后，`pnpm test` / `typecheck` 全绿且线上生效。
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

- [ ] **T-18 节点侧上传（experimental:不烧录房间跳过 rsync 回传）** — 计划 `plans/027_node_side_upload.md`。
  **做什么**：hub 规则加 `pipeline.steps.nodeSideUpload`（缺省 false）。为 true 且**该房间不烧录**时，
  winner 节点本地 remux → 节点 biliup 直接上传，master 只收 BV 号，**省掉整场录像 rsync 回传**。
  需要烧录的房间开关无效（burn 要 11 核 + 中文字体，节点烧不动，实测 vps2 仅 0.38x 实时）。
  **为什么**：实测 pull(rsync) 165s~4198s 是主要耗时，而 9/16 房间不烧录（merge 只是 `-c copy` 纯 I/O）。
  **验收**：见 plan 的验收清单（flag off 零回归 / flag on 不烧录实测无 pull 步 / 缺能力回落不静默）。
  **前置**：需新增 `_node-pipeline` + `_node-capabilities` 隐藏子命令、Transport 可选方法、
  pipeline 分支、节点侧 biliup（install-worker.sh 加 `--with-upload`）。
- [ ] **T-19 worker 安装脚本补 rsync 硬依赖** — 已改 `scripts/install-worker.sh`：rsync 改为
  **两种角色都 fail**（原先仅 master warn）。**背景**：2026-10-08 vps2 缺 rsync → 每场 pull `rc=12`
  → 后处理全卡 needs_manual，排查成本极高（错误只报退出码，无 stderr）。
  **待办**：① 合并 T-5 部署后**重建/重装 VPS** 验证脚本；② `transport-ssh.ts` 把 rsync stderr 尾部
  带进错误消息（现在只 `rsync rc=12`）。
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
- [ ] **T-20 直播间标题未采集 → 稿件 `{title}` 渲染为空**（bug） — **现象**：hub 稿件标题/文件名里
  用 `{title}` 占位符时渲染为空（拿不到主播当场设的直播标题）。**根因（已定位，2026-10-08 实测）**：
  1. 录制侧从不传 title：`packages/app/src/cli-task.ts:859` 是 `session.start(url, opts, { anchorName: t.name ?? "" })`
     —— `StreamInfo.title` 字段没传（`packages/core/src/types.ts:19` 有该字段，但调用点漏了）。
     `packages/cli/src/cli.ts:224` 同样只传 `{ anchorName: "" }`。
  2. `RecordingSession.start()` 用 `info.title` 设 `liveTitle`（`packages/manager/src/index.ts:119`），
     只有非空才写进 session.json（`:326`）；`onLive` 回调（`:141`）**也不更新 liveTitle**
     —— 即使 recorder 侧 `ev.onLive({ title })` 带了 title（`record-engine/src/index.ts:251` 确实带了），
     manager 也没接收。
  3. 结果：`<recordings>/*.session.json` 里**永远没有 `title` 字段**（实测 vps2 全部 session.json 无 title）。
  4. 下游 `scan.ts:42` 读 `d.title` → `NodeRecording.title` → pipeline 的 `titleCtx.liveTitle`
     （`pipeline.ts:389`）→ `{title}` 渲染为空。
  **修复方向**：① `cli-task.ts` / `cli.ts` 的 `session.start` 传入真实 title（需从平台取：抖音
  `getStream().title` 已有，或在开播后经 `getInfo()` 补）；② `manager.onLive` 里用 `i.title` 更新
  `liveTitle`（覆盖「开播时才知道标题」的时序）；③ 补 vitest：session.json 含 title、`{title}` 渲染非空。
  **验收**：新录一场后 session.json 有 `title`，hub 稿件标题 `{title}` 正确渲染出主播直播标题。
- [ ] **T-16 节点「主动加入」+ ticket 机制**（架构级，暂不做） — 现状：master 主动 SSH 拨 worker，
  加节点要手填 host/dataRoot（id 现由 T-15 改为节点自报）。**要做的是 biliup Fleet 那套**：worker 侧
  `task join <ticket>` + master 签发一次性票据（+ 节点私钥）+ 节点主动连 master（可穿 NAT）+ ticket
  校验/撤销。**为什么暂不做**：需引入 master↔worker 常连控制通道（新协议 + 新状态），架构级改动；
  当前 tailscale 组网下 SSH 方案可用。**触发条件**：① 要频繁加节点；② worker 在 NAT 后 SSH 不可达；
  ③ 需要在线态/心跳实时性。**参考**：biliup Fleet（控制面/节点/relay,ticket 加入,私钥鉴权）。

- [ ] **T-10 本机抑制也要走能力门控** — `localSuppressedSourceTaskIds`（`packages/app/src/hub-store.ts`）只看
  `workers` 勾选，不看 `requires`。若某规则 `workers` 不含 local 但 local 也不满足 `requires`，本机仍会实跑
  该源任务（白轮询、可能触发风控）。**验收**：本机抑制与 reconciler 用同一套「能力 ⊇ 要求」判定；
  注意与「幽灵 worker id」的兜底（不抑制 → 防静默漏录）保持一致。
- [ ] **T-6 docker tailscale 版本升级** — sidecar `1.98.4`（落后 5 个月），其他节点 `1.104.1`。
  `docker compose up -d --build` 不会拉新镜像，需 `docker compose pull && docker compose up -d --build`。
- [ ] **T-7 清理 VPS1 exit node 残留** — VPS1 曾 `advertise-routes 0.0.0.0/0`，健康检查报
  `IP forwarding is disabled`；Mac 侧已恢复家宽。**验收**：撤销 VPS1 的 advertise（`--advertise-exit-node=false`）。
- [ ] **T-8 轮换/清理 tailscale auth key** — 用户先后贴过两个 key，`kbnba6Qh4…`（带 tag）已弃用，
  `k6mrGoiS…` 在用。**验收**：旧 key 在 tailscale 后台撤销。
- [ ] **T-9 VPS2 弹幕 0 条深挖** — 干净 IP 仍 0 条，非纯 IP 因素（docker 同代码同 cookie 有 9109B/25 消息，
  VPS 首帧 286B/0 消息/`needAck=false`）。**验收**：定位 wss 层被拦的判定条件。

## 未来 / Backlog

- [ ] **T-2 负载分摊（placement / 按负载自动选点）** — 计划：`plans/026_worker_load_placement.md`。
  **注意**：与现有「多节点冗余录制 + coverage 选优」模型**二选一**（分摊=每房间派 1 台），
  属模型取舍，不是可顺手加的功能。**为什么**：冗余模型把轮询量乘了 N，是 VPS 被限流的根因之一。

## 已完成

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
