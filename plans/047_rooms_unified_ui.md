# 047 统一房间入口：录制节点也走 Rooms，能力按节点角色裁剪，新增/编辑合成一个弹窗

> **状态：已实现并合并前审查中（2026-11-06）。PR #536（issue #534），按 §5 分期落地；§3.5 有一处已记录的实现偏离。**
> 用户口径（原话提炼，含一次自我更正）：
> 1. hub（master）里用 `rooms`，普通节点用 `tasks` → **全部迁到 rooms**（"说错了全部迁移到 rooms"）。
> 2. 普通节点禁用无用功能（例如编辑弹窗的分步 tab）；**不涉及 hub 编排的部分保留**：录制、直传/边录边传、存档格式。
> 3. hub 受管房间：列表只给查看入口，详情页可看全部信息与运行历史，**没有任何写操作**。
> 4. `add room` 与 `edit room` 完全不一致 → 用**同一个弹窗**：新增 = 编辑弹窗（完整四步逻辑），创建后**默认暂停**，需手动开启。
>
> 分支：`feat/tasks-unified-ui`（仓库里已有同名空分支，已切到它）。
> 隐私：本文不写主播名、房间号、streamKey、BV、主机名。

---

## 1. 目标

- **一个实体、一套页面**：所有节点（master / worker）的主入口都是 `/rooms`；"任务"只作为房间的录制半边存在于 API 与实现里，不再作为用户可见的产品概念。
- **能力按角色裁剪**：worker 上只保留"录制 + 存档格式"（直传/边录边传/投稿由主控配置，见 §3.5 偏离记录）；hub 编排（合并/烧录/节点直传/上传投稿/清理/节点选择）与 master 专有页（节点、队列、统计）在 worker 上不可达。
- **受管即只读**：`managedBy === "hub"` 的房间在节点上只能看，不能启停、不能改、不能删。
- **一个弹窗**：新增房间与编辑房间是同一个组件、同一份表单映射与校验；新增使用完整四步（不缩减成"最小表单"），保存时一次写两半。

**非目标**：
- 不改录制引擎、不换运行时、不改 B 站上传硬标准。
- 不删除 `/hub` 页（Rule 级维护仍在 master；本计划只在它内部对齐房间入口，见 §6 F1）。
- 不动 hub 同步协议（`_apply-tasks` / `desiredFor`）。
- 不做视觉重设计：沿用现有 `table-shell` / `telemetry-bar` / `card` 语言与 `ModeChoices`/`ModeLogo`。

---

## 2. 现状（2026-11-06 实读本分支）

| 位置 | 现状 | 问题 |
|---|---|---|
| `packages/web/src/lib/nav.ts` + `test/web/nav.test.ts` | worker 导航 = `[{to:"/", 录制任务}]`；`homeTarget(false) → /tasks` | 节点看到的是 tasks，与 master 的 rooms 是两套页面 |
| `packages/web/src/App.tsx` | `/`, `/tasks`, `/task/:id`, `/rooms`, `/rooms/:key`, `/hub`, `/hub/:key`, `/nodes`, `/queue`, `/stats` 全部注册 | worker 也能直达 master 页（部分页自己判断 hubEnabled，部分没有） |
| `pages/TaskList.tsx`（427 行） | 任务表 + 指标带 + 新建/编辑/启停/删除；worker 用 `isUnassignedHidden` 过滤 | 与 `RoomsPage` 功能重叠，状态/交付/节点信息更少 |
| `pages/TaskDetail.tsx`（395 行） | 任务详情：信息卡 + 日志 + 合并面板 + 滚动上传进度 | 与 `RoomPage` 重叠，`RoomPage` 是其超集（含 runs/直播直传时间线/受管标识） |
| `modals/AddRoomDialog.tsx`（211 行） | 最小化新增：模式（存档/上传）、房间、名字、时段、节点、公开、存档格式、弹幕 | 与编辑面板字段、校验、默认值都不一致；写规则靠"建任务后再读列表反查 key" |
| `modals/RoomEditor.tsx`（471 行） | 编辑：四步 tab（录制 / 处理 / 上传 / 收尾），`managed` 时整表 disabled | 只支持编辑；新增路径完全另写一套 |
| `lib/room-create.ts` | `newRoomTaskPayload` / `newRoomRulePayload` / `planNewRoomRule` / `planNewRoomFinish` / `findExistingRoom` / `findCreatedRoom` | 前四个只为 AddRoomDialog 存在；后两个是必要的重复检测/绑定查找 |
| `app/src/web/api/rooms.ts` | 只有 `listRooms` / `getRoom` / `updateRoom` / `deleteRoom` | **没有创建端点**；新增只能"先 POST /api/tasks 再 POST /api/hub/rules"，天生可能半成功 |
| `rooms.ts` `updateRoom` | `processing` 在任何节点都会写本地规则文件 | worker 上写规则是本计划要堵住的无用/有害能力 |
| `pages/rooms/shared.tsx` | `useRoomsData` 每 5s 拉 `/api/tasks`，10s 级推送 `useHubStream`；`useRoomActions` 提供启停/编辑/删除 | 依赖 master 端点（workers 状态、hub stream、latest-runs）在 worker 上会 503/空 |
| `pages/RoomsPage.tsx` | 列：房间 / 上传方式 / 上次交付 / 节点 / 定时 / 状态 / 操作（启停、日志、编辑） | worker 上"上传方式/上次交付/节点"大多无意义；受管行仍有编辑入口 |
| `pages/RoomPage.tsx` | 详情含处理半、运行 runs、日志、`MergePanel` | worker 上处理半与 MergePanel 无意义 |
| `test/web/room-create.test.ts`、`nav.test.ts`、`test/app/web-api.test.ts` | 钉住上述行为 | 需要同步改（见 §7） |

---

## 3. 决定（待用户确认的只有 §3.5 的 tab 边界）

### 3.1 唯一用户可见实体 = 房间（rooms）
`/rooms` 是**所有节点**的首页；`/tasks` 与 `/task/:id` 退化为兼容跳转；`TaskList` / `TaskDetail` / `CreateEditTaskDialog` / `AddRoomDialog` 删除，能力并入 `RoomsPage` / `RoomPage` / `RoomEditor`。

### 3.2 角色能力矩阵（唯一真理 = 一个纯函数）
新增 `packages/web/src/lib/capabilities.ts`：

```ts
export interface NodeCaps {
  /** 本节点是 hub master（/api/hub/status.enabled）。未知(null)时按 worker 保守处理？见下注。 */
  rooms: true;
  createRoom: true;          // 两端都能建房间
  editRecording: true;       // 两端都能改录制半边
  // 注：实现中移除了曾计划的 editNodeDelivery —— 直播直传/边录边传是 hub 规则字段，
             // 节点写它会被后端拒绝且永不生效；worker 只写 task 字段（存档格式）。见 §3.5 偏离记录。
  editPipeline: boolean;     // master only：合并/烧录/节点直传/上传投稿/清理
  hubRule: boolean;          // master only
  nodes: boolean;            // master only：节点页、worker 选择、节点状态
  queue: boolean;            // master only
  stats: boolean;            // master only
  mergePanel: boolean;       // master only：任务级手工合并
  runs: boolean;             // master only：hub 运行历史
}
export function nodeCaps(hubEnabled: boolean | null): NodeCaps;
```

注：`hubEnabled === null`（启动探测中）沿用现有约定——导航等待探测完成（`homeTarget` 返回 null），页面级判断按 **master=false** 渲染（宁可不显示写操作，不显示越权按钮）。

### 3.3 受管 = 只读
判定沿用现有唯一口径 `task.managedBy === "hub"`（`useRoomActions.managedOf`）。受管房间：
- 列表：无启停、无编辑铅笔；行本身即"查看"入口（保留日志图标）。
- 详情：无编辑按钮、无启停/排空按钮、不挂 `MergePanel` 与任何写操作；信息与运行历史照常展示。
- 服务端仍是最终闸门（`PUT /api/rooms` 403 / `DELETE` 403 / 启停 403），前端只做入口收敛。

### 3.4 新增 = 编辑同一弹窗
`RoomEditor` 增加 `mode: "create" | "edit"`：
- `mode: "create"`：`room` 输入框必填（唯一额外字段）；完整四步可用；底部「创建」；无删除按钮；创建成功后提示"已创建（未启用），需要时再开启"。
- `mode: "edit"`：与今天一致（房间地址只读展示），底部「保存」「删除」。
- 两模式共享：`formFromRoom`（create 用空白预填）、`payloadFromForm`、`room-form-rules` 的锁定/降级/流程摘要、同一条 `submit` 路径与同一套数值校验。
- 重复检测：提交前用 `findExistingRoom`（保留），命中 → 提示"该房间已存在"，不创建。
- 默认暂停：创建走新端点后服务端 `store.addTask` 默认 `enabled=0`；前端不调 `startTask`（沿用 T-157 的验收，source-grep 钉住）。

### 3.5 普通节点的 tab 边界（实现口径 + 偏离记录）
按用户口径"不涉及 hub 编排就保留"：

| 步骤 tab | master | worker |
|---|---|---|
| 1 录制（时间/节点/名字/画质/引擎/分段/弹幕/账号） | ✅ | ✅（"节点"选择区隐藏，只剩本机） |
| 1 录制·附加（直播直传 / 边录边传 / 存档格式） | ✅（在 process/upload 内） | 存档格式 ✅ 可写；直传/边录边传 **只读提示「由主控配置」**（见下方偏离记录） |
| 2 处理（合并/烧录版本/节点直传/能力要求） | ✅ | ❌ 隐藏 |
| 3 上传（上传方式=存档/投稿、时机、公开、tid/tag/描述/模板/分 P 大小） | ✅ | ❌ 隐藏 |
| 4 收尾（清理规则 / 专属推送地址） | ✅ | 只留专属推送地址（清理是 master 的 stage/源文件动作） |

> 若用户希望 worker 也保留"上传时机（节点直传）"等 hub 规则字段，那它们必须走 master 的规则文件，本节点无法生效 —— 这正是要禁的部分。因此 worker 只保留 task 字段级的能力。

**偏离记录（2026-11-06，独立审查 MAJOR，用户已同意按此口径）**

- 用户原口径是"worker 保留录制 + 上传 + 存档格式"。实现的约束比预想更具体，需要分清两类字段：
  - `streamUpload` / `streamUploadSpool` / `rollingUpload` **确实是 task 字段**，节点上写它们本身不被 API 拒绝；
    但它们的**生效前提是主控那条 rolling hub 规则**（`zeroDiskRuleError` 的 rolling + 无烧录 + 恰一个节点），
    而规则文件只属于主控 —— 节点既没有规则可写（`POST`/`PUT /api/rooms` 带 `processing` 会被拒），
    也就没有"开启后真的会跑"的配置。强行放开 = "看起来配了、实际永不生效"的假配置。
  - 投稿元数据（时机/tid/tag/描述/分 P 大小）本身就是 `processing` 里的字段，节点更无从写。
- 因此 worker 实现为：**存档格式可写**；直播直传/边录边传/投稿在录制 tab 里给一行只读提示（`room.editor.deliveryByMaster`）。
- 因此 worker 实现为：**存档格式可写**；直播直传/边录边传/投稿在录制 tab 里给一行只读提示（`room.editor.deliveryByMaster`）。
- **既有值不会被本次编辑清掉，用户改了就必须写回**：`payloadFromForm` 只在本次保存**确实会写规则**（`ctx.writesRule`）且
  （已有规则 或 本次结算为 rolling 或 **用户改过交付字段**（`ctx.deliveryTouched`））时才包含 `streamUpload`/`streamUploadSpool`；
  其余省略（PUT/POST 是 patch 语义 = 保持不动）。这覆盖四件事：主控同一次保存里新开直传会写入；主控编辑无规则旧任务只改名字不会悄悄关掉；
  用户在无规则旧任务上**主动关掉直传**会写回 false（否则后端会拿旧 true 拒掉合法的新配置）；worker（不写规则）永不动它的值。
- 若之后确实要让节点本地配置直传/边录边传，需要独立的"节点本地规则"设计（把规则文件或等价的本地状态落在节点），
  不是本计划的放开范围。

---

## 4. 架构

### 4.1 路由（`App.tsx`）

| 路径 | master | worker |
|---|---|---|
| `/` | `<HomePage>` → `Navigate /rooms` | 同 |
| `/rooms` | `RoomsPage` | `RoomsPage`（裁剪列/隐藏 master 控件） |
| `/rooms/:key` | `RoomPage` | `RoomPage`（无处理半/无 runs/无 MergePanel） |
| `/rooms/by-task/:id` | 解析任务 → `Navigate /rooms/:key` | 同 |
| `/tasks` | `Navigate /rooms` | 同 |
| `/task/:id` | `Navigate /rooms/by-task/:id` | 同 |
| `/nodes` `/queue` `/stats` | 原页面 | `MasterOnly` 说明卡（复用现有的 child-node 提示文案），导航不显示 |
| `/hub` `/hub/:key` | 原页面（高级入口） | 原 child-node 卡 |

`navSections(hubEnabled)` 重写：
- master：`房间 / 节点 / 统计` + 高级 `队列`（保持现状）。
- worker：**`房间`**（唯一 primary，`to:"/rooms"`），无高级。
- `homeTarget` 恒为 `/rooms`（null 仍返回 null，等待探测）。

### 4.2 前端模块
- `lib/capabilities.ts`（新，纯函数 + 测试）
- `lib/nav.ts`（改 + 测试）
- `modals/RoomEditor.tsx`（改：create/edit 双模）
- `pages/RoomsPage.tsx`（改：能力裁剪、受管只读、create 用 RoomEditor）
- `pages/RoomPage.tsx`（改：能力裁剪、受管只读）
- `pages/rooms/shared.tsx`（改：`useRoomsData` 在 worker 上不调 master 端点、改用轮询；`useRoomActions` 增加 `readOnly` 判定与 create 状态）
- `api/client.ts`（新增 `createRoom`）
- 删除：`pages/TaskList.tsx`、`pages/TaskDetail.tsx`、`modals/CreateEditTaskDialog.tsx`、`modals/AddRoomDialog.tsx`
- `lib/room-create.ts`：保留 `findExistingRoom` / `findCreatedRoom`（改名/精简注释），删除 4 个 add 专用构造器
- `atoms`: 删除 `tasksAtom`（仅 TaskList 使用；`rooms/shared` 用局部 state）

### 4.3 后端（`packages/app/src/web/api/rooms.ts`）

1. **新增 `POST /api/rooms`**
   - 输入：`RoomPayload`（`recording.room` 必填，其余同 PUT）+ 可选 `processing`。
   - 步骤：解析平台/房间 → 重复检测（同平台同 slug 已有任务 → 409）→ 校验 processing（复用 `validateWorkers` / `validatePipeline` / `zeroDiskErrorFor`）→ `store.addTask`（默认 `enabled=0`）→（master 且给了 processing）`upsertHubRule` → 失败回滚：删掉刚建的任务，返回 500 + 明确原因；回滚失败要写明"任务可能已创建"。
   - worker：`deps.hubEnabled !== true` 时**拒绝** `processing`（400「本节点未启用 hub，房间的处理半边只能在主控配置」），只建录制半边。
   - 返回：`201` + `RoomDTO`（与 `getRoom` 同形）。
2. **`PUT /api/rooms` 增加 worker 闸门**：`proc && !deps.hubEnabled` → 400，避免在 worker 写规则文件（与 `hub-rules.ts` 既有 400 文案同源）。
3. **`DELETE /api/rooms` 不变**（受管 403 / 启用或录制中 409 已覆盖）。
4. 创建后 `deps.requestSyncTasks?.()`（master 有规则时立刻下发）。

### 4.4 数据契约
- 不改 `RoomDTO`。
- `POST /api/rooms` 请求体在 `core` 的 `RoomPayload` 上要求 `recording.room`；类型放 `app` 域（`CreateRoomInput = RoomPayload & { recording: { room: string } }`），`core` 不新增导出（避免契约面扩大）。

---

## 5. 分期（每期一个 PR，各自可独立合并）

### PR0 纯逻辑：能力矩阵 + 导航 + 文档测试
- [ ] 新增 `lib/capabilities.ts` + `test/web/capabilities.test.ts`：master/worker/未探测三态矩阵；worker 不得拿到 `editPipeline/hubRule/nodes/queue/stats/mergePanel/runs`。
- [ ] 重写 `navSections` / `homeTarget`；更新 `test/web/nav.test.ts`（worker primary = `/rooms`，无 advanced；`homeTarget(false) === "/rooms"`）。
- [ ] 更新 `App.tsx` 路由骨架（`/rooms/by-task/:id`、`/tasks`·`/task/:id` 跳转、`MasterOnly` 守卫组件）。
- 验收：纯函数用例通过；`pnpm build` 通过；旧页面此时仍可访问（未删）。

### PR1 后端：`POST /api/rooms` + worker 规则闸门
- [ ] `createRoom` 实现（见 §4.3），复用 PUT 的校验与 `rollbackKeys` 思路。
- [ ] worker 上 `POST`/`PUT` 带 `processing` → 400。
- [ ] `test/app/web-api.test.ts` 新增：创建成功（任务默认 disabled）；规则写失败 → 任务回滚；重复房间 409；worker 拒绝 processing；`sourceTaskId` 指向新任务。
- 验收：端点级用例覆盖三类失败路径；`pnpm test` 全绿。

### PR2 单弹窗：`RoomEditor` create/edit
- [ ] `RoomEditor` 支持 `mode`；create 时 `room` 输入 + 平台默认值 + 四步全开。
- [ ] `payloadFromForm` 支持 create（`hasRecording:true`；`recording.room` 由弹窗补）；补 `test/web/room-editor-form.test.ts` 用例（create 的 schedule 校验、worker 模式无 processing）。
- [ ] `RoomsPage` 的「添加房间」改开 `RoomEditor(mode:"create")`；删除 `AddRoomDialog.tsx` 与其专用 helpers；`test/web/room-create.test.ts` 改为只覆盖 `findExistingRoom`。
- [ ] 创建后默认暂停：断言不调用 `startTask`（保留 T-157 的 source-grep 用例）。
- 验收：同一条 `submit` 路径；新增后列表立刻出现且状态为「已暂停」；saved/失败 toast 与编辑一致。

### PR3 节点侧收敛：`RoomsPage` / `RoomPage` 能力裁剪 + 受管只读
- [ ] `useRoomsData`：worker 上不调 `getWorkersStatus` / `getLatestRuns` / `useHubStream`（改用 30s 轮询；`workers:[]`；`runs` 空）；保留 `listTasks` 5s 轮询。
- [ ] `RoomsPage` worker：隐藏「节点」pill / `WorkersPanel` / `HubStreamBanner`；列改为 房间 / 录制方式（直播直传·边录边传·普通 + 存档格式）/ 定时 / 状态 / 操作；保留 `isUnassignedHidden` 过滤（原 TaskList 行为）。
- [ ] 受管只读：列表与详情去掉编辑/启停/排空/MergePanel/删除；保留查看、日志、信息与运行历史。
- [ ] `RoomPage` worker：处理半信息卡显示「本节点不处理视频」而不是"无规则"；不挂 `RoomRunsPanel`/`MergePanel`/直播直传时间线（时间线数据来自 master）。
- [ ] 覆盖：`test/web/ui-consistency.test.ts` 增补"受管房间无编辑入口"的 source-grep；`room-detail` 纯函数用例补 worker 分支。
- 验收：worker 页面不再出现任何 master 端点请求（浏览器 Network 面板核对）；受管房间无写操作；手机宽度无横向溢出。

### PR4 退役旧页面 + 收尾
- [ ] 删除 `TaskList.tsx` / `TaskDetail.tsx` / `CreateEditTaskDialog.tsx`，移除 `tasksAtom` 与相关 import；`RecordingSection` 仍由 RoomEditor create 复用（不动）。
- [ ] `/tasks`、`/task/:id` 跳转生效；`/rooms/by-task/:id` 支持通知/旧链接（任务不存在 → `/rooms`）。
- [ ] i18n：新增 create 文案与 worker 能力提示（zh/en 同步，`i18n-completeness` 通过）；删除 AddRoomDialog 专用 key（或标为保留）。
- [ ] 更新 `docs/`（若有 UI 路由说明）；`TODO.md` 勾掉。
- 验收：全量门禁（见 §7）。

---

## 6. 风险与边角

- **F1 `/hub` 页仍存在**：它按规则维度编辑 master 的规则（含拖拽排序）。本计划不动它，但要在 `HubPage` 的规则编辑入口加一句"房间的整体配置在「房间」页"，避免两处配置互相覆盖。若确认要退役，见 §9 后续项。
- **F2 未分配任务的过滤**：worker 上原 TaskList 默认隐藏 `isUnassignedHidden` 的受管任务，Rooms 列表必须承接，否则节点页面会突然多出一堆隐藏房间。
- **F3 受管只读与"本地 override"**：现有受管任务在 worker 上有 per-node override（凭证/账号开关/输出目录/推送地址）。用户口径是"不可 edit"，本计划按**整体只读**执行；若之后要保留 override，需要单独开票（会与"只有一个弹窗"冲突）。
- **F4 创建即写规则的回滚**：任务回滚失败必须显式说明，不能静默半成功（沿用 `updateRoom` 的错误口径）。worker 上不写规则，故无此风险。
- **F5 `hubEnabled === null` 抖动**：首屏探测未完成时若渲染 worker 版，可能闪一下；`homeTarget` 返回 null 已等待，页面内部按 worker 保守渲染（不显示写操作），探测完成后再展开 master 能力。
- **F6 旧链接**：通知、队列页、hub 页存在 `/rooms/:key` 与 `/task/:id` 链接（`ui-consistency` 有守护），跳转必须保参数（`?logs=1`）。

---

## 7. 验证门（每期必过）

- `pnpm test`（全量；涉及前端纯函数的改动必须补/改用例）
- `pnpm typecheck`
- `cd packages/web && pnpm build` + `tsc`
- `pnpm bundle` + 根 `package.json` version patch（本次触及 `packages/` → 必须 bump，commit 内写 `chore: bump version`）
- 手工核对（master + worker）：房间列表/详情/新增/编辑/受管只读/手机宽度
- `scripts/pr-gate.py`、`scripts/pr-risk-scan.sh`（本计划不碰上传/清理/ledger，预期不命中 RISK；若命中按门禁转 `needs-decision`）

## 8. 提交与分支

- 分支 `feat/tasks-unified-ui`，PR base `feat/hub-optimization`。
- 计划文件与 `TODO.md` 单独 commit（`docs(plan): …`），代码按 PR 分期独立 commit。
- 不加任何 AI 署名 trailer。

## 9. 后续（本计划不做）

- 退役 `/hub` 页并把规则拖拽排序迁到 `/rooms`（需先确认用户是否还用排序）。
- 节点侧 per-node override 的只读/可编辑口径（见 F3）。
- 把 `RoomDTO` 的 `recording`/`processing` 拆成独立契约（若之后真要"任务成为唯一实体"）。
