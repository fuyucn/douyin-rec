# #752 PR2 — 主控上传失败安全回队列（T-250）

## 2026-11-26 更新

- 本轮独立复审（PR head `7e72f421`）归为两组根因：①同场稿件归属在新建、强制重跑和自动重试之间缺少统一判定；②到期调度、失败归因与运行配置存在不对称，可能造成第二稿、重试空转或把旧限流套到新失败。当前未提交修复统一自动/手动同场守卫；`-N` 到期任务映射回基础录像；对临时不可派发项有限期退避，对配置/来源不可恢复项转人工；本次执行 runId 隔离失败证据；手动节点重跑使用房间配置；成功建稿后优先保存 BV。
- 审查对称路径：首次 reconcile、到期 tick、`runNow` 默认/force、手动节点重跑、节点能力/磁盘闸门回落主控、重启、停止、同场 sibling、`-N` job 与节点队列所有权。真实管线回归覆盖失败归因、同场重复投稿阻断、强制 supersede、`-N` 调度、房间可见性/season 与主控/节点路径隔离。
- 最新本地完整验证：`pnpm test` **5,822 passed / 42 skipped**（387 个文件通过、1 个既有跳过）；`pnpm typecheck`、`pnpm arch:check`、`pnpm bundle`（`0.0.413-3c5bc8`）、`git diff --check` 均通过。代码已提交为 `af30ae8c`，等待推送后 CI 与独立复审。
- 用户已在 #752 明确批准 PR2 限定行为（仅持久证据证明未提交的单文件限流失败自动重试；未知回执、部分提交、历史任务不自动重传），因此本轮不再重复询问产品决定。风险扫描仍为 `RISK`，属仓库强制风险门禁，须按 review 流程处理；PR 远端待推送 `af30ae8c`，未合并、未部署，生产空闲检查也未执行。

## Goal

本次 PR2 只为主控增加一种自动回队路径：明确限流拒绝且持久证据证明未提交的单文件，按既有退避重试。其他非限流上传错误、未知回执、部分成功和缺少历史证据都不自动重传；PR3–5 另行实施。任务索引：[TODO.md 的 T-250](../TODO.md)，上游 issue #752；PR1 已合并。

## Architecture

- 复用主控现有 `SyncLedger`、`JobDispatcher`、`ResourcePool` 与 core 分类器，不增加数据库、进程或新的上传执行者。
- 在每场 `sync_jobs` 增加紧凑提交日志：逻辑组、分段下标、文件指纹、提交意图、确定拒绝或受理证明。日志与 BV、season 意图和 `sync_parts` 必须同一事务保存。日志只记录本场提交，不记录每块字节或每次重试历史。
- 上传调用前先落意图，调用后先落成功事实。成功结果落库失败保留意图，后续只读核验，不再投稿。已受理/未知项的指纹变化、下标变化或进度表不一致一律人工；只有持久台账记录的单文件明确限流拒绝可在同逻辑组/同下标下重新校验并续跑，不会覆盖已提交项。其他提交前错误不进入本次新增重试队列。
- 日志只对主控路径生效；旧数据缺证据、节点路径继续保守。空日志不当成可重试的上传失败。`accepted` 不冒充 `observed`，原有最终回读与清理闸门不变。
- 失败计数由任务失败收口层单次写入；明确限流拒绝不计数。该单文件重试到期时间复用 core 5 分钟指数退避（上限一小时）与抖动，且不早于上传池的冷却截止。非限流上传失败保持人工处置；不扩展其自动重试策略。
- 独立 5 秒 tick 仅唤醒到期的主控重试；复用同一个 dispatcher。普通对账也尊重到期时间；执行开始前再次核对终态、配置、归属和流锁。停止后不得自动复活。

## Tasks

- [x] 添加日志读写与原子成功提交，补旧库、损坏日志、事务回滚用例。
- [x] 接入主控合并、分段与各续跑调用；替换持锁内的重复上传重试为失败后回队。
- [x] 仅对主控单文件明确限流拒绝接持久证据与独立到期 tick；其他上传失败维持人工兜底。
- [x] 覆盖限流、未知结果、批次失败、成功后崩溃、文件变化、重启、并发去重、用户停止和节点路径不变。
- [!] 本地验证已完成；代码提交 `af30ae8c` 待推送后的远端 CI/自动 review。风险扫描为 RISK，合并仍须通过 review 门禁；部署按仓库流程由人执行，且须通过生产空闲预检。

## Global Constraints

不改投稿参数、源文件保留或删除口径、同场聚类、规则、节点上传协议；不操作生产数据，不启动 Docker 场景。本机同时至多两个 Vitest 进程。按用户要求准备部署，但须确认主控与全部生产节点无录制、无上传，且 SSH 执行能力可用；远程状态能力不可用时不得绕过预检。

## 审查取舍

已采纳顾问关于空日志不能证明失败无副作用、成功证据同事务、未知批次不重试、共用 dispatcher 与流锁、冷却下限和 proof 区分的意见。保留单场 JSON 列以避免扩大共享表清理/迁移范围：每场已有流锁，提交日志通过比较原值原子写入，受理与进度同事务；不会用普通读改写覆盖另一执行者。没有采纳“限流累计若干次即人工”：用户要求减少人工且现有 core 明确限流不耗失败预算；持续限流仍受持久冷却控制，错误与下次唤醒均保留。没有将未知超时当作无副作用。

## Evidence

## 2026-11-26 Review convergence

- **Invariant — at most one archive per broadcast:** before any master submission, all live/terminal sibling jobs, BVs, unresolved create intents, active stream locks and node-queue ownership are considered. Force can supersede only a provably safe pending retry; unknown/legacy submission evidence remains non-forceable.
- **Invariant — retries require current proof:** only a single-file, durable, explicit rate-limit rejection from the current run is retryable. Old journal errors, node-side outcomes, partial batches and ambiguous intents cannot confer retry eligibility on a later run.
- **Invariant — node queue ownership is preserved:** a persisted `uploadPlan` remains the node queue's responsibility; master retries apply only when the pipeline actually owns the upload, including legitimate fallback from unavailable node-side capability.
- **State owners:** `master-upload` owns `uploadJournal`, run identity and submission proof using compare-and-set writes; `SyncLedger` owns the atomic commit of BV/season/part checkpoints; `Reconciler` owns failure classification and retry wake-up fields; the shared `JobDispatcher` owns active-job deduplication; `ResourcePool` owns upload serialization, cooldown and stream locks. The due timer only selects/awakens jobs and never creates a second execution lane.

| Event | No submission proof | Current explicit single-file rejection | Intent / unknown or partial outcome | Submitted / observed or accepted proof | Manual / terminal |
| --- | --- | --- | --- | --- | --- |
| Initial submit | Persist plan and intent, then submit once | Not applicable | Refuse a second submit | Reuse verified checkpoint; do not duplicate | No automatic execution |
| Explicit rate-limit response | Store `not-submitted` proof and bounded-backoff schedule | Retry same logical group/index through existing upload gate | Any other unresolved entry forces manual | Keep already submitted parts and retry only proven missing item | Stay terminal |
| Timeout, process kill, lost response | Intent remains unresolved | Not inferred from an unchanged remote count | Turn manual; never resend | Continue only from durable observed proof | Stay terminal |
| Due tick / ordinary reconcile / `runNow` | Apply the same room, family, source and ownership guards | Preserve retry eligibility through real DAG; consume after execution | Do not schedule or submit | Skip submitted parts; perform existing final verification | Do not resurrect |
| Restart / stale `retrying` | Recover using the same durable evidence | Defer until stale recovery, then dispatch once | Manual; intent is not retried | Resume append/checkpoint path without recreating archive | Stay terminal |
| Source-plan or room-config change | May bind a new plan only before any submission evidence | Stop retry if room mode/worker selection no longer matches | Manual; never remap an old index | Preserve prior mapping; changed submitted input is rejected | Stay terminal |
| Same-broadcast sibling / forced rerun | Block while another viable sibling may submit | Force may supersede a proven retry sibling, clearing its plan | Force cannot bypass unresolved or legacy evidence | Existing BV/history blocks automatic second archive | Remain manual unless an explicitly safe path is selected |
| Persisted node `uploadPlan` | Do not start master upload | Do not steal the node-owned order | Node status unknown remains non-forceable | Node queue completes through its own poller | Do not create a master duplicate |
| User stop / duplicate dispatch | Single dispatcher/stream lock prevents concurrent run | Cancel to manual and do not requeue | Preserve unknown intent | Preserve accepted evidence and do not repeat | Stay terminal |

- **Symmetric path audit:** initial reconcile, due-only scan, default/forced `runNow`, manual node retry, node-side eligibility changes, disk/capability fallback, restart/stale recovery, stop/abort, same-broadcast siblings, `-N` identities and queue ownership use the same predicates and submission evidence. The end-to-end tests exercise real `Reconciler` → `runPipeline` DAG paths rather than only mock callbacks.
- **Scope convergence:** retaining the one per-job submission journal and using the existing dispatcher is necessary for this PR's approved goal—retry a proven no-side-effect rejection without posting twice. No second queue/executor or new persistence store is introduced. Unknown/legacy operator attestation and node-side retry behavior stay out of PR2.
- **Intentional limits:** no operator attestation path for legacy/unknown submissions and no automatic line failover after an ambiguous request; both remain manual to preserve at-most-once behavior. Node-side upload remains owned by each node's existing queue; this PR changes only master-side retry scheduling.

- 初始基线：完整测试 5723 passed / 48 skipped；依赖用 frozen lockfile 恢复，未改锁文件。基线未 bundle 导致 CLI 的 6 条额外跳过；最终先 bundle 再全量回归。
- 首轮本地门禁（补充修复前）：完整测试 **5779 passed / 42 skipped**（387 个测试文件，1 个文件跳过），类型检查、架构检查、bundle 与 git diff --check 通过。既有跳过未增加，不放宽超时。Bundle 版本 `0.0.409-f61f84`；受影响测试另行通过 **429 passed**。补充修复后的权威结果见下条。
- 变异：撤掉未知 intent 守卫 → 3 failed；恢复 → 新增证据/调度测试 17 passed。
- 隔离开发实跑：全新临时数据根、显式回环地址、随机回环端口，`GET /api/tasks` 返回 200，bundle `--version` 返回 `0.0.409-f61f84`；进程已停止并清理临时根，不接触生产目录。
- 首轮全量 10 条旧预期失败保留记录：4 条回读/失败阶段断言改为同轮转人工；2 条旧重传测试改为超时/被杀结果未知不得重发；4 条半成品恢复用例改用可证明未提交的限流拒绝，不再用“被杀”当未提交证明。所有源保留与防重复断言继续保留。
- 最终范围复核发现：有既存 BV 时，缺产物等非限流的提交前错误也可能被 \`resume-append\` 放入重试队列。现已要求当前失败与持久证据都明确为单文件限流拒绝，并补“旧限流记录不得豁免后来非限流失败”的单元及端到端回归；本轮全量回归通过。
- 复核确认 proof-only append 在无基线且不延后核验时转为 `append-ambiguous`，并有回归用例；已到期任务可能仍在录制的路径对新清单成员执行 isDone 检查，未收播会跳过派发；新增直接回归并通过。`scripts/pr-risk-scan.sh origin/main` 按预期输出 `RISK`（上传/台账敏感路径，需按仓库门禁保留人工决定）；不部署，#752 的 PR3–5 未完成。
- 2026-11-25 最终本地复验：`pnpm test --reporter=dot` — 5,794 passed / 42 skipped（387 files passed / 1 skipped）；`pnpm typecheck`、`pnpm arch:check`、`pnpm bundle`（`0.0.412-56034f`）与 `git diff --check` 通过。定向 `master-upload.test.ts` + `pipeline.test.ts` 198 passed；补充 legacy 计划锁定用例 2 passed。计划绑定经自审修正：允许非 legacy 且尚无提交记录的安全重扫更新计划；已有提交或 legacy 计划不允许漂移。独立静态审查未发现 P1/P2；最新这条 legacy 条件另有回归覆盖。当前 PR 远端仍在旧 head，以上为本地验证；尚未部署，机器清单仅确认部署 SSH 主机可达，不等同应用无录制/上传。

## 2026-11-26 Review convergence round 10

- **Failure families and path:** (1) retry age was measured from the original failure while a retry could be queued, active, or live again; retain the existing bounded backoff, but do not expire work while the dispatcher, stream lock, job, or recording owns it. (2) preserving the full stderr tail for classification could exceed Discord's content limit; cap the outgoing notification and log rejected webhook responses while keeping webhook errors non-fatal. (3) force semantics for legacy/unknown history were conflated with automatic retry safety; keep unknown intent and unreadable node-queue state non-forceable. Do not broaden this upload boundary without an owner decision.
- **Convergence decision:** the PR's original goal still requires the single durable submission journal and the existing dispatcher/upload gate; deleting them would permit duplicate archive creation or a second queue. Keep those established mechanisms, add no new queue, executor, or persistence mechanism, and keep per-node upload-plan ownership unchanged.
- **Manual force decision pending:** the latest review asks to restore force for legacy/no-journal history and unreadable node-queue state. The implementation intentionally remains fail-closed because force can lead to a second archive while the previous outcome is unknown. Ask the owner whether manual force should override legacy/no-proof history after the old draft is deleted; do not allow it to bypass a persisted unresolved intent or active/unknown node queue without explicit approval.
- **Regression coverage:** added real dispatcher-queue and active-pipeline long-wait cases plus resumed-recording deferral; Discord payload size/non-2xx handling; force conflict response contract. Targeted suite passed **210/210**.
- **2026-11-26 final local validation:** `pnpm test --reporter=dot` — **5,830 passed / 42 skipped** (388 files passed / 1 skipped); `pnpm typecheck`, `pnpm arch:check`, `pnpm bundle` (`0.0.414-44bde7`), `python3 scripts/issue-guard.py --diff origin/main`, and `git diff --check` passed. `scripts/pr-risk-scan.sh origin/main` still returns `RISK`.
- **Remote state:** PR #754 head is `fe8487b`; the last gate snapshot reported one passing check on that SHA. This round's working-tree fixes have not been committed, pushed, checked by CI, or independently reviewed. No merge, production upload, or deployment occurred. Before any deployment, check master and the chosen node have no recording/upload activity.
- **Follow-up setup:** the active PR schedule uses a legacy pre-run command. The user must replace only its command with the card-provided current `pr-node.cjs pr-heartbeat-gate.mjs` launcher, preserving the timeout; the schedule must not be edited automatically.
