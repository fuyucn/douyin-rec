# 多节点同步编排（master/worker）设计

> **状态:已实现并实测通过(2026-06-30,双节点双平台 douyin+bilibili)。** 本文是原始设计稿;
> 实现过程中的若干演进 —— **配置文件化**(`config/hub/{platform}.{roomSlug}.json`,非 DB)、**多平台**(按 platform,roomSlug 聚类)、
> **session.json sidecar**(合并 meta+gaps)、**穿插上传**、**完整录全优先选优**、**worker UI 区分**、**受管任务下发**(绑定 source task → 按 worker 下发,远端只读,2026-08) —— 见
> [multi-node-sync-followups.md](./multi-node-sync-followups.md)(最终状态 + 实测记录),架构总览见 [architecture.md](./architecture.md)「多节点 hub」。
> 下文设计与最终实现大方向一致,细节以 followups + 代码为准。

## 目标

由 master 控制台为每个房间选择一个或多个录制节点。节点（Docker 本地 worker、VPS 等）各自运行普通录制服务；选中多个节点时才会产生冗余副本。收播后 master 发现节点录像，选出覆盖最完整的一份，拉取到 master 后合并、烧录弹幕/聊天，并按既定分 P 流程投稿 B 站。没有干净版本时不自动投，通知人工处理。

## 心智模型：受管任务下发 + 按需副本 + read-repair

容易误当成数据库 **master-slave 复制**，但要拆成两个方向看，**两侧都已实现**：

- **写侧（已实现，2026-08）= 受管任务下发**：Hub 规则绑定 master 上的源任务（`recording.sourceTaskId`），`workers` 明确该房间要在哪些 worker 录制；master 对每个选中 worker 计算期望任务并对账（local 直接写本机 store，ssh/tailscale-ssh 走隐藏 `_apply-tasks`）。远端任务标记为 `managedBy='hub'`，Web 只读、禁止改删启停；master 的源任务保持用户可编辑。任务页的启停状态表达录制意图，Hub 按规则把该状态同步给选中节点。若 worker 只选 VPS、不含 `local`，master daemon 会抑制源任务的本机录制；选 `local` 与 VPS 则两边都录。cookies 单向下发，节点本地 override（cookies/useCookie/outDir/webhook）保留；移除任务时先停，再于后续对账清理。同步在启动、周期 1min、规则/worker/源任务变更时执行，失败下轮重试。
- **读侧（已实现）= 按规则收集副本并 read-repair**：master 扫描注册 worker 的录像清单，但每个房间只保留规则选中节点的成员参与 settle 和选优。只有多个 worker 被选中时才有副本可选；单 worker 场景直接使用该节点录像。master 按覆盖度选择最完整副本，拉取后 merge/burn/发布；都断流时保留源文件并挂起交人工。文件由 master 主动读取（SSH inventory + rsync），worker 不主动 report。

所以一句话：**master 通过控制台管理录制意图与节点分配，选中节点负责录制，master 负责发现、拉取、后处理与发布；冗余录制是按需选择的。**

## 角色

- **worker** = 普通 `task serve` 进程，具备任务调度、录制和 REST API。VPS worker 不带 `--hub`，受管任务只能由 master 控制台管理。
- **master** = `task serve --hub` 进程，提供 Web 控制台、任务同步、跨节点清单/选优、合并/烧录/上传。Docker master 同时注册一个 `local` worker，因此可以录制分配给本机的房间；但这不是必选行为。角色是进程职责，不要求不同职责必须部署在不同机器上。

> master 需要在线才能同步任务、发现录像并运行后处理。VPS 可独立按已同步的 enabled 状态调度录制；master 离线期间的远端录制会留在 VPS，master 恢复后由周期对账发现并处理。

### 启动方式：集成进 serve（`task serve --hub`）

编排器集成在 `task serve --hub` 进程中，直接订阅该进程的 EventCenter；本机录像由 `local` transport 读取。即使该房间只分配给远端 worker，master 仍可同步配置、扫描远端、拉取并后处理，不要求 master 为该房间启动本地录制。

- merge/burn/upload 均为 spawn 的子进程（不占 serve 主线程），且只在「那场已收播之后」执行，不与该场录制抢资源。
- 需要进程隔离时可后续加独立 `task hub`（经 API 订阅本地 + Transport 连远端）；v1 用集成最简。

## 可插拔接缝：Transport 轴

沿用现有 **平台轴（`<平台>-live`）+ 引擎轴（`record-engine`）** 的风格，新增 **Transport 轴**：master 通过 Transport 访问各远端 worker。

```
interface Transport {
  /** 查某场录像在该节点的清单：会话基名、分段、总时长、缺口、是否收播。 */
  listInventory(streamKey): Promise<NodeInventory | null>
  /** 该节点该场是否已收播（权威 getLiving=false 且进程已停）。 */
  isDone(streamKey): Promise<boolean>
  /** 把指定文件拉到 master 本地目录。 */
  pull(remotePaths: string[], localDir: string): Promise<void>
  /** 该节点当前正在写流的房间(供控制台展示实际录制位置)。 */
  activeRecordingRooms?(): Promise<{ platform: string; roomSlug: string }[]>
}
```

实现：`local`（master 自己）/ `ssh` / `tailscale-ssh`。认证（ssh key / tailscale 身份）封装在各实现内。

**远端走 SSH 隐藏命令**，不要求 worker 跑额外服务：`_tasks`（任务清单，无 cookies）、
`_apply-tasks`（下发期望任务）、`_inventory`（扫描录像清单）、`_is-done`（该房间是否仍在录）、
`_disk`（数据根剩余空间）、`_recording-status`（当前正在录制的房间集合，仅轻量扫 `/proc`）。
`_recording-status` 用于主控控制台显示远端录制状态；尚未更新 bundle 的旧 worker 会回退到
`_tasks` + `_is-done` 查询，功能不变。

**Worker 注册表**（master 配置）：`workers: [{ id, name?, kind: "local"|"ssh"|"tailscale-ssh", host?, dataRoot?, ... }]`（旧名 `tenants` 兼容，读取时 `workers ?? tenants`，首次写入迁移为 `workers`）。`local` 是运行 master 的本机；Docker 部署时即 Docker 容器。`dataRoot` 即该节点的 `DOUYIN_REC_ROOT`（录像在 `<dataRoot>/recordings`，cookie 等见 [biliup 认证]）。

## 触发模型：本地 recordEnd + 周期对账

1. **本地即时触发**：如果 master 的 `local` worker 正在录该房间，本机 `recordEnd` 可在结束后即时启动对账；`recordReconnect` 不代表整场结束。
2. **远端与恢复触发**：远端 worker 的 `recordEnd` 事件不会直接作为 master 本地事件转发。master 通过周期 `reconcileAll` 扫描已收播录像，并在 settle 确认成员已结束后处理。因此远端单节点录制的最终处理时机受 `reconcileIntervalMs` 影响；master 离线期间录制的内容也会在恢复后扫描。

**收播后的重连窗**：一场结束后不足 `reconnectWindowMs`（默认 10 分钟）时，对账会跳过该场，
避免同一房间短时间内的第二场撞上同一个 `streamKey`，也避免边录边合并残片。测试时可用
Hub 房间页的「立即执行」跳过等待。

## 控制台如何显示远端录制状态

master 侧任务 API 不再只反映本机进程。`startHub` 启动后，master 每 **5 秒** 通过
Transport 查询各 worker 的活动录制房间，按房间规则选出参与节点，结果缓存后随
`GET /api/tasks` 的 `recordingWorkers` 字段返回（`{ workerId, workerName, state }`，
`state ∈ recording | not_recording | unavailable`）。因此：

- 源任务只分配给 VPS 时，主控任务列表与详情页显示「录制中 · <节点名>」，顶部「录制中」
  统计也计入远端房间；
- 节点不可达时显示「节点离线」并计入错误统计；
- 页面每 2 秒轮询任务 API，但 SSH 查询只每 5 秒发生一次，且不阻塞请求。

### 跨节点状态如何一致（断链处理的核心）

**不靠节点间 gossip，所有节点都听同一个上游真相：平台 `getLiving`。**

| 场景 | 各节点行为 | master 触发？ |
|---|---|---|
| 真下播 | 各选中节点 `getLiving→false`；各自结束本地录制 | local 的 `recordEnd` 可即时触发；远端结果由周期扫描发现 |
| 某节点抖动（流还在） | 该节点 `getLiving→true` → `recordReconnect`（非整场结束） | 等本地结束事件或周期扫描；settle 校验仍在录制的节点 |
| master 本机断网 | 若 local 正在录制，`getLiving` 失败按错误/重连处理，不误判下播 | 后续本地事件或周期对账补处理 |
| 远端节点晚结束 | worker 继续重连，直到本节点确认结束 | master 周期扫描发现，settle 等待节点录制结束或超时 |

### 识别一致性：跨节点如何认定「同一场」

**用平台的稳定房间标识配对，绝不用 node 内部 task id（各 node 的 DB 各自编号，必然不同），也不用 liveId（每场的、还可能解析过期/不一致）。**

**`streamKey` = 一场直播的唯一标识**，两个用途：① 跨 node 把「同一场」的录像归为一组；② 作 `sync_jobs` 台账的**幂等主键**（一场一作业，杜绝重复处理/重复投稿）。形如 `平台:roomSlug:<时间标签>`，如 `douyin:411477943168:2026-06-27`。

- **roomSlug** = `platform.extractRoomSlug(roomUrl)`（如 `live.douyin.com/411477943168` → `411477943168`），**跨 node 一致**（各 node 配的是同一个房间 URL）。这是配对主键。
- **streamKey 由 master 聚类后赋予，不是各 node 各自计算**（关键，避免开录秒级差导致 key 不一致）：
  1. master 收集某 roomSlug 下**所有 node** 的录像（各自开录/收播时间窗）；
  2. 按**时间窗重叠**聚簇——一簇 = 一场广播（07-54-33 与 07-54-48 重叠 → 同簇；据此区分同房间同一天的早场/晚场——窗不重叠即两簇）；
  3. 给该簇赋一个**规范 streamKey**（簇日期，同一天多场则用取整到分钟的早场标签如 `2026-06-27_0754`）。「时间标签」只是给人/台账看的，跨 node 的秒级差在「聚类」这步已吸收。
- **不用 node 内部 task id**（各 node DB 各自编号，必然不同）、**不用 liveId**（每场的、可能解析过期/不一致）。
- **node→room 关联**：落盘目录按 `anchorName/`（可能因改名/自定义名不可靠），但每个 node 的 task 知道自己的 room URL → roomSlug；master 查各 tenant 的 `/api/tasks`（返回 room）即可把「该 tenant 的某场录像」对到 roomSlug，task id / anchorName 目录差异都不影响。
- 前提：**同一批房间 URL 由 master 下发到每个 worker**（hub 规则绑定源任务后自动对账，不再靠人工镜像）；master 的规则文件是「关心哪些房间」的真相源。

## 对账引擎（核心流程）

按 streamKey 串一条幂等流水线（每场一作业，台账见下）：

1. **settle**：触发后等 ~1–2min（可配），吸收各节点收播时间差。
2. **校验 + 收清单**：对每个租户 `isDone` + `listInventory`；对仍在录的，轮询等待至 `maxWait` 或跳过。
3. **选优（覆盖度，非时长）**：见下。
4. **逃生口判定**：是否存在「干净」节点。
5. **同步**：把胜者的分段 + `.xml` `pull` 到 master（master 自己赢则免拉）。
6. **合并**：`merge` → `{主播}_{日期}.mp4`（复用 `post-process`）。
7. **烧录**：`burn --style danmu` + `--style livechat`（复用 `post-process`）。
8. **上传**：**P1 plain `upload` → 解析 BVID → `biliup append --vid <BV>` 追加 P2 danmu / P3 livechat**（见 [分P上传规则]）。仅自己可见 + 关水印 + config cookie。
9. **台账落地** + 可选清理。

### 选优：覆盖度（谁的洞最少）

不再比「总时长最长」，而比 **coverage**：

- **缺口数据来源**：节点录制时的 `recordReconnect(downSec)` + 真下播/重连事件已记录每次断流时刻与时长。每个节点把本场的**断流区间 + 总缺口秒数**持久化为 sidecar（如 `{base}.gaps.json`），`listInventory` 连同总时长一并上报。
- **coverage = 实录时长 / 该场墙钟跨度**（或等价：`1 - 总缺口/跨度`）。缺口越少越高。
- **胜者 = coverage 最高**；持平时倾向可配置（默认倾向 REMOTE，对齐现状）。
- 天然解决「A 抖了一下、B 没抖 → 选 B」。

### 逃生口：都断（无干净版本）→ webhook + 人工

- **「干净」阈值**（可配）：如总缺口 ≤ 30s 或 coverage ≥ 99%。
- **≥1 节点干净** → 自动选最优，照常 merge/烧/投。
- **无一节点干净** → **不自动投稿**；作业置 `needs_manual`；发 **webhook**（复用现有 `notify`/`EventCenter`），附**各节点 coverage 对比**；master 同时把**最优那台先 merge 暂存**，便于人工 review。人工选项：① 强行选某台（接受带洞）② 跳过 ③（v2）触发跨节点拼接。

## 数据模型

- **`sync_jobs` 台账（master sqlite）**，按 streamKey（`平台:roomSlug:时间标签`，master 聚类赋予，见[识别一致性](#识别一致性跨节点如何认定同一场)）：
  `state ∈ pending|settling|syncing|merging|uploading|done|failed|needs_manual`；记录 seen 租户 + 各自 coverage + 胜者 + BV + 时间戳 + 错误。**幂等**（一场一作业）、**可续**（master 重启按 state 续跑）、**绝不重复投稿**。
- **`{base}.gaps.json` sidecar（各节点）**：`{ sessionBase, gaps: [{startMs, endMs}], totalGapSec, coverage }`。由节点的 session 在 `recordReconnect`/offline 时累积写入。

## 配置

hub 全局配置为 **JSON**，路径 `<root>/config/hub.config.json`（旧名 `hub-config.json` 自动兼容）。解析优先级：`--hub-config`（文件路径 → 读文件 / 否则当内联 JSON 串）> settings 表 `hubConfig` > 自动读 `<root>/config/hub.config.json`。**约定（推荐）**：数据根初始化时自动复制一份模板到 `<root>/config/hub.config.example.json`，改成同目录 `hub.config.json` 后直接 `task serve --hub`（无需 `--hub-config`）自动加载；三者都没有则跳过、warn。模板单一真相 = 仓库源文件 [`configs/hub.config.example.json`](../configs/hub.config.example.json)（打包时 esbuild 内联进 bundle）。

| 字段 | 类型 | 默认 | 含义 |
|---|---|---|---|
| `platform` | string | `"douyin"` | 默认平台（聚类 / 取 roomSlug） |
| `workers` | `Worker[]` | `[]` | 注册的录制节点（含可选的 master 本机 `local`；旧名 `tenants` 兼容）。房间规则未设置 worker 列表时，为兼容旧规则会匹配全部 worker |
| `cookies` | string | `""` | biliup cookie 路径（投稿用；指 `<root>/config/biliup/cookies.json`） |
| `stageDir` | string | `"./stage"` | 拉取 / 合并暂存目录 |
| `cleanMaxGapSec` | number | `30` | 「干净」阈值；winner 缺口 > 此 → 都断逃生口（webhook+人工） |
| `settleMs` | number | `90000` | 收播去抖窗口（isRecording 持续 false 多久算结束） |
| `pollMs` | number | `3000` | isRecording 轮询间隔 |
| `reconcileIntervalMs` | number | `1800000` | 周期兜底对账（30min） |
| `syncIntervalMs` | number | `60000` | 受管任务下发对账周期（1min） |
| `maxWaitSec` | number | `600` | 对账前等所有节点收播的上限 |
| `settleSec` | number | `15` | 上面的轮询间隔 |
| `uploadDefaults` | `{tag,tid,titleTemplate?}` | `{tag:"直播,录像", tid:21}` | 投稿元数据默认（旧名 `uploadMeta` 兼容） |

**Worker**：`{ id, name, kind: "local"|"ssh"|"tailscale-ssh", host?, dataRoot? }`
- `local`：master 自己，无需 host；`dataRoot` = 该机数据根（扫 `<dataRoot>/recordings`）
- `ssh` / `tailscale-ssh`：`host` = 主机名/tailscale 名；`dataRoot` = 远端数据根（远端跑 `node <dataRoot>/dist/douyin-rec.mjs _tasks <dataRoot>` / `_apply-tasks` 出清单/收下发）

```json
{
  "platform": "douyin",
  "workers": [
    { "id": "local", "name": "本机(master)", "kind": "local", "dataRoot": "/home/ubuntu/drec" },
    { "id": "vps2", "name": "香港 VPS", "kind": "tailscale-ssh", "host": "node2.ts.net", "dataRoot": "/home/ubuntu/drec" }
  ],
  "cookies": "/home/ubuntu/drec/config/biliup/cookies.json",
  "stageDir": "/home/ubuntu/drec/stage",
  "cleanMaxGapSec": 30,
  "settleMs": 90000, "pollMs": 3000, "reconcileIntervalMs": 1800000,
  "syncIntervalMs": 60000, "maxWaitSec": 600, "settleSec": 15,
  "uploadDefaults": { "tag": "直播,录像,抖音", "tid": 21 }
}
```

> ⚠️ 全局兜底 = `stage`（只合成不投）。要让某房间全链路投稿，在其 `config/hub/{platform}.{roomSlug}.json` 的 `pipeline.upload.mode` 设 `"upload"`（`private` 默认 true = 仅自己可见），并把 `cookies` 指向 config 那份。Docker master 的 `local` worker 由 Hub 使用；只有规则将 `local` 选入 `workers`，该房间才会在 Docker 本机录制。

## 受管任务下发（hub → worker，2026-08）

hub 规则（`config/hub/{platform}.{roomSlug}.json`）新增 `recording.sourceTaskId` + `workers` 后，master 自动把录制任务下发给选中节点。日常操作从 master Web 控制台的任务页和 Hub 页完成：

1. 在任务页创建房间任务；该任务在 master 上作为可编辑的源任务。
2. 在 Web「Hub」页建/编辑规则时绑定该任务（`recording.sourceTaskId`，房间身份从任务派生，不再手填房间 URL）并选择参与节点（`workers`）。
3. master 对每个 worker 计算期望任务：启用的规则 + 绑定的源任务 + worker 在房间规则 `workers` 里。旧规则若未写 `workers`，为兼容行为会同步给全部 worker；控制台编辑规则时应明确选择目标节点。
4. 源任务的 enabled 状态表示录制意图，并同步到选中的节点。规则选 `["vps2"]` 时，本机 daemon 抑制对应源任务，避免 master 与 VPS 双重录制；规则选 `["local","vps2"]` 时才会两边都录。
5. 下发走 Transport 轴：local = 直接写本机 store（`adopt=false`，源任务保持可编辑）；ssh/tailscale-ssh = 远端隐藏命令 `_tasks` / `_apply-tasks`（`_tasks` 输出无 cookies 的隐私投影；cookies 只随下发通道单向传递）。
6. 远端按 `(platform, roomSlug)` 对账：新建或收编更新受管任务（`managedBy='hub'`），不再期望的任务两阶段删除（先停，等 daemon 收播后下一轮删）。受管任务 Web API/UI 禁止改删启停，只能在 master 操作。
7. 同步触发：启动即跑 + 周期 `syncIntervalMs`（默认 1min）+ 规则/worker/源任务变更后立即触发；节点离线只 warn，下轮对账自愈。

## 清理开关语义（2026-10 实测确认）

### 文件名 / 稿件名 / 分 P 名（三个独立概念，2026-10-06）

**背景**：biliup 的分 P 标题没有 CLI 参数可指定 —— `crates/biliup/src/uploader/line.rs` 里写死
「`video.title` 为空 → 取**文件名 stem**」。而稿件标题(`uploader.rs`)只在 `--title` 为空时才回退到
第一个文件的 stem。所以过去「稿件名 = 第一个视频的文件名」不是巧合，是这套机制的必然结果。

**现在三个概念彻底拆开**(`pipeline.upload`)，**三项都空 = 历史行为**：

| 字段 | 作用 | 缺省（空） |
|---|---|---|
| `titleTemplate` | **文件名规则** —— 磁盘上的 stage 产物 stem（也是下面两项的默认值） | `{name}_{date}` |
| `submissionTitleTemplate` | **B 站稿件标题** —— 整稿总标题，可含空格/标点，不参与文件名 | 回落文件名规则 |
| `partTitleTemplate` | **分 P 视频标题** —— 点进去后 P1/P2/P3 各自的名字 | 回落文件名规则（= 现在的行为） |

`partTitleTemplate` 额外可用 `{part}`(序号)、`{parts}`(总数)。**类型后缀由 pipeline 自动追加**，
模板里不需要(也没有)`{kind}`：

- `plain` → 无后缀；`danmu` → `_danmu`；`livechat` → `_livechat`。
- 后缀与「不配 `partTitleTemplate`」时 stage 产物的默认命名完全一致，所以一条模板
  (`{name}_{date}`)就能让 P1 无后缀、P2/P3 自动带后缀，不需要为 plain 单独写规则。
- 分段模式(`mergeSegments=false`)同类分 P 有多个，必须带 `{part}` 才能区分；否则同名会
  触发兜底改名(`-P{n}`)并在 job 日志告警。

```jsonc
{
  "upload": {
    "titleTemplate": "{name}_{date}_{HH}-{mm}-{ss}",   // 文件名 → 某某_2026-10-06_12-08-22.mp4
    "submissionTitleTemplate": "{name}_{date} 直播回放", // 稿件名 → 某某_2026-10-06 直播回放
    "partTitleTemplate": "{name}_P{part}"               // 分P名 → 某某_P1 / 某某_P2 / 某某_P3
  }
}
```

**实现方式**：

- **稿件名**：直接作为 `biliup upload --title` 传入（biliup 只在 `--title` 为空时才回退文件名，
  所以传了就生效）。走宽松渲染，允许空格/标点/emoji。
- **分P名**：没有 CLI 参数，故上传前把产物**硬链接**到 `<stage>/.upload/<分P标题>.mp4`，
  再把该路径交给 biliup。要点：

- 硬链接，不是改名 —— **规范产物名从不移动**，所以 `deriveStageProducts` 的续跑幂等推导、
  `stageSourceAfterMerge` / `stageAfterDone` 的清理逻辑都不受影响。
- 硬链接不可用时(跨设备)回落复制。
- 别名目录在 `stageAfterDone` 时整体删除；保留 stage 时也不额外占盘(硬链接共享 inode)。
- 未配置 `partTitleTemplate` → 完全不建别名，走原路径，行为与改动前一致。

`pipeline.cleanup` 三个开关彼此独立，实测口径如下（房间 什么佳 50620112379，双节点链路）：

| stageSourceAfterMerge | sourceAfterDone | stageAfterDone | 结果 |
|---|---|---|---|
| on | on | on | 合并/烧录完成后删 stage 里的拉来源 `.ts`（含 `.xml`/`.ass` 副本）；上传成功后删各节点原始 `.ts`，**保留节点源 `.xml`**（成为最后一份）；最后清空 stage 产物。实测 BV11WHZ6tENt。 |
| on | on | **off** | 同样删除拉来源与节点源 `.ts`，但**保留 stage 里的合并/烧录产物与 `.xml`/`.ass`**，节点源 `.xml` 被删（副本在 stage）。实测 BV1C4HZ6xEbi。 |
| on | off | off | 节点源录像保留，stage 保留；仅删 stage 里的拉来源。 |

不变量：**stage 保留 → 节点源 `.xml` 可删（副本在 stage）；stage 不保留 → 节点源 `.xml` 必留**。
`xmlKeepRule()` 是唯一判定点，任何组合都不会出现 `.xml`/`.ass` 两处同时被删空。

## 失败处理

- 租户不可达 → 记录 + 用现有节点继续（兜底对账下轮重试）。
- 上传失败/cookie 过期 → biliup 自带断点续传 + 重试；`failed` 作业可人工/自动重投。
- master 中途崩 → 台账 state 续跑。
- 触发漏 → 兜底对账补。

## 包与分层

`@drec/orchestrator`（L4.5，依赖 `core`/`app`/`post-process`，已在 `test/arch/layering.test.ts` 的 RANKS 登记）。Transport 实现注册表（`registerTransport`，对齐 `registerPlatform`/`registerEngine` 风格）。master 经 `task serve --hub` 启动；受管任务下发 = app 层 `task-sync`（`listNodeTasks` / `applyRemoteTasks`）+ `Transport.applyTasks`（远端 `_tasks` / `_apply-tasks` 隐藏子命令）。web 扩展展示 worker 可达性 + hub jobs。

## 决策（默认值，已在脑暴中确认）

- **D1 worker 清单接口**：v1 用 `ssh + ffprobe + 读 gaps.json`（worker 无需单独实现清单 API）；后续加 `GET /api/recordings` 干净接口。
- **D2 上传**：默认 `auto-private`（自动投「仅自己可见」，你后台 review）；可切 `stage-only`（只暂存 + 通知等批）。
- **D3 清理**：成功投稿后删租户 `.ts`（留 `.xml`），**默认关**；清理开关语义见上文表格，2026-10-06 已实测两组组合。

## 不在 v1（v2）

- **跨节点拼接**：不同节点在不同时刻断 → 跨节点按绝对时间轴拼接、重叠去重，拼出谁都做不到的无洞版本。强大但需跨节点 PTS/墙钟对齐，复杂度高 → v2。
- worker `GET /api/recordings` 专用清单接口（v1 先 ssh+ffprobe）。

## 复用现有资产

- `recordEnd(reason)` / `recordReconnect(downSec)`：触发 + 缺口数据（本会话刚做）。
- `post-process`：merge / burn(danmu·livechat)。
- biliup 上传 + `<root>/config/biliup/cookies.json` cookie（[biliup 认证]）+ 分P P1→append 规则。
- `notify`/`EventCenter`：webhook 告警 + 站内通知。
- ssh/rsync over tailscale：现有 pull 工作流。

[biliup 认证]: ../CLAUDE.md
[分P上传规则]: ../CLAUDE.md
