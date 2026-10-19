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
  ├─ 远端节点:_recording-status ──► { rooms, rolling, uploads? }   (新增可选字段)
  └─ master 自身:serve 进程每轮**无条件**扫一次(不受规则选中 / 是否有 local worker 影响 ——
     master 的合并上传管线总在容器内跑 biliup);只遍历 serve 进程的后代进程树,async execFile
  扫描(远端:cli 把 /proc 遍历得到的 pid 列表传入,与在录房间共用一次遍历;找不到 biliup 进程就不跑 ss):
     /proc/<pid>/cmdline   → 白名单解析:op(upload/append)、文件列表、--line(缺 = auto)
     /proc/<pid>/stat      → 进程起始时间
     /proc/<pid>/fd + fdinfo pos → 当前打开的是第几个文件、已读字节(= 百分比口径,即 issue 的「已读字节数」;
                             读法未实测前不定稿,见 T1a)
     stat(files)           → 各文件大小(总字节、当前文件字节)
     ss -tinpH(可用时)    → 每 socket bytes_acked(只用于速率与卡住,不用于百分比)
master 状态轮询(忙 2s / 闲 10s,沿用现状) ──► UploadRunTracker(纯函数,内存)
API: GET /api/hub/queue + uploads?: NodeUploadViewDTO[](经 deps 注入,同 rollingDelivery)
web: 队列页「上传」视图,按节点分行
```

### 口径

- **百分比 = 已读字节**:当前文件 fdinfo `pos` + 之前各文件大小,除以总字节;biliup 预读会让它略超前于实际发送,
  封顶 99%,进程结束后以结果为准。**前提待 T1a 实测**:biliup 是否顺序 `read()` 每个文件一次。若用 `pread` / mmap
  (`pos` 恒 0)、启动时一次性打开全部文件、或尾段已关 fd,则改用 `/proc/<pid>/io` 的 `rchar` 累计除以总字节,
  并保留最后一次看到的文件序号(`rchar` 含 socket 与 cookies 读取,略偏高,T1a 记录偏差);T1a 结论写回本节再进 T1。
- **速率 / 卡住 = acked 增量**:只对两次采样中都存在的 socket 求差(新开 / 已关的 socket 不计),所以外部采样丢失
  已关 socket 的累计值不影响速率;master 重启只丢一个采样间隔。无 acked 增长 ≥ `stallMs`(默认 300s,与 038 同口径)
  = 疑似卡住;**没有 `ss` 时退回已读字节增长判定,并在界面注明「按读盘进度判定」**(T14 实测读盘可能停顿数分钟而发送仍在进行,
  故此时阈值放宽为 2 × stallMs,只作提示)。
- **分P 归属**:不猜文件名。当前分P = 打开的文件在 argv 文件列表中的序号(1-based)/ 文件数。
  - 边录边传:按 rolling 边车清单 的 `segments[].path` 精确匹配 → 会话与分段序号。
  - 节点侧整场上传 / 队列处理器 / master 整场管线:**按目录归属,不按 inode**(别名可能是副本,且无模板时不建别名)。
    文件位于 `<stageRoot>/<sanitizeStreamKey(key)>/` 或其下 `.upload/` → 节点只上报该目录名(不含路径),
    master 按台账 key 经 `sanitizeStreamKey` 反查场次。stageRoot 取各节点配置的 stage 目录(master 的 stageDir 可在数据根外)。
    master 整场管线的分P 标签为成品类型(plain / danmu / livechat)。
  - 匹配不到 → 场次「未知」,仍显示进度。
- **重试 vs 换线**:同一 `(node, 场次, 分P)` 先后出现不同 pid:`--line` 值变化 = 换线 +1,否则 = 重试 +1。
  采样间隔(2–10s)内开始又结束的进程看不到,计数是下限,界面注明。
- **运行记录**:pid 消失 = 一条记录结束,进入每节点最近 N 条(默认 10);边录边传的结果按 rolling 的
  confirmed / ambiguous 判定,其余为「已结束」。

### 与 issue #44 的偏差(各 PR 与收口评论中写明)

1. 运行记录只在 master 内存,重启后清空(issue 写「记录一条」,未要求持久化;持久化会引入新的写库路径)。
2. 重试 / 换线次数是下限:采样间隔内开始又结束的进程看不到。
3. 只显示状态轮询探测的节点 + master 自身。
4. 百分比按已读字节,封顶 99%(预读),结束后以结果为准。
5. 速率与卡住用 acked 字节(T14 实测读盘会停顿而发送仍在进行);无 `ss` 时退回读盘口径并在界面注明。

## Global Constraints

- 只读:扫描与跟踪失败只影响展示,不得抛出到状态轮询主路径;本机路径必须 async,不得 `execFileSync`。
- 不改上传硬标准、不改任何上传 / 删源 / 台账判定;跟踪器不写台账。
- **节点输出与 DTO 都不含任何路径、凭证路径、标题、简介、标签**:归属在节点上完成,只上报场次 key 或 stage 目录名、
  分P 序号与字节数。argv 不按位置猜文件(`buildUploadArgs` 文件在旗标前,`buildAppendArgs` 文件在旗标后):
  **候选 = 不以 `-` 开头的 argv 项,只保留在节点上解析为 `recordings/` 或 stage 根之下的普通文件者,保持 argv 顺序**;
  不依赖各旗标的参数个数,cookies 路径与各旗标的值天然被滤掉,且路径只在节点上使用。旗标只额外读取 `--line` 的值。
  场次以 key(平台:房间:日期)+ 主播名展示,稿件号沿用现有队列页口径。
- 节点能力状态:`reported:false`(旧 bundle 无字段)/ `supported:false`(无 `/proc`,如 macOS)/
  `permitted:false`(读 `/proc/<pid>/fd`、`fdinfo` 或 `ss -p` 遇 EACCES:状态命令的 ssh 用户与服务运行用户不同,
  见 `scripts/install-worker.sh` 的服务用户)/ 正常;`acked:false` 表示无 `ss` 或无权限读 socket(只有读盘进度)。
- 旧 master 忽略多出的字段;旧节点 bundle 不受影响。

## Tasks

### T0 (待拍板)docker 镜像补 `ss`
- [ ] `Dockerfile` 加 `iproute2`(运行时改动,需 bump 并重新部署 master)。不做 → master 本机只有读盘进度,无字节级速率与卡住判定。
      独立 PR,`needs-decision`。

### T1a 实测 biliup 读文件方式(只读,不改代码)
- [ ] 在一台正有边录边传上传的 VPS 上只读查看 biliup 进程:`ls -l /proc/<pid>/fd`、`cat /proc/<pid>/fdinfo/<n>`、
      `/proc/<pid>/io`,隔 10s 采两次,确认:顺序 read 还是 pread / mmap、同一时刻打开几个视频文件、尾段 fd 是否先关、
      `ss -tinpH` 每 socket 是否长连接(短连接会让 acked 求差偏低)、状态命令用户能否读这些文件。
- **验收**:结论与命令输出(脱敏)写回本计划「口径」节;不满足前提则按口径里的降级方案定稿,再开始 T1。

### T1 节点侧旁路扫描(orchestrator)
- [ ] `parseBiliupArgv(argv)`:白名单解析(纯函数)。
- [ ] `scanUploadProcs(pids, deps)`:async;远端由 cli 传入 `/proc` 遍历得到的 pid(与 `scanRecordingRooms` 同一次遍历),
      master 自身传入 serve 后代进程;只对 biliup pid 读 stat / fd / fdinfo(每进程少量 fd,开销可忽略);只有找到 biliup 进程才跑 `ss`;
      分P 归属按「口径」三类;依赖注入(`readdir/readFile/readlink/stat/ss/now`)。`ss` 解析复用 processors 的 `parseSsAcked`
      (orchestrator 声明对 processors 的依赖,rank 4.5 > 0.4,分层测试仍过)。
- [ ] cli `_recording-status` 输出 `uploads`;transport 类型加可选 `uploads`;master 自身扫描由 cli 装配、每轮执行。
- [ ] `scanRecordingRooms` 改为同时返回遍历到的 pid 列表,传给扫描函数;master 自身按 `/proc/<pid>/task/<pid>/children`
      递归取 serve 后代进程。
- **验收**:fixture 覆盖 `buildUploadArgs` 与 `buildAppendArgs` 的真实输出(各含 / 不含 `--line`)、多文件、旗标值与 cookies 路径
  不被当成文件、敏感值不外泄、三类归属、master 后代进程递归、无 `/proc`、无 `ss`、EACCES、读失败。

### T2 master 跟踪器(orchestrator,纯函数)
- [ ] `UploadRunTracker.ingest(nodeId, snapshot | error, at)`:速率、剩余、卡住、重试 / 换线计数、结束归档、拉取失败保留旧值并标 stale。
- **验收**:vitest 覆盖以上各项 + socket 增减时速率不跳变 + 无 `ss` 降级口径。

### T3 API(core + app + cli 装配)
- [ ] `HubQueueDTO.uploads?: NodeUploadViewDTO[]`;`hub-jobs` 经 `deps.uploadsView?.()` 注入(同 `rollingDelivery`),cli 装配。
      覆盖:状态轮询会探测的远端节点(被绑定 sourceTaskId 的规则选中)+ master 自身(无条件);未探测节点不出现,界面说明。
      注意:收播后的整场上传期间轮询为闲时 10s。
- **验收**:API 单测覆盖有数据 / 未上报 / 不支持 / 无节点。

### T4 界面(web)
- [ ] 队列页新增「上传」视图(页内切换):按节点分行,当前分P、百分比、速率、剩余、线路、重试 / 换线次数、已运行、
      最后进展、卡住标记、最近结果;三态提示;i18n 中英同步。
- **验收**:`pnpm build` + `tsc -b`;PR 附手动核对步骤。

## 分步与门禁

每个 T 一个 PR,中间步骤写 `Part of #44`,T4 写 `Fixes #44`。T0 与 T1–T3 的文件名与内容会命中风险扫描的
上传关键词(实际只读),按规则逐个 `needs-decision` 等人放行合并。
