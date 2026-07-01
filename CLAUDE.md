# CLAUDE.md — 项目上下文

## 项目概述

抖音直播流录制 + 弹幕捕获 + 后处理（合并/烧录/上传）工具，TypeScript 重写版（原 Python 版已移除）。
提供 CLI 子命令与 Web UI（React）。生产录制在 VPS，本地用于开发验证。

**技术栈**：Node 24（ESM，`.js` import 后缀）、pnpm workspace（11 包）、TypeScript、vitest、commander、esbuild 双产物打包（`dist/douyin-rec.mjs` + `dist/tui.mjs`）、`node:sqlite`（内置）。录制自研：取流靠 vendored a_bogus 签名（`packages/douyin-live/src/vendor`，源自 `@bililive-tools/douyin-recorder`），ffmpeg/mesio 引擎落盘；弹幕用**我们自己的 TS 客户端 `packages/douyin-live/src/danmaku/client.ts`**（参考 `douyin-danma-listener` 重写、非复制;签名 `webmssdk.js`(a_bogus) + schema `proto.js` 仍 vendored,经 `Platform.connectDanmu` 暴露,无 pnpm patch）。

## 仓库布局（pnpm workspace monorepo，`packages/*`）

分层(`test/arch/layering.test.ts` 守护依赖只能向下;新增包须在该测试 RANKS 登记)。架构=**2 个可插拔接缝**:
**平台轴**(各 `<平台>-live`,平台专属:取流 + 弹幕)+ **引擎轴**(`record-engine`,平台无关下载)。其余全通用。
另有**多节点编排层**(`orchestrator`,master/slave 跨节点选优合并上传,见「多节点 hub」)。
esbuild 把 cli 打包成 `dist/douyin-rec.mjs`(+ `dist/tui.mjs`),录制必须跑这个打包产物(sm-crypto interop)。
当前 **12 包**(架构图见 `docs/architecture.html`;多节点设计见 `docs/multi-node-sync.md`)。

```
packages/
├── core/                  # L0 契约 + 注册表:Platform 接口 + DownloadEngine 接口 + 注册表
│                          #   (registerPlatform/platformForRoom · registerEngine/getEngine) + types/config/notify/api-types
├── post-process/          # L0 后处理纯函数:concat 多会话拼接 / burn 烧字幕 / ass(rolling·livechat·multi·emoji·render) / merge / ffmpeg / fonts
├── ffmpeg-recorder-extra/ # L0 附加:logStreamMeta(流信息) + detectDevice(ffprobe encoder)
├── tui/                   # L0 Ink TUI(独立打包 dist/tui.mjs)
├── record-engine/         # L1 【引擎轴·平台无关】通用 PollingRecorder(开播轮询/onLive/断流/drain/isLive/卡死看门狗)
│                          #   + 下载引擎策略 ffmpeg(.ts)/ mesio(.flv);取流经 platformForRoom→platform.getStream(url+headers)
├── douyin-live/           # L1.5 【平台轴】douyinPlatform:getStream/getLiving/connectDanmu(抖音 WS)/fetchAnchorName/probe
│                          #   src/{stream(vendored a_bogus 取流)+ danmaku(vendored WS 弹幕)} + probe + resolveDouyinLiveId
├── bilibili-live/         # L1.5 【平台轴】bilibiliPlatform:getStream(getRoomPlayInfo,headers 带 referer)/getLiving;
│                          #   connectDanmu 实装(WBI 签名 + B站二进制 WS 协议,见 src/danmaku)
├── manager/               # L3 RecordingSession:会话编排(onLive 经 platform.connectDanmu 连弹幕 / 重连指数退避 / drain / 会话级 xml)
│                          #   + danmu-xml/(XmlDanmuWriter + RecorderXmlStyle 弹幕 XML 写入) + {base}.session.json sidecar(身份 roomSlug/platform + 缺口 gaps,供 hub 聚类/选优)
├── orchestrator/          # L4.5 【多节点 hub】Transport 轴(local/ssh/tailscale-ssh)+ identity(按 platform,roomSlug 聚类)
│                          #   + select(覆盖度选优,完整录全优先)+ reconciler(recordEnd 触发 + 周期对账)+ pipeline(选优→pull→merge→burn→穿插上传)+ SyncLedger
├── app/                   # L4 有状态层:db(node:sqlite+迁移) / store(房间归一化+平台校验) / hub-store(文件版 hub 规则) / task-manager / daemon(定时) /
│                          #   scheduler / process(record-args) / login(扫码) / web(server+api) / events / anchor / notify / upload
├── cli/                   # L5 入口:cli.ts(record/merge/burn/probe + task)+ providers-register(注册平台 douyin/bilibili + 引擎 ffmpeg/mesio)
└── web/                   # 前端(独立 Vite:React19 + jotai + @base-ui/react + Tailwind v4 + lucide + react-i18next)→ packages/web/dist
test/                         # vitest:纯包单测**就近** packages/**/*.test.ts(挨着源码,如 engines/mesio.test.ts);
│                             #   集成/元测试仍在 test/(app/session/daemon… + arch/layering.test.ts 守护分层 +
│                             #   setup.ts 注册假平台,因 vitest 不能 import douyin-live 的 sm-crypto)
patches/                      # 空(无 pnpm patch；取流签名/弹幕 WS 均已 vendored 进各自包源码)
bin/                          # mesio / biliup 二进制(install-*.sh 下载,不提交)
docs/                         # 设计文档:app/cli/docker.md · architecture.html/.md(架构图)· multi-node-sync(.md/-followups.md 多节点 hub)· 取流防踢调研
scripts/ assets/fonts         # install-mesio/biliup · rename(重命名)· 烧字幕字体
remote/                       # 已移出仓库(.gitignore;含 VPS IP/SSH 个人信息,本地保留供 VPS 工作流);
                              #   旧 Python merge 管线依赖已删的 src/ → 本地已不可跑,合并改走 TS CLI(见下)
```

> 平台抽象:`Platform` 接口(matchUrl/urlPattern/roomToUrl/extractRoomSlug/
> resolveShortUrl/fetchAnchorName/**getStream/getLiving/connectDanmu**/probe? + default{Engine,Quality} +
> engines/qualities)收口平台专属逻辑。**平台专属的一切都在 `<平台>-live` 里**:取流(`getStream` 返 `PlatformStream
> {living,url?,headers?,owner?,title?}`)+ 弹幕(`connectDanmu` 返未 start 的 `DanmuSource`,无能力返 null)。
> 抖音 + bilibili **均完整实装**(取流 + 弹幕;bilibili 弹幕走 WBI 签名 + 二进制 WS 协议)。**录制下载是平台无关的
> `record-engine`**:通用 `PollingRecorder` + 引擎策略(ffmpeg/mesio),`getStream` 给的 url+headers 喂进选中引擎。
> `Task.platform`="douyin"/"bilibili",`Task.engine`="ffmpeg"/"mesio"(无 `recorder`/`danmuProvider` 字段了)。
> **接新平台 = 写一个 `<平台>-live` 实现 Platform + `registerPlatform` 一行**(引擎白嫖,无需写录制器);
> **加新引擎 = `record-engine` 加一个 DownloadEngine 策略 + `registerEngine` 一行**(所有平台立即可用)。
> engine/quality 校验唯一真理 = `platform.{engines,qualities}`;弹幕 on/off 由 `task.danmu` + `platform.connectDanmu` 是否存在。

## 关键设计

### 录制引擎（`record-engine`,平台无关 · 引擎策略化）
- **通用 `PollingRecorder`**(`@drec/record-engine`,平台无关):`platformForRoom(url)` 拿 Platform,每 30s 轮询 `platform.getStream/getLiving` → living 才 spawn → **确认拿到流那刻 fire `onLive`**(弹幕扇出唯一时机,见 onLive 契约)→ 进程退出查权威 `getLiving` 判别下播/断流 → onOffline;卡死看门狗(ffmpeg `time=` / mesio 文件增长 喂 markProgress,停滞超 60s 杀进程重连);`stop()`=SIGINT+8s SIGKILL,`drain()`=停开播轮询不腰斩当前。「下载」这步委托给选中的**引擎策略**,取 `getStream` 返的 `url + headers` 喂进去。
- **引擎(`DownloadEngine`,任务字段 `engine` 选)**:`ffmpeg`(默认,`-c copy` → `.ts`,解析 `Opening`/`time=`)· `mesio`(rust-srec,`--fix -d` → `.flv`,文件增长看门狗)。两者平台无关,headers(如 bilibili CDN 的 Referer/UA)由 `getStream` 提供、引擎透传(ffmpeg `-referer`/`-user_agent`,mesio `-H`)。
- **匿名取流**(抖音不传会话 cookie 否则踢手机主号);video-only,弹幕走 `platform.connectDanmu`。
- 弹幕:`platform.connectDanmu()` 返 `ListenerDanmuSource` 子类(抖音在 `douyin-live`,vendored WS)经 `resolveDouyinLiveId` 拿本场 liveId 连 WS,`XmlDanmuWriter` 写 biliLive 格式 `.xml`(**时间轴锚到视频起点 + 丢弃开播前回灌历史**)。

### 录制会话（RecordingSession，@drec/manager）
- 弹幕归属：录制器 video-only → 总是用独立 DanmuSource + XmlDanmuWriter 落盘。
- **弹幕在 `onLive` 才启动**（不是会话开始）：`danmuStarted` 守卫每个 `_startInner` 只连一次。**根因**:开播前连弹幕会解析到陈旧 liveId → WS 连上却整场 0 条（定时窗口起的任务尤甚）。recorder 确认开播才 fire onLive → 此刻解析 liveId 必为当场。fire-and-forget,不阻塞录制。
- **弹幕健康监控**：`DanmuSource.start(…, onAlert?)`,`ListenerDanmuSource` 三种告警 ① liveId 解析失败 ② WS error ③ 连上 3 分钟仍 0 条（陈旧 liveId/风控的静默失败信号）→ session `notify({kind:"error",stage:"弹幕"})` → webhook + `@@DREC_ALERT@@` + UI。与视频卡死看门狗对等,弹幕静默失败当场报警。
- 断流重连：`onOffline → _handleOffline`，指数退避（`reconnectDelaySec * 2^fails` 封顶 300s）后重连（先 stop 弹幕再新起,新场重新拿 liveId）。
- 会话级 xml：同会话所有分段共享 `{base}.xml`（剥 `-PART###`/`_###` 后缀；容器 `.ts`/`.flv` 均认）。

### 窗口结束「优雅排空」(drain)
- 定时窗口结束**不腰斩**正在进行的直播：`recorder.drain()` 停开播轮询（不再录下一场），当前录制录到自然收播再停。
- 收播判定双信号：`recorder.isLive()`（`getInfo().living` 权威 API，连续 2 次 false）**或** `RecordStop` 事件。
- 信号区分：**SIGUSR2**=排空（daemon 窗口结束发），**SIGTERM**=硬停（手动「停止」/重启）。drain 无 SIGKILL 超时。
- 状态 `draining`（UI badge「⏳ 超窗录制中」）；P0 超长直播跨入新窗口 → 老录制优先 + 告警，收播后自动接管。

### 任务系统（app 层，子进程模型）
- `TaskManager` 持有 `Map<taskId, RecorderProcess>`，每任务 = 一个 `node dist/douyin-rec.mjs record ...` 子进程。
- `TaskDaemon` 每 60s tick，按 `scheduler.inWindow`（本地时区，跨夜）决定 start / stopGraceful。**时区由 config 决定,不看 host/容器的 `TZ` env**:`task serve` 启动时 `applyTimezone()`(`app/src/timezone.ts`)读 `settings.timezone`(未设→默认 `Asia/Shanghai`,因为录的都是国内主播)并**覆盖** `process.env.TZ`,启动日志打一行 `[tz] 时区 = ...` 可查;`GET/POST /api/timezone` 可查/改,改了立即生效(daemon 下一次 tick 就用新时区,不用重启)。之前踩过「host 层 TZ 难从进程外内省——`ssh vps date` 显示的是 ssh 会话自己的环境,不是目标服务进程的,得挖 `/proc/<pid>/environ` 才能确认」的坑,这条彻底绕开。
- 状态恢复、崩溃自动重启、每任务日志环形缓冲（web 实时 tail）。

### Cookie 模型
- **全局 cookie**：`settings.defaultCookies`（扫码登录 / 手动粘贴写入），所有任务共享。
- **每任务开关** `useCookie`：true → 用全局 cookie（弹幕含礼物）；false → 匿名弹幕。`resolveTaskCookies(task, global)` 统一解析。
- cookie 过期时间从 `sid_guard` 解析（`parseCookieExpiry`），UI 顶栏/弹窗显示剩余天数。

### Web UI（React）
- `web/`：Vite + React19 + react-router + jotai（tasksAtom/cookieStatusAtom/hubEnabledAtom）+ @base-ui/react + Tailwind v4 + lucide。Cal.com 风格设计 token。
- `app/web/server.ts`：http server + REST api + SPA fallback，托管 `web/dist`。
- 列表页 + 任务详情/日志页（状态、录制时长、SSE 日志）+ Hub 页(master 才显示;slave 显示 child node 提示)。

### 多节点 hub（`@drec/orchestrator`,master/slave 跨节点同步编排）
- **形态**:一个 **master**(`task serve --hub`,如 docker)编排多个 **slave**(`task serve`,无 `--hub`,如 VPS);各节点匿名各录各的,master 选优合并上传。slave **不需要 `--hub`**——master 经 **SSH** 主动够到它:`_inventory`(一次性扫 `recordings/` 输出 JSON 清单)+ rsync 拉文件 + ssh 清理。
- **身份/聚类**:录制端写 `{base}.session.json`(roomSlug=web_rid + platform + gaps)。`identity` 按 **(platform, roomSlug)** 聚成一场(streamKey=`{platform}:{roomSlug}:{date}`)→ douyin/bilibili 同房间号不撞、跨节点一致(不靠主播名)。
- **选优**:`select` 覆盖度优先(coverage=1−gap/span)→ **完整录全(单会话无断流)优先**,多个完整取最长;**所有节点都断流(没人录全)→ 中断 + 通知 + 绝不删源**(留人工)。
- **pipeline**(`pipeline.ts`,复用 post-process + biliup):选优 winner → pull 到 stage → merge plain → burn danmu/livechat → **穿插上传**(merge 完即后台 fire P1 上传、与烧录并行,await BV 后串行 append;append 也带关水印+仅自己可见,防重置)。
- **配置 = 文件**(对标 DLR,文件=唯一真理源,现读不缓存→UI↔手改文件天然同步):全局 `<root>/config/hub.config.json`(tenants/stageDir/时序 + uploadDefaults)+ 每房间 `<root>/config/hub/{platform}.{roomSlug}.json`(`{room,enabled,pipeline:{steps,upload,cleanup}}`)。`upload.mode`=stage(只合成)|upload(传);`private` 布尔(默认仅自己可见)。**hub-store** 文件版 CRUD;Web Hub 页增删改 = 建/写/删文件。**hub 规则不在 DB**。
- **SyncLedger**(`<db>-sync.db`)幂等台账:sync_jobs(状态机 pending→syncing→merging→uploading→done/needs_manual/failed)+ sync_candidates(选优明细)。reconciler:recordEnd 触发 + 周期 reconcileAll(in-flight 守卫 + settle 等收播,仍在录的场跳过)。
- **硬标准代码常量**(`biliup.ts`,不可配、绝不漏):关水印 `--extra-fields watermark.state=0`、copyright=1、`--is-only-self`(private 时)。可配的只有 tag/tid/desc(主播专属,写任务文件)。
- 详见 `docs/multi-node-sync.md` + `docs/multi-node-sync-followups.md`(实测记录 + per-平台 cookie 等 followup)。

## 常用命令

```bash
pnpm install                  # 装依赖（含 patches）
pnpm typecheck                # tsc --noEmit
pnpm test                     # vitest run
pnpm bundle                   # esbuild 打包 → dist/douyin-rec.mjs
pnpm dev -- record --room URL # tsx 直跑（注意录制必须 node dist，不能 tsx）
cd packages/web && pnpm build # 构建前端 → packages/web/dist（独立 Vite 工程,自带 lockfile）

# 运行
node dist/douyin-rec.mjs record --room URL --segment 1800   # 单次录制
node dist/douyin-rec.mjs task serve --port 7860 --db douyin-rec.db   # Web UI（端口 7860）/ slave 节点
node dist/douyin-rec.mjs task serve --port 7860 --hub        # master:Web UI + 多节点 hub(读 <root>/config/hub.config.json)
node dist/douyin-rec.mjs task add URL                       # CLI 加任务
```

⚠️ **库 interop**：录制必须跑打包后的 `node dist/douyin-rec.mjs`，不能 `tsx`/直 import（douyin-live 的 sm-crypto/protobufjs ESM 坑）。vitest 无法 import 这些包 → recorder/douyin-live/平台实例 **零单测**，靠 session/manager/daemon/store 测 + `test/setup.ts` 注册假平台 + 真实录制覆盖。

📁 **数据目录**：db / recordings / stage / config(含 hub 规则、biliup cookies)全收在**一个数据根** `DOUYIN_REC_ROOT` 下(见 `packages/app/src/paths.ts`),不散落项目里。**未设时默认 `./output-data`**(裸跑不再把文件平铺进 cwd)。本仓库约定:`pnpm serve:local` 用 `DOUYIN_REC_ROOT=./data-local`;docker 固定 `/data`(映射宿主机 `docker-data/`)。专用 env(`DOUYIN_REC_DB`/`DOUYIN_REC_OUTPUT`/`BILIUP_COOKIE`)可单独覆盖某一项。

## B站上传规则（biliup）

**永远用 `upload-recording-today` skill 上传，不要手搓 biliup 命令。** skill 脚本
（`~/.claude/skills/upload-recording-today/scripts/upload-recording-today`）是设置的**唯一权威**——
里面写死了正确的 tag / 简介 / 关水印 / 仅自己可见。手搓极易漏 `--desc`、用错 `--tag`、漏关水印（踩过坑）。

- **一稿三分P**：plain + danmu + livechat 作为同一稿件三个分 P，顺序 **P1=plain → P2=danmu → P3=livechat**。**分步上传（2026-06-27 起用户改）**：先单独 `upload` plain（P1，带全部 metadata + 关水印 + 仅自己可见）**完成、解析出 BVID**，再 `biliup append --vid <BV>` 追加 danmu(P2)、livechat(P3)。**不要再一次性 `upload a b c`**（旧做法已废）——先出 BV 拿到稿件再追加更稳健（P2/P3 是 10GB 级大文件，失败也不影响已建稿）。
- **关水印是硬性**：skill 默认带 `--extra-fields '{"watermark":{"state":0}}'` 关昵称水印。**水印在投稿后无法修改**（用户确认）→ 必须上传时就关，漏了只能删稿重传。
- **可见性默认「仅自己可见」**（`--is-only-self 1`）；用户明确要公开才传 `--public`。tid 21、copyright 1、title `{name}_{date}`。tag/简介是主播专属，**以 skill 脚本里的值为准**。
- **本地胜出时**（`docker-data/output/{主播名}/`）：skill 只扫 `remote/recordings/{主播名}/`，故把本地三文件 **symlink** 进临时 root（`/tmp/upload_stage/remote/recordings/{主播名}/`）再 `--repo /tmp/upload_stage --cookies <repo>/cookies.json` 跑 skill。biliup 跟随 symlink 读真实大小（skill 显示 0.00GB 是 stat 符号链接的 cosmetic 假象，不影响）。
- **上传日志「正常态」**：biliup 在 `pre_upload` 后**日志静默数分钟**（分块进度走 stderr 进度条不写日志）、`ps` 也可能看不到——**这是正常上传中，不是死了，别杀**。靠后台完成通知判断。
- **auth**：`cookies.json`（仓库根 / `~/.config/biliup/` / `~/`，biliup CLI auth，**别删别提交**）。
- **删稿**：`biliup` 无删稿命令；B站删稿 API（`POST member.bilibili.com/x/web/archive/delete`，aid+csrf）**已加人机验证**（`340022 验证码错误`），headless 删不了 → **让用户在创作中心手动删**。重传前先删旧稿（B站不支持改稿件视频内容）。

## 硬性约束

- **删 `.xml` / `.ass` 前必须人工确认**（`.claude/hooks/block_xml_ass_delete.py` 对疑似删除它们的命令**弹确认 ask**，不再硬 block）。原则上清理只删 `.ts`/`.mp4` 大文件；`.xml`/`.ass` 不可再生，确认确实要删再放行。
- **不要破坏 VPS 生产录制**：VPS 只读检查，不杀进程/不删文件。
- 测试录制只用 VPS，本地仅验证 TS（本地 macOS 有 rc-11 fork 污染）。
- `cookies.json`（biliup B站上传 auth）、`config.yaml`、`douyin-rec.db` 已 gitignore，勿提交。

## 提交规范（约定式提交 / Conventional Commits）

- **格式**：`<type>(<scope>): <简短中文描述>`，正文用 bullet points 展开细节（为什么 + 改了什么）。
  - 常用 `type`：`feat`（新功能）、`fix`（修 bug）、`chore`（杂务/配置）、`docs`（文档）、`refactor`、`test`。
  - `scope` 用模块名：`danmu` / `recorder` / `task` / `live_poll` / `post` / `web` 等（可多个：`fix(danmu,recorder): …`）。
  - 例：`fix(recorder): 预建主播子目录，消除「开播首段 ffmpeg 失败一次」`、`feat(task): v.douyin.com 短链入库即转换`。
- **不要用** 旧的 `v0.0.X: 描述` 格式（已废弃，与现有 git 历史不一致）。
- **不要加** `Co-Authored-By: Claude …` 等 AI 署名 trailer，也不加 `Claude-Session` 链接。
- 只 `git add` 本次相关文件，别带上无关的未跟踪文件；仅在用户要求时才 commit/push。

## 保留的 Python 部分

`scripts/rename` + `assets/fonts`(重命名 / 烧字幕字体)。

> `remote/`(旧 VPS Python merge 管线)**已移出仓库**(`.gitignore`,含个人 IP/SSH;本地保留供 VPS 工作流)。
> 它的 `merge.py` 依赖已删除的 Python `src/`,**本地已不可跑**。合并/烧录改走 **TS CLI**:
> `node dist/douyin-rec.mjs merge --in <dir>` + `burn --video <mp4> --xml <xml> --style danmu|livechat --gift-value 0.9`
> (`packages/post-process` 移植版,已实测产出可上传成品)。
> ⚠️ `merge-recording-today` skill 仍调那个不可跑的 Python `remote/merge.py` → **待切到 TS CLI**(已知缺口)。
