# Hub 受管录制任务:master 绑定 source task 并按节点选择性下发

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 master 上创建普通录制任务后,Hub 规则里把该 task 绑定为 `recording.sourceTaskId` 并勾选 worker 节点,主节点的 hub 编排器自动把任务配置下发到这些 node 的本地 `tasks` 表。node 上的受管任务就是普通任务(走既有 daemon / TaskManager / 录制子进程),唯一差别是 UI/API 禁止编辑、删除。录制结束后 hub 沿用现有 pipeline 做合并/上传。

**Architecture:** 复用现有文件版 hub 规则 + worker 配置 + SSH transport。任务身份跨节点用 `(platform, roomSlug)`,不用 master 本地 task id。新增两个隐藏远端子命令 `_tasks` / `_apply-tasks`,Transport 增加可选 `listTasks` / `applyTasks`;master 周期对账(offline 节点下轮自愈)。Node 任务只加一列 `managedBy TEXT`(`NULL`=手动,`'hub'`=受管),不新建 worker 侧状态表。

**Tech Stack:** TypeScript(ESM,`.js` import 后缀)、`node:sqlite`、vitest、ssh/rsync 既有 transport。

## Global Constraints

- **身份不变量**:任何跨节点匹配都按 `(platform, roomSlug)`;sourceTaskId 只在本机 master 的 `tasks` 表内有效。
- **受管不变量**:`managedBy='hub'` 的任务只能由 hub 同步修改/删除;Web API 拒绝 PATCH/DELETE(以及节点 UI 的编辑/删除入口隐藏)。
- **覆盖优先级**:node 上已存在的同名任务被收编时,保留 node 本地的 `cookies / useCookie / outDir / webhook`(per-node override,如本地 docker 匿名 vs VPS 带 cookie);其余字段以 master source task 为准。新建任务用 master 配置。
- **安全**:cookies 只从 master 单向下发到选中 node,`_tasks` 输出永不含 cookies;日志不打印 cookies。
- 不改 `vendor/`,不碰 VPS 生产进程;受管任务删除前先 `enabled=false`,等 daemon 自然停录后下轮再删。
- 运行测试:仓库根 `pnpm test`;单测就近放 `packages/orchestrator/src/*.test.ts`、`test/app/*.test.ts`。
- 提交规范:约定式提交,scope 用 `hub`/`task`/`web`;本计划文件单独 commit。

---

## File Structure

- `plans/022_hub_managed_tasks.md` — 本计划。
- `packages/app/src/db.ts` — `tasks` 加 `managedBy TEXT`(ensureColumn 回填)。
- `packages/app/src/store.ts` — `Task` / `TaskInput` / `TaskRow` / `addTask` 支持 `managedBy`;新增 `setManagedBy`。
- `packages/app/src/task-sync.ts` — **新建**:`listNodeTasks` / `applyRemoteTasks`(node 侧 diff + 两阶段删除)。
- `packages/core/src/api-types.ts` — `TaskDTO` 加 `managedBy`;新增 `HubRecordingConfig` / `NodeTaskDTO` / `RemoteTaskSpec`;`HubRuleDTO` / `HubRulePayload` 加 `recording` + `sourceTask`。
- `packages/orchestrator/src/transport.ts` — Transport 加可选 `listTasks` / `applyTasks` + `NodeTasks` / `ApplyTasksResult`。
- `packages/orchestrator/src/transport-ssh.ts` — 实现 `listTasks` / `applyTasks`(走 `_tasks` / `_apply-tasks`)。
- `packages/orchestrator/src/transport-local.ts` — 注入本地 task 回调。
- `packages/orchestrator/src/index.ts` — `registerBuiltinTransports` 透传 local task 回调。
- `packages/orchestrator/src/hub.ts` — `startHub` 支持 `syncTasks` + `syncIntervalMs`。
- `packages/app/src/hub-store.ts` — `HubRule` / `HubFile` 加 `recording`;upsert/update 保留。
- `packages/app/src/web/api.ts` — TaskView 透出 `managedBy`;PATCH/DELETE 拒受管;hub rule 读写 `recording` + `sourceTask` 校验。
- `packages/cli/src/cli.ts` — 隐藏 `_tasks` / `_apply-tasks`;hubStarter 注入 `listTasks` / `applyTasks` 并周期 sync。
- `packages/web/src/...` — HubRuleDialog 加 source task 选择 + recording 区域;TaskList/TaskDetail 显示 managed 徽标并禁编辑/删除。
- 测试:`packages/orchestrator/src/transport-local.test.ts`、`test/app/web-api.test.ts`、`test/app/task-sync.test.ts`(新建)。

---

## Task 1: 数据模型(managedBy + hub recording)

**Files:** `packages/app/src/db.ts`, `packages/app/src/store.ts`, `packages/core/src/api-types.ts`

- `db.ts`:`ensureColumn(db, "tasks", "managedBy", "TEXT")`。
- `store.ts`:`Task.managedBy: string | null`;`TaskInput.managedBy?: string | null`;`TaskRow.managedBy`;`rowToTask`;`addTask` INSERT 该列;新增 `setManagedBy(id, v)`(只写该列)。
- `core/api-types.ts`:
  - `TaskDTO.managedBy: string | null`。
  - `HubRecordingConfig { sourceTaskId?: number | null }`。
  - `HubRuleDTO.recording?: HubRecordingConfig` + `sourceTask?: { id; room; name; anchorName; enabled } | null`。
  - `HubRulePayload.recording?: HubRecordingConfig`。
  - `NodeTaskDTO`(无 cookies)与 `RemoteTaskSpec`(含 cookies,仅 master→node)。

## Task 2: node 侧同步命令 + task-sync

**Files:** `packages/app/src/task-sync.ts`(新建), `packages/cli/src/cli.ts`

- `listNodeTasks(store): NodeTaskDTO[]` — 每任务派生 `platform + roomSlug`。
- `applyRemoteTasks(store, desired, log?)`:
  - 每条 spec:按 `(platform, roomSlug)` 找已有任务;有 → 收编(`setManagedBy('hub')`)并更新 name/quality/engine/danmu/segmentSec/schedule/enabled/room/anchorName,**保留 node 的 cookies/useCookie/outDir/webhook**;无 → `addTask({ ...spec, managedBy:'hub' })`。
  - 删除:遍历 `managedBy='hub'` 且不在 desired 的任务;`enabled=true` 或 `status` 为 running/pending/draining → 只 `setEnabled(false)`(下轮删);否则 `removeTask`。
  - 返回 `{ applied, removed, pending }`。
- cli 隐藏子命令:
  - `_tasks <dataRoot>` → stdout `{ tasks }`。
  - `_apply-tasks <dataRoot> <base64>` → 解析 `{ desired }`,执行后 stdout `{ applied, removed, pending }`。

## Task 3: Transport + startHub

**Files:** `packages/orchestrator/src/transport.ts`, `transport-ssh.ts`, `transport-local.ts`, `index.ts`, `hub.ts`

- Transport 可选方法:`listTasks(): Promise<NodeTasks>`;`applyTasks(input: { desired: RemoteTaskSpec[] }): Promise<ApplyTasksResult>`。
- SshTransport:`_tasks` / `_apply-tasks`(base64 防引号问题),复用 `remoteNode` 前缀与单字符串命令模式。
- LocalTransport:`listTasks` / `applyTasks` 可选注入;`registerBuiltinTransports` 透传。
- `startHub`:`syncTasks?` + `syncIntervalMs`(默认 60s),与 reconcile 共用并发锁。

## Task 4: master 编排(hubStarter)

**Files:** `packages/cli/src/cli.ts`

- 每次 sync 现读 worker 配置,构造 scoped transport(不进全局 registry)。
- `desiredFor(workerId)` = 遍历 enabled hub 规则,取 `recording.sourceTaskId` 存在且 roomSlug 匹配、且 workers 含该节点(或规则未设 workers=全部)的 source task → `RemoteTaskSpec`(cookies 用 `resolveTaskCookies(src, store.getDefaultCookies())`)。
- 对每 worker `applyTasks`;失败只 warn(下轮自愈);有变化才 log。
- `startHub` 传 `syncTasks` + 从 hubCfg 读 `syncIntervalMs`。

## Task 5: API 保护 + hub 规则读写

**Files:** `packages/app/src/web/api.ts`, `packages/app/src/hub-store.ts`

- `updateTask` / `deleteTask` 先查 `managedBy==='hub'` → 403「由 hub 管理,请在 master 上修改」。
- `hubRuleView` 解析 `sourceTask`;create/update 校验 `sourceTaskId` 存在且 roomSlug 一致(否则 400)。
- hub-store 读写 `recording`,部分更新与 workers 同规则。

## Task 6: Web UI

**Files:** `packages/web/src/modals/HubRuleDialog.tsx`, `packages/web/src/pages/TaskList.tsx`, `packages/web/src/pages/TaskDetail.tsx`, `packages/web/src/lib/i18n.tsx`

- HubRuleDialog:新增「录制下发」区域(source task 下拉,仅列同 roomSlug 的 master 任务)+ 保存 `recording.sourceTaskId`;无匹配任务提示先创建任务。
- TaskList/TaskDetail:受管任务显示 `hub` 徽标,隐藏编辑/删除按钮(API 兜底 403)。
- i18n:zh/en 新增文案。

## Task 7: 测试与验证

- `task-sync.test.ts`:创建/收编保留 override/两阶段删除。
- `transport-local.test.ts`:listTasks/applyTasks 回调接线。
- `web-api.test.ts`:受管任务 PATCH/DELETE 403;hub rule recording 校验。
- `pnpm typecheck && pnpm test && pnpm bundle && (cd packages/web && pnpm build)`。
