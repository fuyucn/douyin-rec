# Worker 实时状态（轻量 ping 轮询）设计

> 状态：设计稿（2026-07-06，brainstorming 产出，待实现）。
> 前置：Workers 管理（已实现，Task 3 的 CLI 注入 `testWorker` = 完整 listInventory）。
> 关联：[multi-node-sync.md](../../multi-node-sync.md)。

## 目标

Workers 卡的状态点从"只有手动点测试才亮"改为**自动轮询的实时健康点**，并用**轻量探针**取代原来的重量级测试（SSH + 完整 `listInventory` 扫 recordings 目录），避免自动轮询带来的负载。

## 关键决策（已定）

- **取代**：轻量 ping 取代完整 listInventory 测试（不再有 recordingCount/dataRootExists，只要"可达 + dataRoot 存在"）。
- **去掉每行手动"测试"按钮**：状态点只由自动轮询驱动。
- **轮询 5 分钟**（常量，改 10 只需改一个数）；`usePolling` 挂载时先立即拉一次 → 开页即见，之后每 5 分钟刷、仅卡片可见时。
- **保留弹窗"存前测试"按钮**（改用轻量 ping）：验证一个**尚未保存**的 worker 配置（自动轮询只能测已保存的；轮询慢时加 worker 更需要）。

## 轻量探针（Transport）

- `Transport` 接口加**可选** `ping(): Promise<void>`（`orchestrator/src/transport.ts`）：可达即 resolve，不可达/dataRoot 错则 **reject 带 message**。
  - `LocalTransport.ping`：`existsSync(dataRoot)`，否则 `throw new Error(...)`——瞬时，无扫描。
  - `SshTransport.ping`：SSH 跑 `test -d <dataRoot>`（快，不扫 recordings），**硬超时 ~6s**（Promise.race + clearTimeout）；非零退出/超时 → throw 带 message。
- 语义：resolve = 可达 + dataRoot 存在；reject = 不可达 / dataRoot 不存在（error 串供 UI 展示）。

## 取代完整测试

- CLI 注入的 `testWorker`（`cli.ts`）从 `listInventory()` 改为 `ping()`；`WorkerTestResult`（`@drec/core` api-types）简化为 `{ ok: boolean; error?: string }`（删 `recordingCount`/`dataRootExists`/`reachable`）。
- 仍用 **scoped 一次性 transport**（`new LocalTransport`/`new SshTransport`，不碰全局 registry——沿用现有安全模式）。

## 端点

- `POST /api/hub/workers/test`（现有，保留）：改跑 `ping()`（测 body 里的 cfg）→ `{ok, error?}`。仅供 Add/Edit 弹窗**存前测试**。
- **新增 `GET /api/hub/workers/status`**：并行 ping **所有已配置 worker**（每个独立超时），返回 `[{ id, ok, error? }]`。给卡片轮询用。
  - 经 CLI 注入的 `probeAllWorkers(): Promise<Array<{id,ok,error?}>>`（`loadWorkers()` 拿列表逐个 ping，`Promise.allSettled` 汇总）。app 层端点调 `deps.probeAllWorkers`（未注入=hub 未开 → 返回 `[]`）。
  - 分层：探针逻辑在 orchestrator（Transport.ping）+ CLI 装配；app（L4）不 import orchestrator，只调注入函数。

## UI（WorkersCard）

- **删掉每行手动测试（wifi）按钮**。
- 卡片挂载/可见时 `usePolling(fn, 300000, visible)` —— 挂载即拉一次 `GET /api/hub/workers/status`，之后每 **5 分钟**刷；不可见（卡片未渲染/hub 未开）不轮询。
- 每行状态点三态：**绿 = ok**；**红 = fail**（`title`/tooltip 显示 error 串）；**灰 = checking**（首次结果返回前）。按 `id` 匹配 status 数组。
- 弹窗"存前测试"按钮：走 `POST /workers/test`（ping 版），UX 不变、后端更轻。

## 错误处理

- 每 worker 独立超时（ssh ping 内置），一个卡住不拖累整批；批量端点用 `allSettled`，返回部分结果。
- 轮询请求整体失败（端点 5xx/网络）→ 保持上次状态或灰，`catch` 不崩。
- `probeAllWorkers` 未注入（hub 未开）→ 端点返回 `[]`，卡片显示灰/无点。

## 测试

- **Transport ping**：`LocalTransport.ping` dataRoot 存在 resolve / 不存在 reject；`SshTransport.ping` 经注入的 exec fake（退出 0 → resolve；非 0 → reject；超时 → reject）。
- **批量 status 端点**：注入 `probeAllWorkers` fake → 返回 per-worker 数组；未注入 → `[]`。
- **`/test` 端点**：ping 版 ok + fail 两路径（注入 fake）。
- **UI**：`cd packages/web && pnpm build` 绿 + `pnpm typecheck` 0；手动清单（开卡片即见状态点；停一个 worker → 下次轮询变红；无手动按钮；弹窗存前测试仍可用；仅可见时轮询）。

## 任务拆分

1. **后端**：`Transport.ping`（local+ssh，含超时）+ `testWorker` 改 ping + `WorkerTestResult` 简化 + `GET /api/hub/workers/status` 批量端点 + CLI `probeAllWorkers` 注入 + 单测。先绿。
2. **UI**：WorkersCard 删手动按钮 + 挂载即拉 + 5 分钟轮询 status + 三态点（error 进 tooltip）；弹窗测试按钮改走 ping 版 `/test`（若返回结构变了则跟着调）。
