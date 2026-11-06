# 042 Worker 轻量化：节点 agent 长连接 + 按需录制进程

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (或 subagent-driven-development) 按任务逐个实现。Steps 用 checkbox 跟踪。

**Goal:** 让两台 Oracle E2.1.Micro worker（2 vCPU / 1/8 OCPU 保底 / 956MB）在当前 9 / 11 房间分配下不再被 CPU 限速、不靠 swap 撑内存；master↔worker 控制面从「每次 ssh 拉起一个 node 进程」改为「节点常驻 serve 主动维持一条长连接」。

**Architecture:** 参照 biliup Fleet（PR #1754）：节点只出站连接 controller，长连接上跑心跳 + 事件 + 请求/应答；节点 agent 跑在已常驻的 `task serve` 进程内，不新增进程。我们已有 tailscale（网络 + 加密），不需要 iroh/relay，传输用 WebSocket（`ws@8.21.0` 已是现有依赖，零新增）。ssh 只保留给 rsync 拉文件与部署；旧 bundle / 连接断开时控制面回落现有 ssh 路径。数据面（录像文件）不变。

**Tech Stack:** Node 24 / TypeScript / `ws` / vitest。

**Spec:** 本文件「背景与实测」「协议」两节。

## 背景与实测（2026-11-03，只读）

| 项 | worker A（9 房间，1 在录） | worker B（11 房间，0 在录） |
|---|---|---|
| load / CPU steal | 4.3–4.9 / 75–77% | 0.3 / 17–47% |
| CPU PSI some avg60 | 43% | 7% |
| memory PSI full avg60 | 5.6% | 0.2% |
| swap used | 440MB | 305MB |

**CPU：master 控制面拉起的 node 进程 ≈ 28 个/分钟/节点**（每个 0.7–0.8s CPU、峰值 ~80MB，≈0.4 vCPU 常驻，超过保底算力）：

| 命令 | /分 | 来源 |
|---|---|---|
| `_recording-status` | 10 | `cli.ts` 自适应探测：有节点在录 2s / 空闲 10s，ssh 慢时自限 |
| `_notify-outbox` | 6 | `serve.ts` 通知中继每 10s 拉 + ack |
| `_is-done` | 5 | `reconciler` settle 循环每 `pollMs`=3s |
| `_inventory` + `_disk` | 4 | `reconcileAll`，hub 全局配置 里 `reconcileIntervalMs: 8000`（代码默认 30min）；带锁，实际周期 ≈ 单轮耗时 ~30s；inventory 对每个文件跑 ffprobe |
| `_apply-tasks` / `_node-status` / `_zero-disk-report` | 3 | 任务同步 `syncIntervalMs` 60s |

**内存：** 等开播 `record` 子进程私有 ~45MB/个（RssAnon 14 + swap 30）；在录 ~170MB/个（RssAnon 138 + swap 34）；serve ~47MB；ffmpeg ~10MB / ~1% CPU。网络：worker→master 的 tailscale 地址 `:7860` 与 master→worker `:7860` 经 tailscale 均实测 200。

## 预期效果（上线后用同一方法复测：vmstat、`/proc/pressure/*`、60s ps 采样、`/proc/<pid>/status`）

| 指标（单台 worker） | 现在 | Task 1–4 后 | Task 6 后 |
|---|---|---|---|
| 控制面拉起的 node 进程 /分 | ~28 | 0（连接正常时） | 0 |
| 控制面 CPU | ~0.4 vCPU | < 0.02 vCPU | 同左 |
| worker A 空闲 CPU steal | 75% | < 20% | < 20% |
| worker A CPU PSI some avg60 | 43% | < 10% | < 10% |
| 收播被 master 发现的延迟 | ~30s 扫描 + 90s settle | 事件即时 + 90s settle | 同左 |
| 控制台录制状态时效 | 2–10s（ssh 慢时更差） | ≤ 10s（心跳）/ 即时（事件） | 同左 |
| 待命内存（全部未开播） | ~650MB | 同左 | ~60MB |
| swap 使用 | 300–440MB | 同左 | < 100MB |
| 可安全同时录制路数 | 估 2–3 | 估 2–3 | 估 4–5 |

不承诺：biliup 边录边传期间的占用；在录进程 170MB 本身（Task 5 只出数据）。

## 协议（`fleet/1`，节点出站、WebSocket over tailscale）

- 端点：master `GET /api/fleet/ws`（HTTP upgrade）。节点连 `hub` 地址来自节点 fleet 配置 `{controllerUrl, nodeId, 凭据}`（0600）。
- 鉴权：master 为每个 worker 生成 32 字节凭据，存 master 侧 master 侧 fleet 凭据表 只存 SHA-256；下发给节点走一次现有 ssh（隐藏命令 `_fleet-join <dataRoot> <base64>` 写 节点 fleet 配置）。`Hello` 带 `nodeId + 凭据`，master 常量时间比较；失败 close code `4401` 节点停止重连 10 分钟。
- 帧：JSON 文本帧，单帧 ≤ 4MiB。`{t:"hello"|"heartbeat"|"event"|"req"|"res"|"welcome", ...}`。
- 节点 → master：
  - `hello {nodeId, 凭据, appVersion, protocol:1, capabilities:string[]}`
  - `heartbeat`（每 10s）`{recording: RecordingStatus（同 _recording-status 的 JSON）, diskFreeGB, procActive, nodeStatus（同 _node-status）, inventoryRev:number}`
  - `event {id:number, kind:"record-start"|"record-end"|"notify"|"inventory-changed", payload}`；`notify` 复用 notify-outbox 行，master 回 `res {ackIds}` 后节点 ack，断线未 ack 的重连后重发（at-least-once，master 按 id 去重）。
- master → 节点：`req {id, cmd, args}`，`cmd` ∈ 现有隐藏命令名（`inventory`/`tasks`/`apply-tasks`/`enqueue`/`proc-status`/`proc-cancel`/`task-logs`/`zero-disk-report`/…）；节点 `res {id, stdout, exitCode}` —— **stdout 与 CLI 字节一致**，`SshTransport` 解析代码不动。超时与现有 ssh 预算一致（8s / 45s / 长任务独立预算）。
- 存活：ws ping 5s；master 30s 无任何帧 → 该节点状态 `unavailable`（**不是**「未在录 / 文件已删」，#146 口径）；节点断线 1–30s 指数退避重连；同 nodeId 新连接顶替旧连接。

## 实现期设计修订（2026-11-03）

- **通知不做推送**：`notify` 仍由 master 每 10s 拉取，只是改走长连接 `req`（不再拉起进程）。省掉 at-least-once/去重/ack 的一整套新语义，CPU 收益相同。`event` 帧暂不实现。
- **心跳只带原样 stdout**：`recording-status` / `disk` / `node-status` 三条命令的输出原样缓存在 master，`SshTransport` 的解析代码零改动；`is-done` 由缓存的在录房间直接推出。
- **接入方式**：hub 全局配置 加 `fleet.controllerUrl`（master 被 worker 访问的 tailscale 地址）才启用（opt-in，需重启 master 生效）；master 每分钟检查未连上的 ssh 节点，最多每 30 分钟经 ssh `_fleet-join`（配置走 stdin）下发一次凭据；节点 serve 每分钟重读 节点 fleet 配置，无需重启。
- **回落**：未连接 / 超时 / 未知命令 / 数据根不符 → 原 ssh 路径；命令自身失败（非 0）照常抛错，不重试 ssh。经长连接路由的命令都幂等，回复丢失后走 ssh 重试是安全的。
- **存活判定**：master 只把请求路由给 25s 内收到过帧的节点（心跳每 10s），半开连接立即回落 ssh；45s 无帧才断开连接。与上文「ping 5s / 30s 判离线」的差异是有意的：路由新鲜度比断开阈值更紧。
- **凭据下发**：先经 ssh 写到节点，节点确认写入后 master 才存新哈希；下发失败不吊销节点手上的旧凭据。
- **本期不做（另立任务）**：Web 节点页显示「长连接 / ssh 回落」；inventory 的 `inventoryRev` 门控（master 仍按对账周期请求 inventory，靠 Task 4 的 ffprobe 缓存降成本）；收播事件即时触发单房间对账（当前心跳发现在录房间变化只刷新控制台状态，收播仍由周期对账发现）。「预期效果」表中对应两行以本条为准。

## Global Constraints

- 代码与注释英文；plan / TODO / commit 描述按仓库约定中文。
- 所有隐藏命令的 stdout 契约字节不变；长连接路径与 ssh 路径共用同一份命令实现（Task 1 注册表），不得写第二套逻辑。
- 旧 bundle、未 join、连接断开 → 控制面自动回落 ssh，行为与现在完全相同。
- 凭据不进 节点身份文件、`_node-id` 输出、日志、UI、issue；master 只存哈希。
- #308：判活频率不高于现在（每房间 ~30s）；未开播不得以非 0 退出换重启。
- 分层：`app` 不 import `orchestrator`；命令注册表在 `cli`，以依赖注入给 `app`。
- 运行时路径改动 → bump version + `pnpm bundle`。部署不在本 plan 内（人做，过 `scripts/deploy-precheck.sh`）。

## Review Focus

1. master 重启：所有节点同时重连 → master 侧 `hello` 处理不得阻塞事件循环；重连期间控制台显示 `unavailable` 而非「未在录」。
2. 事件丢失：master 在事件到达前崩溃 → 节点未收 ack 必须重发；`record-end` 重复到达只触发一次对账（按事件 id 去重）。
3. 半开连接（tailscale 断流、TCP 未 RST）→ 30s 无帧判离线，req 超时回落 ssh，不得挂死对账。
4. 节点版本新于 master / 旧于 master：`protocol` 不一致 → 不连（回落 ssh），未知 `cmd` → `res {exitCode:127, stdout:"unknown command"}`，master 侧按 `isUnknownCommand` 走现有降级。
5. 判活闸门（Task 6）与启停：UI 停止、窗口结束、删除任务必须立刻取消闸门轮询。

---

### Task 1: 隐藏命令实现抽成注册表（行为不变）

**Files:** Create `packages/cli/src/node-commands.ts`；Modify `packages/cli/src/cli.ts`（`_recording-status`、`_is-done`、`_inventory`、`_disk`、`_tasks`、`_apply-tasks`、`_node-status`、`_notify-outbox`、`_zero-disk-report`、`_enqueue`、`_proc-status`、`_proc-cancel`、`_task-logs` 的 action 改调注册表）；Test `test/cli/node-commands.test.ts`

**Produces:**
```ts
export interface NodeCommandResult { stdout: string; exitCode: number }
export type NodeCommand = (dataRoot: string, args: string[]) => Promise<NodeCommandResult>;
export const NODE_COMMANDS: Readonly<Record<string, NodeCommand>>; // key = command name without "_"
```
- [ ] 失败测试：`disk`（存在 / 不存在目录 → `{"error":..}` + exitCode 1）、`tasks`、`notify-outbox`（`--after/--limit/--ack`）、`node-status` 的 stdout 为单行 JSON + `\n`。
- [ ] 搬 action 体进注册表；CLI action = 调注册表 + 写 stdout + 设 exitCode。
- [ ] `pnpm test`、`pnpm typecheck` 全绿 → commit `refactor(hub): 节点隐藏命令抽成注册表`。

### Task 2: 节点 agent（worker serve 内，出站长连接）

**Files:** Create `packages/app/src/fleet-agent`、`packages/core/src/fleet-protocol`（帧类型，master 共用；模块路径省略扩展名）；Modify `packages/app/src/serve.ts`（存在 节点 fleet 配置 且非 `--hub` 时启动 agent）、`packages/cli/src/cli.ts`（注入 `NODE_COMMANDS`；新增 `_fleet-join <dataRoot> <base64>`）；Test `test/app/fleet-agent.test.ts`

**Consumes:** Task 1 `NODE_COMMANDS`。
**Produces:** `startFleetAgent(o: { configPath: string; commands: Record<string, NodeCommand>; snapshot: () => Promise<HeartbeatPayload>; events: FleetEventSource; dataRoot: string; WebSocketImpl?: typeof WebSocket; now?: () => number }): { stop(): Promise<void> }`

- [ ] 测试（用内存 ws server）：hello 字段；每 10s heartbeat；`req` → 调注册表 → `res` stdout 一致；未知 cmd → exitCode 127；4401 → 10 分钟内不重连；断线退避 1→2→4…≤30s；未 ack 的 notify 重连后重发。
- [ ] 实现；事件源接 TaskManager 的录制开始/结束与 notify-outbox append。
- [ ] 全量测试 → commit `feat(hub): 节点 agent 出站长连接(心跳/事件/请求应答)`。

### Task 3: master 侧 fleet 端点 + Transport 优先走长连接

**Files:** Create `packages/orchestrator/src/fleet-hub.ts`（连接表、req/res 关联、心跳快照）、`packages/cli/src/fleet-join.ts`（生成 凭据、哈希入 master 侧 fleet 凭据表、经 ssh `_fleet-join` 下发）；Modify `packages/app/src/web/server.ts`（upgrade 路由注入 `fleetUpgrade?`）、`packages/orchestrator/src/transport-ssh.ts`（构造参数 `fleet?: FleetLink`：`run/runStatus/runLong` 先走 `fleet.request`，未连接 / 超时 → ssh）、`packages/cli/src/cli.ts`（录制状态探测、通知中继、`_is-done` settle、磁盘看门狗改读心跳快照与事件；无快照的节点保持现有轮询）；Test `packages/orchestrator/src/fleet-hub.test.ts`、补 `transport-ssh.test.ts`、`reconciler.test.ts`

**Produces:**
```ts
export interface FleetLink {
  connected(nodeId: string): boolean;
  request(nodeId: string, cmd: string, args: string[], timeoutMs: number): Promise<{ stdout: string; exitCode: number }>;
  snapshot(nodeId: string): HeartbeatPayload | null; // null = no fresh heartbeat (>30s)
  onEvent(fn: (nodeId: string, e: FleetEvent) => void): () => void;
}
```
- [ ] 测试：凭据 哈希比较、重复连接顶替、30s 无帧 → snapshot null；`request` 超时 → Transport 回落 ssh 且错误语义与 ssh 一致；`record-end` 事件 → 触发单房间对账一次（重复 id 去重）；notify 事件去重 + ack。
- [ ] 实现；Web UI 的节点页显示「长连接 / ssh 回落」。
- [ ] 全量测试 → commit `feat(hub): master fleet 端点,控制面优先走节点长连接`。

### Task 4: 节点侧 inventory 增量化

**Files:** Modify `packages/cli/src/node-commands.ts`（`inventory`）；Create `packages/orchestrator/src/probe-cache.ts`；Test `packages/orchestrator/src/probe-cache.test.ts`

**Produces:** `createProbeCache(probe, max = 2000)`，键 `path|size|mtimeMs`；节点 agent 在分段封口 / 删除时 `inventoryRev++` 并发 `inventory-changed`；master 只在 rev 变化时请求 inventory。全量对账兜底间隔建议改为 10 分钟（配置项，由人改）。

- [ ] 测试：同版本不重复 probe；mtime 变化重探；probe 抛错不缓存；rev 不变 master 不发 req。
- [ ] 实现、全量测试 → commit `perf(hub): inventory 增量与 ffprobe 缓存`。

### Task 5: 开播后内存验收（只出数据）

**Files:** Create `docs/perf/2026-11-worker-memory.md`

- [ ] Task 6 部署后，在 VPS 上用独立测试任务同时录 3 路（历史峰值 = 3，见「背景与实测」），记录 serve + 3 个 `record` + ffmpeg 的 RssAnon+VmSwap 与 PSI。
- [ ] 验收：总私有内存 < 700MB、memory PSI full avg60 < 1%。不达标 → 立「录制子进程瘦身」任务（堆快照定位 ~90MB 非弹幕部分）。

### Task 6: serve 判活闸门（按需拉起 record 子进程）

> 设计已由用户确认（2026-11-04：a 边录边传进闸门、c 手动启动也进闸门、直播直传也进闸门、b 收播退回闸门推迟）。现状依据：task-manager / daemon / record-engine / live-pump 的生命周期梳理。

**目标**：未开播的任务不占 `record` 子进程（实测空闲子进程约 10MB 匿名 + 27MB swap / 个，一台 worker 挂 8 个）。

**插入点（唯一）**：`TaskManager.start()` → 原 `trySpawn` 前。闸门是 TaskManager 内部状态 `gates: Map<taskId, Gate>`，不新建模块、不改 daemon 的决策逻辑。

1. **何时进闸门**（判定函数唯一一个 `shouldGate(task)`）：`settings.liveGate !== "false"`（默认开）即进闸门，**含边录边传（rolling）与直播直传（零落盘）**，手动启动与 daemon 启动同口径。唯一例外：直播直传任务的状态里有**未确认分 P**（上次运行留下、需补交）→ 不进闸门、立即 spawn，由子进程照旧先恢复（判定用与子进程同一套状态路径解析与读取函数，不另写一份；读不到 / 解析失败 → 当作有未确认分 P，立即 spawn，宁可多占进程也不拖延补交）。同场判定（#293）本就在开播那一刻于子进程内做，闸门不影响。边录边传：spawn 时 `beforeSpawn` 本就读最新值。
2. **闸门轮询**：首次在 0–5s 随机抖动后查（避免 daemon 一次 tick 拉起 N 个任务同时打 N 个请求），之后按 `platform.pollIntervalMs ?? 30s`（快手 5 分钟，与录制器同口径）。`getLiving` true → 撤闸门、走原 `trySpawn`，此后子进程生命周期完全不变（子进程自己仍会再取一次流，多一个请求，与现状同量级）。
3. **#308**：闸门永不退出、永不计入 restart 预算。`getLiving` 抛错（风控 / 网络）→ 连续失败指数退避（30s → 封顶 5 分钟），首次与每第 10 次记一条任务日志，不告警、不改状态。
4. **抖音 API 模式**：serve 进程目前不设 `DOUYIN_REC_API_MODE`（只注入子进程）→ 闸门会用默认 balance。实现时让闸门调用前按 `settings.douyinApiMode` 设好同一取值（与子进程同口径），否则闸门与录制用不同取流接口。
5. **状态**：闸门中 `isRunning = true`（daemon 的 `runningIds`、Web 启停、维护逻辑都把它当已启动，不会每 tick 重复 start）、`isRecording = false`、`status = "running"`。`TaskDTO` 加可选 `gated?: boolean`；前端现有「running && !recording → 等待开播」徽标不变，仅加提示「未开播，未占用录制进程」；旧前端忽略该字段。
6. **停止类操作立即生效**：`stop` / `requestStop` / `stopWithin` / `stopGraceful`（窗口结束排空）/ 删除 / hub 抑制源任务，遇闸门中任务一律清定时器、标记取消（进行中的 `getLiving` 返回后检查取消标记，不再 spawn），状态 `stopped`。闸门中没有在录内容，排空等于立即停。
7. **hub / 节点**：`recording-status` 按 `/proc` 扫下载器子进程，闸门中与「子进程等待开播」读数相同（都是不在录），对账与 settle 不受影响。hub 零落盘预检在 `spawnFor` 内，开闸时才跑；失败走原 spawn 失败路径。
8. **开关在运行中关闭**：`liveGate` 改为 false → 所有闸门中任务立即开闸 spawn（关开关 = 即时回到旧行为，作为线上兜底）。
9. **本期不做（用户确认推迟）**：收播后子进程退出回闸门（与 30 分钟同场口径、边录边传收尾冲突，另立任务）。所以收益是「每个窗口首次开播前」不占进程；一场播完后子进程照旧留在进程内等待，直到窗口结束。崩溃重启同样直接 spawn，不经闸门。崩溃重启定时器与闸门互斥：重启延迟期间若 `start()` 建了闸门，过期的定时器必须让位（闸门是下一次 spawn 的唯一所有者），任何停止路径都无条件取消闸门。

**测试**（假平台 `getLiving`）：未开播不 spawn 且 `isRunning` 为 true；开播 → spawn 一次；`getLiving` 抛错持续轮询且不进 error / 不计 restart；`stop` / `stopGraceful` / 删除在轮询中途取消且其后不再 spawn；直播直传有未确认分 P（含状态读不到）与 `liveGate=false` 直接 spawn；直播直传无未确认分 P 与边录边传都进闸门；运行中关开关立即 spawn；daemon 连续 tick 不重复 start。

**验收**：0 在录时 `record` 子进程数 = 0；开播 ≤ 60s 开始写分段（快手 ≤ 5 分钟，与现状同）；停止 / 窗口结束 / 删除立即取消闸门；Task 5 复测内存。

### 附：已实测、待排期的其它方向（不在本期验收内）

- **在录进程 ~129MB 匿名内存的构成**：本机实测加载 `webmssdk.js` +19.6MB RSS、`proto.js` +8.0MB → 弹幕模块约 28MB；其余 ~90MB 待 Task 5 堆快照确认（假设：V8 在 1GB 机器上不急于回收、日志/弹幕缓冲累积）。候选：子进程 `--max-old-space-size=96` + 共享弹幕进程。
- **系统进程**（worker B 按进程名汇总 RSS）：`systemd-journald` 94MB 且日志盘 4.0G；`sshd` 48MB（master 的 ssh 会话，Task 3 后消失）；Oracle cloud agent（gomon/agent/oci-wlp/updater）~56MB；snapd 19MB。候选：journald `SystemMaxUse=200M` + 降低 serve 日志量；停用不用的 Oracle agent 插件与 snapd（运维变更，需用户决定）。
- **swap**：2G `/swapfile` 在网络块存储上，`swappiness=10`，无 zram。候选：zram（lz4）替代/前置文件 swap —— 需在 Task 6 后复测再决定（限速 CPU 上压缩也有成本）。
- **带宽**：worker A 单路录制 rx ≈ 3.7Mbps；边录边传再加同量出站，单机 4–5 路 ≈ 40Mbps，目前看不是瓶颈（E2.1.Micro 网卡上限未在本机实测，以 OCI 文档为准）。

---

## 不做（已评估）

- **单进程录制**：失去每房间进程隔离（单房间异常 / 泄漏 / 事件循环阻塞会波及全部房间），而历史峰值仅 3 路，Task 6 已足够。
- **换 A1.Flex**：用户确认不可行。
- **按开播时段排布房间**：单机峰值 3 路，Task 6 后收益很小；房间增多再议。
- **Rust worker daemon**：Task 1–4、6 后 worker 待命仅 serve ~60MB，重写收益不抵双语言维护成本；复测不达标再议（协议 `fleet/1` 已为其留好边界）。
- **部署不打断录制（ffmpeg 脱离 + 接管）**：独立需求，另立任务。

参考：[biliup PR #1754](https://github.com/biliup/biliup/pull/1754)、[biliup Issue #1744](https://github.com/biliup/biliup/issues/1744)。
