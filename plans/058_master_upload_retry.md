# #752 PR2 — 主控上传失败安全回队列（T-250）

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
- [~] 本地验证已完成；等待最新提交的远端 CI/独立审查。部署已获用户要求，但必须先恢复 SSH 执行能力并通过生产空闲预检。

## Global Constraints

不改投稿参数、源文件保留或删除口径、同场聚类、规则、节点上传协议；不操作生产数据，不启动 Docker 场景。本机同时至多两个 Vitest 进程。按用户要求准备部署，但须确认主控与全部生产节点无录制、无上传，且 SSH 执行能力可用；远程状态能力不可用时不得绕过预检。

## 审查取舍

已采纳顾问关于空日志不能证明失败无副作用、成功证据同事务、未知批次不重试、共用 dispatcher 与流锁、冷却下限和 proof 区分的意见。保留单场 JSON 列以避免扩大共享表清理/迁移范围：每场已有流锁，提交日志通过比较原值原子写入，受理与进度同事务；不会用普通读改写覆盖另一执行者。没有采纳“限流累计若干次即人工”：用户要求减少人工且现有 core 明确限流不耗失败预算；持续限流仍受持久冷却控制，错误与下次唤醒均保留。没有将未知超时当作无副作用。

## Evidence

- Final local verification after the retry-cap correction: \`pnpm test --reporter=dot\` passed (5,785 passed, 42 skipped; 387 files passed, 1 skipped); \`pnpm typecheck\`, \`pnpm arch:check\`, \`pnpm bundle\` (\`0.0.408-4b1aab\`), \`git diff --check\`, and the focused master-upload suite (35 passed) passed. Retry jitter is clamped to the core one-hour maximum while the existing upload-pool cooldown remains a lower bound. The latest changes are local and need updated-head remote CI/review. Production nodes were not changed: the SSH executor is disabled in this session and requires a settings change plus a new session; no deployment or production status check was attempted.

- 初始基线：完整测试 5723 passed / 48 skipped；依赖用 frozen lockfile 恢复，未改锁文件。基线未 bundle 导致 CLI 的 6 条额外跳过；最终先 bundle 再全量回归。
- 首轮本地门禁（补充修复前）：完整测试 **5779 passed / 42 skipped**（387 个测试文件，1 个文件跳过），类型检查、架构检查、bundle 与 git diff --check 通过。既有跳过未增加，不放宽超时。Bundle 版本 `0.0.409-f61f84`；受影响测试另行通过 **429 passed**。补充修复后的权威结果见下条。
- 变异：撤掉未知 intent 守卫 → 3 failed；恢复 → 新增证据/调度测试 17 passed。
- 隔离开发实跑：全新临时数据根、显式回环地址、随机回环端口，`GET /api/tasks` 返回 200，bundle `--version` 返回 `0.0.409-f61f84`；进程已停止并清理临时根，不接触生产目录。
- 首轮全量 10 条旧预期失败保留记录：4 条回读/失败阶段断言改为同轮转人工；2 条旧重传测试改为超时/被杀结果未知不得重发；4 条半成品恢复用例改用可证明未提交的限流拒绝，不再用“被杀”当未提交证明。所有源保留与防重复断言继续保留。
- 最终范围复核发现：有既存 BV 时，缺产物等非限流的提交前错误也可能被 \`resume-append\` 放入重试队列。现已要求当前失败与持久证据都明确为单文件限流拒绝，并补“旧限流记录不得豁免后来非限流失败”的单元及端到端回归；本轮全量回归通过。
- 复核确认 proof-only append 在无基线且不延后核验时转为 `append-ambiguous`，并有回归用例；已到期任务可能仍在录制的路径对新清单成员执行 isDone 检查，未收播会跳过派发；新增直接回归并通过。`scripts/pr-risk-scan.sh origin/main` 按预期输出 `RISK`（上传/台账敏感路径，需按仓库门禁保留人工决定）；不部署，#752 的 PR3–5 未完成。
