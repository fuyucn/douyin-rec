# douyin-rec (TS)

抖音直播录制 + 弹幕捕获 + 后处理 + 投稿的 TypeScript 实现。从直播流录制视频（`.ts` 分段）、捕获弹幕（biliLive 风格 `.xml`）、合并分段、烧录弹幕字幕、投稿 B 站，并支持 sqlite 持久化任务 + Web 控制台 + 定时调度。录制引擎与弹幕源**可插拔**。

## 状态

- **全流程完成**：录制 / 弹幕 / 合并 / 烧录(danmu + livechat) / 投稿 / Discord 通知 / sqlite 持久化任务 / 子进程化录制 / 定时调度(跨夜窗口) / Web 控制台(REST + SPA) / 终端 TUI。
- **引擎策略化录制**(通用 `record-engine` + 引擎 `ffmpeg`[默认,.ts] / `mesio`[rust-srec,.flv],任务字段 `engine` 选):取流靠平台 `getStream`(抖音 vendored a_bogus 签名,匿名不踢手机),引擎平台无关;已对真实直播 live 端到端验证。
- **Platform 抽象**：平台专属逻辑收口 `Platform` 接口 + 注册表(matchUrl/getStream/getLiving/…),抖音为完整实现、bilibili 为脚手架占位;接第二平台 = 写 `<平台>-live` 包 + 注册一行。
- 在 `ts-rewrite` 分支开发(pnpm workspace,11 包)。

## 架构

pnpm workspace（11 包），收敛成 **2 个可插拔接缝**:**平台轴**(各 `<平台>-live`,平台专属取流+弹幕)+ **引擎轴**(`record-engine`,平台无关下载),其余全通用。依赖只能向下（`test/arch/layering.test.ts` 守护）。esbuild 把 `cli` 打成 `dist/douyin-rec.mjs`(+ `dist/tui.mjs`)。架构图见 `docs/architecture.html`。

```
packages/
├── core/                  # 契约 + 注册表:Platform 接口 + DownloadEngine 接口 + types/config/notify/api-types
├── post-process/          # 后处理纯函数:concat / burn / ass(rolling·livechat·multi·render) / merge / ffmpeg / fonts
├── ffmpeg-recorder-extra/ # 附加:流信息 logStreamMeta + 设备检测 detectDevice
├── tui/                   # Ink 终端控制台(独立打包 dist/tui.mjs)
├── record-engine/         # 【引擎轴·平台无关】通用 PollingRecorder + 下载引擎 ffmpeg(.ts)/mesio(.flv);取流经 platform.getStream(url+headers)
├── douyin-live/           # 【平台轴】douyinPlatform:src/{stream(vendored a_bogus 取流)+ danmaku(vendored WS 弹幕)} + probe + index 装配
├── bilibili-live/         # 【平台轴】bilibiliPlatform:getStream(getRoomPlayInfo,headers 带 referer)/getLiving;connectDanmu 暂无
├── manager/               # RecordingSession:会话编排 + onLive 经 platform.connectDanmu 连弹幕 + 健康告警 + 断流重连 + 会话级 xml + danmu-xml(XmlDanmuWriter)
├── app/                   # stateful:db/store(房间归一化+平台校验) / task-manager / daemon / web(api+server) / events / login / upload
├── cli/                   # 入口:record/merge/burn/probe + task · providers-register(注册平台 douyin/bilibili + 引擎 ffmpeg/mesio)
└── web/                   # React19 + jotai + @base-ui/react + Tailwind v4 前端 → packages/web/dist,由 app/web/server 托管
```

> 详细:**[docs/app.md](./docs/app.md)**(app/web 层) · **[docs/cli.md](./docs/cli.md)**(CLI)。

详细参考：**[docs/cli.md](./docs/cli.md)**（完整 CLI）· **[docs/app.md](./docs/app.md)**（app / web 层）。

## 技术栈

Node 24（`node:sqlite` 内置）· TypeScript · pnpm workspace · vitest · commander · esbuild。取流靠 **vendored a_bogus 签名**（`packages/douyin-live/src/vendor`，源自 `@bililive-tools/douyin-recorder`，自维护副本）· 弹幕 WS = **自有 TS 客户端**（`packages/douyin-live/src/danmaku/client.ts`,参考 `douyin-danma-listener` 重写;仅 `webmssdk.js`/`proto.js` 作 vendored）· `fast-xml-parser` · `eastasianwidth` · `yaml`。系统依赖：`ffmpeg`/`ffprobe`（录制/合并/烧录），`biliup` CLI（投稿），可选 `mesio`（rust-srec,`bin/`,mesio 引擎用）。

可选：`playwright`（仅 Web 控制台「扫码登录」需要，见 [docs/app.md 扫码登录](./docs/app.md#扫码登录-qr-login)）。它无法打进单文件 bundle（自带原生浏览器），故在 esbuild 中标记 external、运行时懒加载。装法：

```bash
pnpm add playwright && npx playwright install chromium   # 仅扫码登录需要；不装则手动粘 cookie
```

## 安装 & 构建

```bash
pnpm install      # pnpm workspace（无 pnpm patch，取流/弹幕依赖均已 vendored，见下「依赖补丁」）
pnpm typecheck    # tsc --noEmit，0 错误
pnpm test         # vitest run
pnpm bundle       # esbuild → 单文件 dist/douyin-rec.mjs（带 shebang，推荐）
pnpm build        # （可选）tsc 逐文件转译到 dist/，供调试
```

`pnpm bundle` 把全部依赖 + 补丁内联成一个自包含文件 `dist/douyin-rec.mjs`（~2.9MB），拷到任何有 node + ffmpeg 的机器即可运行（无需 `node_modules`）。它顺便规避了 tsx 的 `development` 条件坑（见「已知限制」）。也可 `npm i -g .` 装成全局命令 `douyin-rec`。

## 快速开始

```bash
pnpm bundle

# 录制（默认 ffmpeg 引擎 + 弹幕；Ctrl-C 干净收尾）
node dist/douyin-rec.mjs record --room 36464127515 --quality origin --danmu 1

# 合并分段 → {base}.mp4
node dist/douyin-rec.mjs merge --in ./recordings

# 烧录弹幕（滚动）→ {base}_danmu.mp4
node dist/douyin-rec.mjs burn --video recordings/{base}.mp4 --xml recordings/{base}.xml

# 投稿 B 站（默认仅自己可见）
node dist/douyin-rec.mjs upload --video recordings/{base}_danmu.mp4 --title "标题"

# 全局抖音账号 cookie（所有任务共享；扫码登录走 Web 控制台）
node dist/douyin-rec.mjs cookie set --str "x=1; sessionid=abc"   # 或 --file ./cookies.txt
node dist/douyin-rec.mjs cookie show                            # 查看状态（不打印原始值）

# Web 控制台（http://localhost:7860；默认含定时调度，加 --no-schedule 可关）
node dist/douyin-rec.mjs task serve --port 7860
```

每个命令的全部选项与示例见 **[docs/cli.md](./docs/cli.md)**。

## 终端 TUI 控制台（`task tui`）

在终端里交互式管理任务（Web 的命令行替代）。**TUI 是瘦客户端**——它本身**不录制**，只通过 REST API 连到 `task serve`（默认 `http://localhost:7860`）去看状态、启停、看日志。真正录制的是 serve 的进程；**关掉 TUI 录制照常继续**，**没开 serve 则 TUI 连不上、什么也录不了**。

```bash
# 前提：先有一个 task serve 在跑（docker 的 7860，或本地 serve）
pnpm tui                                              # 连 7860
node dist/douyin-rec.mjs task tui --api http://localhost:7861   # 连别的 serve
```

- 必须在**真实终端(TTY)**里运行（Ink 需要 raw mode）；非 TTY 会打印提示而不渲染。
- 快捷键：`↑/↓`(或 `k/j`) 选择 · `s` 启动 · `x` 停止 · `l`/`⏎` 看日志 · `r` 刷新（本就 2s 自动刷）· `q` 退出。
- 状态徽章：`● 录制中`(绿) / `◌ 等待开播`(品红) / `⏳ 排空中` / `○ 待命` / `○ 已停用`。
- 日志视图**按行上色**：error 浅红行底、warn 黄、success 绿、弹幕灰、状态/主播 青（Web 详情页日志台同款配色）。
- 技术：Ink + React，单独打包成 `dist/tui.mjs`（**不进主 bundle**，详见 [docs/app.md](./docs/app.md)）；`ink/react` 在 host 从 `node_modules` 解析，docker 的 serve 不含也不需要它。

### 「自动录制」是谁做的？

| | 跑录制? | 自动? |
|---|---|---|
| `task serve`（docker/本地） | ✅ 执行方（spawn `record` 子进程） | **默认开调度**：启用的任务**无窗口=24h 录 / 有窗口=窗口内录**；`--no-schedule` 退化为纯手动 |
| `task tui` / Web | ❌ 只遥控/查看 | 只是发指令给 serve |

要让任务自动录：任务**已启用（enabled）**即可（serve 默认带调度）；设了定时窗口就窗口内录、没设就 24h。跟 TUI 开不开**无关**。

## 同时跑两个实例（本地开发 + docker 生产）

两个 serve 各用一个端口 + **各自独立的 DB**就能并行、互不干扰（共用 DB 会让两个 TaskManager 抢着 spawn 录制 → 双录冲突）。

```bash
# 生产：docker，:7860（.env 的 PORT），DB 在 docker-data/db
docker compose up -d

# 开发：本地，:7861，独立库 douyin-rec-local.db
pnpm serve:local        # = task serve --port 7861 --db ./douyin-rec-local.db（默认含调度）

# TUI 分别连：
pnpm tui                # docker  :7860
pnpm tui:local          # 本地    :7861
```

docker 宿主机端口由 `.env` 的 `PORT` 控制（容器内固定 7860），改完 `docker compose up -d` 生效。`.env` / `*.db` 均已 gitignore。

### 远程（VPS）怎么用 TUI

VPS 上 `task serve`（docker）负责录制；**TUI 不能在容器里跑**（镜像无 `node_modules`，`ink/react` 是 external）。从本地遥控：

```bash
# 1) SSH 隧道把 VPS 的 7860 映到本地（API 无鉴权，别直接暴露公网）
ssh -L 7860:localhost:7860 <vps>
# 2) 本地（pnpm install 过的仓库）连过去
pnpm tui            # 实际打到 VPS 的 serve
```

或 ssh 进 VPS、在装好依赖的仓库里 `node dist/douyin-rec.mjs task tui`。不想用 TUI 就浏览器经隧道开 Web UI。**录制由 VPS 的 serve 完成，与 TUI 是否连着无关。**

## Docker 部署（单容器：Web UI + 定时调度）

把录制服务跑成一个容器（`task serve`，默认含定时调度）。数据全在挂载卷上，重建不丢。

```bash
cp .env.example .env          # 改时区 / 宿主机路径 / 端口 / Discord
docker compose up -d --build  # 构建并启动（要部署最新版就再跑这条）
docker compose logs -f        # 看日志
docker compose down           # 停
```

| 变量 | 默认 | 说明 |
|---|---|---|
| `TZ` | `America/Los_Angeles` | **调度按本地时间算窗口**，容器默认 UTC 会让定时错乱，故必设；默认美西自动处理夏令时 |
| `PORT` | `7860` | Web UI 宿主机端口 |
| `DB_DIR` | `./docker-data/db` | 宿主机 DB 目录（→ 容器 `/data/douyin-rec.db`） |
| `OUTPUT_DIR` | `./docker-data/output` | 录像输出目录（任务未单独设 outDir 时用，env `DOUYIN_REC_OUTPUT`） |
| `CONFIG_DIR` | `./docker-data/config` | 放 biliup `cookies.json` / 可选 `config.yaml`（→ `/config`） |
| `DISCORD_WEBHOOK` | 空 | 可选通知 |

- 镜像基于 `node:24-bookworm-slim` + `ffmpeg`，运行自包含 bundle（无需 node_modules）。Linux 容器免疫 macOS 的 rc-11 fork 崩溃。
- **不含 playwright/chromium** → 扫码登录不可用，用 Web 控制台「手动粘贴 cookie」。
- cookie / 任务等设置都存在 DB 卷里，跨重建保留。

完整部署指南（环境变量、卷、时区、排查）见 **[docs/docker.md](./docs/docker.md)**。

## 依赖补丁（pnpm patch）

**当前无 pnpm patch**（`patches/` 为空，`pnpm-workspace.yaml` 无 `patchedDependencies`）。所有曾经的补丁都已通过 vendoring 消除:

- 抖音取流签名(a_bogus 等)+ FLV 重连 flags → vendored 进 `packages/douyin-live/src/vendor`(自维护副本,直接改源)；FLV `-reconnect` flags 由 `record-engine` 的 ffmpeg 引擎拼进 ffmpeg 参数。原 `@bililive-tools/douyin-recorder` 的 sm-crypto / ffmpeg patch 随之取消。
- 弹幕 WS → **我们自己的 TS 客户端 `packages/douyin-live/src/danmaku/client.ts`**(参考 `douyin-danma-listener` 重写,非复制;含 uid 稳定化防踢 + 按 payloadEncoding 解压);仅签名 `webmssdk.js`(a_bogus) + schema `proto.js` 作 vendored blob 保留。

## 已知限制 / 取舍

- **分段命名 `{name}_{开播时刻}_{NNN}`**：自研录制器用 `_NNN`（3 位补零）后缀；merge/burn 的分组规则识别 `-PARTNNN`、`_PARTNNN`、`_NNN`（mesio）、无后缀单文件,容器 `.ts`/`.flv` 均认。
- **不稳定流靠 FLV 重连缓解**：除 session 级断流指数退避重连外,`record-engine` 的 ffmpeg 引擎在 input 层拼了 `-reconnect*` 参数；另有卡死看门狗(无新输出超 60s 杀进程重连)。
- **livechat / 多段烧录排除 `member`（进场）**：对齐 VPS/Python 输出——5000+ 条进场会刷屏，Python 不收，故 TS 也排除。
- **录制必须 `node dist`、不能 `tsx`**：`packages/douyin-live` 的 vendored 取流依赖 `sm-crypto`/`protobufjs`（CJS），tsx/直 import 下 ESM interop 拿不到具名导出 → 签名/解码崩溃。打包后 `node dist/douyin-rec.mjs` 正常。也因此 recorder/douyin-live 无法在 vitest 里 import（零单测,靠 live + 假平台 `test/setup.ts`）。
- **生产用 Linux/VPS**：抖音取流(a_bogus/sm-crypto)在 macOS 下偶发 fork+Network.framework SIGSEGV（rc=-11），生产录制请在 Linux 上跑(docker 镜像免疫)。
- **Web 静态文件解析**：esbuild 只打包 JS，SPA `index.html` 在运行时从源码树读取；脱离源码树部署需设 `DOUYIN_REC_STATIC`（详见 [docs/app.md](./docs/app.md#spa-静态文件解析-static-htmlts)）。
- **cookie 两层模型**：(1) **全局账号 cookie**——登录一次（Web 扫码登录 / `cookie set` / Web 手动粘贴），所有任务共享 `settings.defaultCookies`；(2) **每任务 `useCookie` 开关**（默认开，CLI `task add --use-cookie <0|1>`，Web 创建表单有「使用 cookie 抓弹幕(礼物)」开关）——决定该任务是否把全局 cookie 传给录制器。解析规则（`resolveTaskCookies`，两条录制路径共用）：`useCookie=false` → 无 cookie（匿名）；`useCookie=true` → 任务专属 `task.cookies`（`task add --cookies-file` 可选覆盖）> 全局 `defaultCookies` > 无。`tasks` 表新增 `useCookie` 列（旧库自动补列迁移，默认 1）。详见 [docs/cli.md cookie](./docs/cli.md#cookie--全局账号-cookie)。
- **匿名 vs cookie 弹幕**：匿名 WS 即可拿大部分公开直播间的评论弹幕（实测可收 `<d>`）；礼物 `<gift>` 等需登录态 cookie；cookie 还能缓解长连接 session timeout，长录建议带上。把某任务 `useCookie` 设为关，可让它走匿名连接——例如另一个任务已用同一 cookie 录制时，避免第二个 WS 连接冲突。
- **弹幕 xml 写入**：录制 video-only，弹幕由独立 `DanmuSource` + 本项目 `XmlDanmuWriter` 落盘(biliLive 兼容格式,会话级 xml)。
- **未实现 `task start` / `task stop` CLI 子命令**：进程化启停只通过 Web API 或 daemon 自动调度暴露（见 [docs/app.md](./docs/app.md#已实现--未实现)）。
- **扫码登录需完整安装（playwright + chromium），单文件 bundle 不够用**：扫码登录靠 headless 真浏览器在抖音登录页里中继二维码到网页——因为抖音 qrcode 接口依赖浏览器 webmssdk 生成的 `msToken`/`s_v_web_id`，纯 server 端拿不到（实测结论，详见 [docs/app.md 扫码登录](./docs/app.md#扫码登录-qr-login)）。playwright 无法打进 bundle，需另装；不装时扫码登录报错降级，手动粘 cookie 照常可用。
