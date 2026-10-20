# dev 多节点 e2e 环境(issue #82:P0 设计 + P1 环境 + P4 手册骨架)

目标:在一台开发机上起「1 个 controller + 2 个 worker」,让 **SshTransport / rsync / 隐藏命令 / 节点侧上传** 这些
线上才会走的代码路径,在**不碰线上三节点、不出外网、不真投稿**的前提下真跑。
本文是设计稿 + 使用手册;场景用例(S1–S3 的自动化)由随后的 P2 PR 落地,S4 挂 #72 / #57 解锁后。

入口:`scripts/e2e-verify.sh {up|down|keep|doctor|smoke}`;构建物在 `dev/multi-node/` 与
`dev/multi-node/compose.yml`。**不改任何生产镜像/compose/`packages/` 行为。**

## 1. 拓扑

```
 宿主机(只有 docker,无端口映射)
 ┌──────────────────────── drec-devnet  (internal: true,无网关/无外网/无 DNS 出口) ────────────────────────┐
 │                                                                                                          │
 │  drec-dev  (controller)            ssh -i dev_ed25519 + rsync            drec-dev-node-1 (worker)          │
 │  task serve --hub        ───────────────────────────────────────────▶   sshd:22 + task serve(无 --hub)    │
 │  /output-data ← data-dev/e2e/controller                                 /output-data ← data-dev/e2e/node-1 │
 │  hub 配置: workers =                                                      dist -> /app/dist(启动时刷新)     │
 │   local / node-1 / node-2                                               假 biliup + FAKE-DEV cookies       │
 │  ssh config: Host drec-dev*-node-*                                                                          │
 │   dev 专用密钥 + known_hosts(accept-new)         ───────────────────▶   drec-dev-node-2 (同上,node-2 卷)  │
 └──────────────────────────────────────────────────────────────────────────────────────────────────────────┘
   不接 tailscale sidecar;不挂 docker-data;不挂 remote/vps.key;`drec-dev_default`(已有 dev 实例的网络)不加入。
```

- 三个容器共用一个镜像 `drec-dev-node:local`(`dev/multi-node/Dockerfile.dev`),按 compose `entrypoint` 分 controller / worker 角色。
- 镜像底座 = 生产 Dockerfile 的 **worker 档**(`IMAGE_ROLE=worker`,无 biliup/playwright/ssh),由 `up` 现建并打标
  `drec-dev-base:local`。dev 层再叠 openssh-server / openssh-client / rsync / procps / fonts-noto-cjk + 假 biliup。
- 访问 UI/API:internal 网络上 `ports:` 不生效,所以走 `docker exec drec-dev curl -s http://localhost:7860/api/tasks`。

### 与已存在的 `drec-dev` 并存

本机若已有一个手工起的 `drec-dev`(compose 项目名同为 `drec-dev`),本栈**不会**去覆盖它:`up` 的断言发现同名容器
不属于 `drec-dev-e2e` 项目就拒绝。要并存,设 `DREC_DEV_SUFFIX=-t1`(形如 `-[a-z][a-z0-9]{0,11}`,不能是 `-node`):
容器 `drec-dev-t1` / `drec-dev-t1-node-N`,网络 `drec-devnet-t1`,项目 `drec-dev-e2e-t1`,数据 `data-dev/e2e-t1/`。
默认(无后缀)时容器名恰为 `drec-dev` / `drec-dev-node-N`,与任务单要求的正则一致。

## 2. 为什么是「容器内 sshd」,不是 local-kind 或 tailnet

| 方案 | 能真跑的 | 跑不到的 | 结论 |
| --- | --- | --- | --- |
| **local-kind**(worker 全用 `kind:"local"`,LocalTransport 进程内) | 选优/合并/上传流程 | SshTransport、`ssh <host> -- <cmd>` 单字符串拼法、rsync 拉流、隐藏命令在 ssh 非登录 shell 下的环境(PATH/TZ/无 `DOUYIN_REC_ROOT`)、失联三态(停容器=真 ssh 失败)、节点侧上传的真远端执行 | 保真度不够,生产最多的故障恰恰在 ssh 这一层(见 #27、transport-ssh 注释里的踩坑) |
| **tailnet**(dev 也接 tailscale,SSH 到真实/测试 VPS) | 保真度最高 | 需要凭证与外网;一不小心 `workers[].host` 写成线上地址就会碰线上;不能用 internal 网络隔离 | 违背「绝不碰线上、绝不出外网」 |
| **容器内 sshd + internal bridge**(采用) | 上面全部:SshTransport/rsync/隐藏命令 100% 同一代码路径;`docker stop`/`pause` = 真失联;`docker restart worker` = 真重启(S4) | 真实抖音取流/真 B 站(有意不做,见 §7) | 保真且物理隔离 |

## 3. 4 处 dev 层必修(「零改动」的更正)与证据

SshTransport/LocalTransport 的代码路径零改动即可真跑,但**环境**必须补 4 处,否则一上来就挂。

| # | 必修 | 证据(代码) | 落地位置 |
| --- | --- | --- | --- |
| 1 | **worker 数据根里要有 `dist`**:建软链 `<dataRoot>/dist -> /app/dist`,且**每次启动刷新**(防镜像更新后指向旧程序) | `packages/orchestrator/src/transport-ssh.ts` 所有远端命令默认 `node ${dataRoot}/dist/douyin-rec.mjs …`(`remoteNode` 缺省值);镜像里程序在 `/app/dist`,生产 worker 是把 bundle 部署到 `<dataRoot>/dist`(`docs/worker-install.md`) | `dev/multi-node/dev-worker-entrypoint.sh`(`ln -sfn /app/dist "$DATA/dist"`,若 `dist` 是真目录则拒绝覆盖) |
| 2 | **worker 镜像要有 rsync(和 sshd)** | worker 档 Dockerfile 只装 `ffmpeg ca-certificates curl xz-utils`(`Dockerfile` runtime 段 `else` 分支);`SshTransport.pull` 经 `rsync -e ssh host:path` 拉流,worker 端缺 rsync 报 `rsync: command not found`(T-19 的真实事故) | `dev/multi-node/Dockerfile.dev`(`openssh-server openssh-client rsync procps fonts-noto-cjk`) |
| 3 | **controller 的 dev SSH Host 配置** | `SshTransport` 的 ssh/rsync **不带 `-i`**(`defaultRun`/`buildRsyncArgs`),身份与 User 全靠 `~/.ssh/config`;生产镜像里的 Host 段只匹配 `100.* *.ts.net`,容器名不命中 → 会以 root + 默认密钥去连 | `dev/multi-node/ssh_config.dev`(`Host drec-dev*-node-*`,专用密钥,`accept-new`,known_hosts 落 controller 数据卷);由 `dev-controller-entrypoint.sh` 装入 `/root/.ssh/` <!-- issue-guard: allow --> |
| 4 | **worker 要 sshd + node 双进程启动脚本** | 生产 worker 的 CMD 只有 `task serve`;SshTransport 需要同一容器里还有 sshd。sshd 会话**不继承容器 ENV**,故脚本显式 `SetEnv PATH`(node 在 `/usr/local/bin`)与 `TZ`;主机密钥持久化到数据卷(重启不变,known_hosts 不报警,S4 要用) | `dev/multi-node/dev-worker-entrypoint.sh`(生成主机密钥 → `/run/sshd` → `authorized_keys` → `sshd -t` → 起 sshd → `exec node … task serve`,不带 `--hub`) |

另:**假 biliup**(`dev/multi-node/fake-biliup.js`)与 FAKE-DEV 假 cookies 是第 5 个 dev 层物件,不是必修但必需:
- `_node-capabilities` 探测 `biliup`/`cookies`(`probeNodeCapabilities`,`packages/app/src/node-pipeline.ts`)要求 PATH 里有 `biliup` 且 `<dataRoot>/config/biliup/cookies.json` 存在,否则节点侧上传回落现状; <!-- issue-guard: allow -->
- 假 biliup 模仿真实输出(`投稿成功 BV…`,BV 后 10 位 `[0-9A-Za-z]`,满足 `parseBV`),`-V` 可用(`checkBiliup`),
  `upload`/`append` 把文件名、关水印、仅自己可见写入 `<cookies 目录>/fake-archive.jsonl` 供场景断言「硬标准」;
- **只认含 `FAKE-DEV` 的 cookies,否则拒绝**(防误挂真凭证);全程不联网。

## 4. 隔离断言(`e2e-verify.sh` 内置,任何 docker 操作前执行)

断言分两段:A=纯宿主机静态(未碰 docker);B=docker **只读**(inspect / compose config)。`dc()`(compose)与 `dk_mut()`
(build/run/exec)在断言未过时直接 `die`;`dc()` 恒带 `-p drec-dev-e2e*`,脚本里没有任何不带 `-p` 的 compose 调用。
`doctor` 另做**反例自检**:把线上形态的输入喂给每个断言,必须被拒绝。

| 断言 | 规则 | 反例(doctor 里实测被拒) |
| --- | --- | --- |
| 容器名 | `^drec-dev(-后缀)?(-node-[0-9]+)?$` | `douyin-rec`、`drec-tailscale`、`drec-dev-node-x` |
| 网络名 / 项目名 / 镜像标签 | `^drec-devnet(-后缀)?$` / `^drec-dev-e2e(-后缀)?$` / `^drec-dev-(base\|node):local*$` | 项目默认网络名 |
| 数据根 | 绝对路径、无 `..`、路径含 `data-dev/` | `/srv/docker-data/e2e`、含 `..` |
| 与线上数据根不重叠 | realpath 后不相等、不互为父子;候选 = `<repo>/docker-data`、主 checkout 的 `docker-data`、`.env` 的 `DATA_ROOT`、**线上容器 `douyin-rec` 的 `/output-data` 挂载源(docker inspect 只读)** | 相等 / 子目录 / 父目录 三种 |
| `workers[].host` | 只允许 `<controller 名>-node-N`;并且整份 hub 配置不得出现 IPv4 或 `*.ts.net` 字样、`dataRoot` 必须 `/output-data` | IPv4(tailnet 形态)、`*.ts.net`、普通主机名、非法 dataRoot |
| dev 密钥指纹 | `ssh-keygen -lf` 指纹 ≠ `<repo>/remote/vps.key`、主 checkout 的 `vps.key`、`~/.ssh/id_*`、线上容器挂载的 `vps.key` | 与自身相同指纹 <!-- issue-guard: allow --> |
| dev 数据根无真实凭证 | 禁 `vps.key`/`*.pem`/`.env`/`id_*`/`config.yaml`;`cookies.json` 必须含 `FAKE-DEV`;`keys/` 下只允许 dev 密钥对 | 无 FAKE-DEV 的 cookies、`vps.key` <!-- issue-guard: allow --> |
| compose 渲染(`config --format json`) | 无 `ports`/`network_mode`/`privileged`/`pid`;每个服务 networks 恰为 `[drec-devnet]`;网络 `internal:true` 且名字正确;所有挂载源在 dev 数据根内且不含 `docker-data`/`vps.key` | 含 publish 端口、多网络且非 internal、挂线上数据根 |
| 同名容器归属 | 同名容器必须带 `com.docker.compose.project=<本项目>` 标签,否则拒绝(不覆盖别人的 `drec-dev`) | — |
| 网络 internal(**起栈后复检**) | `docker network inspect` 的 `Internal==true`,且每个容器只接入 `drec-devnet*`;不满足立即 `down` | `Internal=false` |
| 镜像(**build 后**) | 在 `--network none` 下 `docker run` 该镜像:`biliup` 是假脚本、全盘无其它 `biliup`、无 `/root/.ssh/vps.key`、无 playwright | — |

容器侧再加一层兜底:worker/controller entrypoint 在 `/output-data` 没有宿主侧写下的 `.drec-dev-e2e` 标记、或 hostname
不是 dev 形态时**拒绝启动**(防止手工误挂线上数据根)。

`doctor` 实测输出样例(正例 + 反例,节选;完整输出附在 PR 里):

```
== 阶段 A:静态隔离断言(宿主机,未碰 docker)
PASS   容器名 drec-dev-t1-node-1
PASS   dev 数据根与线上数据根不相等/不互为父子(候选 2 个)
PASS   hub 配置模板渲染后 host 均为 dev 容器名
== 阶段 B:docker 只读断言
PASS   与线上容器 douyin-rec 的数据根(/output-data)不重叠
PASS   compose 渲染:无 ports/network_mode/privileged,仅接 drec-devnet-t1(internal),挂载全在 dev 数据根
== 反例自检(每条都必须被拒绝)
REJECT 线上容器名 douyin-rec  <- REFUSE 容器名 'douyin-rec' 不匹配 ^drec-dev(-后缀)?(-node-N)?$
REJECT worker host = IPv4(tailnet 形态)  <- REFUSE worker host '<ipv4>' 不是 dev 容器名(…);疑似线上形态
REJECT 网络 internal=false  <- REFUSE 网络 drec-devnet-t1 不是 internal(Internal=false)
```

## 5. 使用

```bash
scripts/e2e-verify.sh doctor      # 只跑断言 + 反例自检,不起容器(改了 compose/配置先跑它)
scripts/e2e-verify.sh up          # 断言 → 建 worker 档底座 + dev 层 → 起 3 容器 → 起栈后复检
scripts/e2e-verify.sh smoke       # 只读冒烟:controller 内 ssh 到 worker 跑 hostname/_node-capabilities;证明断外网
scripts/e2e-verify.sh keep        # 只 stop(保留数据/网络,事后排查;再 up 续)
scripts/e2e-verify.sh down        # 拆容器+网络,清空 dev 数据(保留 data-dev/e2e*/keys)
# 与已有 drec-dev 并存:所有子命令前加 DREC_DEV_SUFFIX=-t1
```

数据根默认 `<repo>/data-dev/e2e[后缀]/{controller,node-1,node-2,keys}`(`data-dev/` 已进 `.gitignore`),可用 `DREC_DEV_ROOT` 改,
但必须仍含 `data-dev/` 段并过上面的重叠断言。`up` 首次会生成 dev 专用 ed25519 密钥与 `controller/config/hub.config.json` <!-- issue-guard: allow -->
(模板 `dev/multi-node/hub.config.dev.json`,`settleMs/reconcileIntervalMs` 调小以便场景秒级触发)。

可调:`DEV_TZ`(容器 TZ,默认 Asia/Shanghai)、`DEV_SSH_TZ`(ssh 会话 TZ,默认同;**设为空串则 ssh 会话为 UTC**,用来复现 §6.2 的风险)。

## 6. 核实记录

### 6.1 worker 上的受管任务是否只靠调度器启动(决定「internal 网络足够断外网」)

结论:**是。** 对 `managedBy='hub'` 的任务,worker 上唯一的启动入口是 `TaskDaemon` 每 60s 的 tick:
- `_apply-tasks`(`packages/cli/src/cli.ts`)只写 store(+对「不再期望」的任务调 serve 的 stop、对缺主播名的调 `refresh-anchor`),**不启动录制**;
- `POST /api/tasks/:id/start` 对受管任务直接 `403`(`packages/app/src/web/api/tasks.ts` `startTask`);
- 其余 `manager.start(` 只有 `daemon.ts` 的 `manager.start(id)`(条件:`enabled ∧ inWindow`,且不在本机抑制名单);
- 已起的录制进程崩溃会被 `autoRestart: true` 拉起——但那也只发生在 daemon 已启动它之后。

推理:下发的任务若 `enabled ∧ 当前在窗口`,daemon 会起 `record` 子进程去连抖音;**internal 网络没有出口也没有外部 DNS**,
取流在解析域名这步就失败(`smoke` 里 `curl https://example.com` 实测 `Could not resolve host`),不会真录、也不会真连直播流。
所以 internal 网络足以断外网;不需要额外改任务启停逻辑。

残余风险:
1. **有人给容器再接一个有出口的网络**,真录制就会起来。compose 静态断言(仅接 `drec-devnet`、internal)与起栈后复检(每个容器只接入 devnet)挡住这条;手工 `docker network connect` 不在断言范围内,doctor 不是持续监控。
2. 在窗口内的启用任务会让 daemon 持续尝试取流 → worker 日志刷「取流失败」重试;无害但嘈杂。**场景播种的任务一律 `enabled:false` 或把窗口设在当前时间之外**,需要「在录」状态时用 `recording` 字段的构造方式而不是真录。
3. `countVideoParts`(append 幂等核对)用 `fetch https://api.bilibili.com`(`packages/app/src/upload/biliup.ts`),不走 biliup 二进制,**假 biliup 拦不住**;internal 网络下它恒返回 `null`(=无法确认),所以 dev 里 append 幂等核对只能走「无法确认」分支。要覆盖「分 P 数可查」分支需要在 P2 里为该接缝注入替身(现有 `test/e2e` 已覆盖),不是本环境的目标。
4. 邮件/webhook:`DISCORD_WEBHOOK` 置空;其它外发通知通道无出口,会静默失败(日志可见)。 <!-- issue-guard: allow -->

### 6.2 隐藏命令在 SSH 会话下的 UTC/日期语义风险(逐点)

背景:ssh 非登录会话**不继承容器 ENV**,也不经过 `task serve` 的 `applyTimezone()`(只在 serve 启动时把 `process.env.TZ` 覆盖成 `settings.timezone`,默认 Asia/Shanghai)。
所以 `_inventory`、`_tasks`、`_node-pipeline` 等短命进程的 TZ = **ssh 会话自己的 TZ**(无 `SetEnv`/profile 时为 UTC),与录制端、与 master 可能不一致。逐点:

1. **会话 base 里的时间戳是录制端按 serve 的 TZ 写的**(`{name}_{YYYY-MM-DD}_{HH-mm-ss}`)。`scan.ts` 的 `startMsFromSessionBase` 用 `new Date(y, m, d, h, mi, s)` 按**本进程 TZ**反解。
   - 仅在「会话没有任何 .ts」时才用(边录边传把已确认段删空后),此时 `startMs=endMs=baseMs`。
   - **已实测**(本环境,同一份 base `…_2026-06-27_10-00-00`):`TZ=Asia/Shanghai` → `startMs=2026-06-27T02:00:00Z`;`TZ=UTC` → `2026-06-27T10:00:00Z`,**差 8 小时**。
2. **有 .ts 时 `startMs/endMs` 来自 ffprobe 时长 + 文件 mtime**(`cli.ts` `_inventory` 的 ffprobe 适配器:`endMs=mtimeMs`,`startMs=endMs-durationMs`),与 TZ 无关——播种时用 `touch -d @<epoch>` 设 mtime,别用本地时区字符串。
3. **聚类的 streamKey 日期由 master 进程 TZ 决定**:`identity.ts` 的 `ymd()/hhmm()` 用 `getFullYear()/getHours()`。master 是 `task serve`(已 applyTimezone),
   而 `local` worker 走 LocalTransport(同进程)与 ssh worker 走 `_inventory`(ssh TZ)——对第 1 点那类「无 .ts」会话,**local 与 ssh 节点的 startMs 可能差 TZ 偏移**,跨日边界附近同一场可能被聚成两场或日期错一天。
4. **`_node-pipeline` 的标题日期**:`formatBiliTitle` 优先取 session base 里的 stamp 原样,否则用 `spec.timeZone`(master 下发)按 `Intl` 渲染,**不依赖进程 TZ**——此项低风险。
5. **调度窗口**(`inWindow`/`nowMinutesLocal`)只在 serve 进程里用,已 applyTimezone;隐藏命令不涉及。
6. **`_is-done`/`_recording-status`** 只扫 `/proc`,无日期语义。
7. **rolling sidecar / `.rolling.json`** 的时间戳是 epoch,与 TZ 无关。 <!-- issue-guard: allow -->

dev 环境的处理:worker 的 sshd 默认 `SetEnv TZ=Asia/Shanghai`(与 serve 默认一致,免得第 1/3 点的偏差污染场景结论);
想专门验证偏差时 `DEV_SSH_TZ= scripts/e2e-verify.sh up`(ssh 会话变 UTC)。**这不是 dev 层的锅,是生产也存在的隐患**:生产 VPS 的 ssh 会话 TZ 取决于主机登录环境。
是否在隐藏命令入口统一 `applyTimezone`(或让 master 在 ssh 命令前显式 `TZ=`)属生产代码改动,不在本 PR,已单开 issue #87 跟踪。

## 7. 场景编号与范围

| 编号 | 场景 | 对应 | 状态 |
| --- | --- | --- | --- |
| **S1** | **归属隐藏**:规则只勾选 node-1 → node-2 上该任务被停用保留(`assigned=false`),worker 模式 UI/`/api/tasks` 默认隐藏「受管 ∧ 未分配 ∧ 未在录」;不是删除 | T-45 / #73;`isWorkerAssigned`(core `capabilities.ts`) | P2 PR |
| **S2** | **失联三态**:节点清单分 ok / empty / unreachable;`docker stop`(连接被拒,快速失败=reject 路径)与 `docker pause`(挂起,超时路径)**双断言**;unreachable 的场本轮不选优、不收口、不删源,恢复后补收口 | T-42 / #27 | P2 PR |
| **S3** | **收口清理**:收播后选优 → pull → merge → 假 biliup 上传 → 核验 → 按 cleanup 配置清 stage/源;`xml/ass` 保留规则(不得删最后一份) | `reconciler` / `pipeline` / `stage-clean` | P2 PR |
| **S4** | **重启接管**:`docker restart` worker / controller,在途 job 续跑或转人工,不重复建稿 | **#72 / #57 解锁后**(P3b) | **阻塞**,不在本 PR |
| 可选档 | **真实短录**:对真实直播间录一小段走完整链路 | — | 需要外网;internal 网络下不可用 → 作为可选开关,届时向用户索取直播间,且仍禁真投稿 |

> 编号口径:S3 一律指「收口清理」;「边录边传清单」属 S4 之后的另一场景,不占 S3。

## 8. 场景手册(S1/S2/S3 播种与断言)

> 说明:本节的**播种命令已在本环境实测**(ffmpeg 真生成 .ts、节点 `_inventory` 跑真 ffprobe 读回);
> 「预期输出」是按代码路径推出的**样例**,P2 PR 把它们变成自动化用例时以实测输出为准。S4 阻塞,不在此列。
> 下文 `$CTRL`/`$N1`/`$N2` = `drec-dev` / `drec-dev-node-1` / `drec-dev-node-2`(带后缀时相应加后缀)。

### 8.1 播种:真 .ts + session.json(节点扫描跑真 ffprobe) <!-- issue-guard: allow -->

要点:
- `.ts` 必须是 ffprobe 读得出时长的真文件——`_inventory` 里 `ffprobeVideo` 真跑(不是 fake);用 ffmpeg 的 lavfi `testsrc` 生成,**video-only**(录制端本就无音轨)。
- 会话 base = `{anchor}_{YYYY-MM-DD}_{HH-mm-ss}`,分段 `{base}_{NNN}.ts`,旁边放 `{base}.xml`(弹幕)与 `{base}.session.json`(`roomSlug`=房间号、`platform`、`gaps`)。 <!-- issue-guard: allow -->
- **`startMs/endMs` 来自 mtime 与时长**:`touch -d @<epoch>` 把 mtime 设成「收播时刻」(比现在早一小时,过了 settle 窗口)。base 里的时间用同一 epoch 在容器 TZ 下渲染。
- 同一场要在 node-1 / node-2 都放(同 `roomSlug`、起止时间间隔 ≤ 60 分钟(core `SAME_BROADCAST_GAP_MS`)内),才会被聚成一场、进选优。想造「node-2 有断流」就把 node-2 的 `totalGapSec` 写成 > 0。

```bash
seed() { # seed <容器> <anchor> <roomSlug> [段数] [每段秒] [gapSec]
  local N=$1 ANCHOR=$2 ROOM=$3 SEGS=${4:-2} SEG=${5:-20} GAP=${6:-0}
  docker exec "$N" sh -c '
    set -e
    ANCHOR=$1; ROOM=$2; SEGS=$3; SEG=$4; GAP=$5
    D=/output-data/recordings/$ANCHOR; mkdir -p "$D"
    END=$(( $(date +%s) - 3600 )); START=$(( END - SEGS*SEG ))
    B=${ANCHOR}_$(date -d @$START +%Y-%m-%d_%H-%M-%S)
    i=0
    while [ $i -lt $SEGS ]; do
      F=$D/${B}_$(printf %03d $i).ts
      ffmpeg -v error -y -f lavfi -i testsrc=duration=$SEG:size=320x180:rate=15 -an \
             -c:v libx264 -pix_fmt yuv420p -f mpegts "$F"
      touch -d @$(( START + (i+1)*SEG )) "$F"          # mtime = 该段 endMs
      i=$((i+1))
    done
    printf "{\"roomSlug\":\"%s\",\"platform\":\"douyin\",\"gaps\":[],\"totalGapSec\":%s,\"title\":\"dev-title\"}\n" "$ROOM" "$GAP" > "$D/$B.session.json"  # issue-guard: allow
    printf "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<i>\n<d p=\"1,1,25,16777215,1700000000,0,1,0\" user=\"u1\">dev</d>\n</i>\n" > "$D/$B.xml"  # issue-guard: allow
  ' _ "$ANCHOR" "$ROOM" "$SEGS" "$SEG" "$GAP"
}
ROOM=900000001   # 假房间号 # issue-guard: allow
seed drec-dev-node-1 dev-anchor-a "$ROOM"
seed drec-dev-node-2 dev-anchor-a "$ROOM" 2 20 30      # node-2 有 30s 缺口
# 读回(节点扫描=真 ffprobe):
docker exec drec-dev ssh drec-dev-node-1 -- 'node /output-data/dist/douyin-rec.mjs _inventory /output-data' \
  | jq -c '.recordings[] | {roomSlug, sessionBase, durationSec, danmuCount, files: (.tsFiles|length)}'
```

实测输出(1 段 20s 的最小用例,数值脱敏为占位):

```
{"roomSlug":"<room>","platform":"douyin","sessionBase":"dev-anchor-a_<日期>_<时分秒>","durationSec":20,"danmuCount":1,"startMs":<ms>,"endMs":<ms+20000>,"files":1}
```

在 controller 上建源任务与 hub 规则(播种的任务 `enabled:false`,避免 daemon 尝试取流,见 §6.1):

> 下面两条 API 的 payload **本 PR 未实跑**(字段取自 `AGENTS.md` 的 hub 规则格式与 `hub-rules.ts`),P2 PR 落地用例时校准。

```bash
API=http://localhost:7860
api() { docker exec drec-dev curl -s -H 'content-type: application/json' "$@"; }
api -X POST $API/api/tasks -d "{\"room\":\"https://live.douyin.com/$ROOM\",\"name\":\"dev-anchor-a\",\"enabled\":false}"
# 取返回的 task id → 建规则(workers 勾选决定 S1;pipeline 缺省走默认合并+上传,上传用假 biliup)
api -X POST $API/api/hub/rules \
  -d '{"enabled":true,"workers":["node-1","node-2"],"recording":{"sourceTaskId":<id>},"pipeline":{"steps":{"mergeSegments":true,"burnDanmu":false,"burnLivechat":false},"upload":{"mode":"upload","private":true},"cleanup":{"sourceAfterDone":true,"stageAfterDone":true}}}'
api -X POST $API/api/hub/apply            # 立刻同步任务到所选节点
```

### 8.2 三路断言(每个场景都要三路对上)

| 路 | 取法 | 看什么 |
| --- | --- | --- |
| **台账状态** | controller 的 sync 库(`<db>-sync.db` = `/output-data/db/douyin-rec-sync.db`):`docker exec drec-dev node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/output-data/db/douyin-rec-sync.db',{readOnly:true});console.log(JSON.stringify(d.prepare('select streamKey,state,winnerWorker,bv,error from sync_jobs').all()));console.log(JSON.stringify(d.prepare('select streamKey,workerId,coverage,isWinner from sync_candidates').all()))"` | `sync_jobs.state`(pending→syncing→merging→uploading→done / needs_manual / failed)、`winnerWorker`、`bv`;`sync_candidates` 里每节点的 coverage/是否胜出 |
| **文件在位** | `docker exec <节点> ls -l /output-data/recordings/<anchor>`、`docker exec $CTRL ls -R /output-data/stage` | 源录像/`.xml`/`.session.json` 是否仍在;stage 是否有残留;`fake-archive.jsonl`(`/output-data/config/biliup/`)里的 `watermarkOff:true`、`onlySelf:true` <!-- issue-guard: allow --> |
| **API / 界面字段** | `GET /api/hub/jobs`、`/api/hub/queue`、`/api/hub/workers/status`、各节点 `GET /api/tasks`(经 `docker exec <节点> curl …`) | job 状态/ETA/步骤时间线、worker 三态点、节点任务的 `assigned`/`recording` 字段 |

### 8.3 S1 归属隐藏

播种:8.1 的 node-1/node-2 都放录像;规则 `workers:["node-1"]`(只勾 node-1)后 `POST /api/hub/apply`。

预期(样例):
- 台账:`sync_candidates` 只有 node-1(node-2 未被选中,不参与选优)。
- 文件:node-2 上的录像与任务**都还在**(「未派给」≠删除,T3;真删见 #75)。
- API:`docker exec drec-dev-node-2 curl -s localhost:7860/api/tasks | jq '.[]|{id,managedBy,assigned,recording,enabled}'` → 该受管任务 `assigned:false, enabled:false`,且 worker 模式 Web 默认不列出;node-1 上同一任务 `assigned:true`。

### 8.4 S2 失联三态(stop + pause 双断言)

播种:8.1 的 node-1/node-2 都放录像,规则 `workers:["node-1","node-2"]`,node-1 完整、node-2 完整。然后:

| 动作 | 机制 | 预期(样例) |
| --- | --- | --- |
| `docker stop drec-dev-node-2` | 容器名不再可解析 → ssh 快速失败(**reject 路径**) | 该节点清单 = unreachable(不是 empty):本轮不选优、不收口,job 不推进,日志有「失联」行;其它房间照常 |
| `docker unpause`/`start` 后等一轮 reconcile(`reconcileIntervalMs=60s`) | 恢复 | 该场补收口,`sync_jobs.state` → done |
| `docker pause drec-dev-node-2`(换回 start 后再做) | 容器冻结 → ssh 挂起,靠 `ConnectTimeout`/`ServerAlive*`/硬超时(**超时路径**) | 同样判 unreachable,**不得当「无录像」**,且 reconciler 不被永久挂死(硬超时 45s,`ping` 6s) |
| 连续 6 轮失联 | 阈值 | 发一条通知(只发一次);仍不转人工、不删任何东西 |

三路:台账(job 不推进/不进 needs_manual)、文件(node-1/node-2 源都在)、API(`/api/hub/workers/status` 里 node-2 `ok:false` + error 文本)。

### 8.5 S3 收口清理

播种:8.1 的 node-1/node-2 都放 2 段录像,规则 `cleanup.sourceAfterDone/stageAfterDone=true`,`upload.mode=upload`。等一轮 reconcile。

预期(样例):
- 台账:`sync_jobs`:`state=done`、`bv` 形如 `BV1…`(假 biliup 产出)、`sync_candidates` 里 winner 为完整录全的节点;`sync_job_steps` 有 pull→merge→upload→verify。
- 文件:stage 已清空(`job.log` 与 `.drec-node-result.json` 是有意保留的小文件);节点源**视频**已删,但 `.xml` 按 `xmlKeepRule` **至少保留一份**(清空 stage 时保留节点源 .xml)。 <!-- issue-guard: allow -->
- 假 biliup 凭据:`/output-data/config/biliup/fake-archive.jsonl` 每行 `watermarkOff:true`、`onlySelf:true`,`upload` 一行含 plain 文件,`append` 行含其余分 P(顺序 P1=plain → P2=danmu → P3=livechat,按 pipeline 开关)。
- API:`/api/hub/jobs` 该场 `done`,`/api/hub/queue` 无在途。

### 8.6 S4 重启接管

**阻塞于 #72 / #57**。依赖:rolling 韧性(#57 R*)与 #72 的重启语义落地后,才能定义「接管」的预期。环境侧已就绪(主机密钥与数据卷持久化,`docker restart` worker 不触发 known_hosts 告警);用例由 P3b 追加。

## 9. 已知局限

- **不是线上等价物**:无 tailscale、无真 B 站、无真抖音;验证的是 hub/SSH/rsync/管线/台账逻辑,不是平台风控或带宽。
- ssh 会话 TZ 偏差是生产潜在问题(§6.2),dev 默认把它压平,专项验证请用 `DEV_SSH_TZ=`。
- `known_hosts` 用 `accept-new` 仅限 devnet;线上 `StrictHostKeyChecking` 议题(#47 之外的另一话题)不在此混入。
- `down` 的数据清理用宿主机 `rm -rf`;Linux 上若容器以 root 写出文件导致权限不足,需手动 `sudo rm -rf data-dev/e2e*/{controller,node-1,node-2}`。
- 脚本为 bash 3.2 兼容(macOS 自带);依赖 `jq`、`ssh-keygen`、`docker compose`。

## 11. mirror 档:把 dev 当「真 dev server」用(issue #88)

**用途**:平时关着,测试时才起。数据根从 prd(`docker-data`)**只读复制**——真抖音 cookies、任务、hub 规则——三个节点放行外网,你在 dev UI 里把要测的任务打开,就真取流、真录制、真走 hub 链路。与 prd 互不影响。

```bash
scripts/e2e-verify.sh up --mirror            # 播种(首次)+ 起 controller + 2 worker;UI: http://127.0.0.1:7871  # issue-guard: allow(dev 测试夹具:本机回环地址/假房间号)
scripts/e2e-verify.sh x ctrl curl -s -X POST http://localhost:7860/api/tasks/<id>/start   # 或直接在 UI 里开任务
scripts/e2e-verify.sh keep                   # 测完停机,保留数据;再 up 可续
scripts/e2e-verify.sh down                   # 拆容器并清空 dev 数据(下次 up 重新从 prd 复制)
scripts/e2e-verify.sh seed --mirror          # 只播种、不起容器
```

环境变量:`DREC_MIRROR_SRC`(源数据根,默认 `<主仓库>/docker-data`)、`DREC_MIRROR_ROOMS`(逗号分隔 roomSlug,只复制这些房间的 hub 规则;空=全部)、`DREC_MIRROR_PORT`(默认 7871,不得为 7860)、`DREC_DEV_SUFFIX`(与别的 dev 集群并存)。

**复制什么 / 不复制什么**

| 复制(改写后) | 不复制 |
| --- | --- |
| 数据库快照:`settings`(平台 cookies、时区)、`tasks` | biliup cookies、`vps.key`、`.env`、录像、stage、sync 库、prd 合并历史 |
| hub 规则文件:workers 改写成 `local`/`node-1`/`node-2`,`upload.mode` 一律 `stage` | webhook(`discordWebhook`、通知开关)、任务级 webhook/outDir |  <!-- issue-guard: allow(文档里说明「不注入 webhook 设置」这一行为,非凭证) -->

- 任务全部 `enabled=0`、`status=stopped`、`rollingUpload=0`;**controller** 带全部任务,**worker** 只带 settings(任务由 hub 同步下发)。
- 投不了稿(物理上):镜像里是假 biliup,biliup cookies 仍是 `FAKE-DEV`。要测真投稿走 egress 档,不在 mirror 档。
- 种子在播种时过一道断言(`chk_mirror_seed`):无 webhook 设置、无 enabled 任务、无 prd 合并历史、hub 规则 workers ⊆ {local,node-1,node-2}、upload.mode=stage;`doctor` 的反例自检覆盖这些。该断言**不进 gate**——测试时任务被打开是预期。  <!-- issue-guard: allow(文档里说明「不注入 webhook 设置」这一行为,非凭证) -->
- 网络:三节点都接 `drec-devnet`(internal,节点间 ssh/rsync)+ `drec-devnet-egress`(出外网);controller 只发布 `127.0.0.1:$DREC_MIRROR_PORT`。compose 断言按档位校验这些形态,其它档位发布端口/加网络仍被拒绝。  # issue-guard: allow(dev 测试夹具:本机回环地址/假房间号)
- `run s1|s2|s3|all` 在 mirror 档被拒绝(它们用假房间造数),请在 UI 里开真实任务。
- 注意:dev 与 prd 对同一房间**同时**录制会各拉一路流;测试时尽量只开要测的那几个任务。
