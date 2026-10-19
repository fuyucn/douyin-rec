# 039 队列页「上传」视图:每节点 biliup 实时进度(issue #44)

## Goal

在队列页按节点显示「此刻每个 biliup 在传什么、传到哪、是否卡住」,以及最近若干次结果。
**只读观测,不改任何上传行为**(不改 argv、不改重试/换线、不改判定、不改台账)。

## 现状与缺口(2026-10-18 核对)

| #44 验收项 | 现状 | 缺口 |
| --- | --- | --- |
| 每次 biliup 调用一条运行记录 | 队列模式(plan 038)有 proc-queue job + step;**边录边传(生产主路径)只有 `uploading{index,kind}`** | 边录边传与节点侧整场上传没有 pid / 线路 / 起始时间 / 最后进展 |
| 进度不依赖 biliup 输出 | `processors/biliup-progress.ts` 已用 `ss -tinpH` 的 `bytes_acked` 量进度,仅队列模式使用 | 边录边传 / 节点侧整场上传无字节进度 |
| 节点随状态回传、master 汇总、旧节点「未上报」 | `_recording-status` 已带回 `rooms` + `rolling`(F1),旧 bundle 缺字段降级 | 无 biliup 进程字段 |
| 界面按节点分行:分P、百分比、速率、剩余、线路、换线次数、最近结果 | 队列行内有边录边传进度与队列模式字节/速率 | 无按节点汇总视图;无线路、换线次数、剩余时间、卡住标记 |

队列模式(`nodeUpload.mode=queue`)当前未在生产启用(#207 needs-decision),所以只补它不能解决问题。

## Architecture

**不碰上传代码**:节点侧在已有的 `_recording-status` 里**旁路扫描**本机 biliup 进程(Linux `/proc`),
master 侧把每轮快照喂给纯函数跟踪器算速率 / 剩余 / 卡住 / 换线次数 / 最近结果,经 `/api/hub/queue` 下发,前端只渲染。

```
node: _recording-status ──► { rooms, rolling, uploads?: NodeUploadProc[] }   (新增可选字段)
            │  /proc/<pid>/cmdline → op/files/--line/--vid
            │  /proc/<pid>/stat     → 进程起始时间
            │  ss -tinpH            → bytes_acked(复用 parseSsAcked)
            │  stat(files)          → 总字节
master: 每 5s 状态轮询 ──► UploadRunTracker(纯函数,内存)
            │  (node,pid) 连续样本 → bps / ETA / 最后进展 / 卡住
            │  同 (node, sessionBase, 分P) 先后不同 pid → 换线次数
            │  pid 消失 → 结束一条运行记录,结果取 rolling 的 confirmed / ambiguous
API: GET /api/hub/queue  + uploads?: NodeUploadViewDTO[]
web: 队列页「上传」视图,按节点分行
```

## Global Constraints

- 只读:扫描与跟踪失败只影响展示(字段缺省 / 「未上报」),不得抛出到状态轮询主路径。
- 不改上传硬标准、不改任何上传 / 删源 / 台账判定;跟踪器不写台账,只在 master 内存。
- 非 Linux / 无 `ss` / 读不到 socket:降级为只显示状态与已运行时长(百分比、速率为 null)。
- 旧节点 bundle 无 `uploads` 字段 → 界面「未上报」,不报错;旧 master 忽略多出的字段。
- `bytes_acked` 含协议开销,百分比按 `min(acked/size, 0.99)` 封顶,进程结束后以结果为准。
- 不展示文件路径与稿件号以外的隐私:界面用分P序号 + 主播名(沿用 F1 的 anchorName 补全)。

## Tasks

### T1 节点侧旁路扫描(orchestrator + cli)
- [ ] `parseBiliupCmdline(argv)`:识别 `upload` / `append`,取文件列表、`--line`、`--vid`(纯函数)。
- [ ] `scanUploadProcs(deps)`:遍历 `/proc` 找 biliup 进程,读起始时间,`ss` 取 acked,stat 文件大小,
      按文件名映射 sessionBase 与分段序号;依赖注入(`readdir/readFile/stat/ss/now`)便于测试。
- [ ] `_recording-status` 输出 `uploads`;失败 = 省略字段。transport 的 `NodeRecordingStatus` 加可选 `uploads`。
- **验收**:fixture 覆盖 upload/append、无 `--line`、多文件、acked 读不到、非 Linux;旧 master 解析不受影响。

### T2 master 跟踪器(orchestrator,纯函数)
- [ ] `UploadRunTracker.ingest(nodeId, snapshot, at)`:按 `(node,pid)` 维护运行记录;
      bps = 最近两样本差 / 时间差;ETA = 剩余字节 / bps;无 acked 增长 ≥ `stallMs`(默认 300s,与 038 同口径)= 疑似卡住。
- [ ] 同 `(node, sessionBase, 分P)` 出现新 pid 且旧 pid 已结束 → 换线次数 +1。
- [ ] pid 消失 → 记录结束,放入每节点最近 N 条(默认 10);结果按 rolling 的 confirmed / ambiguous 判定,未知 = 「已结束」。
- [ ] 节点本轮状态拉取失败 → 保留上一份快照并标 stale(与 038 PR5 的 `polledAt` 同口径)。
- **验收**:vitest 覆盖速率与剩余计算、卡住判定、换线计数、结束归档、旧节点缺字段、拉取失败保持旧值。

### T3 API(app)
- [ ] `HubQueueDTO.uploads?: NodeUploadViewDTO[]`(core api-types),每个被状态轮询的节点一行;
      节点未上报 = `reported:false`。队列模式的 `NodeUploadStatusDTO` 保持原样,不合并。
- **验收**:API 单测覆盖有数据 / 未上报 / 无节点。

### T4 界面(web)
- [ ] 队列页新增「上传」视图(页内切换,不新增路由):按节点分行,显示当前分P、百分比、速率、剩余、线路、
      换线次数、已运行、最后进展、卡住标记,以及最近结果。i18n 中英同步。
- **验收**:`pnpm build` + `tsc -b`;PR 附手动核对步骤(有上传 / 无上传 / 旧节点 / 卡住样例)。

## 分步与门禁

每个 T 一个 PR,中间步骤写 `Part of #44`,T4 写 `Fixes #44`。T1–T3 的文件名与内容会命中风险扫描的
上传关键词(实际只读),按规则逐个 `needs-decision` 等人放行合并。
