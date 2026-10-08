# AGENTS.md — 项目上下文

## 项目概述

抖音/B站直播流录制 + 弹幕捕获 + 后处理（合并/烧录/上传）工具，TypeScript 重写版（原 Python 版已移除）。
提供 CLI 子命令与 Web UI（React）。支持 **master + worker 多节点架构**：master 通过 hub 编排把录制任务
同步下发到选定节点，收播后在 master 侧做合并/烧录/上传。

**技术栈**：Node 24（ESM，`.js` import 后缀）、pnpm workspace（13 个包）、TypeScript、vitest、
commander、esbuild 双产物打包（`dist/douyin-rec.mjs` + `dist/tui.mjs`）、`node:sqlite`（内置）。
录制自研：`record-engine` 提供通用轮询基类 + 可插拔 ffmpeg/mesio 引擎；取流靠 vendored a_bogus 签名
（`packages/douyin-live/src/vendor`）；弹幕 WS 客户端自研（参考 `douyin-danma-listener` 重写，
仅 vendored `webmssdk.js` 签名 + `proto.js` schema，无 pnpm patch）。

## 任务与 TODO 管理（agent 必读）

**`TODO.md`（仓库根）是本仓库 agent 工作的唯一待办台账。** 任何跨会话/多步工作都记在那里，
不要只留在对话里。规则：

- **开始任何任务前先读 `TODO.md`**，确认它是否已在台账里；是则用其编号 `T-N` 指代，不要另起一份。
- **新任务**：在「待办（Next）」加一条，写清 **做什么 + 为什么 + 验收标准**；有正式计划的挂 `plans/NNN_*.md`。
- **开始做**：把 `[ ]` 改成 `[~]`（进行中）。**同时最多 1–2 项进行中。**
- **完成**：`[x]` 并从「进行中/待办」**移到「已完成」**，行尾补完成日期 `（YYYY-MM-DD）`。
- **删除/放弃**：直接删该行；若是被取代，在对应 plan 里写明替代关系。
- **阻塞**：标 `[!]` 并在该行写明**阻塞原因 + 解除条件**；不要用沉默代替。
- **编号 `T-N` 稳定不变**（不复用、不重排）；引用、commit 正文、计划文件都用它指代条目。
- **大计划**：需要多任务拆分时写 `plans/NNN_*.md`（现有约定：checkbox 任务、Goal/Architecture/
  Global Constraints），并**在 `TODO.md` 里挂链接**；plan 与 TODO 双向引用。
- **提交**：`TODO.md` 与 plan 文件按仓库提交规范单独 commit（见「提交规范」），代码变更分开。

当前台账速览（细节以 `TODO.md` 为准）：`T-1` 能力门控、`T-3` 选优补弹幕维度（这两项本轮要做）；
`T-2` 负载分摊（未来，见 `plans/026_worker_load_placement.md`）；`T-4`…`T-9` 见文件。

## 自审循环（agent 必读：写完 ≠ 完成）

**本仓库不接受「凭印象宣布完成」。** 每个任务在标记 `[x]` 前，必须走完一轮
**实现 → 自审 → 修复 → 复审**，以「完美程序员」的标准交付：结论要有证据，边界要有测试。

1. **实现**：按验收标准写代码；改动尽量小、单一插入点；遵循既有分层与约定。
2. **自审（不写代码，先找错）**：通读自己的 diff，主动找真实缺陷，而不是复述做了什么。
   - **边界**：空值/空数组/undefined、单元素、重复项、首次运行、老数据/老配置（向后兼容）。
   - **并发/时序**：重入、竞态、缓存失效、长任务、跨进程/跨节点不一致。
   - **静默失败**：出错路径是否吞异常？是否留下「看起来成功其实没做」的状态？必须不静默。
   - **一致性**：新字段/新分支是否在所有消费点都接上（DTO、API、UI、store、迁移、文档）？
     是否有一处改了、另一处没改（例如判定逻辑在两个地方各写一份）？
   - **正确性对照**：对照既有权威（单一真理源）确认没写错语义，别自造第二套。
   - **分层/风格**：`test/arch/layering.test.ts` 是否仍通过？命名/注释是否与周边一致？
3. **修复**：把自审发现的**每一项**都修掉或显式记为 TODO（`TODO.md`），不允许「知道但不处理」。
4. **复审**：修复后重跑完整验证（见下），并**再读一遍最终 diff** 确认修复没引入新问题。

**验证门（每次改动必过，命令见「常用命令」）**：

- `pnpm test`（全量，不允许「只跑相关文件」就宣布完成）、`pnpm typecheck`。
- 动到前端：`cd packages/web && pnpm build` + `tsc`（web 无 vitest，只能 build + 类型 + 手动核对）。
- 动到运行时产物：`pnpm bundle`，并确认 `dist/douyin-rec.mjs` 已更新。
- **行为变更必须有测试**：新分支/新边界/修 bug → 补或改 vitest 用例（含向后兼容用例）。
- **不凭印象下结论**：涉及线上状态（录制、VPS、限流、文件）的断言，必须用命令实测取数后再写。

**自审产出**：完成后在回复里给出「自审发现 → 修复」的清单（发现了什么、怎么修的、验证命令与结果）。
若无发现，明确写「自审未发现问题」+ 残余风险/未覆盖项。禁止只报「已完成」。

**审计他人/既有代码**：用户要求「审计」「review」时，先列 findings（按严重度 + 文件:行），
再给结论；不要先总结。

## 快速部署

### Docker master（推荐）

```bash
cp .env.example .env   # 改 TZ / PORT / BIND / DATA_ROOT / TS_AUTHKEY / DISCORD_WEBHOOK
```

`.env` 关键项：`TS_AUTHKEY`（Tailscale Reusable auth key，**必填**）、`DATA_ROOT`（默认
`./docker-data`，容器挂载为 `/output-data`）、`BIND`/`PORT`（Web UI 端口）。然后：

```bash
GIT_SHA=$(git rev-parse HEAD) docker compose up -d --build
```

compose 固定跑 `task serve --port 7860 --hub`，即 **master 模式**：自动读取
`<DATA_ROOT>/config/hub.config.json` 编排 worker；Web UI 端口绑在 tailscale sidecar 上
（默认 `0.0.0.0:7860`）。VPS ssh key 挂载自 `./remote/vps.key`（只读）。

### Docker worker（VPS / 额外节点）

worker **不要带 `--hub`**：`node dist/douyin-rec.mjs task serve --port 7860`。数据根
`DOUYIN_REC_ROOT` 指向本机持久目录（同 master 布局），无需 tailscale sidecar。

### 裸跑（本地开发）

```bash
pnpm install && pnpm bundle
node dist/douyin-rec.mjs task serve --port 7860            # 本地 worker / 单机
node dist/douyin-rec.mjs task serve --port 7860 --hub      # 本地 master（自动读 hub.config.json）
pnpm serve:local                                           # 本地开发（port 7861，数据根 ./data-local）
```

### hub 配置

- 全局 worker 列表：`<root>/config/hub.config.json`（模板在 `configs/hub.config.example.json`；
  旧名 `hub-config.json` 仍兼容），字段含 `platform/workerSeq/workers/cookies/stageDir/...`
  `syncIntervalMs`（默认 60s）、`settleMs/pollMs/reconcileIntervalMs` 等。
- 每个房间一条 hub 规则：`<root>/config/hub/{platform}.{roomSlug}.json`，可在 Web UI
  「hub 房间」页维护：绑定 master 上的源 task（`sourceTaskId`）→ 勾选参与的 workers →
  自动把录制任务同步到所选节点，并在收播后执行 merge/burn/upload 管线。

## 仓库布局（pnpm workspace monorepo，`packages/*`）

分层由 `test/arch/layering.test.ts` 守护：依赖只能向下，**新增包必须在该测试 `RANKS` 登记**。
当前 rank：core=0、observability=0.5、post-process/tui/ffmpeg-recorder-extra=0、
record-engine=1、douyin-live/bilibili-live/kuaishou-live=1.5、manager=3、app=4、orchestrator=4.5、cli=5。

```
packages/
├── core/                     # L0 共享契约:types(Recorder/DanmuSource/RecorderEvents/DanmuMessage)
│                             #   + config(AppConfig/DEFAULT_CONFIG) + providers(recorder/danmu 注册表)
│                             #   + platform(Platform 接口 + 注册表) + notify + api-types
├── observability/            # L0.5 logs + notification 实现(端口在 core;app/cli 依赖,manager/orchestrator 不依赖)
├── post-process/             # L0 后处理(纯函数):concat 多会话拼接 / burn 烧字幕 / ass / merge / ffmpeg spawn / fonts
├── ffmpeg-recorder-extra/    # L0 附加插件:logStreamMeta(流信息) + detectDevice(ffprobe encoder)
├── tui/                      # L0 Ink TUI(独立打包 dist/tui.mjs)
├── record-engine/            # L1 通用 PollingRecorder(平台无关 + 引擎无关)+ 引擎策略 DownloadEngine:
│                             #   ffmpegEngine(-c copy → .ts)/ mesioEngine(rust-srec --fix -d → .flv)
├── douyin-live/              # L1.5 抖音平台核心:vendored a_bogus 签名 + getStream/getInfo/resolveShortURL
│                             #   + extractRoomSlug/roomToUrl/resolveDouyinLiveId + douyinPlatform
│                             #   + 自研弹幕 WS client(connectDanmu,参考 douyin-danma-listener 重写)
├── bilibili-live/            # L1.5 B站平台核心(实现 Platform 契约 + connectDanmu)
├── kuaishou-live/            # L1.5 快手平台核心(取流=直播页 __INITIAL_STATE__ 解析;无弹幕)
├── manager/                  # L3 RecordingSession:会话编排(重连指数退避 / drain 排空 / 弹幕落盘 / 会话级 xml)
├── app/                      # L4 有状态层:db(node:sqlite+迁移) / store(TaskStore) / worker-store / hub-store
│                             #   / hub-jobs / task-manager(子进程生命周期) / daemon(定时启停) / scheduler
│                             #   / process / login(扫码) / web(server+api+static) / events / anchor / notify / upload
├── orchestrator/             # L4.5 hub 编排:startHub + Reconciler + SyncLedger + pipeline/workflow
│                             #   + LocalTransport / SshTransport
├── cli/                      # L5 入口:cli.ts(record/merge/burn/probe + task 命令组 + --hub 隐藏命令)
└── web/                      # 前端(独立 Vite:React19 + react-router 7 + jotai + @base-ui/react + Tailwind v4
                              #   + lucide + sonner + Geist)→ packages/web/dist,由 app/web/server 托管
test/                         # vitest(镜像 packages;arch/layering.test.ts 守护分层;setup.ts 注册假平台,
│                             #   因 vitest 不能 import 部分平台包)
configs/                      # hub.config.example.json(hub 配置模板,启动时复制到数据根)
patches/                      # 空(无 pnpm patch;取流签名/弹幕 WS 均已 vendored 进各自包源码)
bin/                          # mesio / biliup 二进制(install-*.sh 下载,不提交)
docs/ plans/                  # 设计文档 / 实现计划 NNN_*.md
remote/                       # ⚠️历史留存:VPS 旧 Python merge 管线 + deploy/setup_vps(当前 VPS 走 TS CLI + hub)
tools/ scripts/rename assets/fonts   # 保留:合并辅助 / 重命名 / 烧字幕字体
```

> 平台抽象（唯一真理 = `packages/core/src/platform.ts` 的 `Platform` 接口）：
> `matchUrl`/`urlPattern`/`roomToUrl`/`extractRoomSlug`/`resolveShortUrl?`/`fetchAnchorName`/
> **`getStream`/`getLiving`/`connectDanmu?`/`probe?`** + `defaultQuality`/`defaultEngine`/`qualities`/`engines`
> 收口平台专属逻辑。**平台专属的一切都在 `<平台>-live` 里**：取流（`getStream` 返
> `PlatformStream{living,url?,headers?,owner?,title?,raw?,throttledReason?}`）+ 弹幕
> （`connectDanmu` 返未 start 的 `DanmuSource`，无能力返 null）。抖音/B站完整实装（含弹幕），
> 快手实装取流（无弹幕）。**录制下载是平台无关的 `record-engine`**（`PollingRecorder` + 引擎策略）。
> `Task.platform` 区分平台、`Task.engine`="ffmpeg"/"mesio"。**接新平台 = 写一个 `<平台>-live`
> 实现 Platform + `registerPlatform` 一行**（引擎白嫖）；加新引擎 = `record-engine` 加策略 + `registerEngine`。
> engine/quality 校验唯一真理 = `platform.{engines,qualities}`。

## 关键设计

### 录制引擎（record-engine，自研）
- `PollingRecorder`（平台无关 + 引擎无关）：每 30s 轮询开播 → living 才 spawn → 进程退出查权威
  `getInfo().living` 判别下播/断流 → onOffline；卡死看门狗（ffmpeg `time=` 进度 / mesio 文件增长
  喂 markProgress，停滞超 60s 杀进程重连）；`stop()`=SIGINT+8s SIGKILL，`drain()`=停开播轮询不腰斩当前。
- `ffmpegEngine`（默认，`-c copy` 匿名取流，video-only）与 `mesioEngine`（rust-srec，输出 `.flv`，
  自带 FLV/HLS 修复 + 分段）可插拔。ffmpeg 引擎解析 stderr：`Opening '…ts' for writing` → 上报新分段、
  `time=HH:MM:SS.xx` → `markProgress`（喂卡死看门狗）。
- 弹幕（独立 provider）：`connectDanmu` 在平台 core 内实现，经 `resolveLiveId`→`resolveDouyinLiveId`
  拿本场 liveId 连 WS，`XmlDanmuWriter` 写 biliLive 格式 `.xml`。

### 录制会话（RecordingSession，@drec/manager）
- 弹幕归属：录制器 video-only → 总是用独立 DanmuSource + XmlDanmuWriter 落盘。
- **弹幕在 `onLive` 才启动**（不是会话开始）：`danmuStarted` 守卫每个 `_startInner` 只连一次。**根因**：
  开播前连弹幕会解析到陈旧 liveId → WS 连上却整场 0 条（定时窗口起的任务尤甚）。recorder 确认开播
  才 fire onLive → 此刻解析 liveId 必为当场。fire-and-forget，不阻塞录制。
- **弹幕健康监控**：`DanmuSource.start(…, onAlert?)`，`ListenerDanmuSource` 三种告警
  ① liveId 解析失败 ② WS error ③ 连上 3 分钟仍 0 条（陈旧 liveId/风控的静默失败信号）→
  session `notify({kind:"error",stage:"弹幕"})` → webhook + `@@DREC_ALERT@@` + UI。
  与视频卡死看门狗对等，弹幕静默失败当场报警。
- 断流重连：`onOffline → _handleOffline`，指数退避（`reconnectDelaySec * 2^fails` 封顶 300s）后重连。
  重连前先 stop 弹幕、新场重新拿 liveId；客户端重连熔断见 `client.ts`（存活满 `STABLE_CONNECTION_MS`
  才清零计数、上限 5 次、耗尽发 `exhausted`，防无限重连刷风控）。
- 会话级 xml：同会话所有分段共享 `{base}.xml`（剥 `-PART###`/`_###` 后缀；容器 `.ts`/`.flv` 均认）。

### 窗口结束「优雅排空」(drain) — 见 plans/022
- 定时窗口结束**不腰斩**正在进行的直播：`recorder.drain()` 停开播轮询（不再录下一场），当前录制录到自然收播再停。
- 收播判定双信号：`recorder.isLive()`（`getInfo().living` 权威 API，连续 2 次 false）**或** `RecordStop` 事件。
- 信号区分：**SIGUSR2**=排空（daemon 窗口结束发），**SIGTERM**=硬停（手动「停止」/重启）。drain 无 SIGKILL 超时。
- 状态 `draining`（UI badge「⏳ 超窗录制中」）；P0 超长直播跨入新窗口 → 老录制优先 + 告警，收播后自动接管。

### 任务系统（app 层，子进程模型）
- `TaskManager` 持有 `Map<taskId, RecorderProcess>`，每任务 = 一个 `node dist/douyin-rec.mjs record ...` 子进程。
- `TaskDaemon` 每 60s tick，按 `scheduler.inWindow`（本地时区，跨夜）决定 start / stopGraceful。
  **时区由 config 决定，不看 host/容器的 `TZ` env**：`task serve` 启动时 `applyTimezone()`
  （`packages/app/src/timezone.ts`）读 `settings.timezone`（未设 → 默认 `Asia/Shanghai`）并**覆盖**
  `process.env.TZ`，启动日志打一行 `[tz] 时区 = ...` 可查；`GET/POST /api/timezone` 可查/改，改了立即生效
  （daemon 下一次 tick 就用新时区，不用重启）。踩过的坑：host 层 `TZ` 难从进程外内省
  （`ssh vps date` 是 ssh 会话自己的环境，不是服务进程的，得挖 `/proc/<pid>/environ`）—— 这条彻底绕开。
- 状态恢复、崩溃自动重启、每任务日志环形缓冲（web 实时 tail）。

### hub 多节点编排（orchestrator + app 的 hub-store/task-sync）
- **角色与节点分配**：Docker `task serve --hub` 同时是控制台/master 和一个可选的 `local` 录制 worker；
  VPS 跑普通 `task serve`（不带 `--hub`）。Web「Hub」页把规则绑定到任务并选择每个房间的 `workers`；
  任务页的 enabled/启动状态表达录制意图并同步给选中节点。只选 VPS 时本机 daemon 抑制源任务的录制进程
  （`localSuppressedSourceTaskIds`）；选 `local` + VPS 才会双录。远端受管任务只读，所有任务与节点分配
  通过 master 控制台操作。
- **数据流**：选中的节点各自录制；master 主动读清单（local scan / SSH `_inventory`），按房间聚类并选优，
  再把胜出录像经 rsync 拉到 master 的 stage 执行 merge/burn/upload。master 本机 `recordEnd` 可即时触发
  对账；远端收播事件不直接转发，远端独录由周期 `reconcileAll` 扫描发现。
- 全局配置 `hub.config.json` 定义 `workers` 列表；每个房间一条规则存
  `<root>/config/hub/{platform}.{roomSlug}.json`（字段：`room/enabled/pipeline/sourceTaskId/workers`，
  sourceTaskId 非空 → hub 把该 task 同步到勾选的 worker 节点）。
- **身份/聚类**：录制端写 `{base}.session.json`（roomSlug=web_rid + platform + gaps）。`identity`
  按 **(platform, roomSlug)** 聚成一场（streamKey=`{platform}:{roomSlug}:{date}`）→ douyin/bilibili
  同房间号不撞、跨节点一致（不靠主播名）。
- **选优**（`select.ts`）：覆盖度优先（coverage=1−gap/span）→ **完整录全（单会话无断流）优先**，
  多个完整取最长；**所有节点都断流（没人录全）→ 中断 + 通知 + 绝不删源**（留人工）。
  要烧弹幕时另加「有弹幕优先」（见 `selectWinner` 的 `requireDanmu`）。
- **pipeline**（`pipeline.ts`，复用 post-process + biliup）：选优 winner → pull 到 stage → merge plain →
  burn danmu/livechat → **穿插上传**（merge 完即后台 fire P1 上传、与烧录并行，await BV 后串行 append；
  append 也带关水印 + 仅自己可见，防重置）。
- **配置 = 文件**（文件是唯一真理源，现读不缓存 → UI ↔ 手改文件天然同步）：全局
  `<root>/config/hub.config.json`（workers，旧名 tenants 兼容；stageDir/时序 + uploadDefaults）+
  每房间 `<root>/config/hub/{platform}.{roomSlug}.json`（`{room,enabled,pipeline:{steps,upload,cleanup},
  workers,requires}`）。`upload.mode`=stage（只合成）| upload（传）；`private` 布尔（默认仅自己可见）。
  **hub 规则不在 DB**（hub-store 文件版 CRUD）；日常从 Web Hub 页维护规则、从任务页维护任务/启停。
- **SyncLedger**（`<db>-sync.db`）幂等台账：sync_jobs（状态机 pending→syncing→merging→uploading→
  done/needs_manual/failed）+ sync_candidates（选优明细，含 `danmuCount`）。reconciler：本机 `recordEnd`
  可即时触发 + 周期 `reconcileAll`（默认 30min；远端收播由扫描发现；in-flight 守卫 + settle 等收播，
  仍在录的场跳过）。`SyncLedger` 记录步骤时间线/ETA（Web「hub 任务」页展示）。
- **硬标准代码常量**（`biliup.ts`，不可配、绝不漏）：关水印 `--extra-fields watermark.state=0`、
  copyright=1、`--is-only-self`（private 时）。可配的只有 tag/tid/desc（主播专属，写任务文件）。
- 受管任务同步：`managedBy='hub'` 的远端任务**只读**（Web/API 禁止编辑删除）；local worker
  `adopt=false` 时源任务保持可编辑；per-node override（cookies/useCookie/outDir/webhook）保留；
  两阶段删除；身份按 `(platform, roomSlug)`。
- **状态回传**：master 每 5s 经 Transport 查所选 worker 的活动录制房间（SSH `_recording-status`，
  旧 bundle 回退 `_tasks` + `_is-done`），缓存后随 `GET /api/tasks` 的 `recordingWorkers` 返回；
  只探测被绑定规则选中的 worker（`recordingStatusWorkerIds`）。
- 同步触发：启动即跑 + 周期 `syncIntervalMs`（默认 60s）+ 变更即触发。远端隐藏命令
  `_tasks <dataRoot>` / `_apply-tasks <dataRoot> <base64>`（输出不含 cookies）。
  详见 `docs/multi-node-sync.md` + `docs/multi-node-sync-followups.md`（实测记录 + followup）。

### Cookie 模型
- **平台 cookie**：`settings.platformCookies` 按平台独立保存；`defaultCookies` 作为抖音兼容键。
- **每任务开关** `useCookie`：true → 用本平台 cookie；false → 匿名连接。
  `resolveTaskCookies(task, global)` 统一解析；hub 受管任务可在 worker 上单独 override。
- **录制取流 Cookie 按平台解析**：`resolveTaskStreamCookies` 优先任务覆盖 /
  `settings.platformCookies[platform]`；B 站无显式配置时复用 biliup `cookies.json`。
- cookie 过期时间从 `sid_guard` 解析（`parseCookieExpiry`），UI 顶栏/弹窗显示剩余天数。

### Web UI（React）
- `web/`：Vite + React 19 + react-router 7 + jotai（tasksAtom/cookieStatusAtom/toastsAtom）+
  @base-ui/react + Tailwind v4 + lucide + sonner，字体 **Geist**（`@fontsource/geist`）。
- `app/web/server.ts`：http server + REST api + SPA fallback，托管 `web/dist`。
- 页面：任务列表/详情/日志（SSE）、处理队列、hub 房间、hub 任务（时间线 + ETA）。
  任务列表页 + 任务详情/日志页（状态、录制时长、SSE 日志）+ Hub 页（master 才显示；worker 显示
  child node 提示）。
- **处理队列**（`/queue`，仅 master）：跨房间一屏显示「做了什么 / 正在做什么 / 下面做什么」。
  `GET /api/hub/queue` 聚合进行中 job(`buildQueueView`)+ 资源池快照；`ResourcePool.snapshot()`
  暴露 cpu/net/upload 占用与 `waiting`（正在等锁的场）→ 队列页区分「执行中」与「排队等锁(第 N 位)」，
  解决「状态=merging 但其实在等 CPU 闸门、UI 却显示已运行 X 分钟」的失真。DAG 拓扑在
  `core/src/hub-flow.ts`（`HUB_FLOW_ORDER`/`readyNodes`），后端推导 `nextSteps`，前端只渲染。

## 常用命令

```bash
pnpm install                  # 装依赖
pnpm typecheck                # tsc --noEmit
pnpm test                     # vitest run
pnpm bundle                   # esbuild 打包 → dist/douyin-rec.mjs
pnpm dev -- record --room URL # tsx 直跑（注意录制必须 node dist，不能 tsx）
pnpm serve:local              # 本地 Web UI（port 7861，数据根 ./data-local，无 --hub）
cd packages/web && pnpm build # 构建前端 → packages/web/dist（独立 Vite 工程,自带 lockfile）

# 运行
node dist/douyin-rec.mjs record --room URL --segment 1800   # 单次录制
node dist/douyin-rec.mjs task serve --port 7860             # Web UI / worker（端口 7860）
node dist/douyin-rec.mjs task serve --port 7860 --hub       # master（hub 编排 + 后处理管线）
node dist/douyin-rec.mjs task add URL                       # CLI 加任务
node dist/douyin-rec.mjs _tasks <dataRoot>                  # 远端任务清单（隐藏命令,无 cookies）
node dist/douyin-rec.mjs _apply-tasks <dataRoot> <base64>   # 远端应用 master 期望任务（隐藏命令）
```

⚠️ **库 interop**：录制必须跑打包后的 `node dist/douyin-rec.mjs`，不能 `tsx`/直 import
（douyin-live 的 vendored 签名 / sm-crypto / protobufjs ESM 坑；esbuild 把 cli 打成
`dist/douyin-rec.mjs` + `dist/tui.mjs`）。vitest 无法 import 这些包 → 平台实例**零单测**，
靠 store/hub/orchestrator 测 + `test/setup.ts` 注册假平台 + 真实录制覆盖。

📁 **数据目录**：db / recordings / stage / config（含 hub 规则、biliup cookies）全收在**一个数据根**
`DOUYIN_REC_ROOT` 下（见 `packages/app/src/paths.ts`），不散落项目里。**未设时默认 `./output-data`**
（裸跑不再把文件平铺进 cwd）。本仓库约定：`pnpm serve:local` 用 `DOUYIN_REC_ROOT=./data-local`；
docker 固定 `/output-data`（映射宿主机 `docker-data/`）。专用 env（`DOUYIN_REC_DB`/`DOUYIN_REC_OUTPUT`/
`BILIUP_COOKIE`）可单独覆盖某一项。

## B站上传规则（biliup）

**永远用 `upload-recording-today` skill 上传，不要手搓 biliup 命令。** skill 脚本
（`~/Developer/skills/upload-recording-today/scripts/upload-recording-today`）是设置的**唯一权威**——
里面写死了正确的 tag / 简介 / 关水印 / 仅自己可见。手搓极易漏 `--desc`、用错 `--tag`、漏关水印（踩过坑）。

- **一稿三分P**：plain + danmu + livechat 作为同一稿件三个分 P，顺序 **P1=plain → P2=danmu → P3=livechat**。
  skill 用**单次多文件 `upload a b c`**（不是 append；多文件 upload 是正常的，历史 06-11 等都这么传成功）。
- **关水印是硬性**：skill 默认带 `--extra-fields '{"watermark":{"state":0}}'` 关昵称水印。
  **水印在投稿后无法修改**（用户确认）→ 必须上传时就关，漏了只能删稿重传。
- **可见性默认「仅自己可见」**（`--is-only-self 1`）；用户明确要公开才传 `--public`。
  tid 21、copyright 1、title `{name}_{date}`。tag/简介是主播专属，**以 skill 脚本里的值为准**。
- **本地胜出时**（`docker-data/output/{主播名}/`）：skill 只扫 `remote/recordings/{主播名}/`，
  故把本地三文件 **symlink** 进临时 root（`/tmp/upload_stage/remote/recordings/{主播名}/`）再
  `--repo /tmp/upload_stage --cookies <repo>/cookies.json` 跑 skill。biliup 跟随 symlink 读真实大小
  （skill 显示 0.00GB 是 stat 符号链接的 cosmetic 假象，不影响）。
- **上传日志「正常态」**：biliup 在 `pre_upload` 后**日志静默数分钟**（分块进度走 stderr 进度条不写日志）、
  `ps` 也可能看不到——**这是正常上传中，不是死了，别杀**。靠后台完成通知判断。
- **auth**：`cookies.json`（仓库根 / `~/.config/biliup/` / `~/`，biliup CLI auth，**别删别提交**）。
- **删稿**：`biliup` 无删稿命令；B站删稿 API（`POST member.bilibili.com/x/web/archive/delete`，aid+csrf）
  **已加人机验证**（`340022 验证码错误`），headless 删不了 → **让用户在创作中心手动删**。
  重传前先删旧稿（B站不支持改稿件视频内容）。

## 硬性约束

- **部署安全 guard（长期规则,除非用户明确 override)：任何重新部署(本地 docker / VPS worker)前,
  必须先确认没有正在录制的任务;有则等待。**
  - 判定依据:`GET /api/tasks` 里 `recording === true`(真正在录)。`running: true` 只表示任务已启用/在等开播,
    不代表正在录 —— 等开播的状态下重启是安全的;`recording: true` 才是不能打断的。
  - 部署前查**两个节点**(任一在录就等):
    - 本地:`curl -s http://127.0.0.1:7860/api/tasks`
    - VPS:`ssh ubuntu@100.97.21.80 'curl -s http://127.0.0.1:7860/api/tasks'`
  - 有录制 → **不要重启**;等录制结束(可周期性轮询)或先告诉用户什么时候可以部署。
  - 只有用户**明确要求**(如"强制部署""现在就部署""override")才可无视此 guard。
  - 原因:重启会杀掉录制子进程 → 当前分段被截断,可能丢流且 hub 侧留下不完整产物。
- **`.xml` / `.ass` 的保护口径 = 「不得删掉最后一份」**（不可再生），不是「任何位置都永不删」：
  - **源录像目录**（`recordings/`，唯一弹幕源）默认禁删 —— hook 会拦。
  - **stage 目录内**（副本/成品）可删；清理逻辑按 `xmlKeepRule`：保留 stage → 删节点源 .xml（副本在 stage）；
    清空 stage（`stageAfterDone`）→ 保留节点源 .xml、删 stage 的 .xml/.ass。**两处永不同时删光**。
  - 视频（`.ts`/`.mp4`/`.flv`）总删。
  - hook（`.Codex/hooks/block_xml_ass_delete.py`）已按此口径放宽：只动 `stage/` 的删除放行，触及 `recordings/` 仍拦。
- **不要破坏 VPS 生产录制**：VPS 只读检查，不杀进程/不删文件。
- 测试录制只用 VPS，本地仅验证 TS（本地 macOS 有 rc-11 fork 污染）。
- `cookies.json`（biliup B站上传 auth）、`config.yaml`、`douyin-rec.db`、`.env` 已 gitignore，勿提交。

## 版本规则（package.json `version`）

每完成一个 `feat` 或 `fix`（不含纯 `docs`/`test`/`chore`），必须在代码 commit **之前** 将
根目录 `package.json` 的 `version` 字段 patch +1（`0.0.X` → `0.0.X+1`），并重新执行 `pnpm bundle`
使 `dist/douyin-rec.mjs` 内嵌的 `APP_VERSION` 同步更新。version bump 与代码变更合入**同一个 commit**
（用 `chore: bump version` 作为附加说明写进同一 commit，或作为独立紧随其后的 chore commit 均可）。
部署时用 bundle 产物（`dist/douyin-rec.mjs`）校验版本是否已更新再发。

## 提交规范（约定式提交 / Conventional Commits）

- **格式**：`<type>(<scope>): <简短中文描述>`，正文用 bullet points 展开细节（为什么 + 改了什么）。
  - 常用 `type`：`feat`（新功能）、`fix`（修 bug）、`chore`（杂务/配置）、`docs`（文档）、`refactor`、`test`。
  - `scope` 用模块名：`danmu` / `recorder` / `task` / `hub` / `post` / `web` 等（可多个：`fix(danmu,recorder): …`）。
  - 例：`fix(recorder): 预建主播子目录，消除「开播首段 ffmpeg 失败一次」`、`feat(hub): 受管任务按房间同步到选中 workers`。
- **不要用** 旧的 `v0.0.X: 描述` 格式（已废弃，与现有 git 历史不一致）。
- 计划文件 `plans/NNN_*.md` 单独 commit，代码变更单独 commit。
- commit 正文末尾附：`Co-Authored-By: Kiro <noreply@kiro.dev>`。
- 只 `git add` 本次相关文件，别带上无关的未跟踪文件；仅在用户要求时才 commit/push。

## 保留的 Python 部分

`remote/` 是 VPS 旧 Python merge 管线历史留存（`merge.py` + `deploy.sh` + `setup_vps.sh` 等），
本地保留仅供排查/迁移参考。**当前 VPS 部署/合并/上传已走 TS CLI + hub 管线**：VPS worker 跑普通
`task serve`（无 `--hub`），merge/burn/upload 由 master 侧 orchestrator 自动执行；`remote/merge*` 可清理。
