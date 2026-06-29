# 多节点编排 followups(2026-06-28 双节点实测暴露)

两次真实双节点测试(docker master + VPS slave,房间 加不加辣)跑通了完整链路并修了 4 个 bug(已 push)。
以下是**剩余 followup**,均不阻塞主干,按优先级记录待收口。

## 已修(本次,供参考)
- `2abbcc6` reconcile fork 风暴 —— hub 每 8s `void reconcileAll()` 无并发守卫 → 几十个并发 → 打爆两端 fork。加 in-flight 锁。
- `92eb428` listInventory/ssh 无超时锁死 —— hung ssh(tailscale 偶发 stall)卡死 reconcileAll 的 Promise.all。SshTransport 加心跳(ServerAliveInterval 5×3)+ 硬超时 45s;reconciler 加 inventoryWithTimeout 降级。
- `92eb428` **`bash -lc` 经 ssh 被打散**(2 节点失败真根因)—— `run(["bash","-lc",cmd])` 经 `ssh host -- bash -lc <cmd>` 空格 join → 远端 `bash -lc node /path …` → bash 只取 "node" 当命令、其余成位置参数 → 只跑空 `node` → 空输出 → JSON.parse 抛错 → 该 ssh 节点 inventory 恒空。改命令作单字符串传。
- `6efe22c` 容器装 biliup（auto-private 上传能力）+ xz-utils（biliup .tar.xz 解压）+ .dockerignore 放行 install-biliup.sh。

## 待修 followup

### ✅ 已修(`c8d6de1`)
- **#1 选优剔除缺文件成员**:Transport 加 `exists(paths)`(Local=fs.existsSync,Ssh=远端 test -e),pipeline 选优前过滤 exists=false 的成员 → 不再选中已归档/清理的录像;全缺失 → job=failed。**这也是下面「streamKey 碰撞」卡 syncing 的直接止血**(选中旧归档录像会被剔除)。
- **#2 pipeline 出错标 failed**:ledger 加 fails 列 + markFailed;reconciler catch → failed(maxRetries=3 内自动重试,达上限留 failed 不再重入)。原本卡 merging/syncing 永不动 → 现可见 + 有限重试。

### ✅ 已修(2026-06-29 续,真实多节点录制验证通过)
- **#1 streamKey 同主播同日碰撞 + #3 slug 不一致 + 停录时序竞态** —— 统一用 **meta.json 身份**根治:
  RecordingSession 会话**开始**即写 `{base}.meta.json {roomSlug=web_rid}`,scan slug 优先级 `meta > gaps > taskRooms > 目录名`。
  slug 从第一秒就有、随录像走、跨节点一致,不依赖主播名解析、无"停录后 gaps 才有 slug"的竞态。(`c946f85`)
- **#2 pipeline 出错标 failed** —— ledger fails 列 + markFailed + maxRetries(`c8d6de1`)。
- **Bug B settle 边录边合并残片**(致命)—— LocalTransport.isDone 注入 isRoomRecording(不再恒 true)+
  settleAll 返回仍在录成员、reconcileAll **跳过仍在录的场**(不抓残片)。(`92eb428`)
- **SshTransport.pull 不 mkdir** —— rsync 把不存在目标当文件名致 merge ENOTDIR(VPS-winner 拉流首次暴露)。(`38b39c3`)

### ✅ 架构升级:hub=全局管理器 + **HubRule 独立实体**(按 roomSlug,与录制任务解耦)
- 先做成 per-task pipeline(`adb2143`,实测通过),后按「录制任务只管录、hub 是独立管理器」拆成独立实体:
  **`hub_rules` 表**(主键 roomSlug=web_rid,列 room/platform/enabled/config)。Task 不再有 pipeline 字段。
- `config` JSON = `{steps{burnDanmu,burnLivechat}, cleanup{stageSourceAfterMerge,sourceAfterDone,stageAfterDone,includeXmlAss}, upload{mode,tag,tid,desc}}`。
- reconciler `resolveCfg(roomSlug)` 查 `store.getHubRule(slug)`:**有 enabled 规则才处理**(opt-in),无规则/禁用 → null 跳过。
- store CRUD:`listHubRules/getHubRule/upsertHubRule({room,enabled?,config?})/updateHubRule/removeHubRule`(upsert 经 platformForRoom.extractRoomSlug 派生 roomSlug)。
- API:`GET/POST /api/hub/rules` + `PATCH/DELETE /api/hub/rules/:roomSlug`(DTO 带 anchorName,关联同房间录制任务显示)。
- Web:**独立「Hub」页**(`/hub`,TopNav 加导航)+ `HubRuleDialog`;录制任务弹窗回归纯录制(无 hub 面板)。
- pipeline 步骤开关(可只到 plain 就停)+ cleanup 开关(删 stage 源/源节点录制/stage 产物;includeXmlAss 守弹幕源)+ Transport.cleanup(local fs / ssh rm)。
- **2026-06-29 实测(房间 杨甜甜)逐项验证**:唯一 streamKey、2 节点选优、`burnLivechat:false`→无 livechat、`stageSourceAfterMerge:true`→源 .ts 删、`stage-only`→needs_manual、xml 保留、无 fork 风暴。

### 待做
- **daemon 自动重启已停任务**:任务手动 stop 后 daemon 下 tick 又重启(enabled+在窗口+在播)。正解:手动 stop 置 paused 标志,daemon 不自动重启;仅窗口调度自动启停。(测试时靠 delete 任务规避)

## 测试备注
- docker-as-master 经 tailscale sidecar(`network_mode: service:tailscale`)够到 VPS;Tailscale SSH 需把 VPS 打 `tag:rec` + ACL `ssh` accept(tag:rec)避开 check 重认证。详见 [[reference_vps_ssh_keybased]]。
- 重启 tailscale sidecar 后须连带重启 douyin-rec(共享 netns)。
- 测试产物 BV14pT56uE6p(加不加辣 510s,仅自己可见)= pipeline 自动上传验证稿,用后删。
