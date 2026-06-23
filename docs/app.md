# app 层参考

app 层（`@drec/app`,`packages/app/src/`）是 `manager`/`core` 之上的 **stateful** 编排层：sqlite 持久化任务、子进程化录制、定时调度、Web 控制台。CLI 入口为 `task` 子命令组（见 [cli.md](./cli.md#task--持久化任务)）。

## 分层架构与数据流

```
cli (packages/cli/src/cli.ts, packages/app/src/cli-task.ts)
  └─ 解析参数 / 信号处理 / 装配 / providers-register(注册 provider + douyinPlatform)
        │
app (packages/app/src/)             ← 本文档
  ├─ store.ts        TaskStore — sqlite CRUD（任务 + settings;房间归一化 + platform 校验）
  ├─ db.ts           openDb / migrate（node:sqlite，幂等建表 + 列回填）
  ├─ task-manager.ts TaskManager — 子进程生命周期 + 崩溃重启
  ├─ process/        Spawner → RecorderProcess（Task → OS 子进程,进程组隔离）
  ├─ scheduler.ts    inWindow / nowMinutesLocal（纯窗口判定）
  ├─ daemon.ts       TaskDaemon — 定时 tick + decide（纯调度决策）
  ├─ events.ts       EventCenter — 站内通知流（墙钟播种游标）
  └─ web/            api.ts（无 http 的处理器）+ server.ts（http + SPA fallback）+ static-html.ts
        │
manager / core / 平台·引擎 (packages/{manager,core,douyin-live,bilibili-live,record-engine,post-process}/)
  └─ RecordingSession / Recorder / DanmuSource / Platform / DownloadEngine / 后处理 / 通知
```

**关键数据流（启动一个任务）**：

```
Web POST /api/tasks/:id/start   或   Daemon tick（进入窗口）
        │
   TaskManager.start(id)
        │  store.getTask → Spawner.spawn(task)
        ▼
   ChildRecorderProcess.start()
        │  spawn: node dist/douyin-rec.mjs [--discord-webhook ...] record --room ... --quality ... --engine ... --danmu 0|1 --out ... --segment ... [--cookies ...]
        ▼
   record 子进程 → core.RecordingSession.start() → 录制 + 弹幕 + 通知
```

任务状态（status）由 TaskManager 写回 store：`running`（启动）/ `stopped`（正常退出）/ `error`（崩溃）。

---

## 数据库 schema

`node:sqlite`（Node 24 内置，无需 flag；首次 import 会有一条 `ExperimentalWarning`，无害）。`migrate()` 用 `CREATE TABLE IF NOT EXISTS` 建表，每次 open 都幂等执行；建表后再用 `ensureColumn()` 幂等补列（`PRAGMA table_info` 检查 → 缺失则 `ALTER TABLE ... ADD COLUMN`，已有行取列 DEFAULT），因为 `CREATE TABLE IF NOT EXISTS` 不会修改**已存在**的表。后续新增列照此模式补一行 `ensureColumn`。

### `tasks` 表

| 列 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `id` | INTEGER PK AUTOINCREMENT | - | 任务 id |
| `room` | TEXT NOT NULL | - | 房间号或完整 URL |
| `name` | TEXT | NULL | 主播名称 |
| `quality` | TEXT | `'origin'` | 画质 |
| `engine` | TEXT NOT NULL | `'ffmpeg'` | 下载引擎 `ffmpeg`/`mesio`。旧库 `recorder` 列在迁移时按旧值回填到 `engine`（`*-mesio-recorder`→`mesio`，其余→`ffmpeg`）后丢弃 |
| `danmu` | INTEGER | `1` | 1=开 0=关 |
| `segmentSec` | INTEGER | `1800` | 分段时长（秒），0=不分段 |
| `cookies` | TEXT | NULL | cookie 字符串 |
| `outDir` | TEXT | NULL | 输出目录（NULL → 运行时回退）|
| `scheduleStart` | TEXT | NULL | 定时窗口起 `HH:MM` |
| `scheduleEnd` | TEXT | NULL | 定时窗口止 `HH:MM` |
| `status` | TEXT | `'stopped'` | `stopped`/`running`/`error`/`pending` |
| `useCookie` | INTEGER NOT NULL | `1` | 本任务弹幕是否带 cookie：1=带 cookie 抓**礼物 + 入场** 0=匿名（仅评论弹幕）。`Task.useCookie` 暴露为 boolean。旧库由 `ensureColumn` 自动补列（已有行默认 1）|
| `createdAt` | TEXT | - | ISO 时间字符串（入库时写）|

### `settings` 表

| 列 | 类型 | 说明 |
|---|---|---|
| `key` | TEXT PRIMARY KEY | 设置键 |
| `value` | TEXT | 设置值 |

已知键：`discordWebhook`（webhook 兜底）、`defaultCookies`（**全局账号 cookie**，所有任务共享；扫码登录 / `cookie set` / 手动粘贴写入）、`outDir`（输出目录兜底）。这些在 `buildSessionForTask` 里作为 task 字段缺省时的回退来源。

**cookie 的用途**：cookie 只为弹幕的**礼物（gift）+ 入场（member）**服务 —— 这两类事件抖音要求登录态才下发。**视频拉流是匿名的**（公开，匿名即可拿原画，见 `@drec/douyin-live` getStream），**评论弹幕也匿名能抓**；所以不带 cookie 仍能录视频 + 评论弹幕，只是没有礼物/入场。⚠️ getInfo/取流一律匿名（带会话 cookie 会触发抖音异地登录踢手机，见 `docs/douyin-kick-investigation.md`）；cookie 仅用于弹幕 WS 连接。

**cookie 两层模型**：

1. **全局 cookie**（账号级）：登录一次，所有任务共用 `settings.defaultCookies`（扫码登录 / `cookie set` / 手动粘贴写入）。
2. **每任务 `useCookie` 开关**（任务级，默认 true）：决定该任务是否把全局 cookie 传给录制器。每任务的 `tasks.cookies` 列仍保留，作为 `useCookie=true` 时的**可选覆盖**（仅 `task add --cookies-file` 设置；Web 创建的任务恒为 `null`）。

运行时解析由 `store.ts` 的纯函数 `resolveTaskCookies(task, globalCookie)` 统一实现，两条录制路径共用：

- `useCookie=false` → `null`（匿名:仅评论弹幕,无礼物/入场),即使全局已设置也不传 cookie。
- `useCookie=true` → `task.cookies ?? globalCookie ?? null`（`getDefaultCookies()` 把空字符串视为未设置 → `null`）。

`cli-task.ts buildSessionForTask`（`task run` 路径，结果落到 `RecordOpts.cookies`）与 `task-manager.ts spawnFor`（子进程路径，结果落到 `effective.cookies` → `buildRecordArgs` 仅在非空时追加 `--cookies`）都调用 `resolveTaskCookies`，因此两路一致。

---

## TaskStore API

`store.ts`，对 sqlite 的同步封装。构造接受已打开的 `DatabaseSync` 或路径/`undefined`（自动 `openDb` + migrate）。

| 方法 | 返回 | 说明 |
|---|---|---|
| `new TaskStore(dbOrPath?)` | - | 传 DB 对象直接用；传路径/省略则打开并迁移 |
| `addTask(input: TaskInput)` | `Task` | 插入任务，回读返回完整 Task（含默认值）|
| `updateTask(id, patch)` | `Task \| null` | 仅更新 `patch` 中出现的字段（按 `in patch` 动态拼 `SET` 子句），回读返回更新后的 Task；id 不存在→`null`。`id`/`createdAt`/`status` 永不改动；`useCookie` 布尔↔0/1 如 `addTask` |
| `listTasks()` | `Task[]` | 全部任务，按 `id ASC` |
| `getTask(id)` | `Task \| null` | 单个任务 |
| `removeTask(id)` | `boolean` | 删除，返回是否有行受影响 |
| `setStatus(id, status)` | `boolean` | 更新 status |
| `getSetting(key)` | `string \| null` | 读 settings |
| `setSetting(key, value)` | `void` | upsert settings |
| `close()` | `void` | 关闭 DB |

`Task` 类型字段同 [tasks 表](#tasks-表)。`TaskStatus = "stopped" \| "running" \| "error" \| "pending"`，`EngineKind = string`（实际取值由 `platform.engines` 决定，当前 `"ffmpeg" \| "mesio"`；旧名 `RecorderKind` 保留为 `EngineKind` 别名）。

---

## TaskManager 子进程模型

`task-manager.ts`，持有 `Map<taskId → RecorderProcess>`，驱动 start/stop、把状态写回 store、处理崩溃自动重启。它**只**依赖 `TaskStore` + `Spawner` 接口（不直接碰 `child_process`），因此可用 `MockSpawner` 完整单测。

### 为什么子进程隔离

每个任务录制 = 一个独立 `record` OS 子进程，而非在主进程内跑 `RecordingSession`：

- **Web 长驻**：`task serve` 是长期进程，单个录制崩溃不应拖垮控制台。
- **故障隔离**：底层 ffmpeg / mesio / 弹幕 WS 出错被限制在子进程内；主进程照常调度其余任务。
- **崩溃自动重启**：子进程异常退出可独立重启，不影响其他任务。
- **与 VPS 一致**：子进程模型与生产环境（多任务并发）行为对齐。

### 构造选项 `TaskManagerOpts`

| 选项 | 默认 | 说明 |
|---|---|---|
| `autoRestart` | `false` | 子进程**异常退出**（崩溃）时自动重启（`cli-task` 里 `serve`/`daemon` 均传 `true`）|
| `restartDelayMs` | `5000` | 重启前等待毫秒 |
| `maxRestarts` | `5` | 每任务连续自动重启上限，超过则放弃 |
| `log` | `console.log` | 日志回调 |
| `schedule` | `setTimeout` 包装 | 可注入的延时器（测试用，可同步触发重启）|
| `logStore` | 新建 `TaskLogStore` | 每任务日志环形缓冲；`serve` 注入共享实例供 Web 详情/日志页读取 |
| `clock` | `Date.now` | 可注入的时钟（用于 `startedAt`/已录时长，测试可控）|

### 方法

| 方法 | 返回 | 说明 |
|---|---|---|
| `start(taskId)` | `boolean` | 未在运行则 spawn 子进程，status→`running`，重置重启计数；已运行/不存在返回 `false` |
| `stop(taskId)` | `Promise<void>` | 优雅停止（标记 expected），清空重启预算使在途重启 no-op；退出 handler 置 status→`stopped` |
| `stopAll()` | `Promise<void>` | 停止全部 |
| `isRunning(taskId)` | `boolean` | 是否在运行 |
| `runningIds()` | `number[]` | 当前运行中的 taskId 列表 |
| `getLogs(taskId)` | `string[]` | 该任务捕获的日志行（旧→新），供 Web 日志控制台 tail |
| `getRuntime(taskId)` | `TaskRuntime` | `{ running, startedAt, elapsedMs }`——运行中返回 `startedAt`（epoch ms，spawn 时记录）+ `elapsedMs = clock()-startedAt`；停止后三者均 null |

### 日志捕获 + 运行时（TaskLogStore）

`task-logs.ts` 的 **`TaskLogStore`** 是每任务的环形缓冲（`Map<taskId, string[]>`，默认 cap 1000 行，溢出丢最旧）。每行加 `[HH:MM:SS]` 时间戳前缀；多行 `append` 按 `\n` 拆分逐行计入 cap。方法：`append(taskId, line)` / `get(taskId): string[]`（返回副本）/ `clear(taskId)`。

manager 持有一个 `TaskLogStore`，在 `spawnFor` 里把子进程的 `onLog`（stdout/stderr 行）转发进环形缓冲（**额外于** spawner 注入的 console `onLog`），并在 start/stop/crash/restart 时追加 manager 级生命周期行（`▶ 启动` / `■ 停止` / `✗ 异常退出…` / `↻ …重启`），使日志在子进程产出前就能看到生命周期。同时用 `Map<taskId, startedAt>` 记录每次运行的起始 epoch ms（`start`/`spawnFor` 设、`handleExit` 清）。

### 重启策略（`handleExit`）

- 退出时先从 Map 移除该任务。
- `expected`（stop() 触发）→ status `stopped`，结束。
- 非预期（崩溃）→ status `error`；若 `autoRestart` 且未被 stop() 清空重启预算，且未超 `maxRestarts`，则计数 +1、延 `restartDelayMs` 后 respawn（status→`running`）。超上限则放弃。

### Spawner / RecorderProcess 接口

**`Spawner`**（`process/spawner.ts`）—— Task → RecorderProcess 工厂接口：

```ts
interface Spawner { spawn(task: Task): RecorderProcess; }
```

`NodeRecordSpawner` 是唯一知道如何把 Task 变成真实 OS 子进程的地方：

- `command` = `process.execPath`（当前 node）；`cliEntry` = `process.argv[1]`（当前 bundle 路径，如 `dist/douyin-rec.mjs`）。
- argv = `[cliEntry, ...(webhook ? ["--discord-webhook", webhook] : []), ...buildRecordArgs(task)]`。
- `buildRecordArgs`（`process/record-args.ts`，纯函数）：`["record", "--room", room, "--quality", q, "--engine", engine, "--danmu", "1"|"0", "--out", dir, "--segment", String(sec), ...(name ? ["--name", name] : []), ...(cookies ? ["--cookies", cookies] : [])]`。`--name` 使录像落在 `{out}/{name}/` 每主播子目录。
- 构造选项：`cliEntry` / `command` / `cwd` / `webhook` / `onLog` / `killTimeoutMs`（均可选，用于测试与替换入口）。

**`RecorderProcess`**（`process/recorder-process.ts`）—— TaskManager 谈话的封装接口：

```ts
interface RecorderProcess {
  readonly taskId: number;
  readonly pid: number | undefined;
  start(): void;                       // 首次调用才 spawn（幂等）
  stop(): Promise<void>;               // SIGTERM；超时 killTimeoutMs 后 SIGKILL；子进程真正退出后 resolve
  onExit(cb: (info: ExitInfo) => void): void;  // 退出回调，触发一次
  onLog(cb: (msg: string) => void): void;      // 追加日志监听（每行 stdout/stderr）
}
interface ExitInfo { code: number | null; signal: NodeJS.Signals | null; expected: boolean; }
```

`ChildRecorderProcess` 是具体实现，封装单个 `child_process.spawn`：跟踪退出是否 `expected`（stop() 后为 true，否则视为崩溃），把子进程 stdout/stderr 行同时喂给构造注入的 `onLog`（spawner → console）与所有通过 `onLog()` 方法注册的监听器（manager 用它把行打进 `TaskLogStore`），`stop()` 在子进程真正退出后才 resolve（SIGTERM → 超时 `killTimeoutMs`（默认 10000ms）→ SIGKILL）。`spawn` error（如 ENOENT）会合成一次 exit。

---

## 调度（scheduler + daemon）

### `scheduler.ts` — 纯窗口判定

无 I/O、无时钟。窗口是**本地时间** `HH:MM` 字符串。

- `parseHHMM(s)` → 自午夜起的分钟数（0–1439）；非法/越界抛错。
- `nowMinutesLocal(date)` → 该 Date 的本地自午夜分钟数。
- `inWindow(nowMinutes, start, end)` → boolean：
  - `start` 或 `end` 为 null/空 → `true`（无窗口=始终可录）。
  - **当日窗口**（`startMin <= endMin`）：`startMin <= now <= endMin`。
  - **跨午夜窗口**（`startMin > endMin`，如 `22:30-01:00`）：`now >= startMin || now <= endMin`。
  - 两端边界均**含**（inclusive）。

### `daemon.ts` — TaskDaemon

定时 tick 编排器：拥有 tick 循环 + 纯调度决策 `decide`，但不在进程内建 `RecordingSession`——每个任务由注入的 `TaskManager` 跑成独立子进程（崩溃重启），坏掉的录制器不会拖垮 daemon。

- `decide(tasks, now, activeIds)` → `{ start: number[], stop: number[] }`（纯函数）：在窗口内且未激活 → start；不在窗口且已激活 → stop。
- **`DaemonOpts`**：`intervalMs`（默认 `60000`；窗口为分钟粒度，sub-minute 轮询无意义）/ `now`（注入时钟，默认 `() => new Date()`）/ `log`（默认 `console.log`）。
- `start()` 立即跑一次 tick，再每 `intervalMs` 一次；`tick()` 单次调度：离开窗口的任务调 **`manager.stopGraceful`（优雅排空，不腰斩直播）**，进入窗口的调 `manager.start`；有 `ticking` 守卫防重入；`stop()`（整体关停）清 interval + `manager.stopAll()`（硬停），幂等。
- **窗口结束优雅排空**：`stopGraceful` 发 `SIGUSR2` → 子进程停开播轮询、当前直播录到自然收播再退（`getInfo().living` 轮询 + `RecordStop` 双信号），状态 `draining`。超长直播跨入下一窗口（`eligible && draining`）→ 老录制优先 + 告警（去重），收播退出后下一 tick 自动接管。
- `activeIds()` → 当前运行任务集合（来自 `manager.runningIds()`）；`manager.isDraining(id)` 判断是否在排空。

`task daemon` 与 `task serve`（默认调度） 都装配 `TaskDaemon + TaskManager(autoRestart=true) + NodeRecordSpawner`。

---

## Web 控制台（`task serve`）

`web/` 三件套：`api.ts`（无 http 的处理器，纯函数式、可单测）+ `server.ts`（薄 `node:http` 层 + 纯路由）+ `index.html`（SPA）。

### REST API

所有响应 `application/json; charset=utf-8`。任务对象在响应里带 `running: boolean`（由 `manager.isRunning` 注入，称 `TaskView`）。`GET /api/tasks/:id` 额外带 `runtime: { running, startedAt, elapsedMs }`（由 `manager.getRuntime` 注入，称 `TaskDetailView`），供详情页显示开始时间 + 已录时长。

| 方法 | 路径 | 请求体 | 成功响应 | 状态码 |
|---|---|---|---|---|
| GET | `/` 或 `/index.html` | - | SPA HTML | 200 |
| GET | `/api/tasks` | - | `TaskView[]` | 200 |
| POST | `/api/tasks` | `CreateTaskInput`（JSON）| 新建 `TaskView` | 201；`room` 为空→400；schedule 格式错→400 |
| GET | `/api/tasks/:id` | - | `TaskDetailView`（带 `runtime`）| 200；未找到→404 |
| GET | `/api/tasks/:id/logs` | - | `{ lines: string[] }`（manager 捕获的日志行，旧→新）| 200；未找到→404 |
| PATCH | `/api/tasks/:id` | `UpdateTaskInput`（JSON，全部字段可选）| 更新后的 `TaskView` | 200；未找到→404；`room` 提供但为空→400；schedule 格式错→400 |
| DELETE | `/api/tasks/:id` | - | `{ ok: true, id }`（运行中会先 stop）| 200；未找到→404 |
| POST | `/api/tasks/:id/start` | - | `TaskView`（已置 running）| 200；未找到→404；已在运行→409 |
| POST | `/api/tasks/:id/stop` | - | `TaskView` | 200；未找到→404 |
| GET | `/api/cookie` | - | `{ set, hasSession, length }` | 200 |
| POST | `/api/cookie` | `{ cookie }`（JSON）| `{ set, hasSession, length }` | 200；cookie 空→400 |
| DELETE | `/api/cookie` | - | `{ set:false, hasSession:false, length:0 }` | 200 |

其他错误：未知路由→404；请求体非合法 JSON→400；处理器抛错→500。

**全局 cookie 端点（`/api/cookie`）**：读写 `settings.defaultCookies`（全局账号 cookie）。`GET` 返回**隐私安全状态**——`set`=非空，`hasSession`=含 `sessionid`/`sessionid_ss`，`length`=字符数，**绝不回传原始 cookie 值**。`POST` 手动粘贴设置（trim 后非空校验）；`DELETE` 置空（空字符串视为未设置）。QR 登录 `POST /api/login/qr` 仍直接写 `defaultCookies`，无需经此端点。

**`CreateTaskInput`** 字段（均可选，除 `room`）：`room`（必填，trim 后非空）· `name` · `quality`（默认 `origin`）· `engine`（按 `platform.engines` 校验,非法/省略→平台默认 `ffmpeg`；store 层兜底）· `danmu`（number/boolean，默认 1）· `segmentSec`（默认 1800）· `useCookie`（number/boolean，强制转 boolean，默认 true）· `outDir` · `schedule`（`"HH:MM-HH:MM"`，解析为 `scheduleStart`/`scheduleEnd`）· 或直接 `scheduleStart`/`scheduleEnd`。`cookies` 字段仍被后端接受（CLI override 路径），但 **Web 创建表单不再发送**——cookie 全局化，Web 任务恒为 `null`、走全局 cookie。Web 创建表单含「使用 cookie 抓弹幕(礼物)」开关（默认开）→ 以 `useCookie` 字段发送；任务表格新增 `cookie`(用/否) 列展示该状态。`listTasks` 返回的 `TaskView` 含 `useCookie`。

> 注意：`engine` 的校验与归一化已下沉到 `store.addTask`/`updateTask`（唯一真理 = `platform.engines`）；非法/省略 → 平台默认引擎，Web API 不单独报错。

**`UpdateTaskInput`**（PATCH 用，全部字段可选）：与 `CreateTaskInput` 同形（`room`·`name`·`quality`·`engine`·`danmu`·`segmentSec`·`cookies`·`useCookie`·`outDir`·`schedule`/`scheduleStart`/`scheduleEnd`）。**只更新请求体中实际出现的键**（`api.updateTask` 用 `in input` 判断），其余字段不变。`room` 若提供则 trim 后非空校验（空→400）；`danmu`/`useCookie` number/boolean 强制转换；`schedule` 非空解析为 `scheduleStart`/`scheduleEnd`，**空字符串则清空两者**。**编辑运行中任务只更新数据库、不重启**——改动在下次启动时生效。

### 路由匹配（`matchRoute`，纯函数导出）

去除尾部 `/`（保留根 `/`）；`/api/tasks/:id` 与 `/api/tasks/:id/{start,stop,logs}` 通过正则 `^/api/tasks/(\d+)(\/start|\/stop|\/logs)?$` 提取 `:id`（`/logs` 仅 `GET`→`getTaskLogs`）。裸 `:id`（无子路径）上 `GET`→`getTask`、`PATCH`→`updateTask`（带 body）、`DELETE`→`deleteTask`。

### SPA 功能（`index.html`）

单 HTML 页面，daisyUI（night 主题）+ Tailwind CDN，纯 fetch 调上面的 REST API：

- **全局「抖音账号 Cookie」面板**（页面顶部）：状态徽标（✅ 已登录 / ⚠️ 未设置，基于 `GET /api/cookie` 的 `set`+`hasSession`）+ 三个按钮：**扫码登录**（QR 对话框，成功后刷新状态）· **手动粘贴**（textarea → `POST /api/cookie`）· **清除**（`DELETE /api/cookie`）。所有任务共享此 cookie。
- **新建/编辑任务模态**（共用一个表单）：直播间(room) / 主播名 / 画质 / 分段时长 / 定时窗口 `HH:MM-HH:MM` / 弹幕开关 / 使用 cookie 开关。JS 用 `editingId`（`null`=新建模式）区分：新建→`POST /api/tasks`，编辑→`PATCH /api/tasks/:id`。编辑模式标题「编辑任务」、按钮「保存修改」、表单从该任务当前值预填（schedule 由 `scheduleStart`+`scheduleEnd` 拼回），运行中任务额外提示「下次启动生效」。**无 per-task cookie 文本字段**（cookie 全局）。
- **任务表格**：id / 直播间+主播 / 画质 / 弹幕 / cookie / 定时 / 状态（运行中带脉冲点 + badge）/ 操作（启动·停止·**详情 📄**·**编辑 ✏️**·删除）。主播名/房间是指向详情页的链接；编辑按钮从最近一次 `GET /api/tasks` 的缓存（`lastTasks`）取该任务预填模态，无需二次请求。
- 每 **2 秒**轮询 `GET /api/tasks` 刷新（仅在列表页）；顶部显示连接状态。
- 注意：表单暴露的字段不含 `engine`（创建时走平台默认引擎 `ffmpeg`）。

#### Hash 路由 + 详情/日志页

页面是双视图 SPA，靠 `location.hash` 切换（`hashchange` + 启动时 `route()`）：

- `#/`（默认）→ 列表视图（`#view-list`）。
- `#/task/:id` → 详情视图（`#view-detail`），其余隐藏。

**详情页**（Cal.com 浅色风，居中 max-w ~1200）：
- 顶部：「← 任务列表」返回链接、任务名/房间、状态徽标（运行中绿色脉冲 / stopped / error）、启动/停止/编辑/删除操作（复用列表逻辑；删除后跳回 `#/`）。
- **任务信息卡**：房间 / 画质 / 弹幕（含礼物·匿名·关闭，与表格同逻辑）/ 定时窗口（本地时间）/ 含礼物 cookie / 输出目录 / **开始时间**（`runtime.startedAt` 格式化，或 —）/ **已录时长**（`runtime.elapsedMs` → `HH:MM:SS`，运行中随轮询实时更新）。
- **日志控制台**：浅色 surface 等宽面板（~360px 高、`white-space:pre-wrap`），新行自动滚到底（除非用户上滚则暂停自动滚动）；空 → 「暂无日志（任务未运行或无输出）」。
- 在详情页时每 **2 秒**并行轮询 `GET /api/tasks/:id`（状态 + runtime）与 `GET /api/tasks/:id/logs`（日志行）；离开详情页时停止该轮询（列表轮询同时只在列表页跑）。

### SPA 静态文件解析（`static-html.ts`）

esbuild 只打包 JS，bundle 不含 HTML，故 `loadIndexHtml()` 按优先级查找 `index.html`：

1. `process.env.DOUYIN_REC_STATIC`（显式覆盖,指向含 `index.html` 的 dist 目录）。
2. `<本模块目录>/../../../web/dist`（tsx/源码：`packages/app/src/web` → `packages/web/dist`）。
3. `<bundle 目录>/../packages/web/dist`（bundle：`dist/` → `packages/web/dist`）。
4. `<bundle 目录>/../web/dist`、`<bundle 目录>/../../web/dist`（docker runtime 拷成 `/app/web/dist` 等回退）。
5. 内嵌最小 fallback 页（保证 `task serve` 永不 500；REST API 仍可用）。

> 即：从源码 checkout 跑 bundle 时 SPA 自动可用；脱离源码树部署需设 `DOUYIN_REC_STATIC`。

---

## 终端 TUI（`task tui`）

Ink(React)做的全屏终端界面，**Web 的命令行替代**：列表 / 状态徽章 / 启停 / 日志（按行上色）/ 刷新。源码在 `packages/tui/src/`（独立打包 `dist/tui.mjs`,`react`/`ink` 在 host node_modules 解析,不进主 bundle）。

**它是瘦客户端，不是执行方**：TUI **不持有 TaskManager、不 spawn 录制**，只通过 REST 调 `task serve`（`--api`，默认 `http://localhost:7860`）。录制全由 serve 完成 → 关掉 TUI 录制照常、没 serve 则 TUI 连不上。自动录制 = serve 的调度 daemon（默认开），与 TUI 无关。

### 为什么单独打包 `dist/tui.mjs`（不进主 bundle）

主 bundle（`dist/douyin-rec.mjs`）跑 `record`/`serve`，**docker 里无 `node_modules`**。若把 `ink/react` 标成主 bundle 的 esbuild external，ESM 静态 `import` 会被**提升到主 bundle 顶层** → 即使 TUI 是按需 `import()`，主 bundle 一加载就 `import "react"` → docker 的 `task serve` 启动即崩（`ERR_MODULE_NOT_FOUND: react`，容器 restart-loop）。

解法（见 `esbuild.config.mjs`）：

- TUI 单独 esbuild entry → `dist/tui.mjs`（`jsx: automatic`；`ink/react/react/jsx-runtime/yoga-layout` 在**它**里 external）。
- `cli-task.ts` 的 `task tui` 用**变量 specifier** 加载，让 esbuild 不静态跟踪、不把 TUI/react 打进主 bundle：
  ```ts
  const tuiMod = "./tui.mjs";
  const { launchTui } = await import(tuiMod); // 运行时相对 dist/douyin-rec.mjs 解析
  ```
- 验证：`grep -c 'from"react"' dist/douyin-rec.mjs` 必须为 `0`。

结果：主 bundle 干净、docker serve 不含也不需要 react/ink；TUI 只在**有 `node_modules` 的 host** 跑（`ink/react` 运行时解析）。Ink 需 TTY → `launchTui` 里 `process.stdin.isTTY` 守卫，非 TTY 打印提示不抛 Ink 堆栈。

### 远程（VPS）使用

VPS 跑 `task serve`（docker）干活；**容器内不能跑 TUI**（无 node_modules）。从本地经 **SSH 隧道**遥控（API 无鉴权，勿暴露公网）：`ssh -L 7860:localhost:7860 <vps>` 后本地 `pnpm tui`。**最省事其实是浏览器经隧道开 Web UI**（不需要 TUI 的依赖）；TUI 仅「想在终端里管」时用。

---

## 扫码登录 (QR Login)

Web 控制台的「扫码登录」让用户用抖音 App 扫码，自动拿到登录态 cookie——免去手动从浏览器抠 cookie。仅 `task serve` 装配（`cli-task.ts` 注入 `QrLoginManager`）。

### 原理

```
server 起 headless Playwright 真浏览器
  → 加载 www.douyin.com，抖音自家 webmssdk JS 生成反爬 cookie（msToken/s_v_web_id）+ 渲染登录二维码
  → server 从页面抠出二维码 PNG（data:image/png;base64 的 <img>）中继到网页
  → 用户用手机扫码并在 App 上确认
  → headless 浏览器 context 里出现 sessionid cookie
  → server 收割 .douyin.com cookie 白名单 → "k=v; k=v" 串 → 存为 settings.defaultCookies
```

**为什么不能纯 server 直接调 qrcode API**：实测直接请求 `passport/web/get_qrcode/` 返回 `error_code 4031`（风控拦截）——该接口需要浏览器 webmssdk 生成的 `msToken`/`s_v_web_id`，纯 Node 端造不出来（ABogus 签名本身没问题，但不够过风控）。所以必须借一个真浏览器跑抖音自己的 JS，再把二维码中继给用户。

### `QrLogin` 接口（`login/qr-login.ts`）

会话级抽象，唯一接触 Playwright 的地方（`playwright` 动态 `import()` 懒加载，不进其余模块的 import 图）：

| 方法 | 返回 | 说明 |
|---|---|---|
| `start()` | `{ qrPng }` | 拉起 chromium、导航、抠二维码；`qrPng` 是 base64 PNG（无 `data:` 前缀）。无二维码则抛错 |
| `poll()` | `{ state, cookie? }` | `state`: `pending`/`scanned`/`confirmed`/`expired`；`confirmed` 时带收割的 `cookie` 串 |
| `cancel()` | `Promise<void>` | 关浏览器、释放资源；幂等 |

`PlaywrightQrLogin` 是唯一实现：headless（默认）、4 分钟会话 TTL、二维码 25s 超时；见到 `sessionid`/`sessionid_ss` 即判定 `confirmed`、收割后立即关浏览器并锁存 cookie（重复 poll 稳定返回）。当前实现 `poll()` 只在 cookie 落地前返回 `pending`（无法可靠区分「已扫未确认」，故 `scanned` 保留给可检测的 mock/调用方）。另导出纯函数 `harvestCookieString` / `hasSessionCookie` 与白名单 `WANTED_COOKIE_KEYS`（仅留弹幕 WS 真正需要的键，避免导出 6000+ 字符全量 cookie），无需浏览器即可单测。

### `QrLoginManager`（`login/login-manager.ts`）

Web/CLI 层与 `QrLogin` 会话之间的中间层，**最多一个**活跃会话（一次只起一个 headless 浏览器）：

| 方法 | 返回 | 说明 |
|---|---|---|
| `start()` | `{ sessionId, qrPng }` | 先取消上一个活跃会话，再新建；分配 `sessionId` |
| `poll(sessionId)` | `{ state, cookie? }` | id 不匹配/已失效 → `{ state: "unknown" }`（供 404）；`confirmed` 时把 cookie 持久化到 `store.setSetting("defaultCookies", cookie)` 并返回 |
| `cancel(sessionId?)` | `Promise<void>` | 取消指定/当前会话 |

通过注入的 `QrLoginFactory`（`() => new PlaywrightQrLogin(...)`）创建会话，故 manager 可用 mock 会话完整单测，Playwright 不进其 import 图。

### REST 端点（`task serve`）

| 方法 | 路径 | 请求体 | 成功响应 | 状态码 |
|---|---|---|---|---|
| POST | `/api/login/qr` | - | `{ sessionId, qrPng }`（`qrPng` 为 base64 PNG）| 200；未装 playwright→501；`start()` 抛错→500 |
| GET | `/api/login/qr/:sid` | - | `{ state }`（不回传原始 cookie；`confirmed` 时 cookie 已由 manager 落库到 `defaultCookies`）| 200；未知会话→404；未装 playwright→501 |

`:sid` 由路由正则 `^/api/login/qr/([A-Za-z0-9_-]+)$` 提取。SPA 端（全局 cookie 面板的「扫码登录」按钮）：点击 → `POST` 拿二维码 → 每 2 秒 `GET` 轮询 → `confirmed` 时 server 已把 cookie 落到 `defaultCookies`，前端只刷新 `GET /api/cookie` 状态徽标（不接触原始 cookie）；`expired`/出错则停轮询。

### 依赖与优雅降级

`playwright` 是可选依赖（`pnpm add playwright && npx playwright install chromium`），且在 `esbuild.config.mjs` 标记为 external——它自带原生浏览器二进制，无法打进单文件 bundle。`PlaywrightQrLogin.start()` 里动态 `import("playwright")`，未装时抛 `未安装 playwright…`，经 api 变成 500（端点本身在 `login` manager 缺席时才返回 501）。无论哪种，扫码登录失败都不影响其余功能——可在全局 cookie 面板「手动粘贴」cookie（`POST /api/cookie`），或终端 `cookie set` 照常工作。

---

## Discord 通知事件表

通知由 core 的 `Notifier` 发出。webhook 解析：CLI `--discord-webhook` > settings 表 `discordWebhook` > env `DISCORD_WEBHOOK`；未配置 → `NullNotifier`（no-op）。推送失败只 warn log，绝不影响主流程。消息为一行中文（带 emoji）。

| 事件（kind） | 触发时机 | 关键字段 |
|---|---|---|
| `recordStart` | 检测到开播、录制开始（`onLive`）| `anchor`, `room`, `quality` |
| `recordEnd` | `session.stop()` 收尾完成 | `anchor`, `room`, `outDir` |
| `mergeDone` | `merge` 每个会话合并成功 | `file`（输出 mp4 路径）|
| `burnDone` | `burn` 烧录成功 | `style`（danmu/livechat）, `file` |
| `uploadDone` | `upload` 上传成功 | `bv`（BV 号）, `url` |
| `error` | 录制/合并/烧录/上传出错 | `stage`, `message` |

> `upload` 预检失败（`process.exit(2)`）在 try 之外，**不发** error 通知。

---

## 已实现 / 未实现

- **未实现 `task start` / `task stop` CLI 子命令**：CLI 侧只有 `run`（前台立即录制）。进程化的启停只通过 Web API（`POST /api/tasks/:id/{start,stop}`）或 daemon 自动调度暴露。若未来需要从命令行对一个长驻 daemon/serve 实例发启停指令，是后续项（需 IPC 或共享状态，当前 manager 状态在内存中，跨进程不可见）。
- `task run` 的 `--schedule` 仅记录、不自动启停；自动调度走 `task daemon` 或 `task serve`（默认调度）。
