# 多节点同步编排（master/slave）设计

> 状态：设计稿（待评审 → 实现计划）。把现在**手动**的每日同步（拉取 → LOCAL vs REMOTE 选优 → 合并/烧录 → 分P 上传 B 站）**自动化 + 多节点化**。

## 目标

多台录制节点（本地 docker、VPS 等）**对等共录**同一批直播间。任一场直播**真下播**后，自动在所有节点间挑出**覆盖最全**的一份，同步到 master，合并 + 烧录弹幕/聊天，按「P1→append」规则投稿 B 站。没有干净版本（都断）时不自动投，发 webhook 交人工。

## 角色

- **slave** = 现有 `serve`（已具备：录制 + REST API + `recordEnd`/`recordReconnect` 事件 + getLiving 权威判活）。本设计对 slave **零或极小改动**。
- **master** = 新增角色，**本身也是一个录制节点**（对等共录），额外承担：租户注册表 + 对账引擎 + 合并/烧录/上传。**一台 slave 可兼任 master**；master 可跑在任何设备上。

> master 只需在「自己录制时」在线（它录的时候本来就在线），不要求 7×24 —— 漏掉的触发由周期性兜底对账补回（见下）。

### 启动方式：集成进 serve（`task serve --hub`）

master **本就共录**（要跑 serve 才能录 + 才有 EventCenter/recordEnd），而**触发器正是它自己进程内的 `recordEnd` 事件**。因此编排器**集成进同一个 serve 进程**（`task serve --hub` 开启），**直接订阅进程内 EventCenter**，零 IPC、不轮询自己；本地节点即 `transport: local`。

- merge/burn/upload 均为 spawn 的子进程（不占 serve 主线程），且只在「那场已收播之后」执行，不与该场录制抢资源。
- 需要进程隔离时可后续加独立 `task hub`（经 API 订阅本地 + Transport 连远端）；v1 用集成最简。

## 可插拔接缝：Transport 轴

沿用现有 **平台轴（`<平台>-live`）+ 引擎轴（`record-engine`）** 的风格，新增 **Transport 轴**：master 通过 Transport 访问各 slave。

```
interface Transport {
  /** 查某场录像在该节点的清单：会话基名、分段、总时长、缺口、是否收播。 */
  listInventory(streamKey): Promise<NodeInventory | null>
  /** 该节点该场是否已收播（权威 getLiving=false 且进程已停）。 */
  isDone(streamKey): Promise<boolean>
  /** 把指定文件拉到 master 本地目录。 */
  pull(remotePaths: string[], localDir: string): Promise<void>
}
```

实现：`local`（master 自己）/ `ssh` / `tailscale-ssh`。认证（ssh key / tailscale 身份）封装在各实现内。

**租户注册表**（master 配置）：`tenants: [{ id, transport: "local"|"ssh"|"tailscale-ssh", host, dataRoot, ... }]`。`dataRoot` 即该节点的 `DOUYIN_REC_ROOT`（录像在 `<dataRoot>/recordings`，cookie 等见 [biliup 认证]）。

## 触发模型：自录 recordEnd + 兜底对账

1. **主触发**：master **自己的 `recordEnd`**，且 `reason ∈ {主播下播, 手动停止, 窗口结束收播}`（**排除 `recordReconnect`** —— 抖动重连不是结束）。这利用「master 也共录」的事实，一收播立刻触发，不依赖 master 常在线。
2. **兜底对账**：master 周期性（如每 30min）扫描各租户清单，找出「已收播但 master 没处理过」的 streamKey（台账里没有 done/failed 记录）→ 补处理。覆盖「master 那次自录触发漏了」（本机崩溃/断网）的情况。

### 跨节点状态如何一致（断链处理的核心）

**不靠节点间 gossip，所有节点都听同一个上游真相：平台 `getLiving`。**

| 场景 | 各节点行为 | master 触发？ |
|---|---|---|
| 真下播 | 各节点 `getLiving→false`，各发 `recordEnd(主播下播)`（±秒级） | ✅ settle 窗口吸收时间差 |
| 某节点抖动（流还在） | 该节点 `getLiving→true` → `recordReconnect`（非 recordEnd） | ❌ 不触发 |
| master 自己断网 | master `getLiving` **失败** → 不下「下播」结论（当 error/重连） | ❌ 不误触发；兜底对账后补 |
| slave 多扛一次重连、晚收 | slave 晚几十秒 `recordEnd` | settle + 校验该 slave done，等它或超时跳过 |

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
- 前提：同一批房间 URL 配在每个 node 上（即共录的前提）。master 配置可作为「关心哪些房间」的真相源。

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

hub 配置为 **JSON**,经 `task serve --hub --hub-config '<JSON>'` 或 settings 表 `hubConfig` 传入(`--hub` 不带配置则跳过、warn)。**模板单一真相 = 仓库源文件 [`configs/hub-config.example.json`](../configs/hub-config.example.json)**(打包时 esbuild 内联进 bundle);**数据根初始化时自动复制一份**到 `<root>/config/hub-config.example.json`(serve 启动 + `DOUYIN_REC_ROOT` 可解析时,幂等不覆盖;复制出来的是占位值,改 host/cookies/uploadMode 后用 `--hub-config` 指过去)。

| 字段 | 类型 | 默认 | 含义 |
|---|---|---|---|
| `platform` | string | `"douyin"` | 平台(聚类 / 取 roomSlug) |
| `tenants` | `Tenant[]` | `[]` | **所有录制节点**(含 master 自己) |
| `cookies` | string | `""` | biliup cookie 路径(投稿用;指 `<root>/config/biliup/cookies.json`) |
| `uploadMode` | `"auto-private"` \| `"stage-only"` | `"stage-only"` | 自动投(仅自己可见)/ 只暂存不投 |
| `uploadMeta` | `{tag, tid, desc?}` | `{tag:"直播,录像", tid:21}` | 投稿元数据 |
| `cleanMaxGapSec` | number | `30` | 「干净」阈值;winner 缺口 > 此 → 都断逃生口(webhook+人工) |
| `stageDir` | string | `"./stage"` | 拉取 / 合并暂存目录 |
| `settleMs` | number | `90000` | 收播去抖窗口(isRecording 持续 false 多久算结束) |
| `pollMs` | number | `3000` | isRecording 轮询间隔 |
| `reconcileIntervalMs` | number | `1800000` | 周期兜底对账(30min) |
| `maxWaitSec` | number | `600` | 对账前等所有节点收播的上限 |
| `settleSec` | number | `15` | 上面的轮询间隔 |

**Tenant**:`{ id: string, kind: "local"|"ssh"|"tailscale-ssh", host?: string, dataRoot?: string }`
- `local`:master 自己,无需 host;`dataRoot` = 该机数据根(扫 `<dataRoot>/recordings`)
- `ssh` / `tailscale-ssh`:`host` = 主机名/tailscale 名;`dataRoot` = 远端数据根(远端跑 `node <dataRoot>/dist/douyin-rec.mjs _inventory <dataRoot>` 出清单)

```json
{
  "platform": "douyin",
  "tenants": [
    { "id": "local", "kind": "local", "dataRoot": "/home/ubuntu/drec" },
    { "id": "vps2", "kind": "tailscale-ssh", "host": "node2.ts.net", "dataRoot": "/home/ubuntu/drec" }
  ],
  "cookies": "/home/ubuntu/drec/config/biliup/cookies.json",
  "uploadMode": "auto-private",
  "uploadMeta": { "tag": "直播,录像,抖音", "tid": 21 },
  "cleanMaxGapSec": 30,
  "stageDir": "/home/ubuntu/drec/stage",
  "settleMs": 90000, "maxWaitSec": 600
}
```

> ⚠️ 自动生成的模板 `uploadMode` 是保守的 `stage-only`(不自动投稿)——要全链路投稿改 `auto-private`,并把 `cookies` 指向 config 那份。master 自己也要在 `tenants` 里列为 `kind:"local"`(它共录,要参与选优)。

## 失败处理

- 租户不可达 → 记录 + 用现有节点继续（兜底对账下轮重试）。
- 上传失败/cookie 过期 → biliup 自带断点续传 + 重试；`failed` 作业可人工/自动重投。
- master 中途崩 → 台账 state 续跑。
- 触发漏 → 兜底对账补。

## 包与分层

新增 `@drec/orchestrator`（依赖 `core`/`app`/`post-process`，rank 待定，**须在 `test/arch/layering.test.ts` 的 RANKS 登记**）。Transport 实现注册表（`registerTransport`，对齐 `registerPlatform`/`registerEngine` 风格）。master 经 `task hub`（或 `task serve --hub`）启动；web 扩展展示租户可达性 + sync_jobs。

## 决策（默认值，已在脑暴中确认）

- **D1 slave 清单接口**：v1 用 `ssh + ffprobe + 读 gaps.json`（slave 零改动，等于现在手动做的）；后续加 `GET /api/recordings` 干净接口。
- **D2 上传**：默认 `auto-private`（自动投「仅自己可见」，你后台 review）；可切 `stage-only`（只暂存 + 通知等批）。
- **D3 清理**：成功投稿后删租户 `.ts`（留 `.xml`），**默认关**。

## 不在 v1（v2）

- **跨节点拼接**：不同节点在不同时刻断 → 跨节点按绝对时间轴拼接、重叠去重，拼出谁都做不到的无洞版本。强大但需跨节点 PTS/墙钟对齐，复杂度高 → v2。
- slave `GET /api/recordings` 专用清单接口（v1 先 ssh+ffprobe）。

## 复用现有资产

- `recordEnd(reason)` / `recordReconnect(downSec)`：触发 + 缺口数据（本会话刚做）。
- `post-process`：merge / burn(danmu·livechat)。
- biliup 上传 + `<root>/config/biliup/cookies.json` cookie（[biliup 认证]）+ 分P P1→append 规则。
- `notify`/`EventCenter`：webhook 告警 + 站内通知。
- ssh/rsync over tailscale：现有 pull 工作流。

[biliup 认证]: ../CLAUDE.md
[分P上传规则]: ../CLAUDE.md
