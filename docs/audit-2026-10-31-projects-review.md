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
