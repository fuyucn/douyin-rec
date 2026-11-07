# 044 录制进程统一状态 + 部署不打断录制

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development 按任务逐个实现。Steps 用 checkbox 跟踪。

**Goal:** 一次解决三件事：
1. 三种录制模式（普通录制 / 边录边传 / 直播直传）的「这个录制进程在干什么」用同一份状态描述，`is-done` / `recording-status` / 部署前检查只认这一个判定。
2. 直播直传的临时分 P 文件永远不会被 hub 当录像拉走合并（11-04 等三次 needs_manual 误报的根因）。
3. 部署更新 bundle 时只重启 serve，不杀正在录的子进程；新 serve 接管它们（VPS 与 master）。

**Issue:** [#456](https://github.com/fuyucn/douyin-rec/issues/456)（用户 2026-11-04 拍板 accept）。`TODO.md` T-137。

**范围（2026-11-04 用户决定）：** 本轮只做第一期 = Goal 1、2（Task 1–3：临时分 P 跳过 + 状态文件 + 消费方切换）。Goal 3「部署不打断录制」（设计 D、E，Task 4–6）**推迟**，另开第二期；设计保留在本文件作为第二期依据。第一期的状态文件字段（owner 三元组、`exit`、`--task-id`）按第二期需要一次定好，避免二期改格式。

**评审：** 初稿经独立评审（opus）对照代码找出 3 个严重 + 5 个高危问题，本版已全部吸收，见文末「评审记录」。

## 现状（2026-11-04 实测 + 读代码）

| 问题 | 位置 | 后果 |
|---|---|---|
| 会话分组接受任何 `.ts` 名，直播直传临时分 P（live 后缀的 TS 临时文件）也被当录像 | post-process 会话分组 | hub 起普通 job 拉到 0 字节文件 → 合并失败 → needs_manual |
| 「录完没有」靠扫进程：该房间有无 ffmpeg/mesio 孙进程 | cli 节点命令 `scanRecordingRooms` | ffmpeg 退出后直播直传最后一个分 P 仍在子进程里上传，被判已收播 |
| 是否仍在工作三套实现：会话边车无状态；边录边传边车有 owner pid/heartbeat/closedAt（#309）；直播直传有分 P 状态文件 | manager / app / zero-upload | 口径分散 |
| serve 退出 = `stopAll`；子进程 stdout/stderr 是给 serve 的管道，serve 从中解析 `[状态]` 与告警 | serve 关停、recorder-process、task-manager | 部署必打断录制 |
| `--task-id` 只在 outputFormat 生效时传 | record-args | 子进程无法反查归属任务 |
| VPS unit：`Restart=always` + `KillMode=control-group`；master：node 是容器 PID 1，web 与依赖烘进镜像 | systemd / compose / Dockerfile | 同上 |
| hub 合并/烧录/上传跑在 master 的 serve 进程内 | orchestrator pipeline | 重启 master serve 会打断它们（现有检查只看处理队列里的 biliup） |

## 设计

### A. 录制进程状态文件（新文件，子进程唯一写者）

`<root>/run/rec-<taskId>.json`，**只由 record 子进程写**（原子写）。不放进会话边车：会话边车已有第二个写者（remux 标记容器，读改写无锁，#223 同类竞态），高频心跳会放大竞态并可能把状态写回旧值。

| 字段 | 说明 |
|---|---|
| `taskId`、`room`、`platform`、`mode`（file / rolling / live） | 子进程启动参数一律带 `--task-id`（不再只在 outputFormat 时带） |
| `owner` | `{ pid, startTicks, bootId }`：`/proc/<pid>/stat` 第 22 列 + 内核 boot_id，防 pid 复用与重启误判 |
| `phase` | `polling`（等开播，仅子进程自身轮询时）/ `recording` / `finalizing`（不拉流但仍在收尾：封口、上传分 P）/ `exited` |
| `heartbeatAt` | 仅 `finalizing` 期间定时写（30s）；其余阶段靠 owner 校验即可 |
| `session` | 当前会话基名；会话轮换时先写 `finalizing`/切换，不会让上一会话一直挂 active |
| `exit` | `{ code, signal, at, draining }`：所有退出路径都写（含直播直传）；被 SIGKILL 则没有 → 读方按崩溃处理 |
| `logOffset` | 见 D：子进程写日志文件的当前字节位置 |

### B. 唯一判定函数（节点侧）

`recorderActivity(file) → "active" | "ended" | "dead"`，放 core（纯逻辑，`/proc` 读取经注入；非 Linux 一律按文件内容 + 无法校验 → dead 以外不判）：
- `exited` → ended。
- 其余 phase：owner 三元组一致（pid 存活且 startTicks、bootId 相同）→ active；`finalizing` 另要求心跳未超时（3h，沿用 #309 上限）；否则 dead。

只在节点上求值。消费方：
- `is-done(room)`：该房间有 active 的状态文件（phase ≠ polling）→ 未完成；**无状态文件的房间**（老 bundle）回落现有进程扫描。不再「任一老会话 → unknown → 整个回落」。
- `recording-status`：active 且 `phase=recording`。
- 部署前检查：见 E。
- 边录边传 `rollingOwnerActive` 本计划**不改**（推迟）。

### C. hub 侧

- 会话分组跳过 「live 后缀的 TS 临时分 P」名（core 单一判定，与原子写临时名同处），覆盖当前与旧版纯时间戳命名。直播直传临时分 P 的会话基名与 `sessionBaseOf` 本就对不上（每个分 P 一个基名），所以不给 inventory 加 live 模式，直播直传结果仍走现有节点结果文件。
- 不新增「dead 会话处理」规则：普通录制仍走现有 settle + 30 分钟同场窗口（`SAME_BROADCAST_GAP_MS`），崩溃重启续录不会被提前切场。

### D. 子进程日志写文件

- spawn 时 stdout/stderr 指向 `<root>/run/task-<id>.log`；**由子进程自己轮转**（它持有 fd；serve 改名无效、copytruncate 丢行）。
- serve tail 该文件解析 `[状态]`、主播名、`@@DREC_ALERT@@`，填日志环形缓冲；web 实时日志不变。新起与接管同一路径。
- 接管时从交接清单记录的字节位置续读：既不漏 serve 停机期间的告警，也不重复发出已发过的外部通知。phase 与主播名先从状态文件恢复。

### E. 部署交接

1. **触发**：`POST /api/handover`（不用 SIGUSR1，Node 保留给 inspector）。部署脚本先探测该接口：不存在（旧版本）→ 走旧的等空闲路径，绝不靠人工参数选择。
2. **交接退出**：serve 停 HTTP / daemon / fleet / 处理队列持有者，**不 `stopAll`**；原子写交接清单 数据根 run 目录下的交接清单文件：每个任务的 pid、startTicks、日志字节位置、内存态 `expected` / `draining` / 重启计数 / `gaveUpAt`、待清理凭证文件。
3. **接管来源 = 状态文件 + `/proc` 校验**，交接清单只补内存态。所以 serve **崩溃**（无清单）时孤儿子进程照样被认领，不会被 daemon 再起一份重复录制（`KillMode=process` 下的必要条件）：
   - 有 active 状态文件的任务 → 登记为已接管 RecorderProcess，不 spawn。
   - 接管登记在 `listen` 之前完成；完成前 HTTP 手动启动、hub 同步、fleet、daemon 一律不能 spawn（`trySpawn` 前加「该任务有存活 owner」拒绝）。
4. **退出检测**：轮询 owner；退出后读状态文件 `exit`，结合交接来的 `expected` / `draining` / 重启计数交给原 `handleExit`（排空后正常收播不再被判崩溃；streamUpload 的 exit 0 规则照旧）。无 `exit` → 崩溃。凭证临时文件由接管方在退出后清理。
5. **共享数据库**：被接管的旧子进程与新 serve 共用 `proc-queue` / 主库 / 通知 outbox。**改了任何 schema 的 bundle = 不可热替换**，走等空闲（bundle 构建时写 schema 版本，部署脚本比较）。
6. **VPS**：unit 改 `KillMode=process`；部署 = 原子换 bundle（临时文件 + rename）→ `POST /api/handover` → serve 自行退出 → systemd `Restart=always` 拉起新 serve（不再 `systemctl restart`）。
7. **master（Docker）**：compose `init: true`，入口用 `tini -g` 或 `exec` 链保证 SIGTERM 到达 serve，`stop_grace_period` 加大；bundle 与 `web/dist` 从宿主机挂载；入口循环在 serve 交接退出后用新 bundle 重启。依赖（`node_modules`）/ ffmpeg / 镜像变化 → 仍重建容器、等空闲。
8. **部署前检查新规则**（`deploy-precheck.sh` 唯一实现）：
   - 热替换（bundle-only、schema 未变、节点支持交接）：录制中不阻塞；仍阻塞：处理队列 biliup、**master `/api/hub/queue` 有非终态 job**（合并/烧录/上传跑在 serve 内）。
   - 其他部署：保持现规则（任一在录即等）。
   - 首次上线本功能：旧版本不支持交接 → 等空闲。

## 兼容与边界

- 混合版本：新 master + 旧节点 → 节点无状态文件 → `is-done` 回落进程扫描；节点不支持交接接口 → 部署脚本走旧路径。
- 状态文件写失败（磁盘满）：子进程记日志继续录；读方 owner 校验仍有效（phase 停在旧值）；`finalizing` 心跳超时 → dead → 部署检查按「状态未知」fail-closed。
- 同一任务同时有存活 owner 与新 spawn 请求：一律拒绝 spawn（单一插入点 `trySpawn`）。
- 非 Linux（本地开发）：无 `/proc` → 不接管，行为同今天。

## Tasks

### Task 1：临时分 P 跳过（可单独先合并、先部署）
- [ ] core 新增临时分 P 名判定；会话分组首轮跳过。
- [ ] 测试：只有临时分 P 与直播直传弹幕文件的目录 inventory 为空；混合目录只认普通段；变异：去掉跳过 → 失败。

### Task 2：状态文件 + 判定函数
- [ ] core：状态类型、`recorderActivity`（`/proc` 注入）。
- [ ] record 子进程：一律带 `--task-id`；三种模式写 phase / owner / finalizing 心跳 / 会话轮换 / 所有退出路径写 `exit`。
- [ ] 测试：phase × pid 存活/复用/重启 × 心跳超时；SIGKILL 无 exit → dead；会话轮换不残留 active。

### Task 3：消费方切换
- [ ] `is-done`、`recording-status` 用判定函数；无状态文件回落进程扫描。
- [ ] 回归：直播直传 finalizing 期间 `is-done=false`、hub 不起普通 job（复现本次事故）。

### （第二期，推迟）Task 4：子进程日志写文件
- [ ] spawn stdio → 日志文件；子进程自轮转；serve tail（字节位置续读）解析状态与告警。
- [ ] 测试：与原管道路径解析结果一致；轮转不丢行；续读不重放告警。

### （第二期，推迟）Task 5：交接与接管
- [ ] `POST /api/handover`、交接清单、按状态文件 + `/proc` 接管、`listen` 前完成、`trySpawn` 拒绝重复、退出检测 + 内存态恢复、凭证清理。
- [ ] 测试：交接后子进程存活且被接管；停止 / 排空 / 崩溃重启语义不变（排空后正常收播不判崩溃）；serve 崩溃无清单仍认领、不重复 spawn；pid 复用不误接管。

### （第二期，推迟）Task 6：部署链路
- [ ] VPS unit `KillMode=process`；部署脚本探测交接接口、原子换 bundle、schema 版本比较。
- [ ] master：compose `init` / 信号转发 / 挂载 bundle 与 web；入口循环。
- [ ] `deploy-precheck.sh` 两种模式 + hub 队列非终态阻塞；AGENTS.md「部署安全 guard」同步。

### Task 7：上线与实测（部署由用户决定，precheck 通过后）
- [ ] 第一期：直播直传一场无 needs_manual 误报；收尾期间 `is-done=false`、`recording-status` 与 UI 一致；混合版本期间行为不变。
- [ ] 第二期（推迟）：录制中各做一次 VPS 与 master 的 bundle 部署：录制不断、分段无缺口、UI 状态连续、无重复录制、无重复告警。

## 不做

- 合并边录边传 / 直播直传的进度文件；`rollingOwnerActive` 迁移（推迟）。
- inventory 增加 live 模式、hub「只收结果」新路径（现有节点结果文件已覆盖）。
- 镜像 / 依赖 / schema 变化时的不中断（少见，等空闲）。
- 收播后子进程退回闸门（042 推迟项 b）。
- UI「旧版本运行中」标记。

## 评审记录（2026-11-04，opus 对照代码）

已吸收：会话边车双写者竞态 → 独立状态文件；serve 崩溃 + `KillMode=process` 重复录制 → 以状态文件认领、`trySpawn` 拒绝、子进程一律带 `--task-id`；接管后退出语义 → 交接内存态 + 全路径写 `exit`；临时分 P 基名不匹配 → 按名跳过、不进 inventory；unknown 回落导致新判定失效 → 按房间是否有状态文件回落；master hub 管线在 serve 内 → 检查加 hub 队列；容器入口吞 SIGTERM → tini/exec；日志 tail 漏/重放告警与轮转 → 字节位置续读 + 子进程自轮转；SIGUSR1 → HTTP 接口 + 探测；共享库 schema → 变化即不可热替换、原子换 bundle；web/dist 烘进镜像 → 一并挂载；dead 会话处理与同场窗口冲突 → 删除该规则；会话轮换残留 active；启动顺序；`Restart=always` 冲突 → 交给 systemd 拉起。
