# 项目审计报告（2026-10-31，feat/hub-optimization @ f30e4f30）

两轮独立模型审计（读代码为主）：第一轮全量扫核心模块，第二轮逐条验证第一轮 findings（读调用方/防护代码判定可达性）并抽查上传链路、proc-queue 关停路径、静态文件服务。本 issue 汇总两轮结论，严重度以第二轮验证后的为准。

## 概览

整体健康度较好：无空 catch 滥用、无 `as any`、remux 校验与 proc-queue 状态机扎实、凭证出口收敛（单一脱敏出口 + 日志脱敏 + 通知地址不回显）。主要风险集中在 Web API 无鉴权、SQLite 多进程写配置、清理失败被吞三点。

## Findings

### [P1] Web API 无鉴权、无 Origin/Host 校验，CSRF 可串到代码执行
- 位置：`packages/app/src/web/server.ts`（路由 dispatch、`readJson`）、`packages/app/src/web/api/settings.ts:136`、`packages/app/src/process/spawner.ts:163`
- 问题：全仓无共享密钥/Authorization/Origin/Host 校验；`readJson` 不看 content-type、不限 body 大小。`text/plain` 的 JSON POST 是"简单请求"，不触发 CORS 预检——任何网页都能对打开着 UI 的浏览器发起 CSRF。可达后果：
  - `POST /api/mesio-path` 把 `settings.mesioPath` 设为任意路径，下次起录经 `MESIO_PATH` 注入子进程执行（→ RCE）。
  - 通知地址设置接口可被改写（房间/错误信息外泄）；对应测试接口构成盲 SSRF。
  - `POST /api/maintenance/orphans` 带 `{"confirm":true}` 直接触发删除；登录态接口可被覆盖。
  - docker-compose 把 7860 绑在 `所有网卡`。
- 建议：加共享密钥或 Basic 鉴权；校验 Origin/Host 白名单；要求 `application/json` 并限制 body 大小；`mesioPath` 校验为存在的可执行文件。
- 附带（P3）：`/api/hub/stream`（SSE）无连接数上限，与上条同源，加鉴权后自然收敛；`internal` 回环信任在"同机反代"部署下会失效，属部署注意项。

### [P2] SyncLedger 无 busy_timeout/WAL，多进程写同一 `-sync.db` 撞锁即抛
- 位置：`packages/orchestrator/src/ledger.ts:113`（构造无任何 PRAGMA）；`packages/app/src/hub-jobs.ts:128`（deleteHubJobHistory 另开写连接，同样无配置，且五表 DELETE 无事务，中途 BUSY 会删一半）
- 问题：serve 长连接、master 本机直播直传收尾的 record 子进程（每次 `new SyncLedger`）、删除房间历史——三个写端并发。只读连接持有共享锁时，写端提交立刻 `SQLITE_BUSY`，pipeline 步骤被记 failed。
- 另：record 子进程侧台账写入失败只 `console.log`（`packages/cli/src/cli.ts:626`），不告警不重试——稿件已上传但台账没记，房间永远看不到这场结果；同函数受管分支失败会 notify，两条路径不一致。
- 建议：SyncLedger 统一 `WAL + busy_timeout`（可复用 proc-queue 的 initWal）；deleteHubJobHistory 加 busy_timeout + 事务；record 子进程失败分支补告警。

### [P2] 清理失败被吞，台账「清理失败可见」不成立
- 位置：`packages/orchestrator/src/transport-ssh.ts:523`、`transport-local.ts:133`（cleanup 内部吞异常）；`packages/orchestrator/src/pipeline.ts:307`（defaultRmStage 逐路径吞）
- 问题：设计前提是 cleanup 失败会抛 → 记 `clean_source` failed → 补跑。但真实 transport 都吞异常，`catch → srcFailed` 永远走不到，步骤恒为 done。磁盘满/权限错/ssh 断开时节点源不删、stage 不清，磁盘悄悄涨满，无任何告警。第二轮还确认「done 且缺 clean_source 就补跑」已被撤回（reconciler.ts:597），兜底也没有。
- 建议：transport cleanup 失败时 reject（或返回失败列表），defaultRmStage 聚合抛错。

### [P3] acquireLease 先读后写无事务
- 位置：`packages/proc-queue/src/lease.ts:42-66`
- 问题：双进程同时看到过期租约可各自 `acquired:true`。第二轮验证实际影响有限：输家 claim 被库内 fencing 拒绝，仅其 `recoverKind` 在 ≤10s 窗口内多跑一遍（可能误删胜者新 tmp → 一次假失败告警）。微秒级窗口。
- 建议：`acquireLease` 包进 `BEGIN IMMEDIATE`（同文件 yieldLease 已是此写法）。

### [P3] pr-risk-scan 漏掉「放宽校验」类危险改动
- 位置：`scripts/pr-risk-scan.sh` SENSITIVE_FILES
- 问题：改 `packages/processors/src/remux.ts` 的 `MIN_SIZE_RATIO` 或放宽 `verifyRemuxed` 不会命中任何删除/ledger 关键字，RISK 扫描 PASS，agent 可自动合并——而这里正是"通过校验才删原文件"的唯一闸门。
- 建议：把 `remux.ts`、`proc-queue/src/store.ts`、`finalize-format.ts` 加入 SENSITIVE_FILES（一行改动）。

### [P3] issue-guard 覆盖不到本部署实际形态的敏感信息
- 位置：`scripts/issue-guard.py`
- 问题：不拦 `.ts.net` MagicDNS 主机名；「本机路径」只认 `/Users/`、`/home/`、`~/`，不拦 `/root/`、`/mnt/` 等；主播名无检测（只能人工）。
- 建议：补 `.ts.net`、`/root/`、`/mnt/`、`/srv/` 等规则。

### [P3] 日志清理不看 job 是否仍在进行
- 位置：`packages/app/src/job-log-cleanup.ts`
- 问题：只按 mtime 删，非终态 job 若日志静默超过 N 天（N=1 时可能），其日志被删、UI 404。手动触发 + 有预览 + 正在写的日志 mtime 会更新，实际风险低。
- 建议：selectJobLogs 排除非终态 job 的日志路径。

### [P3] zero-disk 存活判断用裸 pid
- 位置：`packages/app/src/zero-disk-node.ts`（pidAlive / readLiveUploadFile / buildZeroDiskReport）
- 问题：容器重启后 pid 复用，死 run 可能一直显示 running。仅影响展示。
- 建议：状态文件记录进程启动时间指纹，校验 pid + 指纹。

### [P2→条件] rsync host key 策略与远端路径转义
- 位置：`packages/orchestrator/src/transport-ssh.ts:61`
- 问题：`StrictHostKeyChecking=no` 属实（tailnet 内风险低）；remote 路径未转义——目录名经 `sanitizePathSegment` 仍保留 `$ ( ) ; & \``，主播名由主播控制。rsync ≥ 3.2.4（Debian 12 / Ubuntu 22.04 = 3.2.7）默认保护参数不受影响；Ubuntu 20.04（3.1.3）会在节点 shell 展开。
- 建议：先在节点 `rsync --version` 确认版本；< 3.2.4 则加 `--protect-args`（或转义），顺手去掉 `StrictHostKeyChecking=no`。

### [P3] 前端小项
- 静态资源对非 hash 文件（如 favicon）也发 `immutable` 一年缓存（`server.ts` sendAsset）：只对 `/assets/` 用 immutable。
- `CurrentRunTree` 与 `LiveRunHistory` 对同一任务各轮询一份 `getTaskLive`（10s/30s）：可合并为一份。

## 抽查未发现问题的部分
- 上传链路：BV 先落库再 append，续跑不重建稿；删源在回读分 P 数之后。
- proc-queue stop/fence：fence 后不可逆动作被 `assertLease` 拦住，关停超时落 cancelled/uncertain 并告警。
- 静态文件路径穿越防护正确。

## 建议处理顺序
1. 必修：P1 鉴权（共享密钥 + Origin/Host 校验 + content-type 限制 + body 上限 + mesioPath 校验）；P2 清理失败可见；P2 SyncLedger WAL/busy_timeout + 台账失败告警。
2. 建议修：rsync 转义（先确认节点 rsync 版本）、pr-risk-scan 清单、issue-guard 规则。
3. 可接受：acquireLease 事务、pid 指纹、日志清理排除非终态、前端两项。

---

# 附：专项审计（结构与代码 bug，第三轮，2026-10-31）

汇总 issue：#420。本轮覆盖分层守护、包职责与录制链路功能缺陷（#419 未覆盖的面）。

## 结构 Findings

- [结构-中] orchestrator → app 反向依赖被 RANKS 检查意外放行（只拒 depRank >= myRank，4.5→4 合法通过；源码注释以为会挂，与实际不符）。建议加显式禁止边清单。
- [结构-中] 分层测试只读 package.json 的 dependencies，不扫源码 import（含动态 import）；web 经 vite alias 直接引 core 内部文件绕过包边界。建议对 packages/*/src 做 import 扫描并与 RANKS 对账。
- [结构-中] app 直写 orchestrator 台账 schema：hub-jobs.ts 以可写连接 DELETE 五张台账表，「SyncLedger 是唯一写端」不成立；hub-watch/hub-jobs 裸 SQL 依赖台账列。建议读写模型收进 SyncLedger、app 走注入端口。
- [结构-中] 原子写至少 8 份实现（worker-store/credential-file/hub-config-store/managed-state/hub-store/zero-disk-node/rolling-upload/live-pump），临时文件命名约定不同，清理扫描只覆盖 core 那种。建议统一到 core。
- [结构-中] 新增包要手工登记 7 处，仅 RANKS 与生成脚本 2 处强制；vitest alias/tsconfig paths 缺多个包且残留失效别名；生成架构图的 RANK_LABEL/SEMANTIC 缺漏导致 mermaid 分组标错。建议别名从 workspace 现算或加测试钉住。
- [结构-中] core 含 I/O 与上传业务（rolling-upload 路径调用带登录态的外部接口；upload-gate/slot 在 core）；「core 纯契约」只测不依赖 @drec/*，不禁 fs/网络。
- [结构-低] app 约 70 文件过大（节点侧执行体可拆）；ffmpeg-recorder-extra 可并入 record-engine；scheduler 用本地时区 getHours()（靠 serve 改 TZ 才正确，与「日期统一口径」不一致）。

## bug Findings

- [bug-高] 断流重连被最后一段上传阻塞：`manager/index.ts` _handleOffline 里 `await rolling.onSessionEnd()`（等 GB 级末段上传，槽忙最多 30 分钟）排在退避与重连之前，期间主播还在播，内容永久丢失。涉上传行为 → needs-decision。修法：后台收尾 + 后继会话按 #46 接管，需先修「同进程 pid 视为已结束」假设。
- [bug-中] ffmpeg 分段解析在主播名含撇号时失效：`record-engine/engines/ffmpeg.ts:52` 正则 `/Opening '([^']+\.ts)' for writing/`，sanitizePathSegment 不剥 `'`，含撇号名从第 2 段起全部不触发 onSegment → 不上传/不转码/不删源，静默残留转人工。修法小：放宽正则 + stderr 按行缓冲。
- [bug-中] 弹幕 WS 僵尸连接：listener-base 的 start 在 await 场次号/访客登录态期间 stop() 空操作、随后仍连 WS 无人关；client.ts 的 close() 不清重连定时器、不终止 CONNECTING 态 socket。同设备多路 WS 并存（风控信号），僵尸源闭包写进下一场 xml。修法：stopped 标志 + close 全清 + 登录态拉取超时；顺带让 client 可测（注入签名/proto）。
- [bug-中] mesio 引擎只上报第 1 段：无逐段回调，边录边传/节点侧 remux 在 mesio+分段下第 2 段起失效。需先确认调用链是否已拦截。
- [bug-低] daemon.tick 在 reconcileRollingDrift 里 await 停任务，占住 ticking 锁拖慢全部任务窗口启停；弹幕去重键秒级精度，同秒同内容两条丢一条。

## 测试缺口
danmaku/client.ts 零测试（重连计数/清零/exhausted/close 竞态）；引擎撇号/单段问题无用例。

## 建议处理顺序
1. needs-decision：重连阻塞（涉上传行为）。
2. 直接修（小）：ffmpeg 撇号解析；弹幕僵尸 WS（一张票，含 client 可测性）。
3. 先确认再定：mesio 逐段上报。
4. enhancement：分层守护补强、app 直写台账收进 SyncLedger、原子写统一、包登记自动化、core I/O 迁出、scheduler 时区口径。
