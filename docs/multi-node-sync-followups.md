# 多节点编排 followups(2026-06-28 双节点实测暴露)

两次真实双节点测试(docker master + VPS slave,房间 加不加辣)跑通了完整链路并修了 4 个 bug(已 push)。
以下是**剩余 followup**,均不阻塞主干,按优先级记录待收口。

## 已修(本次,供参考)
- `2abbcc6` reconcile fork 风暴 —— hub 每 8s `void reconcileAll()` 无并发守卫 → 几十个并发 → 打爆两端 fork。加 in-flight 锁。
- `92eb428` listInventory/ssh 无超时锁死 —— hung ssh(tailscale 偶发 stall)卡死 reconcileAll 的 Promise.all。SshTransport 加心跳(ServerAliveInterval 5×3)+ 硬超时 45s;reconciler 加 inventoryWithTimeout 降级。
- `92eb428` **`bash -lc` 经 ssh 被打散**(2 节点失败真根因)—— `run(["bash","-lc",cmd])` 经 `ssh host -- bash -lc <cmd>` 空格 join → 远端 `bash -lc node /path …` → bash 只取 "node" 当命令、其余成位置参数 → 只跑空 `node` → 空输出 → JSON.parse 抛错 → 该 ssh 节点 inventory 恒空。改命令作单字符串传。
- `6efe22c` 容器装 biliup（auto-private 上传能力）+ xz-utils（biliup .tar.xz 解压）+ .dockerignore 放行 install-biliup.sh。

## 待修 followup

### 1. streamKey 同主播同日复用碰撞(高)
streamKey = `平台:roomSlug:日期`。同一主播**同一天的新旧两场**(或测试反复跑)→ 撞同一 streamKey。
旧场已 `needs_manual`/`done`(终态)且文件已归档 → 其陈旧 sync_candidates 残留 → 新场重聚时 winner 可能选中**已归档的旧录像** → pull 找不到文件 → 卡 syncing。
- clusterBroadcasts 对**同日多簇**已有 `_HHMM` 后缀逻辑,但跨「已从 recordings 移走的旧场」失效(旧场不在 inventory 里,但 sync db 残留)。
- 正解:① 选优/pull 前校验 winner.rec.tsFiles 存在,缺失则剔除该候选;② streamKey 含会话起播时刻区分;③ 或 sync_candidates 随 job 状态清理,不跨场残留。

### 2. pipeline 出错 / pull 失败应标 job=failed(高)
reconciler 的 per-broadcast try/catch 只 `console.error` 不更新 job 状态 → runPipeline 抛错时 job 卡在最后设的状态(merging/syncing)永不动,且不重试(RETRYABLE 只含 pending/failed)。
- 正解:catch 里 `ledger.setState(streamKey, "failed", {error})`,使其可被后续 reconcile 重试 / 人工可见。

### 3. VPS 短链转换 best-effort 无重试 → slug 不一致(中)
`resolveAnchorBg` 后台把 `v.douyin.com/XXX` 转 `live.douyin.com/<web_rid>`,但 `resolveShortUrl().catch(()=>null)` 失败即保留短链、**无重试**。某节点转换失败 → 该节点 `_inventory` 回退主播名 slug → 跨节点 slug 不一致 → 聚不上。
- 正解:① 转换失败重试(几次退避);② 或 inventory 的 roomSlug 解析运行时统一(不依赖入库转换是否成功,如统一用 web_rid 或统一用主播名)。

### 4. daemon 自动重启已停任务(中)
任务 stop 后,daemon 下一 tick 见 enabled + 在窗口 + 房间在播 → 又重启录制。测试时需 delete 任务才能真正停。
- 正解:区分「用户手动 stop」与「窗口调度」——手动 stop 应置一个 `disabled`/`paused` 标志,daemon 不自动重启;窗口调度才自动启停。

## 测试备注
- docker-as-master 经 tailscale sidecar(`network_mode: service:tailscale`)够到 VPS;Tailscale SSH 需把 VPS 打 `tag:rec` + ACL `ssh` accept(tag:rec)避开 check 重认证。详见 [[reference_vps_ssh_keybased]]。
- 重启 tailscale sidecar 后须连带重启 douyin-rec(共享 netns)。
- 测试产物 BV14pT56uE6p(加不加辣 510s,仅自己可见)= pipeline 自动上传验证稿,用后删。
