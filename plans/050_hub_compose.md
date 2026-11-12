# plans/050 — hub 组装层：把 hubStarter 本体迁出 cli（P1-3 第三刀）

状态：050.1（PR #655 / 0.0.370）、050.2（PR #657 / 0.0.371）、050.3（PR #659 / 0.0.372）、050.4（PR #661 / 0.0.373）已合并部署（vps1 待空录后补）；050.5 待开工。前两刀：`@drec/hub-compose`（#649）、台账删除归 orchestrator（#651）。

## 目标

`packages/cli/src/cli.ts` 现在 2600 行，其中 `hubStarter` 本体从 `const hubStarter: HubStarter = {`（约 1290 行）到 `probeAllWorkers` 收尾，合计约 1070 行，占全文件 40%。目标是把这块搬进 `@drec/hub-compose`，cli 只剩命令接线与 `createHubStarter(...)` 的一次调用。

验收：`cli.ts` ≤ 1600 行；全量测试与 `arch:check` 绿；一次部署后 hub 启停、任务同步、cookie 同步、retry/ack/runNow、zero-disk 编排与搬迁前行为一致（用现有测试 + 线上日志对照：`任务同步 applied=…`、`[fleet] connected`、`[zero-disk] 回执`）。

## 为什么不是一次搬完

这 1070 行不是纯闭包搬家，它握着三类 cli 私有的东西：

1. **cli 本地模块**：`localRoomProbes`（`cli/node-commands.ts`）、`SyncGate`（已搬到 hub-compose）、`getTransport`；
2. **注入进 app 的回调**：`hubStarter` 对象被 `runServe` 的 `ServeDeps.hubStarter` 使用，类型 `HubStarter` 定义在 `@drec/app`；
3. **cli 私有小工具**：`masterUploadAccountKey`、`dateNameOf` 这类只在启动路径用的函数。

所以按依赖拆成五步，每步一个 PR、都要能独立部署。

## 切片

### 050.1 抽 `createHubStarter(deps)` 骨架（纯搬迁，行为不变）

- `hub-compose/src/hub-starter.ts` 导出 `createHubStarter(deps)`，`deps` = `{ store, manager, log, warn, notifier, transport, hubConfigJson, clock }`；
- 把 `masterUploadAccountKey`、`localRoomProbes`（若只被启动路径使用）一并搬进 hub-compose；
- cli 只留 `const hubStarter = createHubStarter({...})`。
- 风险点：`hubStarter` 对象方法（`retryNode` / `stopJob` / `ackJob` / `runNow` / `probeAllWorkers` / `testWorker` / `requestSyncTasks`）的**返回契约**不能变，否则 web 端 400/409 判定会漂。

### 050.2 cookie 同步拆成 `cookie-sync.ts`

- 现状：约 200 行闭包，含 `warnedCookieUnsupported` / `cookieWarnSeen` 去重、`shouldPushCookies` 闸门、`recordCookiesApplied`；
- 拆成 `createCookieSync({ store, warn, log })`；去重集合随实例走（现状没有任何 clear/重置，保持同一生命周期）。

### 050.3 任务同步拆成 `task-sync.ts`

- `syncTasks` 是最大的块（约 500 行），含 `desiredSpecsForWorker`、`recordExpectedVersion`、`recordSyncError`、`hubSyncGate.bind`；
- 拆成 `createTaskSync({...})`，由 `hubStarter.start` 装配；`hubSyncGate` 仍由 hub-compose 统一持有。

### 050.4 zero-disk 编排拆成 `zero-disk-sync.ts`

- 节点侧零落盘的回执轮询与 `setZeroDiskSnapshot` 写入；
- 依赖 `ZeroDiskFleet`，构造参数与现在一致。

### 050.5 retry / ack / runNow / 行为探测拆成 `hub-actions.ts`

- `retryNode` 的 120 行（含 ledger 状态回落、`USER_STOP` 判定）最后搬；它最容易被误改。

## 每一步的验收

- 纯搬迁：`pnpm typecheck` 0 错、全量 `pnpm test` 全绿、`arch:check` 通过；
- 行为不变证据：搬迁前后对同一份 fixture 跑 `hub-desired` / `web-api` 用例；线上部署后看 5 分钟日志里的 `任务同步 applied=`、`[fleet] connected`、`[zero-disk] 回执` 三条链路；
- 部署：每步单独部署，失败只回退一步。

## 明确不做

- 不顺手改 `HubStarter` 类型或 web 端判定；
- 不把 `hub-compose` 变成第二个 orchestrator：它只做装配，不写台账、不碰录制进程。

