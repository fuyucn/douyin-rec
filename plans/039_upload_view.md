# 039 队列页「上传」视图:每节点 biliup 实时进度(issue #44)

## Goal

在队列页按节点显示「此刻每个 biliup 在传什么、传到哪、是否卡住」,以及最近若干次结果。
**只读观测,不改任何上传行为**(不改 argv、不改重试/换线、不改判定、不改台账)。

## 现状与缺口(2026-10-18 核对)

| #44 验收项 | 现状 | 缺口 |
| --- | --- | --- |
| 每次 biliup 调用一条运行记录 | 队列模式(plan 038)有 proc-queue job + step;**边录边传(生产主路径)只有 `uploading{index,kind}`** | 边录边传与节点侧整场上传没有 pid / 线路 / 起始时间 / 最后进展 |
| 进度不依赖 biliup 输出 | `processors/biliup-progress.ts` 已用 `ss -tinpH` 的 `bytes_acked` 量进度,仅队列模式使用 | 边录边传 / 节点侧整场上传无字节进度 |
| 节点随状态回传、master 汇总、旧节点「未上报」 | `_recording-status` 已带回 `rooms` + `rolling`(F1),旧 bundle 缺字段降级;本机 local 走 `LocalTransport.recordingStatus` | 无 biliup 进程字段 |
| 界面按节点分行:分P、百分比、速率、剩余、线路、换线次数、最近结果 | 队列行内有边录边传进度与队列模式字节/速率 | 无按节点汇总视图;无线路、换线次数、剩余时间、卡住标记 |

队列模式(`nodeUpload.mode=queue`)当前未在生产启用(#207 needs-decision),所以只补它不能解决问题。
另:docker 镜像无 `iproute2`(无 `ss`),master 本机目前取不到 acked 字节(见 T0)。

## Architecture

**不碰上传代码**:节点在已有的状态采集里**旁路扫描**本机 biliup 进程(Linux `/proc`),master 把每轮快照喂给
纯函数跟踪器算速率 / 剩余 / 卡住 / 重试与换线 / 最近结果,经 `/api/hub/queue` 下发,前端只渲染。

```
节点采集(两条入口共用一个扫描函数,async,不阻塞事件循环)
  ├─ 远端:_recording-status ──► { rooms, rolling, uploads? }      (新增可选字段)
  └─ 本机 local:LocalTransport.recordingStatus() 直接调用同一扫描(serve 进程内,async execFile)
  扫描(与在录房间同一次 /proc 遍历;找不到 biliup 进程就不跑 ss):
     /proc/<pid>/cmdline   → 白名单解析:op(upload/append)、文件列表、--line(缺 = auto)
     /proc/<pid>/stat      → 进程起始时间
     /proc/<pid>/fd + fdinfo pos → 当前打开的是第几个文件、已读字节(= 百分比口径,即 issue 的「已读字节数」)
     stat(files)           → 各文件大小(总字节、当前文件字节)
     ss -tinpH(可用时)    → 每 socket bytes_acked(只用于速率与卡住,不用于百分比)
master 状态轮询(忙 2s / 闲 10s,沿用现状) ──► UploadRunTracker(纯函数,内存)
API: GET /api/hub/queue + uploads?: NodeUploadViewDTO[](经 deps 注入,同 rollingDelivery)
web: 队列页「上传」视图,按节点分行
```

### 口径

- **百分比 = 已读字节**:当前文件 fdinfo `pos` + 之前各文件大小,除以总字节;biliup 预读会让它略超前于实际发送,
  封顶 99%,进程结束后以结果为准。
- **速率 / 卡住 = acked 增量**:只对两次采样中都存在的 socket 求差(新开 / 已关的 socket 不计),所以外部采样丢失
  已关 socket 的累计值不影响速率;master 重启只丢一个采样间隔。无 acked 增长 ≥ `stallMs`(默认 300s,与 038 同口径)
  = 疑似卡住;**没有 `ss` 时退回已读字节增长判定,并在界面注明「按读盘进度判定」**(T14 实测读盘可能停顿数分钟而发送仍在进行,
  故此时阈值放宽为 2 × stallMs,只作提示)。
- **分P 归属**:不猜文件名。当前分P = 打开的文件在 argv 文件列表中的序号(1-based)/ 文件数。
  - 边录边传:按 `.rolling.json` 的 `segments[].path` 精确匹配 → 会话与分段序号。
  - 节点侧整场上传 / 队列处理器:文件是按分P标题建的硬链接别名 → 按 inode 匹配 stage 目录下的 job → 场次 key。
  - master 本机整场管线(plain / danmu / livechat 成品):按所在 stage 子目录得场次 key,分P 标签为成品类型。
  - 匹配不到 → 场次「未知」,仍显示进度。
- **重试 vs 换线**:同一 `(node, 场次, 分P)` 先后出现不同 pid:`--line` 值变化 = 换线 +1,否则 = 重试 +1。
  采样间隔(2–10s)内开始又结束的进程看不到,计数是下限,界面注明。
- **运行记录**:pid 消失 = 一条记录结束,进入每节点最近 N 条(默认 10);边录边传的结果按 rolling 的
  confirmed / ambiguous 判定,其余为「已结束」。**只在 master 内存,重启后清空**(与 issue 的偏差,PR 中说明)。

## Global Constraints

- 只读:扫描与跟踪失败只影响展示,不得抛出到状态轮询主路径;本机路径必须 async,不得 `execFileSync`。
- 不改上传硬标准、不改任何上传 / 删源 / 台账判定;跟踪器不写台账。
- **DTO 不含任何路径、cookie 路径、标题、简介、标签**;argv 解析用白名单(只取 op、文件列表、`--line`),
  已知带值的旗标(`-u`、`--title`、`--desc`、`--tag`、`--vid`、`--submit`、`--extra-fields`、`--is-only-self` 等)整体跳过;
  场次以 key(平台:房间:日期)+ 主播名展示,稿件号沿用现有队列页口径。
- 节点能力三态:`reported:false`(旧 bundle 无字段)/ `supported:false`(无 `/proc`,如 macOS)/ 正常;
  `acked:false` 表示无 `ss`(只有读盘进度)。
- 旧 master 忽略多出的字段;旧节点 bundle 不受影响。

## Tasks

### T0 (待拍板)docker 镜像补 `ss`
- [ ] `Dockerfile` 加 `iproute2`(运行时改动,需 bump 并重新部署 master)。不做 → master 本机只有读盘进度,无字节级速率与卡住判定。
      独立 PR,`needs-decision`。

### T1 节点侧旁路扫描(orchestrator)
- [ ] `parseBiliupArgv(argv)`:白名单解析(纯函数)。
- [ ] `scanUploadProcs(deps)`:async;与在录房间共享 `/proc` 遍历结果;读 stat / fd / fdinfo;只有找到 biliup 进程才跑 `ss`;
      分P 归属按「口径」三类;依赖注入(`readdir/readFile/readlink/stat/ss/now`)。`ss` 解析复用 processors 的 `parseSsAcked`
      (orchestrator 声明对 processors 的依赖,rank 4.5 > 0.4,分层测试仍过)。
- [ ] cli `_recording-status` 输出 `uploads`;`LocalTransport.recordingStatus` 调同一函数;transport 类型加可选 `uploads`。
- **验收**:fixture 覆盖 upload / append、无 `--line`、多文件、敏感旗标不外泄、三类归属、无 `/proc`、无 `ss`、读失败。

### T2 master 跟踪器(orchestrator,纯函数)
- [ ] `UploadRunTracker.ingest(nodeId, snapshot | error, at)`:速率、剩余、卡住、重试 / 换线计数、结束归档、拉取失败保留旧值并标 stale。
- **验收**:vitest 覆盖以上各项 + socket 增减时速率不跳变 + 无 `ss` 降级口径。

### T3 API(core + app + cli 装配)
- [ ] `HubQueueDTO.uploads?: NodeUploadViewDTO[]`;`hub-jobs` 经 `deps.uploadsView?.()` 注入(同 `rollingDelivery`),cli 装配。
      只覆盖状态轮询会探测的节点(被绑定 sourceTaskId 的规则选中 + local);未探测节点不出现,界面说明。
- **验收**:API 单测覆盖有数据 / 未上报 / 不支持 / 无节点。

### T4 界面(web)
- [ ] 队列页新增「上传」视图(页内切换):按节点分行,当前分P、百分比、速率、剩余、线路、重试 / 换线次数、已运行、
      最后进展、卡住标记、最近结果;三态提示;i18n 中英同步。
- **验收**:`pnpm build` + `tsc -b`;PR 附手动核对步骤。

## 分步与门禁

每个 T 一个 PR,中间步骤写 `Part of #44`,T4 写 `Fixes #44`。T0 与 T1–T3 的文件名与内容会命中风险扫描的
上传关键词(实际只读),按规则逐个 `needs-decision` 等人放行合并。
