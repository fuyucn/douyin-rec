# CLI 参考

`douyin-rec` 是单文件 CLI（`dist/douyin-rec.mjs`），抖音直播录制 + 弹幕捕获 + 后处理 + 投稿的完整工具链。

所有子命令均通过打包产物运行：

```bash
pnpm bundle                       # 产出 dist/douyin-rec.mjs（带 shebang，可直接执行）
node dist/douyin-rec.mjs <cmd>    # 或 ./dist/douyin-rec.mjs <cmd>
```

> 录制（默认引擎 = 平台默认 `ffmpeg`）必须用 `node dist/...` 运行，**不能**用 `pnpm dev`（tsx），原因见 [README 已知限制](../README.md#已知限制取舍)。

## 目录

- [全局选项](#全局选项)
- [`record`](#record--录制) — 录制直播 + 捕获弹幕
- [`merge`](#merge--合并分段) — 合并分段 `.ts` → `.mp4`
- [`burn`](#burn--烧录弹幕) — 烧录弹幕 ASS → 带字幕 `.mp4`
- [`upload`](#upload--投稿-b-站) — 投稿到 B 站
- [`task`](#task--持久化任务) — 持久化任务（sqlite + Web 控制台 + 定时调度）

---

## 全局选项

放在子命令名**之前**，对所有子命令生效。

| 选项 | 说明 |
|---|---|
| `--discord-webhook <url>` | Discord incoming webhook URL。优先级：命令行 > YAML config `discordWebhook` 字段 > 环境变量 `DISCORD_WEBHOOK`。未配置时全程 no-op；推送失败只 warn log，绝不影响录制/处理。详见 [app.md 通知事件表](./app.md#discord-通知事件表)。|

```bash
node dist/douyin-rec.mjs --discord-webhook "https://discord.com/api/webhooks/..." record --room 36464127515
```

---

## `record` — 录制

录制抖音直播流，同时捕获弹幕。检测到开播即开始录制；断流自动重连（等待 `--reconnect` 秒后重试）。`Ctrl-C`（SIGINT）或 `kill`（SIGTERM）干净收尾（停弹幕、停录制、终止 ffmpeg、闭合 xml）。

| 选项 | 默认 | 说明 |
|---|---|---|
| `--room <id\|url>` | （必填）| 房间号（如 `36464127515`）或完整 URL（`https://live.douyin.com/...`）|
| `--name <s>` | - | 主播/输出名称。有值 → 录像落在 `{out}/{name}/` 子目录、文件名以 `{name}` 开头；留空 → 按抓取到的主播名自动分目录。名称会做路径安全处理（剥离 `/ \ : * ? " < > \|` 及控制字符）|
| `--quality <q>` | `origin` | 画质：`origin`/`uhd`/`hd`/`sd`/`ld` |
| `--engine <e>` | 平台默认（douyin/bilibili 均 `ffmpeg`）| 下载引擎：`ffmpeg`（默认，`-c copy` → `.ts`）/ `mesio`（rust-srec，`--fix -d` → `.flv`）。引擎由 `record-engine` 实现，平台无关。`--recorder <r>` 为 `--engine` 的**废弃别名**（取值相同）|
| `--danmu <0\|1>` | `1` | 弹幕开关：`1`=开 `0`=关（也接受 `on`/`off`、`true`/`false`、`none`）。弹幕来源由命中平台的 `connectDanmu` 提供，不再按 provider 名分派 |
| `--cookies <s>` | - | 抖音 cookie 字符串 |
| `--cookies-file <path>` | - | 从文件读取 cookie（读取后 trim；优先于 `--cookies`）|
| `--out <dir>` | `./recordings` | 输出目录 |
| `--segment <sec>` | `1800` | 分段时长（秒），`0`=不分段 |
| `--reconnect <sec>` | `5` | 断流后快速重连前的等待秒数 |
| `--config <path>` | - | YAML 配置文件；命令行选项优先覆盖（见下「配置文件」）|

**配置文件字段**（YAML，全部可选，命令行优先覆盖）：`quality` · `recorder`（**字段名沿用旧名以兼容历史 YAML**，值为引擎 id `ffmpeg`/`mesio`，作 `--engine` 的回落值；非法/旧值 → 回落平台默认引擎）· `danmu`（`1`/`0`/`on`/`off`/`none`）· `cookies` · `outDir` · `segmentSec` · `pollIntervalSec` · `reconnectDelaySec` · `discordWebhook`。`recorder`/`danmu` 留空时由 `Platform.defaultEngine` / 平台 connectDanmu 解析。缺省值见 [config.ts](../packages/core/src/config.ts) 的 `DEFAULT_CONFIG`。

**产物**（一次录制会话 = 会话基名 `{主播}_{date}_{time}`）。录像按主播分目录，落在 `{out}/{主播}/` 子目录下（`{主播}` = `--name` 或抓取到的主播名）：

```
recordings/{主播}/{base}-PART000.ts   # ffmpeg 分段：-PARTNNN（按分段时间命名，非严格序号）
recordings/{主播}/{base}-PART001.ts
recordings/{主播}/{base}.xml          # 会话级弹幕 xml（一个会话一个）
```

> **`merge` / `burn` 的 `--in` / `--indir` 现在指向「每主播子目录」** `{out}/{主播}/`，而非顶层 `{out}/`。`merge` 不递归查找子目录。

- **录制 video-only**：通用 `PollingRecorder`（`@drec/record-engine`，平台无关）+ 选中的下载引擎。`ffmpeg` 引擎写 `{base}.ts`、分段 `{base}_NNN.ts`（3 位补零）；`mesio` 引擎写 `.flv`。弹幕始终由独立 `DanmuSource`（平台 `connectDanmu` 提供，抖音见 `@drec/douyin-live`）+ `XmlDanmuWriter`（`@drec/manager` 的 `danmu-xml/`）写 biliLive 格式 `{base}.xml`。

**示例**：

```bash
# 默认 ffmpeg 引擎录制 + 弹幕
node dist/douyin-rec.mjs record --room 36464127515 --quality origin --danmu 1 --out ./recordings

# 不分段、带 cookie
node dist/douyin-rec.mjs record --room https://live.douyin.com/36464127515 --segment 0 --cookies-file ./cookies.txt

# mesio 引擎（rust-srec，落 .flv）
node dist/douyin-rec.mjs record --room 36464127515 --engine mesio
```

---

## `merge` — 合并分段

将一个会话的所有分段 `.ts` 无损拼接（ffmpeg `-c copy -movflags +faststart`）成单个 `.mp4`。自动按文件名分组识别会话。

| 选项 | 默认 | 说明 |
|---|---|---|
| `--in <dir>` | （必填）| 录像目录，含 `{base}-PART*.ts` / `{base}_*.ts` / `{base}.ts` 与 `{base}.xml`。录像现在按主播分目录，应指向「每主播子目录」`{out}/{主播}/`（不递归）|
| `--base <base>` | 全部会话 | 只合并指定会话基名 |

**分段识别规则**（与录制命名对齐）：`{base}-PART000.ts`（ffmpeg）/ `{base}_000.ts` / `{base}.ts`（不分段）。无段号的单文件排在所有分段之前。

**产物**：`{dir}/{base}.mp4`。每个会话合并成功后发 `mergeDone` 通知。

```bash
# 合并目录内所有会话（指向每主播子目录）
node dist/douyin-rec.mjs merge --in ./recordings/主播

# 只合并指定会话
node dist/douyin-rec.mjs merge --in ./recordings/主播 --base 主播_2026-06-10_00-23-33
```

---

## `burn` — 烧录弹幕

将弹幕渲染为 ASS 字幕并烧录进视频（`libx264 crf=18 preset=veryfast` + `aac 192k`）。两种样式：滚动弹幕（`danmu`）或左下角聊天框堆叠（`livechat`）。

支持两种输入模式：

- **单文件模式**：`--video`（已合并的 plain mp4）+ `--xml`（会话级弹幕 xml）。
- **多段模式**：`--indir` + `--base`，读取目录中 `{base}_NNN.ts` + 对应 per-segment `{base}_NNN.xml`，按各段 `.ts` 累计时长平移弹幕时间，合并到一条时间轴上烧录。视频默认取 `{indir}/{base}.mp4`（可用 `--video` 覆盖）。

| 选项 | 默认 | 说明 |
|---|---|---|
| `--video <mp4>` | （单文件必填；多段默认 `{indir}/{base}.mp4`）| 已合并的 plain mp4 |
| `--xml <xml>` | （单文件必填）| 会话级弹幕 xml |
| `--indir <dir>` | - | 多段模式目录（含 `{base}_NNN.ts` + `{base}_NNN.xml`）。录像按主播分目录后，指向每主播子目录 `{out}/{主播}/` |
| `--base <base>` | - | 多段模式会话基名 |
| `--style <s>` | `danmu` | `danmu`（滚动弹幕）/ `livechat`（左下角聊天框堆叠）|
| `--gift-value <n>` | `0.9` | 礼物价值过滤阈值：`price <= n` 的礼物不进弹幕轨 |
| `--out <mp4>` | `{video stem}_{style}.mp4` | 自定义输出路径 |
| `--hwaccel <h>` | `auto` | `auto`（macOS→videotoolbox，其他平台软解）/ `videotoolbox` / `none` |

**`--hwaccel auto`**：`darwin` 自动加 `-hwaccel videotoolbox` 解码加速；其他平台软解（无 `-hwaccel` 参数）。

**样式差异**：
- `danmu`：仅 `danmaku` + `gift` 进滚动轨；`member`（进场）不入轨。
- `livechat`：仅 `danmaku` + `gift`；`member` 同样排除（对齐 VPS/Python 输出，避免进场刷屏）。

**字体**：渲染默认用仓库 `assets/fonts/`（Noto CJK / Noto Emoji），可用环境变量 `FONTS_DIR` 覆盖。

**产物**：`danmu` → `{base}_danmu.mp4`；`livechat` → `{base}_livechat.mp4`。烧录成功发 `burnDone` 通知（含 `style`）。

```bash
# 滚动弹幕（默认）
node dist/douyin-rec.mjs burn --video recordings/主播_2026-06-10.mp4 --xml recordings/主播_2026-06-10.xml

# 聊天框堆叠
node dist/douyin-rec.mjs burn --video recordings/主播.mp4 --xml recordings/主播.xml --style livechat

# 多段模式（per-segment xml）
node dist/douyin-rec.mjs burn --indir ./recordings --base 主播_2026-06-11_15-01-27 --style danmu

# 自定义礼物过滤 + 强制软解
node dist/douyin-rec.mjs burn --video x.mp4 --xml x.xml --gift-value 2.0 --hwaccel none

# 自定义字体目录
FONTS_DIR=/path/to/fonts node dist/douyin-rec.mjs burn --video x.mp4 --xml x.xml
```

---

## `upload` — 投稿 B 站

包装 `biliup` CLI 上传 mp4 到 B 站，返回 BV 号。上传前预检 `biliup` 命令可用 + cookies 文件存在。

> **前提**：先 `biliup login` 产出 `~/.config/biliup/cookies.json`，并已安装 `biliup` CLI。

| 选项 | 默认 | 说明 |
|---|---|---|
| `--video <mp4>` | （必填）| 要上传的 mp4 |
| `--title <s>` | （必填）| 稿件标题 |
| `--tag <csv>` | `直播,直播录像,抖音` | 标签（逗号分隔）|
| `--tid <n>` | `21` | 分区 tid（21=生活）|
| `--public` | `false` | 公开（不加则仅自己可见，`--is-only-self 1`）|
| `--desc <s>` | - | 稿件简介 |
| `--cookies-file <path>` | `~/.config/biliup/cookies.json` | biliup 登录后的 cookies |

底层固定带 `--copyright 1`（自制）。上传成功发 `uploadDone` 通知（含 BV 号 + URL）。

> 预检失败时 `process.exit(2)`，**不发** error 通知（预检在 try 之外）。

```bash
# 默认仅自己可见（方便审查）
node dist/douyin-rec.mjs upload --video recordings/主播_2026-06-10_danmu.mp4 --title "主播 2026-06-10 直播录像"

# 公开 + 自定义标签/分区/简介
node dist/douyin-rec.mjs upload --video x.mp4 --title "标题" --public --tag "直播,抖音" --tid 21 --desc "录像"
```

**输出**：`[upload] 完成: BV1Ab4y1C7xY  https://www.bilibili.com/video/BV1Ab4y1C7xY`

---

## `task` — 持久化任务

stateful app 层：任务持久化到 sqlite（`node:sqlite`，Node 24 内置），支持手动 CRUD、立即运行、Web 控制台、定时调度。app 层完整设计见 [app.md](./app.md)。

**数据库路径解析**：`--db <path>` > 环境变量 `DOUYIN_REC_DB` > 默认 `./douyin-rec.db`。多数 task 子命令都支持 `--db`。

### `task add` — 新增任务

| 选项 | 默认 | 说明 |
|---|---|---|
| `--room <id\|url>` | （必填）| 房间号或完整 URL |
| `--name <s>` | - | 主播名称。也用作输出子目录名：录像落在 `{out}/{name}/`、文件名以 `{name}` 开头；留空 → 按抓取到的主播名自动分目录 |
| `--quality <q>` | `origin` | 画质：`origin`/`uhd`/`hd`/`sd`/`ld` |
| `--engine <e>` | 平台默认（`ffmpeg`）| 下载引擎：`ffmpeg`/`mesio`（按平台 `platform.engines` 校验，非法值列出该平台合法项并退出 2）。`--recorder <r>` 为废弃别名 |
| `--danmu <0\|1>` | `1` | 弹幕开关（`0`/`off`/`false`/`none` → 关，其余 → 开）|
| `--segment <sec>` | `1800` | 分段时长（秒），`0`=不分段 |
| `--cookies-file <path>` | - | **本任务专属 cookie**（可选覆盖；trim 后入库）。默认留空，任务用全局 cookie，见下文 [`cookie`](#cookie--全局账号-cookie) |
| `--use-cookie <0\|1>` | `1` | **本任务是否带 cookie 抓弹幕**：`1`=带 cookie 拿礼物（已登录会话，更稳）；`0`=匿名只评论（不传 cookie，避免与其他用同一 cookie 的录制冲突）。接受 `1`/`0`/`on`/`off`/`true`/`false`/`none`。入库为 `useCookie` 布尔列 |
| `--out <dir>` | - | 输出目录（空 → 运行时回退到 settings/默认）|
| `--schedule <HH:MM-HH:MM>` | - | 定时窗口（本地时区，支持跨夜）；解析为 `scheduleStart`/`scheduleEnd` 入库 |
| `--db <path>` | `./douyin-rec.db` | 数据库路径 |

```bash
node dist/douyin-rec.mjs task add --room 36464127515 --name 主播 --quality origin --danmu 1 --segment 1800
node dist/douyin-rec.mjs task add --room 767116735823 --schedule 06:00-09:00   # 跨夜窗口也支持，如 22:30-01:00
node dist/douyin-rec.mjs task add --room 603532021677 --use-cookie 0            # 匿名抓弹幕（只评论，不带 cookie）
```

### `task list` — 列出任务

| 选项 | 默认 | 说明 |
|---|---|---|
| `--db <path>` | `./douyin-rec.db` | 数据库路径 |

输出表格列：`id` · `room` · `name` · `quality` · `danmu`(on/off) · `cookie`(用/否) · `schedule` · `status`。`cookie` 列即各任务的 `useCookie` 开关：用=带 cookie 拿礼物，否=匿名只评论。

### `task edit` — 编辑任务

更新已有任务的字段。**只更新本次实际传入的选项**——commander 不传的选项保持 `undefined`，因此命令按 `=== undefined` 跳过，绝不会用默认值覆盖未提供的字段。`id`/`createdAt`/`status` 永不改动。编辑**运行中**任务只更新数据库，不重启；改动在**下次启动**时生效。

| 选项 | 说明 |
|---|---|
| `<id>` | 任务 id（参数）|
| `--room <id\|url>` | 直播间房间号或 URL |
| `--name <s>` | 主播名称 |
| `--quality <q>` | 画质 origin\|uhd\|hd\|sd\|ld |
| `--engine <e>` | 下载引擎 ffmpeg\|mesio（`--recorder` 为废弃别名）|
| `--danmu <0\|1>` | 弹幕开关 |
| `--segment <sec>` | 分段时长(秒), 0=不分段 |
| `--cookies-file <path>` | 从文件读取本任务专属 cookie |
| `--use-cookie <0\|1>` | 本任务是否带 cookie 抓弹幕 |
| `--out <dir>` | 输出目录 |
| `--schedule <HH:MM-HH:MM>` | 定时窗口 |
| `--db <path>` | 数据库路径 |

删除/编辑不存在的 id 报错退出 1。

```bash
node dist/douyin-rec.mjs task edit 1 --name 新名 --use-cookie 0   # 只改名 + cookie 开关，其余字段不变
```

### `task remove` — 删除任务

```bash
node dist/douyin-rec.mjs task remove <id> [--db <path>]
```

参数 `<id>`（任务 id）。删除不存在的 id 报错退出 1。

### `task run` — 立即运行

立即录制指定任务直到 `Ctrl-C`/`kill`，**不**按 schedule 自动启停（schedule 仅记录）。运行时把 status 置 `running`，停止时置 `stopped`（出错置 `error`）。在前台进程内直接构建 `RecordingSession`（不走子进程）。

| 选项 | 默认 | 说明 |
|---|---|---|
| `--db <path>` | `./douyin-rec.db` | 数据库路径 |

```bash
node dist/douyin-rec.mjs task run <id>
```

### `task daemon` — 定时调度守护

按各任务的 `schedule` 窗口（本地时区，支持跨夜）自动启停录制。每个任务作为独立 `record` 子进程运行（崩溃自动重启）。无窗口的任务 → 始终录制。`Ctrl-C`/`kill` 停止所有任务。

**窗口结束 = 优雅排空（不腰斩直播）**：到达窗口结束时间时，若直播仍在进行，daemon **不**强杀录制，而是发 `SIGUSR2` 让子进程「排空」——停止开播轮询（不再录下一场），当前这场录到**自然收播**再停（收播判定：`getInfo().living` 权威轮询 + `RecordStop` 事件双信号）。排空期间任务状态为 `draining`（Web UI 显示「⏳ 超窗录制中」）。手动「停止」/ 重启仍走 `SIGTERM` 立即硬停。超长直播跨入下一窗口 → 老录制优先 + 告警，收播后自动接管。

| 选项 | 默认 | 说明 |
|---|---|---|
| `--db <path>` | `./douyin-rec.db` | 数据库路径 |
| `--interval <sec>` | `60` | 调度检查间隔（秒）；窗口为分钟粒度，sub-minute 轮询无意义 |

```bash
node dist/douyin-rec.mjs task daemon --interval 60
```

调度窗口语义与子进程模型详见 [app.md](./app.md#调度-scheduler--daemon)。

### `task serve` — Web 控制台

启动 HTTP 服务 + SPA（单 HTML 页面），手动管理任务（创建/列表/启动/停止/删除）。**默认同时启用定时调度守护**（`--no-schedule` 关）。`Ctrl-C`/`kill` 先停调度、再停所有录制、最后关 HTTP。

Web 控制台顶部有**全局「抖音账号 Cookie」面板**：登录一次，所有任务共享（详见 [全局 cookie 模型](#全局-cookie-模型)）。支持「扫码登录」（抖音 App 扫码，需另装 `playwright`，未装时报错、手动粘贴仍可用）、「手动粘贴」、「清除」。原理与 REST 端点见 [app.md 扫码登录](./app.md#扫码登录-qr-login) 与 [app.md 全局 cookie](./app.md#全局-cookie-restapicookie)。

控制台支持 **hash 路由的任务详情/日志页**（`#/task/:id`，从列表点主播名或 📄 进入）：展示当前状态、任务配置、**开始时间 + 已录时长**（实时刷新），以及该任务录制子进程 stdout/stderr 的**实时日志 tail**（每 2 秒轮询 `GET /api/tasks/:id/logs`，日志由 manager 的 `TaskLogStore` 环形缓冲捕获）。

| 选项 | 默认 | 说明 |
|---|---|---|
| `--port <n>` | `7860` | 监听端口 |
| `--db <path>` | `./douyin-rec.db` | 数据库路径 |
| `--no-schedule` | （默认开调度）| 关闭定时调度守护，仅手动启停 |

```bash
node dist/douyin-rec.mjs task serve --port 7860              # 仅手动控制
node dist/douyin-rec.mjs task serve --port 7860            # 默认含定时调度（--no-schedule 关）
```

REST API、SPA 功能、SPA 静态文件解析详见 [app.md Web 控制台](./app.md#web-控制台-task-serve)。

---

## `cookie` — 全局账号 cookie

### 全局 cookie 模型（两层）

cookie 采用**两层模型**：

1. **全局 cookie**（账号级，所有任务共享）：登录一次即可。存储在 `settings` 表的 `defaultCookies` 键（与扫码登录写入的键相同）。三种设置方式：
   - **Web 控制台扫码登录**（推荐）：`task serve` → 顶部「抖音账号 Cookie」面板 → 扫码登录。
   - **`cookie set`**（终端，见下）。
   - **手动粘贴**：Web 面板「手动粘贴」 → `POST /api/cookie`。
2. **每任务 `useCookie` 开关**（任务级，默认开）：决定**该任务**是否把全局 cookie 传给它的录制器。开=带 cookie 拿礼物（已登录会话，更稳）；关=匿名只评论（不传 cookie，避免与另一个用同一 cookie 的录制器抢同一个弹幕 WS 连接）。CLI 用 `task add --use-cookie <0|1>` 设置；Web 创建表单有「使用 cookie 抓弹幕(礼物)」开关。`tasks` 表新增 `useCookie INTEGER NOT NULL DEFAULT 1` 列（旧库自动补列迁移，已有行默认 1）。

录制时 cookie 解析规则（两条录制路径——`task run` 与 `task serve`/`daemon` 子进程——共用 `resolveTaskCookies`）：

- `useCookie=false` → **无 cookie**（匿名），即使全局已设置也不传。
- `useCookie=true` → **任务专属 `task.cookies`（`task add --cookies-file`，可选覆盖） > 全局 `defaultCookies` > 无**。

空字符串视为未设置。

`cookie` 子命令组管理全局 cookie，**不含**终端扫码登录（QR 登录走 Web 控制台）。所有子命令支持 `--db <path>`（解析规则同 task）。

| 子命令 | 选项 | 说明 |
|---|---|---|
| `cookie show` | `--db` | 打印状态：是否已设置 / sessionid 有无 / 长度（**不打印原始值**）|
| `cookie set` | `--file <path>` \| `--str <s>`，`--db` | 从文件或字符串设置全局 cookie（trim；二者择一，缺失退出 2，空值退出 2）|
| `cookie clear` | `--db` | 清除全局 cookie |

```bash
node dist/douyin-rec.mjs cookie set --str "x=1; sessionid=abc"      # 直接给字符串
node dist/douyin-rec.mjs cookie set --file ./cookies.txt            # 从文件读
node dist/douyin-rec.mjs cookie show                               # 查看状态
node dist/douyin-rec.mjs cookie clear                              # 清除
```
