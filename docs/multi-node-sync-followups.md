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

### ✅ 断流多会话选优:完整优先 + 都断则中断通知(2026-06-29)
- **背景**:我们的录制器**断流重连 = 新会话**(每次 `spawnRecording` 用新时间戳 nameBase)。所以一场断流几次 = 几个 sessionBase。`scan` 每会话一条 `NodeRecording`,`identity` 把同房间 5min 内的会话聚成一个 Broadcast(members = 所有节点 × 所有会话)。
- **旧 bug**:`selectWinner` 按单会话覆盖度选最长那一个会话,单会话自身 gap=0 → 误判 clean → 当完整版上传,且 `sourceAfterDone` 删掉所有会话源 → **丢内容**。
- **新规则(用户定)**:**完整录全的 tenant 优先**(= 只有 1 个会话、没断流、gap≤阈值);多个完整取最长。**没有任何完整 tenant(都断流过)→ 直接中断 + 通知,绝不删源**(保护数据,留人工)。
  - `select.ts`:按 tenant 会话数判完整(>1 会话 = 断流过 = 不完整);`clean` ⇔ 存在完整 tenant;winner 完整优先、否则报最长供人工参考。
  - `pipeline.ts`:`!clean` → early-return `needs_manual` + notify(「所有节点均断流,最完整=X,已保留全部源」)+ **不 pull/不 merge/不删源**。

### ✅ hub 配置文件化(2026-06-30):config/hub/{platform}.{roomSlug}.json,从 DB 迁出
- **文件 = 唯一真理源**(对标 DLR):服务端现读不缓存 → UI 与手改文件天然同步,无两份存储要对齐;
  reconciler 每 tick 现读 → 手改即时生效。删了 sqlite `hub_rules` 表 + store DB 方法。
- 结构:全局 `config/hub.config.json`(基础设施 + `uploadDefaults`)+ 每房间 `config/hub/{platform}.{roomSlug}.json`。
  **key 按平台限定**(douyin/bilibili 同房间号不撞);任务文件 `{room, enabled, pipeline:{steps, upload, cleanup}}`(upload 收进 pipeline)。
- `hub-store.ts`(app):文件版 CRUD,原子写(temp+rename)、坏 JSON 跳过、现读不缓存。api 注入 hubDir;reconciler `resolveCfg(platform, roomSlug)`。
- upload metadata(tag/desc/tid/title)写在任务文件,留空回退 `hub.config.json` 的 `uploadDefaults`;硬标准(关水印/仅自己可见/copyright)仍在 biliup.ts 代码常量。
- 实测(docker master):API 建→文件冒出、手改文件→API 现读即变、删→文件消失;迁移 docker 旧 sqlite 规则(767116735823)→ `douyin.767116735823.json`。

### ✅ 穿插上传(pipelined upload,2026-06-30)
- merge plain 完即**后台 fire P1 上传**(网络),与随后的 burn danmu/livechat(CPU)并行;再 split → await BV → **串行 append**(同稿件并发会撞)。省总墙钟。仅 auto-private 生效;stage-only 不传。
- 接缝:biliup `uploadPlain`(传 plain 拿 BV)+ `appendGroup`(追加一组);`PipelineDeps.upload` → `uploadPlain`+`appendGroup`。P1 失败→failed+notify;空组不 append。

### ✅ 多平台 hub(2026-06-30,实测 douyin+bilibili 双跑通)
- meta.json 加 `platform`(manager 写);NodeRecording 加 platform(scan 读,旧录像 fallback douyin);
  clusterBroadcasts 按 (platform,roomSlug) 聚类,Broadcast 带 platform,streamKey=`{platform}:{roomSlug}:{date}`;
  reconciler 用 b.platform 调 resolveCfg(this.platform 仅作旧录像默认)。
- **实测**:douyin 788038294100 + bilibili 1861302252 同时两节点录 → 聚成两个独立 streamKey → 各查各的 hub 规则
  (`douyin.788…` / `bilibili.186…`)→ 各自选优(winner 可不同)→ 合并/烧/真实上传(4 条测试 BV,已清任务/规则/产物,BV 待手删)。
- bilibili 平台录制验证 OK(WBI 取流 + 二进制 WS 弹幕);**匿名拿到 1080p60 原画**(qn 10000)。

### ✅ sidecar 合并(2026-06-30):meta.json + gaps.json → {base}.session.json
- 开录写身份(sessionBase/roomSlug/platform),停录同名覆盖补 gaps/totalGapSec。媒体目录少一种文件。scan 读 session.json,旧两文件仍兼容回落。

### ✅ daemon「手动 stop 后自动重启」—— 已解决(非待办)
- 旧 followup 已失效:`stopTask` 现 `setEnabled(false)`,daemon 只拉起 enabled 的任务 → 手动停不会被重启。
  enabled=false 本身就是「暂停」。(注:带排期的任务停了,未来窗口也不录,直到重新启动 —— 符合直觉。)

### 待做
- **per-平台 cookie**:cookie 模型目前「抖音单一」(全局 cookie = 抖音账号)。bilibili getStream **支持传 cookie**
  (登录态取大会员/4K/杜比/HDR 等更高 tier),但没 per-平台 cookie 存储 → bilibili 高 tier(超 1080p 原画)目前拿不到。
  原画 1080p 匿名够用。要覆盖 4K/大会员档需做按平台分别存 cookie。
- **`merge-recording-today` skill 仍调不可跑的 Python `remote/merge.py`** —— hub 已自动做合并/上传,该 skill 待切 TS CLI 或标废弃。
- **跨会话对齐拼接(断流场自动出完整版)** —— 先记录,后续做:
  - 现在「都断流」是中断+通知人工。要 hub 自动把断流多会话拼成完整版,需移植 skill 的**逐会话烧再拼**:
    每会话先 `merge`→`burn(offset=0)`(弹幕 p 偏移本就相对本会话起点,零累计漂移),再 **concat filter 重编码**拼接(各会话 fps 可能不同,`-c copy` 会压坏 PTS;重编码统一 fps/timebase)。
  - 对齐保证靠「**每会话弹幕只跟自己视频对齐 → 物理拼接**」,不靠墙钟偏移(gap 被压扁 → 墙钟会漂)。livechat 的 gift/member 绝对 epoch 锚点需在拼接后统一参照系。会话真实时长用 ffprobe 末帧 PTS(mesio flv 头时长可能=0)。
  - building blocks 已在 `post-process`(`mergeSession` / `burn --indir --base` / ass 按 `video_start_time` 分段锚定);缺 orchestrator 层串「winner tenant 多会话逐烧+concat 拼」。
- **daemon 自动重启已停任务**:任务手动 stop 后 daemon 下 tick 又重启(enabled+在窗口+在播)。正解:手动 stop 置 paused 标志,daemon 不自动重启;仅窗口调度自动启停。(测试时靠 delete 任务规避)

### 想法记录(暂不做,评估过收益/成本)

- **hub 中心化任务管理(centered manage,2026-07-01 讨论)**:在 hub 建任务时勾选目标 slave 节点
  (如 VPS),任务定义自动下发,不用去各节点单独建;录制结束结果回收(这半边即现有 inventory+选优+pipeline,已存在)。
  - **方向对**:与现有「master 经 SSH 主动够 slave、slave 零感知」哲学一致。做的话走 Transport 轴加
    `_apply-tasks` 类子命令(slave 收 JSON upsert 进自己 DB),**desired state 周期对账**而非一次性推送
    (幂等、自愈,同 reconciler 思路);任务定义放 `config/hub/` 文件(文件即真理,与 hub-store 一致)。
  - **要想清楚的点**:归属标记(`managedBy: hub`,slave UI 只读化,防两边改回到漂移)、per-node override
    (如同任务 VPS 用 cookie / docker 匿名,避免弹幕 WS 相撞——已验证的真实约束)、时区一致性
    (排期窗口 "HH:MM" 由各节点自己的 settings.timezone 解释,下发前须校验或把时区纳入 desired state)。
  - **结论:现在不做**。规模 = 2 节点 1 生产任务、任务定义月改一两次,省的是每月一两分钟;而实现要好几天
    并给稳定生产加一层新状态同步。**唯一真实痛点(改漏一边→两边悄悄漂移→选优时段不对齐)用检测就够**:
    reconciler 周期扫描时顺手比对同 roomSlug 任务的关键字段(排期窗口/画质/engine),不一致→通知告警。
    几十行、零新增写路径,覆盖漂移风险的 90%。**触发重评的条件**:节点 ≥3、任务增删变频繁、或出现
    per-node 差异化配置的真需求。

## 测试备注
- docker-as-master 经 tailscale sidecar(`network_mode: service:tailscale`)够到 VPS;Tailscale SSH 需把 VPS 打 `tag:rec` + ACL `ssh` accept(tag:rec)避开 check 重认证。详见 [[reference_vps_ssh_keybased]]。
- 重启 tailscale sidecar 后须连带重启 douyin-rec(共享 netns)。
- 测试产物 BV14pT56uE6p(加不加辣 510s,仅自己可见)= pipeline 自动上传验证稿,用后删。
