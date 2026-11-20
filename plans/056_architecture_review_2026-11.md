# 056 — 2026-11-20 全项目架构审查与改进批次

> 状态：实现已汇总到集成分支 `arch/2026-11-batch`，待独立 review/PR。
> 审查基线：`main` `167b0726` / `0.0.395`。本计划不部署、不改上传投稿/删源/hub 规则。

## 1. 目标与审查方法

用 `xingchiapi/gpt-6.1-sol`（xhigh）做一次只读全项目架构审查，再由同一模型拆成 6 个只读小审查（W1–W6），最后由主会话逐条核对源码与测试。审查产出不直接当事实；例如“README 包数测试恒红”已被实测否定（20 个 `packages/` 目录、19 个 workspace 成员；README 20，`docs/architecture.md` 的 13 是过期数字）。

审查覆盖：包边界/所有权、hub 编排与台账、上传/队列、平台注册、Web/API 契约、配置/路径/时区、测试架构。
不覆盖：大规模重写、上传驱动统一、pipeline 步骤注册表、worker wire protocol、平台登录能力矩阵；这些继续由 `#419 / #420 / #484 / #49` 与 `plans/049/051/052` 推进。

## 2. 已确认的可执行 findings

### P1

1. **hub 全局配置坏 JSON/空文件/不可读会被写回覆盖**：`worker-store` 与 `hub-config-store` 的读取都折成 `{}`，下一次写用空底稿原子替换，workers/resources/未知字段可能消失。
2. **Hub 台账读失败被伪装成空列表**：`selectJobPage` / `latestRunPerRoom` 的 catch 返回空；API 仍 200；缺少必需表/列的旧库与真实 IO 错误未分开。`HubJobView` 与 `HubJobDTO` 缺编译期约束。
3. **Hub 重试 UI/状态错位**：清理节点显示重试按钮但后端 CORE 六节点拒绝；`done` 场的“补跑收尾”按钮走整场 `onRunNow`；分段模式 `retryNode` 先写 `retrying` 再 400。

### P2

4. **配置读改写没有事务边界**：两个 store 固定 `.tmp`、读—改—写无文件锁；跨进程可能丢更新/串台。
5. **平台注册/匹配歧义**：Platform/Engine 静默重复覆盖；多重 default/matchUrl 按注册顺序；B 站短链大小写前后端口径不一致。
6. **直播直传台账路径不一致**：serve 用 `resolveDbPath(--db)`，直传收尾按 `DOUYIN_REC_ROOT ?? cwd`；录制子进程没收到 serve 实际 DB。

### P3

7. **文档漂移**：包数口径、README 目录树、030 计划“未落地”状态、历史拆包状态映射过期。

## 3. Issue 映射与实现边界

| Issue | 内容 | 落点 | 风险 |
|---|---|---|---|
| #721 | 坏配置写入 fail-closed | `packages/app/src/worker-store.ts`、`hub-config-store.ts` + tests | 配置读写 |
| #722 | 配置读改写事务化 | 新增 `hub-config-transaction.ts`；core 原子写/文件锁；多进程测试 | 配置并发 |
| #723 | Hub 重试 UI 对齐 + 撤伪收尾 | `packages/web/src/components/HubJobs.tsx`、`lib/hub-job-retry.ts` + tests | UI |
| #724 | 分段模式拒绝前置 | `packages/hub-compose/src/hub-actions.ts` + tests | 台账状态 |
| #725 | 台账读失败语义 + DTO | `hub-job-reads.ts`、`hub-job-ledger.ts`、web api + tests | 只读 API |
| #726 | 平台注册/URL 匹配一致性 | core platform/engine、bilibili-live、web labels + tests | 启动期校验 |
| #727 | 直传 DB 路径跟随 serve | serve/spawner/record-args/stream-upload-lifecycle + tests | 上传记账路径（RISK 边界） |
| #728 | 文档包数/目录树/030 状态 | README、architecture.md/html、package-split | docs |

集成后额外修复（复审发现）：
- `maintenance` 活动保护改用 `activeHubJobKeys`，不再依赖完整 job 投影（旧台账也能保护活动 stage）。
- `settings` 来源拒绝非对象 JSON 根，避免资源更新假成功。
- `#723` 分段模式隐藏必然 400 的节点重试。
- `030` 文档/生成图改为 M1–M3 已落地、T16/T20 延期。

## 4. 不重复既有票

- `#420`：Web→core alias 守护、app 直写 ledger schema、原子写统一。本批不重复开同义票；#721 的 fail-closed、#722 的 RMW 事务是具体子问题。
- `#419`：Web 鉴权、SyncLedger WAL、清理失败可见。本批只读/UI 小修，不重复。
- `#484`：节点 proc-queue 任务表，不是 hub job 台账。
- `#49` / `plans/049/051/052`：pipeline、上传驱动、worker 协议、平台登录矩阵，继续原计划。
- `#324`、`#312` 已关闭，仅历史关联。

## 5. 实施与验证

- 每个 sub-issue 一个分支/worktree；集成分支 `arch/2026-11-batch` 合并 8 个实现提交 + 复审修复。
- 分支期不预分配版本；最终 PR rebase 到最新 main 后 bump 当前 main+1，`pnpm bundle`，一次 PR。
- 验证门：`pnpm test`（本次 5580 passed / 48 skipped）、`pnpm typecheck`、`pnpm arch:check`、`packages/web pnpm build`、`pnpm bundle`；PR 再过 `scripts/pr-gate.py`、`scripts/pr-risk-scan.sh` 与独立 review。
- 本批不部署。`#727` 触上传记账路径，PR 需标 RISK/人工决定；不自动合并/部署。

## 6. 残余风险

- `#722` 只覆盖文件来源；`settings` 来源的 JSON 读改写仍无跨进程事务（同 DB 的并发写）。本批不修，后续单独决定。
- Hub worker 写 API 仍把所有存储错误映射为 400；锁忙/IO 故障未区分，属于后续小修。
- `#726` 无法验证任意自定义 `matchUrl` 与 `urlPattern` 一致，只覆盖内置规则。
- `#727` 未做完整 `runServe` 启动集成/真实上传验证；只做 fake child + 临时目录。
- `#725` 只支持有限旧 schema 矩阵；不承诺任意历史库。
- `#723` 无真正 DOM 交互测试，按钮行为仍需要人工核对；当前以纯函数/静态断言兜底。
