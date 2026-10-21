# TODO — Agent 工作台账

> 本文件是本仓库 **agent 工作的唯一待办台账**。管理规则见 `AGENTS.md`「任务与 TODO 管理」。
> 编号 `T-N` 稳定不变（引用/提交信息里用它指代条目）。
> 最后更新：2026-10-20

## 状态约定

- `[ ]` **待办** — 已明确、尚未开始
- `[~]` **进行中** — 同时最多 1–2 项；开始做才标
- `[!]` **阻塞** — 必须在该行写明阻塞原因与解除条件
- `[x]` **完成** — 完成后移到「已完成」，行尾补完成日期

每条至少写清：**做什么 + 为什么 + 验收标准**；有计划的挂 `plans/NNN_*.md` 链接。

## 进行中
- [~] **T-104 房间编辑器投稿 B站开关移到第 3 步（issue [#346](https://github.com/fuyucn/douyin-rec/issues/346)）**
  — 2026-10-21 认领,分支 `codex/issue-346-upload-toggle-step3`,base `feat/hub-optimization`（**未合并 / 未部署 / 未 close**）。
  **做什么**：「归档 / 投稿 B站」开关从第 2 步挪到第 3 步顶部,第 3 步始终可点;选投稿才显示投稿字段。
  **为什么**：原来要先回第 2 步选投稿才能解锁第 3 步,顺序绕。
  **验收**：不改表单状态与保存内容;第 2 步依赖开关的项仍按值显示;全量测试 / 类型 / web 构建 / 文案检查通过。

- [~] **T-103 房间编辑器标题模板预填统一默认值（issue [#344](https://github.com/fuyucn/douyin-rec/issues/344)）**
  — 2026-10-21 认领,分支 `codex/issue-344-title-defaults`,base `feat/hub-optimization`（**未合并 / 未部署 / 未 close**）。
  **做什么**：房间没存标题模板时,编辑弹窗三个模板输入框预填统一默认值;清空保存仍走原回落。
  **为什么**：空输入框看不出当前生效的标题方案,各房间设置容易不一致。
  **验收**：已存模板优先;清空后 payload 不下发;全量测试 / 类型 / web 构建通过。

- [~] **T-102 房间编辑弹窗改为分步骤标签页（issue [#342](https://github.com/fuyucn/douyin-rec/issues/342)）**
  — 2026-10-21 认领,分支 `codex/issue-room-editor-steps`,base `feat/hub-optimization`（**未合并 / 未部署 / 未 close**）。
  **做什么**：房间编辑弹窗拆成 录制 / 处理 / 上传 / 清理与通知 四个可自由跳转的标签页;没选投稿时「上传」置灰;弹窗固定高度,切步骤不跳动;手机全屏可用。
  **为什么**：原来录制、处理、上传、清理全挤在一个滚动区与「更多设置」折叠区里,层级不清。
  **验收**：不改字段含义与保存逻辑;桌面与手机宽度实看通过;web build / 类型 / 文案检查 / 全量测试通过。新建房间、任务、hub 规则弹窗不在范围。

- [~] **T-101 录像与 stage 改用「主播名_平台_房间号」房间目录(新会话)（issue [#336](https://github.com/fuyucn/douyin-rec/issues/336)）**
  — 2026-10-21 认领,分支 `codex/issue-336-room-dir-layout`,**叠在 T-100（#335,PR #340）之上**,base 为该分支（**未合并 / 未部署 / 未 close**;RISK,不自动合并;#337 仍阻塞不做）。
  **做什么**：每个节点用本地开关文件(数据根 `config/` 下的 output-layout 文件)启用房间目录布局;录制器、master 管线、节点管线、合并页、维护页保护、清单扫描统一走 core 解析函数。录像新会话进 `<名>_<平台>_<房间号>/`(按后缀查找,主播改名不换目录;旧名字目录只读不迁移);stage 为 `<名>_<平台>_<房间号>/<日期[_HHMM]>/`,已存在的场次目录(任一布局)一律沿用。清单扫描对无边车的录像从目录后缀解析房间号,新旧目录同房间仍聚成一场。
  **为什么**：一眼认出直播间;日志已移出 stage(T-99)、空目录已清(T-100)。节点侧只拿得到 streamKey,故查找只靠后缀、名字只在创建时用、拿不到用房间号兜底。
  **验收**：开关关闭时行为与路径完全不变;开关开启后新会话落房间目录、旧目录不动;节点结果读写 / 中止 / 续跑在新布局下正常,且开关中途关闭仍能找到;维护页保护同时命中新旧目录;合并页新旧会话都可见;全量门禁 + web 构建通过。
  **文档**：`docs/output-layout.md`(布局、开关、规则、回滚、上线顺序)。

- [~] **T-100 完成后清 stage:清理后删除空场次目录(master 侧)（issue [#335](https://github.com/fuyucn/douyin-rec/issues/335)）**
  — 2026-10-21 认领,分支 `codex/issue-335-empty-stage-dir`,**叠在 T-99（#334,PR #339）之上**,base 为该分支（**未合并 / 未部署 / 未 close**;RISK,不自动合并）。
  **做什么**：master 侧 `stageAfterDone` 清理成功后,对场次目录做**非递归** rmdir(只删已知文件,目录里还有东西就保留并写日志告警);只在「上传已确认 + 有稿件号 + 清理无失败」的分支里调用;只允许 stage 根目录内的真目录(不删根、不跟符号链接);从不外抛。
  **为什么**：#5 空壳目录堆积;日志已由 T-99 移出 stage,这里删的只是空目录。
  **验收**：done 且勾选清理 → 目录消失、日志仍在;目录不空 / 未上传(stage 交付)/ 无稿件号 / needs_manual → 不动;节点侧 stage 与节点结果文件不动(架构守护);变异验证(五处调用点逐个撤、非递归改强删均红);全量门禁通过。
  **注意**：已堆积的旧空壳目录不在本条范围(旧目录里有旧日志,保留);仅对之后完成的场次生效。

- [~] **T-99 场次日志移出 stage 到独立日志目录,永久保留（issue [#334](https://github.com/fuyucn/douyin-rec/issues/334)）**
  — 2026-10-21 认领,分支 `codex/issue-334-job-log-relocation`,**叠在 `codex/issue-333-path-resolver`（T-98,PR #338,RISK 待 owner 拍板）之上**,base `feat/hub-optimization`（**未合并 / 未部署 / 未 close**）。
  **做什么**：新场次日志写 `<root>/logs/hub/<平台>_<房间号>/<场次>.log`（经 T-98 解析函数,不做跨盘搬迁）;读日志 / hasLog / 删除场次历史三处同时兼容新旧路径;旧场次若 stage 内已有 job.log 则继续写旧路径（sticky）。
  **为什么**：stage 清理后只剩 job.log 导致空壳目录堆积（#5）;且清理之后管线仍会写日志,目录被删则写入被 FileLogger 静默吞掉。
  **验收**：清理后写的日志仍完整可见;旧场次日志在 UI 仍可查;删除历史时新旧两处日志都处理;回归用例 + 变异验证;全量门禁通过。运维脚本按目录名统计残留的逻辑核对结论见 PR。

- [~] **T-98 输出路径统一解析函数(stage / 录像 / 场次日志),行为不变（issue [#333](https://github.com/fuyucn/douyin-rec/issues/333)）**
  — 2026-10-21 认领,分支 `codex/issue-333-path-resolver`,base `feat/hub-optimization`（**未合并 / 未部署 / 未 close**）。目录布局改造 #333→#334→#335→#336 的第 1 步,#337 阻塞不做。
  **做什么**：core 新增 `output-paths.ts`(stage 场次目录 / 录像房间目录 / 场次日志的唯一解析 + 目录名清洗唯一规则),替换 11 处手写拼接与三份清洗副本;默认仍输出旧路径,新布局只在显式 `layout: "room"` 时生效。
  **为什么**：后续布局调整都依赖单一入口,否则写入方与读取方路径不一致、维护页活动保护静默失效。
  **验收**：按 `_<平台>_<房间号>` 后缀查找、仅创建时用名字(无名字用房间号兜底);旧目录 sticky;同后缀多目录取最早并告警;core 外无手写拼接(架构守护 + 变异);全量测试 / typecheck / arch:check / bundle 通过,对外路径不变。

- [~] **T-95 合并内存准入:内存不足改为排队等待,不再超时转人工（issue [#311](https://github.com/fuyucn/douyin-rec/issues/311)）**
  — 2026-10-20 认领,分支 `codex/issue-311-merge-mem-wait`,base `feat/hub-optimization`（**未合并 / 未部署 / 未 close**）。
  **做什么**：内存闸门超时不再抛错,只告警一次（含需求/可用量）并继续等;新增 `minMergeFreeMemMB`（默认 512,实测 concat-copy 峰值约 60 MB）,merge 取 `min(merge, burn)`;烧录默认阈值 2048 → 1024。
  **为什么**：master 所在 VM 约 3.9 GB,`MemAvailable` 常态约 1.9 GB,永远达不到 2048,合并必超时转人工。
  **验收**：先低后高 → 最终执行;超时只告警一次;`minBurnFreeMemMB=0` 仍整体关闭闸门;全量测试 / typecheck / bundle 通过。
  **复审**：发现内存等待持锁 → 一个等不到内存的烧录会卡死全部合并 → 改为锁外等待、持锁复核。
  **决定**：owner 选择烧录默认阈值降为 1024（实测烧录峰值约 600 MB,约 1.7 倍余量;0 仍关闭整个闸门）。
  **残余**：复审 Low —— 内存回升后告警计时 `shortSince` 未清零,极端时序下可能提前告警一次(只影响告警时机,不影响排队/执行),后续顺手修。

- [~] **T-94 对账日志去重:「仍在录制 / 重连窗内等待」每轮刷屏（issue [#313](https://github.com/fuyucn/douyin-rec/issues/313)）**
  — 2026-10-20 认领,分支 `codex/issue-313-settle-log-dedupe`,base `feat/hub-optimization`（**未合并 / 未部署 / 未 close**）。
  **做什么**：按 (场次, 节点集合) 去重,状态变化 / 条件清除后再现 / 30 分钟后才再打;文案去掉「超时」。**为什么**：生产 8 小时约 350 条,淹没真实错误。
  **验收**：重复轮次只出一条;状态变化再出;对账行为不变（pipeline 仍不跑）;全量测试 / typecheck / bundle 通过。

- [~] **T-88 任务敏感字段接口脱敏 + 回调地址不进 argv(issue [#47](https://github.com/fuyucn/douyin-rec/issues/47))**
  **做什么**：任务/房间 DTO 的 登录态、回调地址经 core `redactTaskSecrets` 脱敏(只给 是否已设置标记);编辑表单留空=不改;子进程 回调地址走 0600 文件传入。**为什么**：接口明文返回敏感字段、`ps` 可见回调地址。**验收**：list/detail/create/update/room 响应无明文;PATCH 缺省保留;argv 不含回调地址;变异检查 FAIL→PASS。
- [~] **T-90 边录边传:槽忙时不留建稿/追加意图,避免被误判为「建稿中断」转人工（issue [#309](https://github.com/fuyucn/douyin-rec/issues/309)）**
  — 2026-10-20 认领(用户授权),分支 `codex/issue-309-rolling-slot-busy-intent`。**做什么**：上传槽等待超时(biliup 未启动)时清掉已落盘的 create/append 意图。**为什么**：意图先于抢槽落盘,槽忙只 break 不清,下一个进程读到 create 意图即转人工、无稿件号。**验收**：槽忙后 sidecar 无 `uploading`;重启后的 uploader 不记 ambiguous 并正常建稿;变异检查 FAIL→PASS。不改「绝不自动重建稿」规则。
- [~] **T-92 「同一场」判定改用平台 liveId,60 分钟间隔只作兜底（issue [#320](https://github.com/fuyucn/douyin-rec/issues/320)）**
  — 2026-10-20 认领(用户授权),分支 `codex/issue-320-live-id-broadcast`(叠在 T-90 之上)。**做什么**：录制端把 `liveSessionId` 写进会话 sidecar;core `isSameBroadcast` 两边都有 id 时只比 id,否则按 60 分钟;节点续稿(#148)与 master 聚类共用。**为什么**：实测 26 分钟内两次开播 liveId 不同(按 #148 会被并进一个稿件,不可逆),而 84 分钟空窗可能仍是同一场。**验收**：不同 id 不续稿不聚类、相同 id 跨 60 分钟续稿聚类、缺 id 行为不变;变异检查 FAIL→PASS。
- [~] **T-91 边录边传:append 失败后分P数读不到时延迟复核（issue [#310](https://github.com/fuyucn/douyin-rec/issues/310)）**
  — 2026-10-20 认领(用户授权),分支 `codex/issue-310-rolling-confirm-retry`(叠在 T-90 之上)。**做什么**：append 失败后分P数读不到(null)先延迟重读等接口恢复,恢复后仍须在 #66 的完整窗口内保持不变才算未提交;窗口内任一次 null 或读数低于基线都判 ambiguous。**为什么**：单次读不到即转人工;反过来,恢复后只读一次就换线会重复追加。**验收**：恢复且变多 → 已提交;恢复不变 → 走完整窗口才换线;混合/低于基线 → ambiguous;变异检查 FAIL→PASS。收尾槽忙的有界重试未做(证据不足,见 #310 评论)。
  **残余(未做)**：崩溃恢复路径的分P数读取仍是单次读;失败路径的延迟重读(最长约 40s)期间仍持有节点上传槽。
- [~] **T-89 边录边传:后继会话接管前序会话的未确认分段（issue [#46](https://github.com/fuyucn/douyin-rec/issues/46)，#57 R2 的接管部分）**
  — 2026-10-20 认领(用户授权),分支 `codex/issue-46-rolling-takeover`,PR 待开(base `feat/hub-optimization`)。
  **做什么**：重启/断流重连后,后继会话先结算前序会话悬空的 `uploading` 意图(分P数回读),再把前序剩余封口段按段号 append 并确认后删源,最后才传自己的段;sidecar 记 owner pid + 心跳,owner 存活则等待(规避 PR #72 的接管竞态)。
  **验收**：重启后 A 残段 → B 先传 A 残段再传 B;悬空意图落地/未落地/不可知三态;owner 存活等待;A 模糊 → B 转人工;e2e 的 `it.fails`(#46)转真实通过;变异验证。
  **不做**：前序有稿件号残段但无后继会话 → 仍由主控 needs_manual 处理。

- [~] **T-87 rolling 上传拦截 0 字节封口段(issue [#177](https://github.com/fuyucn/douyin-rec/issues/177))**
  **做什么**：rolling 上传读段真实大小,0 字节段不上传、保留源、记日志、不阻塞后续段(不依赖前段 mtime)。**为什么**：0 字节段致 B 站 duration=0 → 稿件 -16 不可逆。**验收**：前段源已删/仍在两种 0 字节用例不上传;既有碎片/崩溃恢复用例绿。
- [~] **T-86 起录时记录平台本场 id 与拉流路径(诊断日志)(issue [#294](https://github.com/fuyucn/douyin-rec/issues/294))**
  **做什么**：每次起录/重连打 `[session-id]` 日志(抖音 id_str / B站 live_time + 去签名的拉流 host+path)。**为什么**：#148/#292 要定「同一场」口径,先跑两天验证重连前后 id 是否一致。**验收**：单测 + 全量绿;部署后两天数据回填 #148。
- [!] **T-79 队列页「上传」视图:每节点 biliup 实时进度(issue [#44](https://github.com/fuyucn/douyin-rec/issues/44))** — 计划 [`plans/039_upload_view.md`](plans/039_upload_view.md)
  — 2026-10-18 计划经三轮独立设计审查,PR [#263](https://github.com/fuyucn/douyin-rec/pull/263) 已合并(计划入库)。**仍 `[!]`**:确认计划 + T0(镜像补 `ss`)是否做。
  **做什么**：节点状态命令旁路扫描 biliup 进程(只读),master 算速率/剩余/卡住/重试换线/最近结果,队列页按节点展示。**验收**：见计划 T1a–T4。
- [!] **T-80 派生分P弹幕 xml 回收与总 xml 区分(issue [#84](https://github.com/fuyucn/douyin-rec/issues/84))** — 计划 [`plans/040_derived_part_xml_recycle.md`](plans/040_derived_part_xml_recycle.md)
  — 2026-10-18 计划经三轮独立设计审查,PR [#264](https://github.com/fuyucn/douyin-rec/pull/264) 已合并(计划入库;T0 改为空 xml 永不凭副本证据删除,emptyXml 类别停止删除)。**仍 `[!]`**:改名(R)还是保持同名(M)、T0 是否先行。
  **做什么**：T0 修既有风险(不删文件)→ T1 清单 → T2 维护页回收(dryRun + 审计)。**验收**：见计划。

- [~] **T-78 追加后回读分P数遇B站列表刷新延迟:先间隔重读再换线（issue [#66](https://github.com/fuyucn/douyin-rec/issues/66)）**
  — 2026-10-18 PR [#261](https://github.com/fuyucn/douyin-rec/pull/261)(仅测试/文档,独立审查 APPROVE):假B站支持回读延迟,已知缺陷场景复现「重复追加一次」。**风险扫描按路径名判 RISK + 修复改追加成功判定 → `needs-decision`**,issue 已写决定三行。
  **做什么**：读到「没变」先退避重读(约 10 秒)再换线,主控/边录边传/节点侧共用。**验收**：#261 场景转真实用例;退避时长有单测;不改上传硬标准。

- [~] **T-77 主控止血跟进:保留成员回归用例、混合稿件号情形、回读计数（issue [#70](https://github.com/fuyucn/douyin-rec/issues/70)）**
  — 2026-10-18 第 1 项完成:PR [#259](https://github.com/fuyucn/douyin-rec/pull/259) 已合并(仅测试,独立审查 APPROVE),改回旧剔除逻辑两例变红。**第 2、3 项改上传完成/转人工判定 → `needs-decision`**,issue 已写决定三行。
  **做什么**：①剔除阶段保留成员的回归用例(已完成) ②台账有稿件号 + 另一成员建稿中被杀的判定 ③回读计数口径。**验收**：各项有测试;不改上传硬标准。

- [~] **T-76 节点失联三态的跟进:脚手架双节点、失联超阈值、立即执行拦截（issue [#69](https://github.com/fuyucn/douyin-rec/issues/69)）**
  — 2026-10-18 第 3 项完成:PR [#257](https://github.com/fuyucn/douyin-rec/pull/257) 已合并(仅测试/文档,独立审查 APPROVE),e2e 脚手架支持多节点,双节点失联场景对「失联当成空」有区分力。**第 1、2 项改收口/上传触发条件 → `needs-decision`**,issue 已写决定三行。
  **做什么**：①选中节点失联超阈值转待人工或界面提示 ②立即执行遇选中节点失联返回冲突 ③脚手架双节点(已完成)。**验收**：三项各有测试;变异「失联当成空」时第三项场景变红(已满足)。

- [~] **T-67 主播名含 emoji/全角符号/点号时收口失败:stem 清洗、稿件标题保留原始字符（issue [#171](https://github.com/fuyucn/douyin-rec/issues/171)）**
  — 2026-10-18 认领。PR [#236](https://github.com/fuyucn/douyin-rec/pull/236) 已合并(0.0.186,独立审查两轮 APPROVE)。审查发现稿件查重按标题精确比较,emoji/全角标题若被B站改写会被判「无稿件」而重传 → 已改为宽松匹配命中时返回「无法确认」(各调用方转人工,不重传),回归用例撤修复即红。**待部署实跑**。2026-10-19 用户要求「emoji 部分自动忽略」:文件名 stem 改为直接删除 emoji(不再替换成 `-`),稿件标题仍保留原始字符(0.0.189)。
  **做什么**：stem 渲染遇非法文件名字符改为清洗(已合法名原样不变);稿件标题四处(master / 节点 / 队列 / 边录边传)收口为 core 单一函数,未配稿件模板时保留原始字符。
  **验收**：三种以上非法字符形态回归用例;已合法名 stem 与标题不变;部署后此类房间收口不再需要人工改名。

- [~] **T-70 租约交接预留落库:兄弟 record 进程不再在让出瞬间抢走租约（issue [#241](https://github.com/fuyucn/douyin-rec/issues/241)）**
  — 2026-10-18 PR [#242](https://github.com/fuyucn/douyin-rec/pull/242) 已合并(0.0.177,schema v4 单向迁移,独立审查 APPROVE),issue `待验证`。取代 T-69 的进程内冷却。
  **做什么**：让出与预留同事务;预留期内只有请求方可取得租约;墙钟回拨与让出写库失败均有兜底。**验收**：多 runner 用例 + 迁移用例;部署后多房间同录时 serve 接管一次完成。

- [~] **T-68 房间 PUT 回滚字段不全 / 源任务校验晚于录制写入（issue [#200](https://github.com/fuyucn/douyin-rec/issues/200)）**
  — 2026-10-18 PR [#237](https://github.com/fuyucn/douyin-rec/pull/237) 已合并(0.0.175,三轮独立审查,CI 绿),issue `待验证`,随下次部署收口。
  **做什么**：回滚从写入前原始任务快照恢复,回滚键由正向 patch 推导(含派生列);源任务校验失败同样回滚;回滚自身失败明确报出。
  **验收**：8 条房间用例 + 5 组变异均被抓到;部署后关闭。

- [~] **T-71 录制凭证文件遗留项:启动清扫、同步抛错回滚、启动失败告警去重（issue [#41](https://github.com/fuyucn/douyin-rec/issues/41)）**
  — 2026-10-18 PR [#244](https://github.com/fuyucn/douyin-rec/pull/244) 已合并(0.0.184,独立审查两轮 APPROVE;删除仅限 run 目录本模块凭证临时文件)。**待部署实跑**。
  **做什么**：serve 启动清扫残留凭证文件;子进程同步抛错时清理进程表与凭证文件;启动失败告警按任务去重、成功后重置。**验收**：各分支 vitest + 变异验证;部署后 run 目录无残留。

- [~] **T-83 Rooms 切换房间残留旧进度/旧时间 + 提示名称优先级统一（issue [#275](https://github.com/fuyucn/douyin-rec/issues/275)）**
  — 2026-10-18 PR [#276](https://github.com/fuyucn/douyin-rec/pull/276) 已合并(0.0.188,审查 APPROVE)。过期响应按当前房间作废、taskId 变化清空详情;提示统一「解析名 > 主播名 > 兜底名」,兜底名不加错误前缀。**部署后**在两个在录房间间切换核对。

- [~] **T-73 账号开关文案与按平台登录判定（issue [#85](https://github.com/fuyucn/douyin-rec/issues/85)）**
  — 2026-10-18 PR [#246](https://github.com/fuyucn/douyin-rec/pull/246) 已合并(0.0.178,两轮独立审查,CI 绿),issue `待验证`,部署后浏览器核对收口。
  **做什么**：开关文案改为功能语义(抖音抓礼物/入场、B站取流+礼物、快手取流);登录判定按房间所属平台;锁定原因与弹幕开关同名。**验收**：表单规则与文案用例;部署后三类表单逐项核对。

- [~] **T-74 通知与日志统一带直播间名称等上下文（issue [#53](https://github.com/fuyucn/douyin-rec/issues/53)）**
  — 2026-10-18 认领,按 issue 内调查方案 N1–N8 分步。N1 契约随 PR [#248](https://github.com/fuyucn/douyin-rec/pull/248) 合并(0.0.179);N2 名称链路收口 + hub 事件附上下文随 PR [#249](https://github.com/fuyucn/douyin-rec/pull/249) 合并(0.0.180,两轮独立审查)。均未部署。
  **做什么**：唯一名称链路(任务名 → 运行时主播名 → 缓存名 → 台账快照 → 会话基名 → 平台+房间号)+ 事件结构化上下文;后续 N3 台账快照列与编排层发送点、N4 录制子进程通知、N5 级别/去重/下一步、N6 前端渲染(含节点页两处主播名优先)、N7 日志前缀、N8 仓库假名扫描。
  **验收**：每步独立 PR + 用例;旧事件文案除名称优先级外不变;部署后通知能看出是哪个直播间。

- [~] **T-62 节点侧上传队列:biliup 作为 proc-queue 处理器,按进度停滞判死（计划 [plans/038_node_upload_queue.md](plans/038_node_upload_queue.md)）**
  — 2026-10-16 立项,承接 plan 036 第二期 T14/T15,取代 plan 033 W1-2 与 issue #25 ①。issue [#202](https://github.com/fuyucn/douyin-rec/issues/202)（PR0 #203 已合并、PR1 #205 已合并,**均待部署实跑**;`待验证`）。
  **做什么**：①止血：节点侧上传预算按胜出方全部会话字节求和并下调保守带宽,超时报错带 stderr、不覆盖原始错误；②biliup 处理器进每节点 proc-queue（阶段 gate_wait/transfer/submit;预处理先由独立 kind=upload-prep job 完成（不删源）,默认并发 1,字节停滞才判死,transfer 失败按退避重试、submit 不确定转 `uncertain`）；③master 改入队 + 轮询（钉住节点、不 abort、sweep 豁免、原 key 409、部署 guard 加 `running.biliup`）；④边录边传共用并发槽；⑤队列页与归并工具。
  **为什么**：一次 743MB 的节点侧上传因预算只算第一会话 + 同节点并发抢带宽被总时长误杀（事后人工 5MB/s 约 2.5 分钟传完）；总时长判死与重启误 abort 都会把「没建稿」变成人工事故。
  **验收**：PR0 回归用例钉住多会话求和与错误不覆盖；队列模式下重启 / SSH 断开不产生第二次 upload；停滞判死只看字节、submit 永不 kill；全量 vitest / typecheck / arch:check / bundle 绿。
  **进度（2026-10-17）**：T01–T13c 随 PR [#209](https://github.com/fuyucn/douyin-rec/pull/209) 合并（审查中修了 biliup 续传会重复追加 P1 的缺陷）;T16 部署 guard 三态随 PR [#210](https://github.com/fuyucn/douyin-rec/pull/210) 合并;T17 `-N`/runNow 409 + force 随 PR [#211](https://github.com/fuyucn/douyin-rec/pull/211) 合并（均为用户批准的计划默认口径,**均未部署**）。队列模式仍默认关闭,节点不广播 `biliup-queue` 前不会启用。T14 实测（`tcp.acked` 为进度信号,`stallMs` 默认 300 秒）+ T15 字节停滞判死随 PR [#214](https://github.com/fuyucn/douyin-rec/pull/214) 合并（0.0.168,节点开始广播 `biliup-queue`）;T15b master 入队入口 + biliup 处理器补限流闸门/节点本机凭证/分 P 标题随 PR [#215](https://github.com/fuyucn/douyin-rec/pull/215) 合并（0.0.169）;PR5 队列页节点上传状态/心跳/实测 ETA 随 PR [#217](https://github.com/fuyucn/douyin-rec/pull/217) 合并（0.0.170）;PR4 边录边传与队列上传共用节点上传槽（方案 B,用户选定）随 PR [#219](https://github.com/fuyucn/douyin-rec/pull/219) 合并（0.0.171）。**均未部署**。
  **剩余（2026-10-17）**：①启用队列模式 = 在 master hub 配置写 `nodeUpload.mode=queue`（`needs-decision`）,且需先部署 0.0.171 到 master + 两个 worker;队列完成不删源（T13c 设计）,启用前需决定磁盘回收口径。②PR7/PR8 Phase 2（`needs-decision`）。③部署后实跑验证 #202/#204/#207（目前 `待验证`）。PR6 恢复工具（`recover-order`）**代码已在 #209**,此前误记为待交付;2026-10-17 两台节点 dry-run 验证可跑通(队列为空,只验证到拒绝未知订单)。

- [~] **T-54 分段续跑补齐烧录轨:续跑不重烧也不补烧录轨分 P（issue [#142](https://github.com/fuyucn/douyin-rec/issues/142)）**
  — 2026-10-15 认领,分支 `codex/issue-142-resume-burn`(**未合并 / 未部署 / 未 close**)。#140 复审期间发现（不在 #140 范围，单独开票）：续跑路径拿到的烧录产物字段恒为空
  （赋值在主流程烧录循环里，而该循环在续跑分叉之后）→ `appendSegmentGroup(files=[])` 直接把该步骤标
  `skipped` → `markDone` ⇒ **台账 done 但稿件缺烧录轨分 P，全程无告警**。
  **做什么**：续跑按分 P 规范名重新发现已存在的烧录产物并继续 append；缺失/坏 → 重烧或转 `needs_manual`。
  **验收**：续跑「产物在盘」→ 追加成功且分 P 数正确；「产物缺失」→ 不标 done；烧录产物同过提交前自检。

- [~] **T-53 产物落盘原子化 + 复用/提交前自检（issue [#140](https://github.com/fuyucn/douyin-rec/issues/140)）**
  — 2026-10-15 认领，dev-loop run 模式（人直接指派），分支 `codex/issue-140-atomic-part-write`，PR [#141](https://github.com/fuyucn/douyin-rec/pull/141)，base `feat/hub-optimization`。
  **状态 = needs-decision**（4 轮独立审查收敛：代码与用例 PASS、CI 绿、dev e2e 留证；唯一阻塞 = `pr-risk-scan` RISK ⇒ 合并需人拍板）。
  **未合并 / 未部署 / 未 close**。
  **做什么**：产物一律先写 `.part` 再 rename（存在 ⟹ 完整）；`linkOrCopy` 改原子替换（同 inode 幂等）；
  分段管线（master + 节点侧）续跑判定由「存在」改为「存在且探得出时长」；提交前对分 P 自检，读不出即拒投。
  **为什么**：被强杀留下的半成品大小正常却读不出时长，旧逻辑当成品复用 → 静默投稿坏分 P（B站转码 `-16`）。
  **验收**：三条路径（remux / merge / burn）原子落盘有回归用例；半成品必重做；坏产物拒投；全量测试 / typecheck / bundle 通过；
  dev 三节点 e2e（S1/S2/S3 + 真 ffmpeg 端到端）留证；独立审查 PASS。

- [~] **T-41 边录边传硬化：崩溃恢复 + 头阻塞 + 原子写 + 末段封口（issue [#3](https://github.com/fuyucn/douyin-rec/issues/3)，T-33 后续）**
  — 2026-10-13 认领，PR [#18](https://github.com/fuyucn/douyin-rec/pull/18)（分支
  `codex/issue-3-rolling-upload-harden`，base `feat/hub-optimization`，独立 worktree 实现，
  **未合并 / 未部署 / 未 close**）。
  **做什么**：对已部署的 T-33 骨架补容错：①sidecar 原子写（openSync→fsync→rename，WAL 意图标记
  `uploading`），写失败即 `stateUntrusted` 停上传/删源转人工；②崩溃恢复 `recoverDanglingUpload`
  （create 无 BV → 人工绝不重建稿；append 用分 P 数核对补确认/安全重试）；③头阻塞
  `headOfLineFilter`（段 k 不确定则 >k 一律不外发，防不可逆分 P 空洞）；④收尾封口 `sealGraceMs=0`
  回归修复（旧 3s 宽限 × 一次性收尾 = 末段永不上传、源永残留，e2e 实测复现）；⑤`minSegmentSec`
  碎片段过滤；⑥append 强制 `countParts` 幂等核对；⑦确认后未删源的重启补删；⑧建稿时刻 `startMs`
  持久化（重启后投稿标题不漂到尾段时间）。
  **为什么**：dev 隔离环境 e2e（5 分钟段真实直播间）暴露：a) 末段宽限 bug（整场残段、master 转人工）；
  b) 手动停止与在途 append 竞态：父进程 10s SIGKILL 兜底腰斩 biliup → sidecar 悬空 `uploading`。
  **验收**：上述不变量各有 vitest（封口才传/ack 才删/头阻塞/恢复三分支/原子写失败停摆/末段收尾）；
  `pnpm test` + `typecheck` + `bundle` 绿。**边界**：不改多节点闸门与 hub 短路语义；不删 `.xml`/`.ass`。
  **遗留（本 PR 不做，已在 PR 正文记为残余风险）**：①「孤儿 sidecar 无人接管」——恢复逻辑只在活跃会话内跑，
  会话中断后无扫描者重新认领补传（待用户拍板 Q-2：自动补传 vs 仅上报）；②停录 SIGKILL 10s 超时 vs
  在途上传（待拍板 Q-1/Q-B：解耦方案）；③`runBiliup` 无超时是有意为之（上传中日志静默数分钟=正常态，
  固定超时会误杀），风险由 WAL + ambiguous 转人工兜底。

- [~] **T-37 分段模式派生 per-分P 弹幕 xml（issue [#7](https://github.com/fuyucn/douyin-rec/issues/7)）**
  — 2026-10-12 认领（用户拍板选 **A「同时存在」**：会话级单 xml 保持完整，per-分P xml 作为附加产物并存，
  通过后再谈迁移）。实现由 sub-agent 独立会话 / 独立 worktree 完成，分支
  `codex/issue-7-per-part-danmu-xml`，base `feat/hub-optimization`，**未合并 / 未部署 / 未 close**。
  **做什么**：在分段流水线里由会话级 xml **派生**每个分 P 的 xml —— 复用既有「窗口累计（按会话分开）
  + 窗口切片 + 时间重定基到 0」逻辑，条目集合与烧录切出的窗口一致，命名沿用下游已识别的约定。
  **为什么**：分段模式下分 P 与弹幕没有一一对应的可交付文件，外部工具想按分 P 校对/二次渲染只能自己切窗口；
  合并模式已有对齐的整片 xml，两种模式能力不对称。**验收**：派生 xml 与合并模式算出的绝对时间一致（回归测试钉住）；
  会话级 xml 行为与清理不变量不变；`pnpm test` + `typecheck` + `bundle` 绿。
  **边界**：不改上传/交付口径、不改 hub 规则、不删任何 `.xml`/`.ass`；派生文件不参与「最后一份」不变量判定。
  **待确认（不阻塞）**：这份 per-分P xml 最终是交付物还是仅中间产物，迁移阶段再定。

- [!] **T-5 部署未上线改动** — **阻塞原因**：部署 guard 要求两节点 `recording===true` 为 0，
  当前 VPS1 正在录「yyoo」、VPS2 正在录「凌晴」（2026-10-07 实测）。**解除条件**：两节点都收播
  （周期性 `curl /api/tasks` 复查）。**内容**：弹幕重连熔断、`resolveDouyinLiveId` 三级回落、
  `updateTask` 变更即同步、`anchorName` 比对、web 移动端 nav、T-1 能力门控、T-3 弹幕选优、
  **T-24 快手取流修复(页面优先 + 递进退避,`0.0.38`)**。
  **验收**：重建 docker master + 更新 VPS worker 后，`pnpm test` / `typecheck` 全绿且线上生效；
  快手任务在干净出口能真正取到流（不再「等待开播」）。
- [~] **T-17 分区录制 A/B 对比（VPS1 vs VPS2）** — 2026-10-08 10:21 起：cookie 已复制到 VPS2；
  5 个房间（呆呆蒽/什么鱼/潘潘不困/yyoo/忘忧时枫）分到 VPS2 且**全开弹幕**，VPS1 保留 7 个（含任务 1）。
  每天 10:30 cron 自动分析 → `logs/split-analysis-YYYYMMDD.log`（`scripts/daily-split-analysis.sh`）。
  **验收**：明天对比两侧 .ts 数量/大小 + xml 空/满比例 + API blocked 频率 → 得出「哪台适合录视频、
  哪台能拿弹幕」的结论，据此决定弹幕是否必须收回家宽节点。

### T-17 明日检查清单（2026-10-09 10:30 分析时逐条核对）

- [ ] **两侧是否真在录**：`/api/tasks` 的 `recording` 有非空；`recordings/` 下 `.ts` mtime 是今天。
- [ ] **VPS2 视频**：`ts` 数与总字节较 12.5GB 基线是否增长（说明新分配的房间真在录）。
- [ ] **VPS1 视频**：是否仍为 `ts=0`。**若仍 0 → 新部署的均衡模式没解决它的取流问题**（P1 待查）。
- [ ] **弹幕成败**：两侧 `emptyXml` vs `fullXml`。预期 VPS2 视频有但 xml 全空 → 印证「出口 IP 被风控 →
  拿不到 liveId」。若 VPS2 也能拿到 full xml，说明 cookie 复制 + 均衡模式已解决弹幕（P0 结论反转）。
- [ ] **API 被禁频率**：`journalctl -u video-screenshot | grep -c "blocked"`。频繁 = 端点持续被风控。
- [ ] **liveId 是否拿到**：`grep "解析 liveId 失败\|拿不到本场 liveId"` 日志计数。
- [ ] **资源**：`free -h` 的 swap 使用量（持续接近满 = 956MB 内存不够）；`dmesg | grep -i oom`。
- [ ] **VPS2 稳定性**：`tailscale ping 100.115.69.88` 是否仍抖（公网 22 不稳但 tailscale 稳，属云侧问题）。
- [ ] **master 视角**：`/api/hub/workers/status` 三节点全 ok；`journalctl` 无「没有对应成员」幽灵 id 告警。
- [~] **T-12 抖音取流/弹幕切「均衡模式」（自动挑 api type）** — 见下。代码完成 + 本机/VPS1 实测通过；
  **待 VPS2 复测**（公网 SSH 超时，暂不可达）后并入 T-5 部署。
  - 自审发现①（真缺陷）：`getStream` 走 balance 时把 `webHTML` 留在候选里 → 它**恒返回 streams:0**
    （实测家宽/VPS 一致），选中必失败、白试一次。已修为取流 `exclude:["webHTML","userHTML"]`
    （与上游 `stream.ts` 强制 `webHTML→web` 同理）。**注意弹幕 liveId 路径相反**：那里 webHTML 可用
    （只要 id_str），故保留 —— 两处 exclude 不同是有意的。
  - 自审发现②（真缺陷）：均衡器把「不抛错但返回不可用结果」当成功 → VPS2 取流失败（`未找到对应的流`）。
    已加 `validate` 钩子（返回 falsy 即按失败处理、换下一个端点）。
  - 自审发现③（真缺陷）：上游 `getNextEndpoint()` 无参 → 单次调用可能重复选中同一失败端点。
    已加单次调用内去重（`tried` 并入 exclude）。
  - 自审发现④（认知修正）：`priority` **不影响选择概率**（weight 全 1 → 均匀随机；模拟 20000 次验证
    50/50，家宽实测 web7/webHTML3 印证）。真正影响概率的是 `weight`。所以「调 priority 让 web 优先」
    是无效操作 —— 要改概率得调 weight。本轮未改 priority。

## 待办（Next）
- [~] **T-97 0 落盘支持单个 side node,由 master 统一管理(issue [#331](https://github.com/fuyucn/douyin-rec/issues/331))** — 2026-10-20。**做什么**:策略放开为「恰好一个节点」;master 随任务下发上传元数据/账号键/凭证路径;节点写回执、master 轮询后写台账(幂等);节点能力位 `zero-disk:v1` 作闸门;master 控制台可见状态/拒绝原因。**为什么**:0 落盘只能占 master 本机带宽;节点规则目录为空会静默退回默认(私稿/默认标题),节点自写台账 master 看不到。**验收**:单 worker 可保存、多节点/烧录仍拒;节点稿件元数据与 master 规则一致(变异验证);回执在 master 台账出现且离线重连不丢不重;账号不一致/旧节点/元数据缺失明确失败;local 行为不变;全量测试/类型/打包通过。
- [~] **T-96 0 落盘弹幕 xml 每次启动覆盖上一份(issue [#329](https://github.com/fuyucn/douyin-rec/issues/329))** — 2026-10-20。**做什么**:xml 按每次运行独立命名,writer 打开时不截断已有非空文件(改名留存)。**为什么**:0 落盘 xml 是唯一落盘产物,覆盖不可恢复。**验收**:同房间连续两次运行两份弹幕都在;回归测试 + 变异验证;上线后实测两场两份 xml。
- [~] **T-89 0 落盘稿件状态按同场口径切分(issue [#293](https://github.com/fuyucn/douyin-rec/issues/293))** — 2026-10-20。状态只按房间键,同房间下一场会追加到上一场稿件。**做什么**:启动时按最后活动距今与 `SAME_BROADCAST_GAP_MS` 比较,超过则归档旧状态并新建稿件,不确定则拒绝并报错。**验收**:同房间间隔 61 分钟起新稿件、59/60 分钟续用、归档含未确认分 P 时保留并报错、状态损坏拒绝启动;有变异验证。
- [x] **T-85 0 落盘作为 rolling 子选项(issue [#285](https://github.com/fuyucn/douyin-rec/issues/285))**
  — 2026-10-19 完成。PR [#287](https://github.com/fuyucn/douyin-rec/pull/287)(三轮 review,末轮通过;`pr-risk-scan` = RISK,用户拍板合并)合并 `c888f334`;PR [#289](https://github.com/fuyucn/douyin-rec/pull/289) 恢复丢失的 CLI 接线合并 `d7c50582`,已部署 `0.0.192-7dc6a6`。
  **做了什么**:0 落盘从任务页独立开关迁到房间编辑的 rolling 子选项;core 唯一判定 `zeroDiskRuleError`「rolling + 无烧录 + 仅 local」;房间 / 任务 / hub 规则三条写入口共用,按生效房间与房间内全部 0 落盘任务校验;hub 同步下带 `streamUpload`,不再每个 tick 清掉;默认稿件标题带开播时分秒;新增 `test/arch/zero-disk-wiring-guard.test.ts` 守住 CLI 接线。
  **实测**:生产任务 85(测试直播间)rolling + local + 无烧录 + 真 0 落盘,`[状态] 录制中`,分块持续上传到 60MiB+;dispatch 前旧的 `10011` 消失。
  **遗留**:state 文件命名改为数字房间号,升级瞬间若有进行中的 0 落盘会话会起新稿件(本次部署时未开录,无影响);两个 worker 仍是 `0.0.189-dev`。
- [ ] **T-63 UPOS 直传 + 边录边传 PoC(T-63,计划 [plans/039_zero_disk_upload.md](plans/039_zero_disk_upload.md) 附录 A/B)**
  — 2026-10-17 起，分支 `codex/research-zero-disk-upload`（**未合并 / 未部署 / 未开 PR**）。
  **做了什么**：`packages/processors/src/upos-stream.ts`（自研 UPOS 直传：preupload/chunk/complete/submitStudio，不依赖 biliup CLI）+ `live-pump.ts`（每段一个 ffmpeg 管道，边录边传）+ 隐藏命令 `_live-pump <room>`。29 + 16 单测。
  **为什么**：用户目标「直播间直接出稿件，减少仅上传不需备份的空间占用」。
  **关键实测**：①容器必须用 **mpegts** —— matroska 写 stdout 带不了音轨、被 `-fs` 强杀不写 trailer → 缺 duration → B站拒（`62002`）；TS 每包自带 PTS，全过。②`complete` 接受**少传**（声明 N 块实传 M<N 个连续 part → `OK:1`），所以 `size` 是上界、分 P 大小=实际字节，「谁先到算一 P」（字节兜底 / 时长阈值）成立。③UPOS 单 P ≤ 2GiB，「一稿一 P」不可能。④preupload 有 **601「上传过快」限流**，是建会话频率问题：8×8MiB 触发 5 次退避、10 块连续 0 次。
  **修掉的真 bug**（均实测，变异验证）：①时长结算尾块被静默丢弃（3 段各丢 ~3 秒视频，日志只看块数毫无异常）；②`maxMs` 从未从 `pumpSegment` 下发；③缺 ffprobe 自检导致 `62002`；④四处文档承诺「回退文件上传」而代码没有（已补 `reuploadSpoolFile`）。
  **验收**：`pnpm test` **2935 passed / 42 skipped**、`typecheck`/`bundle`/`arch:check` 绿。真实直播间：单段 1P、多段 5P、断流 4P 均回读 `code=0`。
  **直播复核（2026-10-18）**：真实直播间完成 1P 与 2P 两轮私稿。1P：`streamedBytes == spooledBytes == 8771328`，22.071s，`usedFileFallback=false`；2P：两段分别 5,603,340 / 4,883,300 字节，14.002s / 12.370s，均无回退，服务端回读 2 个 cid。取流失败后的指数退避已补（5s/10s/20s…，上限 5 次重试）。
  **2026-10-18 单稿状态机**：新增 `LivePumpSession`：P1 完成即建稿、后续 P 完成即读取完整稿件后 `edit` 追加；每次不可逆请求前 fsync WAL，崩溃后按 `archive/view` 的 stem 核对，绝不再建第二稿；未确认 P 头阻塞；确认后才删 spool。单测覆盖建稿、连续追加、失败保留 spool、建稿/追加恢复、标题歧义、网络不可达与写盘失败。
  **真实单稿多分 P（2026-10-18，房间 <房间>）**：一次在线跑通 **同一稿件 5 个分 P**（`BV1xx`，aid `<aid>`，私稿）：P1 建稿后每段确认即追加，服务端回读 `partCount=5` 且 cid 各不相同；每段 2 块、约 16MB、时长 41~47s，`usedFileFallback=false`、`sessionLeaked=false`、`backpressured=false`；确认过的 spool 全部已删。
  **修掉的真 bug（真实跑出来的）**：续跑/恢复后 CLI 仍用本地段号 `index=seg` 提交 → 复用已确认索引、覆盖分 P 记录、新段 spool 泄漏（实测第 3 段未入稿且文件残留）。改为按会话已确认最大索引续号，并补回归用例。
  **互斥修复**：`record --stream-upload` 原本与普通录制会话并行（同一流被拉两次 + 可能重复建稿）。改为**替换**落盘录制器，且与 `--rolling-upload` 同开时直接 exit 2 拒绝。
  **断流验证（2026-10-18，房间 <房间>）**：强杀 ffmpeg 3 次，段1/段2 仍进**同一稿件** `BV1xx`（服务端回读 2 个 cid），证明断流后自动重取流并续同一稿件。
  **修掉的真 bug（断流跑出来的）**：web `edit` 连续追 P 命中 `code:21540 请求过于频繁` → 之前按「永久失败」处理，整个分 P 判失败并头阻塞后续分 P。已把 `21540` 纳入 core `isUploadRateLimited`，并给 `submitPart` 加指数退避重试（默认 60s 起、5 次、封顶 300s）。
  **断流 + 限流双重验证（同房间，修复后）**：强杀 ffmpeg 1 次，5 个分 P 全部进入同一稿件 `BV1xx`（`partCount=5`，5 个 cid），全部 `usedFileFallback=false` / `sessionLeaked=false` / `backpressured=false`，spool 全部清理。
  **未确认分 P 的恢复**：单条未确认且 spool 仍在时，按整文件重传再追加（`resubmitUnconfirmedPart`）；多条未确认或 spool 已丢仍转人工。实测遇到 B 站 `10010 稿件已锁定`（审核锁定）时**正确停手不丢数据**，spool 保留待人工。
  **接成任务开关（2026-10-18，`cc2c54f`）**：`streamUpload` 升为一等任务字段（DB/store/hub 同步/argv/Web 表单/API 门禁全链路打通），不再只能跑隐藏命令。互斥判定收敛到 core `streamUploadConflicts`（唯一一份，API + 表单 + argv 兜底共用）；`OutputFormatLock` 新增 `stream-upload`（0 落盘不产文件 → 格式无对象可作用）；登记实验性徽标（layer=task，观察 168h）。门禁：test **2944 passed / 42 skipped** + typecheck/arch:check/bundle/web build 全绿。
  **接开关后的真实实跑**：①`_live-pump --size 25MiB --segments 8` → 同一稿件 `BV1xx`，服务端回读 **8 个分 P**、cid 各不同，8/8 `usedFileFallback=false`/`sessionLeaked=false`/`backpressured=false`，spool 逐段删除。②走任务 argv 的 `record --stream-upload 1 --size 25MiB --sec 45` → 稿件 `BV1xx`，每段 ~17MiB/45s 证明**时长上限先到即结算**（字节未到 cap），与设计一致。
  **更正归因（2026-10-18，`221bfa4`）**：B11 把「第 1 段后静默停住」归因为「取流无超时」并不完整。真正根因是超时定时器 `unref()` —— fetch 永不返回时它是事件循环里唯一句柄，unref 后 Node 空转，`Promise.race` 永不 resolve，表现为进程存活/CPU 0/无 socket/无日志。已去掉 unref，并用**真子进程**回归（esbuild 打包后 spawn；vitest 自己持句柄测不出）+ 变异验证（加回 unref 即失败）。修后实测私稿 `BV1xx`（8.2MiB / 22.4s，无回退）。
  **弹幕 + 取流超时（2026-10-18，`2c70271`）**：0 落盘路径现在自己连平台弹幕，用同一个 `XmlDanmuWriter` 写会话级 `.xml`（唯一落盘产物；连接失败不阻断视频，`finally` 保证停源）。同时修掉本轮跑出的**真事故**：`acquireStreamWithBackoff` 直接 await `platform.getStream`，该调用可永久挂起（无超时）→ 第 1 段确认后静默停录、无重试日志、弹幕还在涨；现每次取流 30s 上限，超时/抛错都按失败退避。实测房间 <房间> 私稿 `BV1xx`：**5 个分 P 同一稿件**（5 个不同 cid，duration 190s，每段 ~45s 时长先到），spool 逐段删除，xml 含锚点与 `<d>/<member>`；修前同场景第 1 段后卡死，修后连跑 5 段。`pnpm test` **2948 passed / 42 skipped** + typecheck/arch:check/bundle 全绿。
  **生产路径验证（2026-10-18，`f532296`）**：隔离数据根起 `task serve`，走 API 建任务 + 启动，确认真实 spawn 的 argv 含 `--stream-upload 1`（非手工命令）；同次运行验证取流失败退避（抖音 `10011` → 5/10/20/40/80s，5 次后收尾）与弹幕 xml 落盘。另加 hub 边界 guard：0 落盘不产可扫描录像，绑成规则源会让 hub 永远选不到 winner → 房间编辑与任务改开关两个方向都回 400。
  **重启续录 + 孤儿 spool（2026-10-18，`793e433`）**：真实私稿 `BV1xx` 三次启动同目录，part 0→3 连续进**同一稿件**；kill 在段中途会留下永不清扫的孤儿 spool（实测 1.07MB），已在 app 层加启动清扫（processors 禁止列目录），删除条件 = 本模块命名 + 不在 state + 超 10 分钟宽限 + unlink 成功，任何异常不阻断启动。真实 CLI 日志确认孤儿被删、state 引用的 spool 全保留。
  **真 0 落盘（2026-10-18，`a71bff4`）**：审计发现此前「0 落盘」仍把每个字节 writeSync 到 spool（峰值占用=一个分 P），只是确认后删。现在 spool 可关：`full`（默认，可整文件回退 + 本地自检）/ `none`（真 0 落盘，失败无本地回退、必须显式报错）。接线到 core/DB/store/hub 同步/argv/API/任务弹窗；单测覆盖 none 模式不创建任何文件、字节仍全部上传、失败必须报错；真实 daemon spawn 已确认 argv 含 `--stream-upload-spool none`。另修：分 P 时长此前不读任务的 `segmentSec`，现在 `maxMs = --stream-upload-sec ?? --segment`（0/缺失 = 只用字节兜底）。
  **真实容器跑出的第二个 bug：0 落盘自行收尾被判崩溃（2026-10-19，B27，已修）**：容器实测 —— 6 次取不到流后 pump 正常收尾（`{"ok":true,"segments":[]}`，`exit 0`），但 TaskManager 判 `异常退出 (code=0 signal=null)` 并立即重启，每轮又烧 6 次取流尝试，形成 tight loop。根因：`expected` 只在 SIGTERM/SIGUSR2 时置位（`recorder-process.ts:199/208`），而 0 落盘**替换了落盘录制器、自己拥有进程**，自然退出时没有任何人置位。修：`code===0 && !expected && task.streamUpload` → 正常停止，日志 `0 落盘直传已自行收尾(exit 0)`。**刻意不放宽到全部任务**（普通录制进程只在停止信号时退出，其 exit code 不是它自己的结论；已加对照组用例）。门禁 test 3310/42 + typecheck 绿，变异验证过。
  **daemon→SIGUSR2 链路证据闭合（2026-10-19，B27）**：三段各有证据 —— ① daemon 窗口结束 → `manager.stopGraceful` → `status=draining`（`test/app/daemon.test.ts` 的 graceful drain 用例）；② `ChildRecorderProcess.stopGraceful` → `child.kill("SIGUSR2")`（`test/app/recorder-process.test.ts`）；③ record 进程收 SIGUSR2 → 不被杀、当前段传完（B26 容器实测：分 P 在传时发信号，进程 ALIVE）。唯一缺「同一次运行三层串起来」的观测：容器出口 IP 被抖音限流（`10011`，同容器手工跑也一样，宿主机 probe 正常）→ 取不到流就没有在录段，环境限制，非代码问题。
  **拆包 + 真实环境验证（2026-10-19，B26）**：0 落盘拆为独立叶子包 `@drec/zero-upload`（rank 0.35，只依赖 core + post-process），processors 仅 re-export；`biliupCookieHeader` 下沉 core 以免新包反向依赖 processors。容器内真实验证：真 0 落盘上传成功（`BV1xx`，盘上零视频文件）、多分 P 同稿（`BV1xx`）、serve 真实 spawn 参数正确、同房间 guard 生效、SIGTERM 正常。**SIGUSR2 排空**：分 P 在传时发信号 → 进程 ALIVE 未被杀（对照无 handler 时 exit 159）。验证中发现并修掉：排空不打日志（排空后可能等数分钟，与卡死无法区分）→ 补一次性留痕 + 断言。门禁 test 3308/42 + typecheck/arch:check/bundle 绿。**未覆盖**：daemon→serve→子进程链路的真实 SIGUSR2 端到端。
  **窗口结束排空 P1 修复（2026-10-18，B25）**：0 落盘分支此前只注册 SIGINT/SIGTERM，daemon 窗口结束发 SIGUSR2 → Node 默认动作杀掉进程（实测 exit 159）→ 在录的那段被腰斩（`spool=none` 下无本地副本，视频永久丢失），且 `stopGraceful` 发信号前已置 `expected=true`，task 日志反而打印「直播自然收播，排空完成」—— 与事实相反。修：`RunLivePumpOptions.drainSignal`（与 `signal`(= 腰斩) 职责分开，语义同 `record-engine.drain()`）+ cli 在 `runLivePump()` 前注册 `process.on("SIGUSR2")`。回归 9 条（4 排空行为 + 2 真子进程 + 3 grep 守护），三条变异验证都真的跑失败过。门禁：test 2987/42 + typecheck/arch:check/bundle 绿。**未覆盖**：排空落在取流退避 sleep 里会多录一分 P；未做 daemon→serve→子进程真实端到端。
  **审计收尾（2026-10-18）**：旧库迁移已补测试覆盖 `streamUpload`/`streamUploadSpool` 补列与默认值（旧库读出「关」+「保留 spool」，行为不变）。
  **真 0 落盘端到端（2026-10-18，`83ac51d`）**：缺口 1 已补 —— 容器内真实 ffmpeg + 假 B 站跑 `runLivePump(spoolMode:"none")` 2 段：同一稿件 `BV1xx`、`create`+`append` 各一次、**盘上视频文件 0 个**。顺带修两个真 bug：①`runLivePump` 没把 `fetchImpl` 传给 `LivePumpSession`，假传输在建稿处静默回落真实网络（拿到 -400），已贯通 + 回归用例 + 变异验证；②none 模式亚秒分 P 被 `Math.round` 舍成 0 → 判「缺 duration」判死，改为保留两位小数。
  **多房间并发（2026-10-18，`7a28ebc`）**：两个房间并发跑 `spoolMode:"none"`，各自 2 个分 P 进**各自稿件**（两个不同假 BV 号），state 按房间名分离，盘上零视频文件；回归用例做了变异验证（同 BV 即失败）。
  **hub 守卫补洞（2026-10-18，`d07a97c`）**：真漏洞 —— `createHubRule` 自己内联查任务存在性、没调 `ctx.recordingError`，于是 `POST /api/hub/rules` 能把 streamUpload 任务绑成规则源，造出永远选不到 winner 且无报错的规则。已改为复用唯一判定；三条写入路径（房间编辑 / 规则 PATCH / 规则新建）现在全部拒绝，无绕过入口。
  **录制相位标记（2026-10-18，`17435af8`）**：真缺口 —— 0 落盘路径不打 `[状态] 录制中/等待开播`，TaskManager 解析不到 → 任务永远显示「进程在跑但没在录」。已补标记（拿到流后打一次「录制中」）+ 回归 + 变异验证。另自查并否决一个疑似问题（`--output-format` 与 stream-upload 同给不会 exit 2，因流式路径先 return），改动已回退。
  **停止不留孤儿 ffmpeg（2026-10-18，`725a506f`）**：真缺口 —— 0 落盘路径在共享 SIGINT/SIGTERM handler 安装前就 return，停止任务时正在录的 ffmpeg 没人杀。已让 CLI 自装 handler 并 abort、AbortSignal 贯通到 runSegment，另对**已** aborted 的信号补显式 kill（addEventListener 对已中止信号永不触发）。实测 abort 后 `ffmpeg_procs=0`。
  **真 0 落盘在线验证（2026-10-18，房间 <房间>）**：缺口 1 已补。真实直播间 + 真实 B 站，`--stream-upload-spool none`：首次 10 个分 P → SIGKILL → 重启后续 6 个分 P，全部进**同一稿件** `BV1xx`；服务端回读 **16 个分 P**、16 个不同 cid、duration 356s、审核中；磁盘上只有 state + xml，**视频文件 0 个**。
  **hub 台账回流 + 停止不作废（2026-10-18，`61d2d72e`/`2f79acfc`）**：①新增 `recordStreamUpload`，0 落盘上传结果直接写台账终态（pending→done+BV），房间不再永远空转；修掉 `markDone` 覆盖已有 BV 的问题（B 站无删稿，覆盖会让台账指向无法撤下的稿件）。②在线 SIGTERM 实测 bug：停止切断末段时整个 run 报 `ok:false`，即使此前 4 个分 P 已入稿 → 退出码非 0 + 台账不写。已修（abort 归类 + 已入稿即成功）。在线验证 `BV1xx` 4 分 P/152s，`ok:true` + `台账已记录`。
  **多房间在线并发 + 21186 限流（2026-10-18，`<sha>`）**：两个直播间同时在线各跑 `none` 模式 → 两个不同稿件（`BV1xx` 3P/119s、`BV1xx` 3P/100s），各 3 个不同 cid，盘上零视频文件。同场暴露两个真问题：①`21186 投稿的频率过快` 未被识别为限流 → 第二个房间建稿被拒、已上传 6.3MB 直接丢弃、整场零产出（已纳入 `isUploadRateLimited`）；②preupload 限流退避完全静默（可超 40 分钟），形态与卡死无异，现已每次退避打日志。
  **同房间双 0 落盘 guard（2026-10-18，`<sha>`）**：实测风险 —— 同一房间两个任务各录一次，state 按 outDir 隔离互不知情 → 产出两个重复稿件（`BV1xx`/`BV1xx`），B 站无删稿 API 撤不下来。已在 `TaskManager.start` 挡掉（按平台+房间判；普通录制不受影响）。变异验证过。
  **同房间 guard 真实 serve 验证（2026-10-18）**：真实 `task serve` 进程里两个同房间 0 落盘任务，任务 1 `running=true`、任务 2 被拒停在 `stopped`，serve 日志打出「拒绝启动 id=2:同一房间已有 0 落盘任务 id=1(g1)在录,同时录会产出两个重复稿件且无法删除」—— 原因对用户可见。
  **下一步（接生产前必做）**：①`RollingUploader` 契约从 `path` 扩到 `bytes`（现 0 落盘完全绕过它）。②**接 hub 规则**需要先设计「上传结果如何回流 SyncLedger」（当前 streamUpload 只能当单机/手动任务，guard 已明确拒绝绑规则）。③`record --stream-upload` 目前不写 `会话状态边车` 边车（hub 按它聚场/选优），接 hub 前必须补。
  **纪律教训**：PoC 为二分调试新建 6 条测试稿件（本可全部 append 到一条），B站无删稿 API，清理代价由用户承担；并曾把「上传路径打通」误述为「链路打通」。

- [~] **T-61 全自动流水线 + fleet 式房间管理（计划 [plans/037_autopilot_fleet.md](plans/037_autopilot_fleet.md)）**
  — 2026-10-16 认领，2026-10-16 落 plan + 开工 step 1。主流程收敛为「监听 → 录制 → 投稿」，存档/烧录/多格式为默认关的增强开关。
  **拆分**：①人工收件箱去噪（issue [#188](https://github.com/fuyucn/douyin-rec/issues/188) → PR [#189](https://github.com/fuyucn/douyin-rec/pull/189)，已实现待审；顺带修了「所有节点断流」漏写 error 曾被显示成「待上传」）②通知带该场直链 + 收件箱按「真事故/增强」分组 ③`/rooms` 首页化 + 内联日志 + 任务/Hub/队列收进「高级」④配置模板（改一次应用到多房间）⑤新增房间自动选节点（已在录房间绝不自动迁移）。
  **进度（2026-10-16）**：①已合并（#189/#191，`needs_manual` 必带原因 + 房间列表不把正常收口判成需处理）；③除「`/rooms` 设为首页 / 导航瘦身 / `/hub/:key` 跳转」外已合并（#187/#193/#195，房间页功能 + 视觉 + 移动端 + 术语）；隔离 master 真实浏览器 UAT 已跑，发现项已修（#196→#198 编辑保存先校验后写入 + `workers:null`；#197→#199 添加即启动 / 立即刷新 / 状态行 / 链接 / 窄屏日志）。**待做**：设为首页 + 导航瘦身（用户暂缓）、②通知直链、④配置模板、⑤新增房间自动选节点；UAT 遗留：#200（回滚字段不全）、#199 review 的三处接线守卫 / 任务列表旧响应覆盖 / 状态行与交付列对「需人工且带 BV」口径不一（落点 `room-status` 与 `last-delivery`）、队列页与房间页同一房间名称口径不同。
  **验收**：默认口径为「录完就投、投完就删」；`needs_manual` 只剩真事故且必带原因；模板批量写回逐房间可见；全量 vitest / typecheck / web build 绿。

- [ ] **T-58 后处理插件化第一期复审遗留（PR #152/#154/#159/#169 的非阻塞项，2026-10-16 从 T-55 抽出）**
  — 第二期开工前须处理;逐条落点如下。
  - T1 复审遗留（PR [#152](https://github.com/fuyucn/douyin-rec/pull/152)）:符号链接逃逸 → 已在 plan T9a 落地（节点侧 realpath,已合并);`finish(cancelled)` 先经 `cancelOutcome` → 落点 plan 第二期 T15。
  - T1/T3 契约结论:`recover()=done` 不带 outputs → **T6 已决定不改契约**(入队时显式带 `outputs=[目标路径]`),无需后续动作。
  - T3 N3（PR [#154](https://github.com/fuyucn/douyin-rec/pull/154) 第二轮）:活动快照读取把所有异常吞成空快照,权限/只读异常时运行计数静默归零 → **第二期把 `running.biliup > 0` 接入部署 guard 前**必须改为只把「库/表不存在」当空,其余带 `error` 返回或抛给 `_node-status`;落点 `packages/proc-queue` 的 runner。
  - T3 N4（同上）:认领路径对已认领过的待执行取消行直接落终态,未经状态机 `canTransition` → 在 core 状态机补显式 reason(`cancel-before-rerun`)并让该路径断言;落点 `packages/core` 状态机 + `packages/proc-queue` store。
  - T3 遗留:存疑确认 / 重排目前只有 store 方法,**尚无 HTTP/CLI 入口** → 落点 `_proc-*` 隐藏命令或队列页;第二期补。
  - T6 审查遗留（PR [#159](https://github.com/fuyucn/douyin-rec/pull/159)）:第 1/2/4 项已由 issue [#160](https://github.com/fuyucn/douyin-rec/issues/160) 的 PR [#170](https://github.com/fuyucn/douyin-rec/pull/170) 修复并随 0.0.149 部署验收（**#160 本身仍 open,待其独立复核后再 close**）;第 3 项（回落进程内串行链不受通道限额约束,节点转封装并发可到 2）与第 5 项（前台运行仍走旧进程内链、无接管）**明确推迟到第二期**（PR #170 正文已写明）。
  - T9b ①（PR [#169](https://github.com/fuyucn/douyin-rec/pull/169) 第一轮）:低码率体积比误判（`MIN_SIZE_RATIO` 0.5 对纯音频/静态画面可能误报;原文件保留、有告警,行为安全）→ 落点 `packages/processors` 的校验函数,评估改绝对差或放宽比例。
  - T9b ②:hub 任务页不展示留存转格式标注（跳过/拒绝/回滚/缺边车/入队耗尽只在台账与 job 日志）→ 落点 `packages/web` 的 hub 任务页 + `GET /api/hub/queue` DTO 带出摘要。
  - T9b ③:转换失败后会话边车仍写着已转换容器标记（转换前就写;当前无害）→ 落点 `packages/processors` remux 失败路径回写,或改为转换成功后才写(须保持崩溃接管可判定)。
  - T9b ④:stage 交付模式 + 清 stage 开关时留存判定与实际不符（该模式从不执行清 stage）→ 落点 `packages/core` 的留存判定按交付模式取口径,并与清理共用同一判定。



- [ ] **T-50 水位配置注入的跟进项(#97 审查 LOW,不阻塞)** — 2026-10-15。三项:
  ① `serve.ts` 注入环境变量的分支只有源码文本断言 → 抽 `hubConfigEnvFor(src)` 纯函数并补行为测试;
  ② 不经 serve 直接跑 `task run`/`record` 时读不到 settings 表(会回落根文件)→ `buildSessionForTask` 手里有 store,可改调 `resolveHubConfig(undefined, store)`;
  ③ **hub 配置 JSON 若含 `cookies` 字段,经 settings/inline 来源会整份进环境变量,被子进程(ffmpeg/mesio/ssh)继承,同用户可从 `/proc/<pid>/environ` 读到** → 改为只传水位相关字段(如仅 `diskMinGB`)。③ 建议优先做。

- [ ] **T-38 CI 架构文档漂移守护恒红（issue [#11](https://github.com/fuyucn/douyin-rec/issues/11)）**
  — 2026-10-12 开票（incident）。**做什么**：让 CI 的架构文档守护能变绿。**根因**：CI 工作流用
  `actions/checkout@v4` 默认浅克隆（`fetch-depth: 1`），而架构文档生成脚本用 `git log --since="90 days ago"`
  统计每包近 90 天提交数当热图数据 → 浅克隆里每包只剩 1 条提交 → `--check` 恒 exit 1（全历史下通过）。
  **影响**：任何分支 CI 都无法变绿，门禁形同虚设，每次开 PR 都是红叉（#8 实现会话为此多花一轮定位）。
  **验收**：CI `Unit tests` 步骤全绿；不改生成物语义。**路线**：①（首选）checkout 加 `fetch-depth: 0`；
  ②生成脚本检测浅克隆时跳过热图维度并补测试。**归属**：改 CI 工作流属基础设施改动 → 按规则走
  `needs-decision` 等人拍板，agent 不自动 accept。

- [~] **T-32 分P 核验假 mismatch → 13 个 job 卡 needs_manual + 源不删(磁盘持续涨)** — 2026-10-10 实测发现。
  **根因(台账时间戳 + B站实查双向取证)**:`finalizeAfterUpload` 在**最后一个 append 成功后 0.5~0.6 秒**
  就去查 `view?bvid=`,而 B站 `pages` 列表此刻**还没同步** → 只看到 P1 → 判「期望3/实际1」→
  永久 `needs_manual` + 保留全部源。**上传其实全对**:实查 `BV1xx`=3 分P、`BV1xx`=2 分P。
  **影响**:13/61 个 job(21%)卡人工待办;每场源几个 GB 不删 → 磁盘持续涨;reconciler **不重跑
  `needs_manual`**(设计如此,防重传重复稿)→ 不会自愈。
  **修**:①核验前等 B站数据可见并重查(`verify.ts` 加带重试的最终一致:mismatch 不立刻转人工,
  间隔重查,稳定不一致才判 mismatch);②重试耗尽 → 判 `unknown`(软,可被 reconciler 补跑)**而非**
  `mismatch`(不污染待人工列表);③一次性重核工具,把假 mismatch 翻回 done 并正常删源。
  **验收**:复现竞态的测试(append 成功但 view 少一个分P → 必须重查到一致,不转人工);
  工具跑一遍后 13 个里「B站分P 实际够」的翻回 done、真故障(如 `68133201791` `rsync rc=12`)
  保持 needs_manual 不被误伤;`pnpm test`/`typecheck`/`bundle` 绿。
  **进行中**:2026-10-10 已定位根因,开始写复现测试。
  **已修**(`0.0.72`,**未部署**):①`verify.ts` 加一致性重查(5 次 × 3s 退避,稳定不一致才判 mismatch);
  ②**核验降级为非阻塞**(`DEFAULT_VERIFY_BLOCKING=false`):mismatch 只记录(台账 `clean_verify` + job.log
  + 一条「观察期仅记录」通知),**不再**转 needs_manual、**不再**阻止删源;`unknown` 不放宽(仍保留源)。
  开关单一(`verifyBlocksOnMismatch()`),传 `blocking:true` 即恢复旧行为。
  ③新增 `finalize-verify.test.ts`:核验真正的收口闸门 `finalizeAfterUpload` **此前无任何测试**
  (「核验阻塞删源」一直裸奔);新增 4 例,已验证改回 true → 2 例失败。
  ④一次性重核工具 `hub recheck-verify`(默认 dry-run):识别出 **2 个**可翻转
  (`347071634383:2026-10-11`、`63171491268:2026-10-11`),跳过 11 个非核验失败者。
  **观察期要攒的数据** = 「biliup 退出码 0 但 B站分P 最终不符」的真实发生率 + 重查耗时分布,
  攒够后用**真实分布**回答「要等多久」,再决定是否升回硬验收。
  **已查清(24h 内,无未处理真故障)**:`kuaishou:myhx123456789:2026-10-10` 与
  `douyin:391647909803:2026-10-10` 两个「error 为空」的 needs_manual = **`upload.mode=stage`**
  (只合成不上传,按设计如此;job.log 写明「stage 模式:合成完毕待人工上传」,`bv=null` 是正确结果)。
  → 我此前误判成「合并成功但没上传的故障」,已纠正。
  ⚠️ 附带发现(非故障,供知情):这两房 `burnDanmu/burnLivechat=false` —— 什么鱼 danmuCount=5637
  条**录到了但没烧进画面**,只落 `.xml`。若预期是「视频里有弹幕」,配置需改。
  **排查口径(2026-10-10 用户定)**:只查**最近 24 小时**;更早的一律不追(环境已变、价值低)。
  据此 `rsync rc=12`(`68133201791:2026-10-08_1157`,10/8,真故障)划到线外不再追 ——
  且该房间 10/09、10/10 均已正常 done(已自愈)。

- [~] **T-31 `/rooms` 完整替代 Tasks + Hub**(2026-10-10 用户定调:「新的 room 是为了替换掉 tasks 和 hub,
  必须做到完整更改时有效,如果没有提升就没有意义」)。**做什么**:把 `/rooms` 从「并存实验页」推进到
  「可替代」—— ①录/处理两半的**每个字段都能配**(对齐 CreateEditTaskDialog + HubRuleDialog);
  ②列表页具备**日常操作**(启停/排空/删除/新建),不只是看;③任何保存都**真的落库**(不得静默丢弃)。
  **为什么**:此前 `/rooms` 配不全(缺定时窗口/webhook/清理开关/标题模板/能力门控)、也没有启停入口,
  替代旧页会让用户「改不了、存不住」。
  **验收**:两旧页的每个字段在 `/rooms` 都能读能写;改任一字段保存后 `/api/rooms/:key` 读回一致;
  行内可完成启停/排空/删除/新建;`pnpm test`/`typecheck`/web build 绿。
  **进度**(`0.0.69`):审计出并修掉三处 —— ①**P0 静默数据丢失**:`hub-store` 整体替换 pipeline,
  改一个步骤会抹掉 cleanup/标题模板(已改深合并 `mergePipeline` + 2 个回归用例,验证「还原旧实现即失败」);
  ②**P1 静默丢失**:`PUT /api/rooms` 漏读 schedule,房间页改窗口存不进去(已成对写入/成对清空/半窗 400 +
  回归用例);③**P1 能力缺口**:面板补齐定时窗口/webhook/三清理开关/三标题模板/能力门控 requires,
  列表页加行内动作(启停/排空/详情/编辑/删除)+ 新建房间。真实浏览器验证保存往返 + 未提交字段不被抹掉。
  **剩余**:是否把 `/rooms` 设为主入口、旧页降为只读/重定向(**待用户拍板**,即原 T20 的 ①②③④)。
  **追加**(`0.0.71`,用户反馈「看不到 hub 的 workflows、队列进程」):补 **Hub 运行态半边** ——
  `RoomRunsPanel`/`RoomRunsDrawer`(**复用 Hub 的 `RunCard`**,不重写流程图)→ workflow DAG +
  运行记录 + job 日志 + 单节点重试 + 失败重跑 + 停止,行内时钟图标入口,推送驱动刷新。
  至此 `/rooms` = Tasks(录)+ Hub(配)+ Hub(看)。**仍未做**:跨房间的处理队列视图
  (现 `/queue` 页独有,「队列的进程」要并进来需再评估是否同页共存或合并)。
  **追加**(`0.0.183`,#265 / PR #266,2026-10-18):Rooms 补齐 Tasks 的只读展示项 —— 顶栏「已连接 · 时间」
  (共享 `ConnStatus`,房间拉取与任务轮询分别记录,任一失败即显示连接失败)、房间详情的账号开关/输出目录/
  开始与创建时间、边录边传会话进度(共享 `RollingProgress`)。**故意不做**:「显示未分配」仅 worker 节点有意义;
  Rooms 状态栏是房间级模型。待部署后实跑验证。

- [~] **T-30 hub/tasks 协作 + 编排/队列/多节点优化**(分支 `feat/hub-optimization`;M1 进行中) — 计划 `plans/030_hub_tasks_optimization.md`
  (结构化任务 `plans/030_tasks.json`,唯一执行源;20 任务 / 8 组件,plan-loop 校验 ok)。
  **来源**:2026-10-09 用户三轮提问(队列/workflow 不实时、hub 与 tasks 是否融合、编排/队列/多节点优化)
  + **7 轮独立 principal-engineer 评审**(score 55 → 56 → 58 → 72 → 70;循环 11 次、blocking 6 项 / major 21 项
  逐条修完,末轮 file-level 自检 0 blocking 0 major)。评审台账:`/tmp/opt-plan/ledger.tsv`(过程记录,不入库)。
  **做什么**:①控制面安全阀(审计快照 + 骤减守卫 + force + 禁用≠删除);②SSE 实时状态(替换 3s 轮询,
  去竞态、本地计时、过期提示);③跨房间非阻塞派发(同房间串行、不重复建稿);④上传冷却跨重启持久化
  (master + 节点侧共用);⑤统一房间入口 `/api/rooms`(低风险版:既有 Hub 页内联 + 房间级动作,不新建页/不退役旧入口);⑥按**实际提交段数**
  核验分 P 再删源 + 清理可重试;⑦孤儿/空壳维护清理;⑧短命录制熔断;⑨并行度可配。
  **为什么**:近期实况已暴露数据丢失(节点任务被清空)、产物丢失(什么鱼 livechat 分 P)、
  状态失真(队列卡顿)、节点重连风暴(1650 次)四类问题。
  **验收**:master 配置不可读 → 节点任务一条不减;SSE 1s 内同步;后一场收播的 job 行立即可见;
  冷却跨重启保留;`PUT /api/rooms/:key` 一次改两半;分 P 不符不删源;短命录制退避递增。
  全程 `pnpm test`/`typecheck`/`bundle`/web build 绿 + 架构图一致 + 每个 `feat|fix` bump version。
  **取代** `plans/029` 的 P0/P2/C 工作(029 保留为历史;D4 内存决策仍未决)。
  **进度**:**M1 全部完成**(`0.0.50`,待部署验证):T1 节点审计快照 / T2 期望骤减安全阀 + force 通道 /
  T3 删除语义收敛(禁用≠删除)/ T11 产物完整性核验 + 延迟删源 / T12 清理独立化(可重试、失败不影响终态)/
  T13 孤儿与中间产物维护清理(可预览可审计)/ T14 录制健康(有效落盘判成功 + 短命录制熔断)。
  **M2 进行中**:`0.0.52` 已完成 T4(SSE 端点)、T5(队列读取批量化)、T6(前端推送驱动 + 过期提示 + 本地计时)、
  T7(非阻塞派发)、T8(上传冷却/滑动窗口跨重启持久化)、T9(统一房间 API)、T10(Hub 弹窗内联录制配置)。
  **用户最初报的「队列/workflow 卡卡的、不实时」到此闭环**:推送服务端(T4)+ 前端消费(T6)两侧都到位。
  `0.0.53` 追加 T17(录制侧状态实时化:状态变更主动推 SSE + 远端状态带「N 秒前核对」+ 探测周期自适应 2s/10s)、
  T19(节点侧上传共用持久化 601 冷却,判定下沉到 @drec/core 单一实现)。
  `0.0.54` 追加 T15(资源并行度可配 + **立即生效**:新增设置页「资源」页签,写回 master **实际在用的那份**
  hub 配置,内联 JSON 时明确 400 而不是假装保存成功)。
  `0.0.55` 追加 T18(房间级动作:排空 / 立即停止(二次确认) / 立即处理 / 重试清理,全在既有 Hub 房间详情)。
  **M1–M3 全部完成**;仅剩 T16(已 defer)、T20(需你确认需求反转后才立项)。
  其余任务见 plans/030_tasks.json 的 status 字段。
  跨任务审计抓到:子 agent 全局字符串替换导致 `openLedger` 自调用无限递归(局部测试全绿、全量崩 2 例)——
  教训:**局部跑通 ≠ 全量通过**,跨 agent 改同一批文件时必须以仓库根全量为口径。
  T19 落地后的跨任务审计又抓到:`UPLOAD_FAILCLOSED_MS` 的 30min 在 core 与 ResourcePool 各写一份,
  改一处不会报错、只会让两条路径的 fail-closed 悄悄分叉 → 已改为单一引用。
  M1 跨任务审计:核验接缝 `countParts` 由 cli 注入(orchestrator 不 import app,分层测试过);
  `clean_verify` 在 core/web/前端文案三处都已接上;xml「不得删最后一份」判据落在 orphan-cleanup 的
  非空副本索引上;T13 只动了 server.ts 的路由段,未覆盖 T2 的 `POST /api/hub/apply`。
  T2 自审修复记录:①TDZ(守卫引用未初始化的 upsert/writeSnapshot)→ 移到 upsert 之后、快照抽 `writeSnapshot`;
  ②空期望分支曾先跑「只停用」→ 「一个没删却全被停用」,比原 bug 更隐蔽 → 判定/执行按分支隔离;
  ③force 在同步在途时被合并丢失(用户点「强制应用」没反应且 master 侧无痕)→ 抽 `SyncGate` 累积标志 + 6 用例;
  ④`SyncGate` 化后 stop 未 unbind → 停机后请求打到旧 runner → 补 `unbind()`;⑤骤减阈值曾用严格小于,与 plans/030
  定稿(≤ floor(n/2))不一致 → 回归计划口径并加「下一轮真删」的收敛用例(证明不卡死)。
  **分四个里程碑发版**(避免大爆炸):M1 止血(T1-T3/T11-T14)→ M2 实时与吞吐(T4-T8/T15/T19)
  → M3 房间入口**低风险版**(T9/T10/T18:在既有 Hub 页一处配完 + 房间级动作,**不新建页/不退役旧入口**)
  → M4 可选/需确认(T16 运维可见性按需;**T20 完整单页合并属需求反转,需你确认后才立项**)。
  评审中据实下调了两处预期:T7 只交付「job 行立即可见 + net/upload 与 CPU 重叠」(`maxCpuParallel` 仍 1,
  merge/burn 依旧串行,真并行需 D4);房间入口改为在既有 Hub 页内联,风险与返工显著降低。

- [!] **T-26 节点韧性 + 房间配置统一 + 队列并行度** — 计划 `plans/029_room_config_and_resilience.md`(实施计划)。
  **来源**:2026-10-09 三轮审计 + 用户讨论。结论均以真实台账 + 实测验证(plan §9 附复现命令)。
  **三组工作(按优先级)**:
  - **P0 节点韧性(🔴 数据丢失)**:master `config/hub/` 丢失/不可读 → `listHubRules` 把「读不到」当「没有」
    → `desired=[]` → `applyRemoteTasks` **两阶段删除** → **所有节点受管任务被清空**(实测复现:第1轮停用、
    第2轮删除、剩余 0);节点**零规则副本**。**修**:① 期望状态副本(`config/managed/rooms.json`)
    ② 期望骤减安全阀(空期望拒绝 / 骤减只停不删)③ 删除改**显式意图**(缺席只停用)。
  - **P1/P2 配置统一(🟡)**:房间配置分两处(task + hub 规则)。历史 `6636952`(2026-06-29)显示是
    **按当时用户要求**拆的 → 需求反转,非设计事故。**目标**:一个房间一份配置(record/process/place),
    一个入口配完。分 Phase 1(清死代码 + 弹窗内联录制配置)→ 2(统一 `/api/rooms`)→ 3(合并存储,可选)。
  - **C 并行度(🟡)**:实测**单次 burn 只用 5.3/11 核(48%)**;`maxCpuParallel` 默认 1 且 **UI 改不了**;
    内存闸门 2048MB 卡住第 3 位(容器仅 4GB)。**注意**:7 天 burn 仅 5.6h → 提并行度**削峰不提吞吐**。
  **明确不做**:worker claim/lease 队列(Fleet 54 个 `.rs` 中 queue/claim/job/task **零命中**;
  房间是常驻监控,非一次性 job)。
  **⚠️ 阻塞原因**:4 个决策待裁决(plan §2 D1~D4)。**推荐**:D1=是(韧性最先)、D2=显式删除、
  D3=先做 Phase 1+2、D4=需你提供 master VM 配额能否调大。
  **解除条件**:用户答复 D1~D4 → 按 P0 → P1 → P2 →(可选 P3)+ C 组推进。

- [~] **T-18 节点侧上传（experimental:不烧录房间跳过 rsync 回传）** — 计划 `plans/027_node_side_upload.md`。
  **本轮施工（2026-10-11）**：用户要求「把分P 无烧录的全改成节点上传,然后测试」。范围 = 9 个
  `mergeSegments=false` + 不烧录 + `mode=upload` 的房间全开 `steps.nodeSideUpload`。
  开做前先修节点侧既有缺陷：**删最后一份 .xml**、`{title}` 渲染空、`partTitleTemplate` 被忽略、
  失败不落 `sync_node_states`（会无限重试 → 重复投稿风险）、缺 `minSegmentSec` 碎片过滤、
  `startMs` 用节点当下时间（命名漂移）、能力探测对 `DOUYIN_REC_ROOT` 未生效导致 cookie/cookies 判定错误。
  **2026-10-11 实测（真实直播 task 79 = douyin/249293641318，VPS1+VPS2 双录）**：
  首跑**卡住**——节点侧产物落到 `<cwd>/output-data/stage`（错根）而非 `<root>/stage`，
  `限流库 <cwd>/output-data/db/douyin-rec.db` 父目录不存在 → `openUploadLimitStore` 打不开 →
  UploadGate **fail-closed 静默冷却 30 分钟**。**根因**：`applyNodeDataRoot` 曾写
  `process.env.DOUYIN_REC_ROOT = drecRoot()`，而 ssh 会话 env 为空时 `drecRoot()` 回落默认根
  `./output-data`，把数据根错设。**修复**（0.0.76）：入参 `dataRoot` 才是权威，直接绝对化写进 env；
  另 `openUploadLimitStore` 主动 `mkdirSync` 父目录（消除同类静默失败）。两处均补测试。
  修复后自审另发现**渲染上下文静默丢失**：`NodeSideUploadArgs.earliest` 声明成
  `{ rec: { n?: string } }` 却读 `o.earliest?.rec.n`，真实字段是 `NodeRecording.sessionBase` ——
  因 `n?` 可选故 TS 不报错，`sessionBase` **永远不下发**，节点侧退回按文件名推 base，
  `{title}` / `{HH}-{mm}-{ss}` 与 master 常规路径**漂移**。**修复**（0.0.77）：改用
  `rec.sessionBase`；`pipeline.ts` 两处重复的 `earliest` reduce 合并为一份口径；新增
  `test/orchestrator/node-side-upload.test.ts` 钉死三个渲染字段。
  **修复后复测（VPS2 节点本地实跑 `_node-pipeline`）**：产物落**正确根** → 建稿
  `BV1xx`（「Lilt_2026-10-12 直播回放」）→ 逐条 append P2/P3/P4 → 源 `.ts` 清理、
  **`.xml` 保留**（最后一份）、`.upload` 别名清理。**全链路通过**。
  **2026-10-12 复核（线上台账 + 两节点实测）—— 自动化路径仍全败 + 发现删源/清 stage 漏网**：
  ① **两次自动跑全失败**（`sync_node_states` 两条 `upload_plain=failed`）：test room/Lilt 那次是
  **VPS2 跑的是 pre-0.0.76 旧 bundle** → `applyNodeDataRoot` 错根 → 限流库 `output-data/db/…`
  打不开 → ssh rc=255；`douyin:347071634383:2026-10-12_0523` 那次 winner 是 **VPS1 0.0.75**
  （同样错根）→ 产物落 `~/output-data/stage/…`、`ssh rc=1`。**根因都是没部署到 0.0.76+**。
  唯一成功的仍是**手动** `_node-pipeline`（某个 worker，`BV1xx`，private 4 分 P）。
  ② **删源漏网（本轮修复）**：节点侧路径**提前 return**，`runPipelineInner` 走不到常规
  `cleanupSources()` ⇒ `transport.cleanup` 永不调用 ⇒ 节点 `recordings/` 的 `.ts` 永远不删。
  实测残留：VPS1 `~/output-data/` 5.8G（错根 stage + db）、VPS1 `~/drec/stage/douyin_32353809778_2026-10-11/`
  434M、VPS2 `~/drec/stage/douyin_249293641318_2026-10-12/` 3.4G（mp4 + `.work/` 双份）。
  **修复**：`node-side-upload.ts` 在 `markDone` 后调 `cleanupSourcesShared`（与 master 常规路径
  **同一份删源实现**，按**全部在场成员**含落败节点，`keepNodeXml:true`）；失败写
  `sync_node_states(upload_plain)=failed` → reconciler 走 `UNSAFE_RETRY_NODES` 转人工，**绝不自动重传**。
  ③ **自审发现（删最后一份 .xml）**：`xmlKeepRule("node", stageAfterDone=false)=true` 的前提是
  「stage 里有 pull 来的 xml 副本」，而节点侧**从不 pull xml** ⇒ 照搬会删掉**唯一一份**弹幕。
  已在 3 处按「节点源 xml 恒为最后一份」收紧：`keepNodeXml:true`、`nodeStageCleanupTargets` 不带
  `deleteXml`、`app/node-pipeline.ts` 源清理只删 `.ts`。新增 `test/orchestrator/node-side-upload.test.ts`（5 例）
  + `nodeStageCleanupTargets` 3 例 + `pipeline.test.ts` 2 例钉死。
  **待办**：部署 0.0.78 到 **master/VPS1**（VPS2 已部署，2026-10-12；master 有 task 74、VPS1 有 task 35 在录，
  受部署 guard 阻塞，等空闲），再实跑一场验证「自动建稿 + 删源 + 清 stage」。
  **手工清理已完成（2026-10-12，用户授权）**：VPS1 `~/output-data/`（错根 stage+db，5.8G）+
  VPS1 `~/drec/stage/douyin_32353809778_2026-10-11`（434M）+ VPS2 `~/drec/stage/douyin_249293641318_2026-10-12`（3.4G）；
  删前确认这些路径内 `.xml`/`.ass`/`.ts` 为 0（只剩 mp4 + `.work` + db）→ 不触「最后一份弹幕」口径。
  **本轮施工（2026-10-12，0.0.79）—— 修「假失败」+ 删源漏网的另一半**：
  **缺陷**：`_node-pipeline` 是**长命令**，ssh 可能在节点**跑完上传之后**才断开/超时。实测两条台账
  全是**假失败**：`douyin:249293641318:2026-10-12`（`rc=255`，VPS2，稿件其实已建好 private/4 分 P）、
  `douyin:347071634383:2026-10-12_0523`（`rc=1`，VPS1）。旧实现只在 catch / `!result.ok` 里**无条件**
  `markFailed` → ① 台账/UI 误报；② **收尾删源永不执行** ⇒ 落败/winner 节点源 `.ts` 永久泄漏
  （实测 VPS1 `~/drec/recordings/Lilt/` 4 个 `.ts` 约 1.8G 残留）。
  **修复**：节点侧把结果**落盘** `<root>/stage/<sanitizeStreamKey>/.drec-node-result.json`
  （`phase`=uploading→done→failed，上传**前**先落 `uploading`）；master 失败时经隐藏命令
  `_node-result <dataRoot> <streamKey>` **回读权威结果**，统一收口 `handleNodeFailure`：
  - `done`+bv → **其实已成功** → `markDone` + 与成功路径**共用** `finalizeNodeSuccess`（`cleanupSourcesShared` 删源）→ `done`；
  - `uploading` / `done` 无 bv / `failed` 带 bv → **结果不确定** → `needs_manual` + 写 `sync_node_states(upload_plain)=failed`，**绝不自动重传**（重复投稿不可逆）；
  - `failed` / `null`（确认没成）→ 原失败路径。
  另加**幂等护栏**：`ledger.bv` 已存在 → 直接 `needs_manual`，节点侧绝不重复建稿。
  收尾实现收敛为单一 `finalizeNodeSuccess`（成功路径与假失败回读共用），消除「一条分支删源、另一条忘了删」的漂移。
  **测试**：`test/orchestrator/node-side-upload.test.ts` +7 例（假失败回读四态 + 两条失败分支共用收口 + 回读抛错保守）；
  `test/app/node-pipeline.test.ts` +6 例（结果文件往返/损坏/空态/上传前 uploading/failed 带 bv）；
  `test/cli/node-pipeline-commands.test.ts` +1 例。全量 `pnpm test` 1219 通过、`pnpm typecheck` 通过、`pnpm bundle` 出 0.0.79。
  **2026-10-12 收尾复核（本机 master 0.0.76 + VPS1 0.0.75，均为 pre-0.0.79）——「播种假录像 + jobs/run」实测全链路**：
  用 `runNow` 跳过 settle/断连窗，对**已在盘录像**直接点火后处理，无需等真收播：
  `POST /api/hub/jobs/run {streamKey}`。本次对 test room 249293641318 的**真实残留**（VPS1 Lilt 1.8G
  4×`.ts`，即缺陷 A 的现场）点火 → 节点侧 remux 4 分 P → 上传成功 → 台账 `done` + **`BV1xx`**（private）。
  **证实「节点侧上传」功能本身 OK，但 pre-0.0.79 的 master 不跑收尾清理** ⇒
  ① VPS1 `recordings/Lilt/*.ts`（1.8G）**未删**、节点 stage mp4 4 个（1.8G）**未清**；
  ② `sync_node_states` 行**陈旧**（仍 `upload_plain=failed`，与新 `done` 不一致）；
  ③ 节点 stage 落 `~/output-data/stage/…`（master 绝对 `stageDir:/output-data/stage` 被原样下发，
  节点上不存在 → 相对 HOME 落错根）。**三项均已含在 0.0.79 未部署的 diff 里**
  （`finalizeNodeSuccess`→`cleanupSourcesShared` 删源；`node-pipeline.ts:395` 节点本地 stage 回落）。
  **结论**：无需再等真收播验证 —— 用「播种假录像/复用残留 + `jobs/run`」即可随时回归节点侧上传；
  部署 0.0.79 后再跑一次同一场，预期 ①②③ 全部消失。
  **streamKey 口径备忘**：`streamKey = {platform}:{roomSlug}:{yyy-MM-dd}`（同日同房间多簇加 `_HHMM`），
  日期用 **config timezone（Asia/Shanghai，已覆盖 host env，启动日志有 `[tz]` 行）**，**不是 host TZ**；
  `jobs/run` 传**裸 base key** 会按同日前缀匹配多个簇并取 startMs 最新者，故点错场不报错要当心 ——
  精确点火请用 reconciler 日志里那串**带 `_HHMM` 的完整 key**。
  **做什么**：hub 规则加 `pipeline.steps.nodeSideUpload`（缺省 false）。为 true 且**该房间不烧录**时，
  winner 节点本地 remux → 节点 biliup 直接上传，master 只收 BV 号，**省掉整场录像 rsync 回传**。
  **⚠️ 2026-10-09 收益复核（真实台账 + 实测带宽，见 plan 文末「收益复核」）—— 原估算偏高**：
  ① T-18 只覆盖**总 pull 字节的 30%**（48GB/157.5GB，7 天）；② pull **不占端到端关键路径**
  （`maxNetParallel=1` 但实测净闸门并发度仅 **0.10x**，几乎不排队）→ 省 8h ≠ 快 8h；
  ③ 实测 master **下行 26Mbps / 上行仅 12Mbps** → 省的是「上行那一半」（约 24GB），不是全部；
  ④ **发现更大更便宜的目标**：local winner 的 pull 是**同盘 `copyFileSync`（7 天 51GB > 48GB）**，
  修法只是硬链接/跳过拷贝，零协议改动。
  **建议**：先做「local winner 硬链接」；T-18 若要做得**只做最小版**（就地 remux+上传，不做
  `_node-capabilities`/节点侧状态机）并只开 1 个房间；完整版暂缓。**待用户决策**。
  **验收**：见 plan 验收清单（flag off 零回归 / flag on 不烧录实测无 pull 步 / 缺能力回落不静默）。
- [~] **T-19 worker 安装脚本补 rsync 硬依赖** — ② **已完成(2026-10-08)**:`transport-ssh.ts` 的
  rsync 失败现带 stderr 尾部(新纯函数 `summarizeRsyncStderr` 丢弃进度行、留真错误、限长),错误形如
  `rsync rc=12: rsync: command not found(host:remote)`;+4 测试。① **待办**:合并 T-5 部署后
  **重建/重装 VPS** 验证 `install-worker.sh` 的 rsync 硬依赖 fail 行为。
  **背景**:2026-10-08 vps2 缺 rsync → 每场 pull `rc=12` → 后处理全卡 needs_manual,
  错误只报退出码无 stderr,排查成本极高。
- [x] **T-22 app 解耦 1–4 步(api.ts 拆域 / 修反向依赖 / tui 归位 / serve 归位)** — 2026-10-08 起。
  **背景**:T-21 原计划「先拆 web/ 成独立包」经复核**是错的** —— `web/api.ts` 值导入 12 个 app 模块
  (hub-store/hub-jobs/worker-store/store/scheduler/task-input/timezone/paths/version/upload/biliup/
  task-manager/merge-jobs),拆包必成 `@drec/app ↔ @drec/web-server` 循环,layering 测试必红。
  故改为**先拆文件、修反向依赖**,拆包(T-21 第 5 步)留到最后且可能不必做。
  **四步**(每步独立提交 + 全量验证):
  1. `app/src/web/api.ts`(1321 行,`makeApi` 单函数 909 行、51 方法)→ 按域拆 `web/api/*.ts`:
     tasks / hub-rules / hub-jobs / workers / cookies / settings / login / merge / events。`makeApi` 只做组装。
  2. `parseCookieExpiry` 从 `web/api.ts` 下沉(命令层 `cli-task.ts:674` 反向 import 了它)→ 消除反向依赖。
  3. tui 启动从 `app/cli-task.ts:813` 挪到 `cli` → 断掉 `app`(L4) → `@drec/tui`(L0) 的怪依赖。
  4. `serve` 命令从 `app/cli-task.ts`(508..805, 298 行)挪到 `cli` → 命令定义回归 cli。
  **验收**:`pnpm test`(现 119 个 web-api 用例 + 16 个 web-server 用例必须全绿)/ `typecheck` / `bundle`;
  `test/arch/layering.test.ts` 通过;`pnpm arch:gen` 重新生成架构图。**纯重构,行为零变更**。
  **完成(2026-10-08)**:
  - 步 1:`web/api.ts` 1321→45 行(纯组装),拆出 `web/api/{types,context,tasks,cookies,hub-rules,hub-jobs,workers,settings,merge,login}.ts`
  - 步 2:`parseCookieExpiry` 下沉 `app/cookie-utils.ts`,断掉 命令层→web 反向依赖
  - 步 3:`task tui` 挪到 cli,app 移除 `@drec/tui` 依赖(依赖边 27→26)
  - 步 4:`task serve` 命令定义回归 cli,运行时装配抽到 `app/serve.ts` 的 `runServe()`;
    `app/cli-task.ts` 878→约 560 行
  - 自审修复:重复常量 `DEFAULT_COOKIES_KEY` 去重(删新 consts.ts,统一从 login-manager 导入);
    删除 types.ts 残留死代码 `sanitizeSeg`
  - 验证:`pnpm test` 869 passed / typecheck / bundle / `task serve` 实测起服务 / `task tui` 在
  - **审计(2026-10-08,逐项实测,非自述)**:53 handler 函数体逐字节一致 / 域间零互相 import /
    serve 装配体与拆分前一致(仅多一行注入)/ tui·serve 命令定义一致 / 命令树完整 /
    app 对外导出仅 +3 行无删除。审计发现并修复:`sanitizeSeg` 多余暴露在 ApiCtx → 改私有。
- [ ] **T-21 拆分 app「上帝包」**(架构/认知税) — **问题**:`packages/app` 是 7215 LOC / 30 文件的
  单一包,同时承担 ≥8 个不相干职责:sqlite store、任务调度 daemon、子进程生命周期、hub 规则文件 CRUD、
  hub 台账读取、扫码登录(3 平台)、**web HTTP API(api.ts 1321 行,单个对象 51 个方法)**、biliup 上传、
  TUI 启动、时区、路径。它还是全仓依赖最宽的包(7 个 @drec + 5 个第三方)。
  **证据(2026-10-08 实测)**:见 `docs/architecture.html` 热图 —— app 与 web 并列改动热点(各 34 次/90 天);
  `app/src/web/` = 2005 行、`app/src/login/` = 686 行,均为**内聚、可独立**的子域。
  **另**:`app`(L4)依赖 `@drec/tui`(L0)只为 `cli-task.ts:813` 一处动态 import;
  `app` 里还有 `new Command("task")`(命令定义本应属 cli)—— 两个跨层味道。
  **建议顺序**(每步独立可验证):① 拆 `web/` → `@drec/web-server`(api+server+static);② 拆 `login/` →
  `@drec/login`;③ hub 领域(`hub-store`/`hub-jobs`/`worker-store`)考虑挪到 orchestrator 或独立包;
  ④ `cli-task.ts` 的命令定义回归 `cli`。**验收**:每拆一个包 `test/arch/layering.test.ts` 的 RANKS 登记 +
  `pnpm test`/`typecheck`/`bundle` 全绿 + 架构图重新生成。**注意**:纯重构,行为零变更。
- [ ] **T-16 节点「主动加入」+ ticket 机制**（架构级，暂不做） — 现状：master 主动 SSH 拨 worker，
  加节点要手填 host/dataRoot（id 现由 T-15 改为节点自报）。**要做的是 biliup Fleet 那套**：worker 侧
  `task join <ticket>` + master 签发一次性票据（+ 节点私钥）+ 节点主动连 master（可穿 NAT）+ ticket
  校验/撤销。**为什么暂不做**：需引入 master↔worker 常连控制通道（新协议 + 新状态），架构级改动；
  当前 tailscale 组网下 SSH 方案可用。**触发条件**：① 要频繁加节点；② worker 在 NAT 后 SSH 不可达；
  ③ 需要在线态/心跳实时性。**参考**：biliup Fleet（控制面/节点/relay,ticket 加入,私钥鉴权）。

- [ ] **T-6 docker tailscale 版本升级** — sidecar `1.98.4`（落后 5 个月），其他节点 `1.104.1`。
  `docker compose up -d --build` 不会拉新镜像，需 `docker compose pull && docker compose up -d --build`。
- [ ] **T-7 清理 VPS1 exit node 残留** — VPS1 曾 `advertise-routes 0.0.0.0/0`，健康检查报
  `IP forwarding is disabled`；Mac 侧已恢复家宽。**验收**：撤销 VPS1 的 advertise（`--advertise-exit-node=false`）。
- [ ] **T-8 轮换/清理 tailscale auth key** — 用户先后贴过两个 key，`kbnba6Qh4…`（带 tag）已弃用，
  `k6mrGoiS…` 在用。**验收**：旧 key 在 tailscale 后台撤销。
- [ ] **T-9 VPS2 弹幕 0 条深挖** — 干净 IP 仍 0 条，非纯 IP 因素（docker 同代码同 cookie 有 9109B/25 消息，
  VPS 首帧 286B/0 消息/`needAck=false`）。**验收**：定位 wss 层被拦的判定条件。

## 未来 / Backlog

- [ ] **T-31 角色模型重构：standalone / controller / node 三态**(2026-10-10 记录,待用户确认后立项)
  **问题**:现在只有一个 `--hub` 开关(hubEnabled),把「有没有控制台」和「本机是否录制节点」耦合在一起。
  导致单机用户也会看到「Worker 列表里只有一个 local」这种无意义概念 —— 单机场景根本不该有「节点」这个说法。
  **现状三种真实场景**:①**单机**(录+处理+上传全在本机,不需要节点) ②**controller**(只管编排,自己不录)
  ③**node**(纯录制,等下发)。目前 ①③ 都能跑,但 ① 的 UI 被迫显示节点概念。
  **期望**:引入 `role: standalone | controller | node`。standalone 的 UI **完全不显示节点/Worker 概念**;
  controller 显示节点管理/队列/选优;node 保持现状(无 Hub 页)。
  **触发条件**:/rooms 页(T20 第 1 步)稳定后,用户确认要做。
  **关联**:T-30 的 c5(hub/tasks 协作)。**不排期**。
- [ ] **T-2 负载分摊（placement / 按负载自动选点）** — 计划：`plans/026_worker_load_placement.md`。
  **注意**：与现有「多节点冗余录制 + coverage 选优」模型**二选一**（分摊=每房间派 1 台），
  属模型取舍，不是可顺手加的功能。**为什么**：冗余模型把轮询量乘了 N，是 VPS 被限流的根因之一。

## 已完成
- [x] **T-93 0 落盘下播后进程不再 code=1 退出重启循环(issue [#308](https://github.com/fuyucn/douyin-rec/issues/308))**（2026-10-20）
  — PR [#319](https://github.com/fuyucn/douyin-rec/pull/319) 已合并(0.0.207,独立 Opus 审查 2 轮:第 1 轮 FAIL 已修,第 2 轮 PASS;CI 绿;`pr-risk-scan` = RISK,owner 预授权合并)。未部署,生产确认待下次部署。
  **做了什么**:0 落盘 `waitForBroadcast` 在打开稿件会话前留在进程内每 30s 探测,停止/排空才结束(`idle` exit 0);同场判定移到开播时刻;有可补传的未确认分 P 时等待前先恢复;弹幕开播后才连;TaskManager 重启耗尽后 daemon 冷却 10 分钟不自动拉起(手动启停清除)。经验回写 AGENTS.md「任务系统」段。
  **遗留**:冷却日志在「手动启动后再次放弃」时可能少打一条;开播后的退避睡眠不响应停止信号(既有);0 落盘同场判定未接入 #320 的平台 liveId。
- [x] **T-69 remux 租约交接竞态:让出者自己抢回租约,用例间歇失败（issue [#238](https://github.com/fuyucn/douyin-rec/issues/238)）**（2026-10-20）
  — 2026-10-18 PR [#240](https://github.com/fuyucn/douyin-rec/pull/240) 已合并(0.0.176,独立审查 APPROVE,CI 绿),issue `待验证`。
  **做什么**：让出后不立即抢回;修用例里永不求值的等待条件。**验收**：全量负载下租约用例不再间歇失败;部署后 serve 接管不乒乓。
  — 2026-10-20 四不 close 收口,issue #238 已关闭。
- [x] **T-72 隐私闸门与风险扫描加固（issue [#74](https://github.com/fuyucn/douyin-rec/issues/74)）**（2026-10-20）
  — 2026-10-18 PR [#245](https://github.com/fuyucn/douyin-rec/pull/245) 已合并(仅脚本/测试/文档,不 bump)。用户按建议选 A:接受更严的风险扫描,函数签名启发式与「仅改 value 行」的凭证漏检另开 [#269](https://github.com/fuyucn/douyin-rec/issues/269) 跟进。
  **做什么**：json/生成物豁免收窄、登录凭证键值规则、allow 标记仅测试夹具;风险扫描敏感文件清单、改名/权限/二进制路径、按 hunk + 函数签名匹配、异常 diff fail closed;文档同步。**验收**：37 条正反用例 + 变异验证。
  — 2026-10-20 四不 close 收口,issue #74 已关闭。
- [x] **T-84 风险扫描对纯展示模块只列提示（issue [#254](https://github.com/fuyucn/douyin-rec/issues/254)）**（2026-10-20）
  — 2026-10-18 PR [#277](https://github.com/fuyucn/douyin-rec/pull/277) 已合并(仅脚本/测试/文档,三轮审查末轮 APPROVE)。`DISPLAY_ONLY`(词典、提示文案、步骤标签)内容命中只列提示;hunk 含网络调用或导入即按完整规则。「导入行不匹配」会漏判换模块,未采纳。回放 40 提交 RISK 8→7。issue `待验证`。
  — 2026-10-20 四不 close 收口,issue #254 已关闭。

- [x] **T-82 node-upload-poll 用例 CI 偶发失败:派发等待不确定（issue [#271](https://github.com/fuyucn/douyin-rec/issues/271)）**
  — 2026-10-18 PR [#272](https://github.com/fuyucn/douyin-rec/pull/272):假录像终点在 2026-06,默认 10 分钟重连窗会按宿主时钟跳过该场 → 显式关闭重连窗、等待放宽到 5 秒,断言消息带派发次数与台账状态。已合并(0.0.187),issue `待验证`:后续 CI 轮次不再复现即收口。
  — 2026-10-19 完成:#271 关闭,#272 合并后 CI 连续 29 次通过、0 失败。
- [x] **T-81 风险扫描函数签名启发式补全 + 仅改 value 行的凭证漏检（issue [#269](https://github.com/fuyucn/douyin-rec/issues/269)）**
  — 2026-10-18 认领并实现(#74 选 A 的跟进),纯脚本与测试。**做什么**:收集 hunk 内全部签名行、补属性箭头与多行方法签名;`name` 在上下文、`value` 为新增行时命中凭证规则。**验收**:每类正反样例 + 现有 review-gates 套件不回退。
  PR [#273](https://github.com/fuyucn/douyin-rec/pull/273) 已合并(五轮审查,末轮 APPROVE;回放 40 提交 RISK 7→7)。
  — 2026-10-19 完成:#269 关闭,新扫描已在 #274/#276/#277/#278 实际运行。
- [x] **T-75 PR 门禁与状态机支持分步实现的票(Part of #N)（issue [#253](https://github.com/fuyucn/douyin-rec/issues/253)）**
  — 2026-10-18 完成。PR [#255](https://github.com/fuyucn/douyin-rec/pull/255) 已合并(仅脚本/文档/测试,两轮独立审查),issue 已 close。门禁接受 `Part of #N`;`in-review → in-progress` 须写原因;review 合并口径与指标脚本同步。T-74(#53)后续步骤改用此写法。

- [x] **T-60 会话 sidecar 写权威起止时间戳:远端隐藏命令按 UTC 运行导致跨天错日（issue [#87](https://github.com/fuyucn/douyin-rec/issues/87)）**
  — 2026-10-18 完成。PR [#179](https://github.com/fuyucn/douyin-rec/pull/179) 已合并并随 0.0.174 部署；worker 主机为 UTC,而无分段会话的 `startMs` 全部与文件名时间在 Asia/Shanghai 对齐(毫秒级),旧边车回退文件名有回归用例。issue #87 已 close。
- [x] **T-46 dev 多节点 e2e 环境（issue [#82](https://github.com/fuyucn/douyin-rec/issues/82)，P0+P1+P4）**
  — 2026-10-18 完成。PR [#86](https://github.com/fuyucn/douyin-rec/pull/86) 与场景 PR [#125](https://github.com/fuyucn/douyin-rec/pull/125) 已合并；用该环境在 0.0.174 上重跑 S1 19/19、S2 28/28、S3 40/40，隔离断言与反例自检全过。issue #82 已 close。
- [x] **T-45 节点只显示归属自己的任务（issue [#73](https://github.com/fuyucn/douyin-rec/issues/73)，低风险部分）**
  — 2026-10-18 完成。PR [#76](https://github.com/fuyucn/douyin-rec/pull/76) 已合并并随 0.0.174 部署；S1 覆盖 `assigned=false` 停用保留、worker 默认隐藏、受管任务只读 403。真删未分配残留仍另票（#75）。issue #73 已 close。
- [x] **T-49 磁盘水位闸门补全:常驻任务「新一场开播」与「手动启动」也过闸门（issue [#96](https://github.com/fuyucn/douyin-rec/issues/96)）**
  — 2026-10-18 完成。PR [#97](https://github.com/fuyucn/douyin-rec/pull/97) 已合并并随 0.0.174 部署；新一场拒绝/热改恢复/同场重连放行/手动启动 409 均由回归用例与 dev 实跑覆盖。issue #96 已 close。
- [x] **T-52b 状态机脚本收尾（issue [#81](https://github.com/fuyucn/douyin-rec/issues/81)）**
  — 2026-10-18 完成。PR [#233](https://github.com/fuyucn/douyin-rec/pull/233) 已合并（独立审查两轮，第二轮 MERGE）；`--from` 必须匹配当前标签、旧口径 closeout 文档化、PR 模板提示。issue #81 已 close。
- [x] **T-59 收口:扫描与拉取之间会话边车消失导致 job 失败（issue [#146](https://github.com/fuyucn/douyin-rec/issues/146)）**
  — 2026-10-18 完成。PR [#174](https://github.com/fuyucn/douyin-rec/pull/174) 已合并并随 0.0.174 部署；边车消失的确认缺失 / 无法确认 / 混合轮由 orchestrator 回归套件覆盖，隔离多节点 e2e S1 19/19、S2 28/28、S3 40/40 全绿。issue #146 已 close。
  残余(#176):PR [#222](https://github.com/fuyucn/douyin-rec/pull/222) 处理 —— 成员剔除只在确认缺失时删除,探测失败保留成员;跳过写独立 `skipped` phase,前端不再显示为 `pull/done`。
- [x] **T-42 节点清单三态：失联/超时不再当「无录像」（issue [#27](https://github.com/fuyucn/douyin-rec/issues/27)）**
  — 2026-10-18 完成。PR [#67](https://github.com/fuyucn/douyin-rec/pull/67) 已合并并随 0.0.174 部署；在干净隔离多节点集群（真 sshd、internal 网络、假 biliup）跑 S2：`docker stop` 拒绝路径与 `docker pause` 超时路径均判定 unreachable，28/28 通过；失联期间不建 job/不选优/不删源，恢复后补收口且无重复上传。issue #27 已 close。
- [x] **T-63 会话边车并发写入导致 nodeFormat 丢失（issue [#224](https://github.com/fuyucn/douyin-rec/issues/224)，#223 v4 PR0）**
  — 2026-10-18 完成。PR [#227](https://github.com/fuyucn/douyin-rec/pull/227) 已合并并随 0.0.174 部署到 master 与两个 worker；`appliedVersion=1`、`appVersion=0.0.174-*` 三台一致。issue #224 已 close。
- [x] **T-64 节点清单上报未认领的已转换分段（issue [#225](https://github.com/fuyucn/douyin-rec/issues/225)，#223 v4 PR1）**
  — 2026-10-18 完成。PR [#228](https://github.com/fuyucn/douyin-rec/pull/228) 已合并并随 0.0.174 部署；两个 worker 的 `_inventory` 均返回 `unclaimedSegments` / `unclaimedTruncated`，master 日志由「unknown」变为「0 in 0 sessions」。issue #225 已 close。
- [x] **T-66 节点应用回执端到端接通期望版本与 bundle 版本（issue [#230](https://github.com/fuyucn/douyin-rec/issues/230)）**
  — 2026-10-18 完成。PR [#231](https://github.com/fuyucn/douyin-rec/pull/231) 已合并并随 0.0.174 部署；三节点 `expectedVersion=1`、`appliedVersion=1`、`appVersion` 一致，`_node-status` 回吐真实 `appVersionAtApply`。issue #230 已 close。
- [x] **T-65 孤儿分段重叠时对账跳过并禁止删源（issue [#226](https://github.com/fuyucn/douyin-rec/issues/226)，#223 v4 PR2）**
  — 2026-10-18 主动放弃（not planned）：孤儿分段按丢失接受，不再加保护规则。依据是 audit agent 的口径——根因 #224 与观测 #225 上线后，两节点孤儿统计均为 0（`0 in 0 sessions`），保护规则对当前不发生的场景只会增加旧 worker 的磁盘占用。PR [#229](https://github.com/fuyucn/douyin-rec/pull/229) 未合并已关闭，分支 `codex/issue-226-orphan-guard` 保留；若将来重现孤儿，重开 #226 并以当时 base 重建。

- [x] **T-57 时区口径遗留三处（issue [#158](https://github.com/fuyucn/douyin-rec/issues/158)，#155 审查遗留）**
  — 2026-10-16 完成。PR [#162](https://github.com/fuyucn/douyin-rec/pull/162) 已合并并随 0.0.149 部署；三种宿主时区全量结果一致。issue #158 已 close。
  **做什么**：① 带 `<dataRoot>` 的隐藏命令按该数据根的库读时区；② 库不存在时保留继承的有效 TZ；③ 节点侧管线 spec 缺 `timeZone` 回落进程生效时区。
  **为什么**：非默认时区节点上「段被删空」兜底日期与文件名对不上；自定义库路径下子进程被覆盖成默认时区；节点侧与边录边传口径不一致。
  **验收**：三处各有回归用例；全量 test / typecheck / arch:check 通过。

- [x] **T-56 标题/产物名/场次键/默认日期统一按设置时区（issue [#155](https://github.com/fuyucn/douyin-rec/issues/155)）**
  — 2026-10-16 完成。PR [#157](https://github.com/fuyucn/douyin-rec/pull/157) 已合并并随 0.0.149 部署；实测录制节点系统时区为 UTC、分段文件名与场次键均为北京时间。issue #155 已 close。
  **做什么**：审计全部生成日期的入口并统一为 `settings.timezone`（缺省北京）：分段文件名、streamKey、会话名还原、
  独立 CLI 入口、前端默认日期。**为什么**：宿主机/浏览器为美西时晚间（北京次日）场次日期错一天。
  **验收**：美西宿主机/浏览器下日期均为北京日期；每个入口有回归用例；全量 test / typecheck / web build 通过。

- [x] **T-52 收口混合容器目录缺段修复（issue [#143](https://github.com/fuyucn/douyin-rec/issues/143)，最小修复）**
  — 2026-10-16 完成。PR [#144](https://github.com/fuyucn/douyin-rec/pull/144) 已合并进开发分支并随 0.0.149 部署；隔离 dev 集群用真实直播间录像复现混合容器目录：拉取 4 个文件、两段都进合并、成品时长 189.865s = 177.832 + 12.023（修复前成品约为各段合计六成）。issue #143 已 close。
  **做什么**：①pull 带会话边车（`NodeRecording.sessionJsonPath`，缺失则不带，旧 bundle 兼容）；
  ②CLI `merge`/`burn` 与 scan/web 合并共用 `groupSessionsInDir`，读边车认节点侧已转换的 mkv/mp4 分段；
  ③合并前兜底：拉进 stage 的视频分段有未被会话认领的 → 本场 `needs_manual` + 告警，不合并、不上传、不删源。
  **为什么**：节点侧原地替换（T-51）后混合容器目录收口会静默丢整场会话，成品缺段且 job 照常往下走。
  **验收**：混合容器全部会话进合并；边车缺失转人工且不删源；旧 bundle 无 sessionJsonPath 行为不变；CLI merge 认 mkv；
  全量 vitest + typecheck + bundle 通过。不改输出格式作用位置/终态转换/锁定口径（属 `plans/036`）。

- [x] **T-51 输出格式选项:按产出形态原地替换容器（issue [#137](https://github.com/fuyucn/douyin-rec/issues/137)）**
  — 2026-10-16 完成。两个 stacked PR（存档侧 [#138] → 节点侧原地替换 [#139]）已合并;后续 [#143] 修复了收口丢失已转换会话的缺口(混合容器成品时长 = 各段合计)。
  输出格式语义在第一期收敛为「只作用于清理后存活、用户最终拿到的文件」:无后处理任务封口转换走每节点任务表;有规则任务处理中途不转、收尾后转存活源分段;上传固定 mp4;本地无留存时锁定格式选项;合成所选跟随输出格式。
  **验收(部署 0.0.149 后 dev 集群真实场次)**:节点侧替换生效、控制组锁定符合预期、存档侧容器正确、混合容器合并无丢段、收尾转格式后修改时间不变且无重复上传。issue #137 已 close。
- [x] **T-55 后处理插件化第一期:Processor 契约 + 每节点持久任务表 + 留存文件转所选输出格式（计划 [plans/036_processor-plugins.md](plans/036_processor-plugins.md)）**
  — 2026-10-16。切片 T1 [#151] → T3 [#153] → T6 [#156] → T8 [#161] → T9a [#164] → T9b [#168] → T11 [#165] 全部经独立审查合并;另含 #143 收口丢段最小修复、#155/#158 时区口径、#160 封口队列遗留、#137 输出格式交付。部署 0.0.149 后在隔离 dev 镜像集群用真实直播间录像逐项验收(混合容器合并时长=各段合计、封口转换走任务表、收尾转格式且修改时间不变/无重复上传、远端入队越权全拒、合成所选跟随输出格式、标题按北京时间),除 issue [#160](https://github.com/fuyucn/douyin-rec/issues/160)(其 1/2/4 项已修并验收,票本身待独立复核后 close)外均已 close。第二期(merge/burn/上传迁表 + 队列页)待第一期稳定 ≥2 周后细化。

- [x] **T-48 界面把 stage 统一称「存档」,不投稿时锁定清理存档开关（issue [#135](https://github.com/fuyucn/douyin-rec/issues/135)，2026-10-15）**
  — 2026-10-15 认领，swe-loop 执行，分支 `codex/issue-135-archive-wording`（PR #136），base `feat/hub-optimization`，已合并并部署（`0.0.136`）。
  **做什么**：用户可见的 stage / 只合成 文案统一改为「存档」；不投稿时锁定「清理存档」并写回关（后端只合成路径本就不执行该清理）；清理开关改正向「投稿后保留存档」。存储与配置字段名不动。
  **验收**：锁定与取反往返有 vitest + 变异；中英文案无用户可见 stage 残留；全量测试 / typecheck / web build / i18n 检查通过。
  **验证（2026-10-15，dev 多节点镜像档实跑）**：界面切简体中文核对 —— 流程摘要显示 `plain → 存档`、上传区显示「只存档,不投稿(留存档待人工)」、
  产出形态徽标显示「存档」，无 stage 残留；「投稿后保留存档」开关为禁用态（可访问性属性 aria-disabled 为真、底层输入 disabled），
  强制点击不翻转（回读仍为开），提示「不投稿时存档就是成品,不会被清理;开关已锁定为保留」。
  **收口**：已 close（2026-10-15），依据写在该票评论。

- [x] **T-47 房间 / Hub 规则 / 任务三处表单按依赖重排（issue [#126](https://github.com/fuyucn/douyin-rec/issues/126)，2026-10-15）**
  — 2026-10-15 认领，swe-loop 执行，stacked PR [#127](https://github.com/fuyucn/douyin-rec/pull/127)→[#128](https://github.com/fuyucn/douyin-rec/pull/128)→[#129](https://github.com/fuyucn/douyin-rec/pull/129)→[#130](https://github.com/fuyucn/douyin-rec/pull/130)→[#131](https://github.com/fuyucn/douyin-rec/pull/131)→[#132](https://github.com/fuyucn/douyin-rec/pull/132)，最底层 base `feat/hub-optimization`，已合并并部署（`0.0.136`）。
  **做什么**：前端字段依赖收口到一个纯模块（边录边传可用性直接复用 core `resolveRollingPolicy`）；三处表单共用「录制→节点→处理→上传→清理→通知」分区，上传区「上传方式」三选一（收播后 / 节点侧 / 边录边传），不可用项给原因、失效自动回落；顶部流程摘要。
  **顺带修**（均浏览器实测复现）：Hub 规则弹窗定时窗口静默丢失；新建规则把表单默认值写到源任务；规则开关文案称「录制不受影响」实为全房间暂停；任务弹窗未登录保存会改写登录态开关。
  **验收**：依赖矩阵 vitest 覆盖；三处表单保存往返不丢字段；`pnpm test`/`typecheck`/web build 绿。
  **验证（2026-10-15，dev 多节点镜像档实跑）**：三条表单逐条保存并回读 —— 任务弹窗（分段 1800→300、窗口 10:00-12:00、输出格式 原始→MKV）、
  Hub 规则弹窗（分段 120、窗口 00:00-00:01，写入源任务并回读一致，确认定时窗口不再静默丢失）、统一房间面板（分段 240、窗口 08:00-09:00）
  均与后端存储一致；三处均为分区布局 + 顶部流程摘要，输出格式锁与原因按后端下发的锁定原因显示。
  **收口**：已 close（2026-10-15），依据写在该票评论。
  **待决（另议）**：「只关处理、录制照常」现有规则模型无法表达，是否拆独立处理开关。

- [x] **T-36 节点侧上传补磁盘水位闸门（issue [#8](https://github.com/fuyucn/douyin-rec/issues/8)，已 close 2026-10-13）**
  — 2026-10-12 认领，PR [#10](https://github.com/fuyucn/douyin-rec/pull/10)（分支
  `codex/issue-8-node-upload-disk-gate`，base `feat/hub-optimization`，sub-agent 独立 worktree 实现，
  **已由 review agent 合并（2026-10-13，merge commit `<sha>`），0.0.87 已部署，issue 已 close**）。
  **做什么**：`shouldUseNodeSideUpload` 或其 executor 增加一道磁盘水位闸门 —— 节点剩余空间低于阈值时不选
  节点侧、回落 pull 回 master，并记明回落原因。**为什么**：节点盘满时仍走节点侧 → remux 写盘 ENOSPC →
  ssh rc≠0 → 保守转人工（2026-10-12 多场即该簇）。**验收**：阈值与 reconciler `diskMinGB` 同源；
  vitest 覆盖「低于阈值回落 / 等于高于阈值照常 / 阈值未配置向后兼容」；`pnpm test` + `typecheck` + `bundle` 绿。
  **边界**：不自动重传、不删源、不改 hub 规则 —— 仅新增一道「不选节点侧」的判定。
  **实现完成**：纯判定 `diskWatermarkGate` + 执行器插入闸门 + 组合根两处注入 `resources.diskMinGB ?? 10`
  （与 reconciler 同表达式同源）；自审修 2 项（读数缺失展示串、执行器层覆盖缺口），另核查边界 / 一致性 / 分层。
  验证 101 文件 / 1283 用例通过、typecheck exit 0、bundle `0.0.82`、架构文档 check 一致。
  **rebase 收敛**：与已合并的 #6（`0.0.81`）在架构文档与版本号撞车 → 重放到最新 base，架构文档重新生成、
  测试文件两边用例都保留、版本推进到 `0.0.82`；分支现为单提交 `73dfaf6`，PR `mergeable=MERGEABLE`。
  **收口**：已 close（2026-10-13）。线上实跑：master job.log 出现 `剩余磁盘 4.4GB < 阈值 10GB → 回落 pull 回 master`
  （16:12Z/16:39Z/16:49Z 三次），该场改走 master 拉取后正常 done；高于阈值（12.1–21.7GB）照常节点侧。（2026-10-13）

- [x] **T-39 流程补 review 环节：PR 独立审查通过后由 agent 自动合并（issue [#14](https://github.com/fuyucn/douyin-rec/issues/14)，2026-10-13）**
  — 2026-10-12 用户要求（「流程中增加一个 review agent，他 review 完提交的 PR 之后通过了，就可以合并了，
  不需要我来操作」）。**做什么**：在自动流程里加「PR 自动 review + 合并」heartbeat —— 对每个 open PR
  派 `fork_context:false` 的**新会话**只读审查，按「review 门禁」逐条核；**门禁全过 → review agent 直接
  `gh pr merge --merge`**（base 保持 `feat/hub-optimization`，不删分支）；不通过 → 打回并列缺口，保持
  `in-progress`。合并后按「四不 close」收口 issue。**为什么**：实现 heartbeat 只开 PR，合并一直留给人，
  闭环断在环 4 入口，且实现与审查同会话 = 自我审查不可信。**验收**：三份文档口径一致
  （实现只开 PR / review 通过即合并 / **部署仍由人做**）；review heartbeat 配置落盘并 ACTIVE；
  首个样本 PR 走通「审查 → 合并」。**边界**：review agent 不改实现代码、不部署、不跳过门禁；
  不删任何 `.xml`/`.ass`；不碰 `recording===true` 的任务。

- [x] **T-35 中间产物→规范上传名改同盘硬链接（issue [#6](https://github.com/fuyucn/douyin-rec/issues/6)，已 close 2026-10-12）**
  — 2026-10-12 认领，PR [#9](https://github.com/fuyucn/douyin-rec/pull/9)（分支 `codex/issue-6-stage-hardlink`，
  base `feat/hub-optimization`），**已由人合并**（merge commit `<sha>`，版本 `0.0.81`），issue 已按
  「四不 close」门禁收口 close。
  **做什么**：节点侧分段管线 + master 分段管线的「中间产物 → 规范上传名」由真拷贝改同盘硬链接优先、
  失败回落复制（`linkOrCopySync`），降低上传期 stage 峰值占用。**为什么**：真拷贝使峰值翻倍，
  盘满时 remux ENOSPC 转人工。**验收**：同 inode 断言 + 硬链接失败回落 + 续跑不重复 remux 的回归用例；
  `pnpm test` / `typecheck` / `bundle` 绿。
  **实现完成**：sub-agent 独立 worktree（`fork_context: false`），自审修 3 项（架构文档漂移、账本句柄泄漏、
  排除就地写入风险）；验证 101 文件 / 1276 用例通过、typecheck exit 0、bundle `0.0.81`。
  **仍未部署**：部署后需人工实跑一场（不烧录 + 节点侧上传的房间）核对上传期 inode 与整场峰值。

- [x] **T-34 自强化循环开发落地** — 完成 2026-10-12（issue [#4](https://github.com/fuyucn/douyin-rec/issues/4) 已 close） — 提案 issue [#4](https://github.com/fuyucn/douyin-rec/issues/4)。
  文档部分已完成：`docs/self-reinforcing-dev.md`（五环闭环 + 每环门禁 + 指标口径）、
  `docs/agent-workflow.md`（五环总览 + 四不 close + 指标与闭环回写）。
  **本轮补齐剩余**：①新增只读指标脚本 `scripts/reinforce-metrics.py`（默认不写文件，
  `--write` 落 `docs/metrics/<date>.md`），聚合 done/needs_manual/failed、疑似假失败率、
  master stage 与（可选）节点卡死残留、近 30 天已关闭 issue 的开单→收口时长；②首个基线
  报告 `docs/metrics/2026-10-12.md` + 文档「指标记录」表；③`.github/ISSUE_TEMPLATE/`
  的 enhancement/incident 模板在「验收标准」默认写入「部署核对版本 + 实跑验证 + 至少一项回写资产」。
  **验收**：指标能自动计算并写入文档（已跑通）；新增修复类 issue 的验收标准默认含「验证 + 回写」。
  本轮只改文档 / 脚本 / 模板，未改任何录制、上传、删除、部署行为，未部署、未 commit。
  **自动化已注册（2026-10-12）**：环 5「指标回写」heartbeat（`FREQ=DAILY;INTERVAL=2`，9:00）
  跑 `--days 7 --write` 并追加「指标记录」，退步/复发才通知；环 1 值班 Audit（120min）与
  环 2 issue 监听（5min）、环 4 部署 guard 由既有部署 heartbeat 承担。
  **自动 gate 升级（2026-10-12，用户拍板方案 1）**：环 2 改为**自动 triage**（危险类 → `needs-decision`
  等人；证据充分 + 低风险 + 可测试 → 自动 `accept`；证据不足 → 自动 `decline` 写原因）；
  环 3 新增**自动实现** heartbeat（10min，消费 `accept` 且无 `in-progress` 的票 → 打 `in-progress` +
  留言认领 → 分支 + **开 PR**，串行一次一条）。**人只做三件事：合并 PR、部署、危险类拍板。**
  边界写进 `docs/agent-workflow.md`「自动 gate」与 `docs/self-reinforcing-dev.md` 环 2/3 + §5。
  **闭环现状**：1/2/3/5 自动；4 拆开——合并 PR 与部署由人做，**close 由实现 agent 按「四不 close」门禁执行**。
  issue [#4](https://github.com/fuyucn/douyin-rec/issues/4) 已按新门禁收口 **close（2026-10-12）**。

- [x] **T-33 边录边传：已封口分段确认上传后再删源** — 2026-10-12 认领（GitHub #3）。计划 `plans/031_rolling_segment_upload.md`。
  评论约束：做成任务配置里的开关，类似节点侧上传，默认关闭。可以不照单全收，但要在 PR / issue 里写理由。
  **为什么**：整场录完才上传，多房间同时在录时节点盘会先满（某 worker 49G 写满，两场 `needs_manual` 无 BV）。
  **做什么**：任务配置加 `rollingUpload`（默认 false）；只处理已封口分段；winner 段确认（BV / 分 P ack）
  后才删该段视频；落败节点同一段在 winner 封口胜出后删；不碰正在写的文件；低水位拒绝新开录、
  不删未确认源腾空间；`.xml`/`.ass` 留到整场结束。
  **验收**：计划里的不变量有对应测试；实现前不改线上行为；与 `plans/024`（产出形态）开关独立。
  **实现完成（2026-10-12）**：分支 `codex/issue-3-rolling-upload`（worktree）。
  core 纯判定 `packages/core/src/rolling.ts`；录制端执行体 `packages/app/src/rolling-upload.ts`（每会话一实例，
  封口才传、ack 才删、失败转人工不重传、sidecar 重启幂等 + 段号单调续号）；manager 加 `makeRolling` 工厂接缝；
  master 识别短路（scan 读 `.rolling.json`、pipeline 见 `rolling.bv` 直接 done 绝不重复建稿）；
  daemon 磁盘水位闸门（拒绝新开录、不截断当前）；CLI/`record`/web 开关 + `Task`/`RemoteTaskSpec`/DTO 全链路透传。
  **不采纳**原文「落败节点同段立刻删」（理由见 plan：边录边传在选优前发生，跨节点删会丢唯一副本；
  单节点闸门下不存在落败节点、多节点不启用）。
  **验证**：`pnpm test` 1230 passed（仅 2 个与本次无关的基线固有失败：`architecture-docs` 生成物漂移、
  pipeline 分段核验观察期用例——均在基线 `4dbbaec` 上同样失败）；`pnpm typecheck` 通过；web `pnpm build` 通过；
  `pnpm bundle` 出 `0.0.75`。**版本**：本 worktree 基线 0.0.74 → bump 0.0.75；与主工作区未提交的 0.0.76–0.0.79
  合并后统一为 **0.0.80**（合并提交里改的，见 package.json）。
  **合并完成（2026-10-12）**：合并进 `feat/hub-optimization`（merge commit `<sha>`，与主工作区 0.0.76–0.0.79 汇合，版本统一 **0.0.80**）；合并后整树 `pnpm test` **1270 passed**、`pnpm typecheck` 通过、`pnpm bundle` 出 0.0.80。**未部署、未 push**（远程无 `feat/hub-optimization`，是否 push 待用户决定）。
  **部署完成（2026-10-12）**：三节点均升到 **0.0.80**（local `0.0.80-66feff`、两台 VPS `0.0.80-88d10e`），
  经 `scripts/auto-deploy.sh`（stage first → vps1 → migrate）在部署 guard 全空闲时执行；worker id → nodeId 迁移完成（无改动，已备份）。
  **部署后无回归**：`/api/hub/workers/status` 三节点全 `ok`、`/api/tasks` 16 任务正常、`/api/hub/queue` 正常；
  部署产物内含本次 `rollingUpload`（grep 12 处）与 0.0.76–0.0.79 节点侧修复（`_node-result`）。
  **仍待办**：边录边传的**真实链路**验证需一场开了该开关的录制（未做——需用户指定一个房间开开关）。
  **仍未 push**（远程无 `feat/hub-optimization`）。

- [x] **T-29 分段模式下多会话(断流重连)的烧录分 P 丢失(真缺陷)** — 2026-10-09 用户发现
  `douyin.63171491268`(什么鱼)稿件 P1-P6 齐全但 livechat 只有 P7-P9(会话1 的 3 段),会话2 的 3 段
  livechat 全丢。
  **根因(读源码 + 真实 xml 复现)**:`segment-pipeline.ts` 的弹幕窗口用**整场单一 `globalOffset`** 累计,
  而窗口是相对**该段所属会话**的 xml 切的(`video_start_time` = 该会话起点)。断流重连产生**新会话 + 新 xml**
  (时间轴从 0 重起),沿用整场 offset → 新会话各段窗口整体错位到该会话时长之外 → 窗口内 0 条弹幕 →
  `窗口内无弹幕,跳过` → 这些分 P 的 livechat 全不产出。实测复现:会话1 三段 10128s、会话2 三段;
  旧代码给会话2 的窗口是 [10128,13729]/[13729,17330]/[17330,20178],而会话2 xml 只覆盖 ~10050s → 0 命中;
  按会话累计后 [0,3601]/[3601,7202]/[7202,10050] → 命中 140/302/307 条。
  **同类风险(一并修)**:分组计划可能把**跨会话**的段合进同一个分 P(只有一份 xml,窗口并集却用其中一个 xml)
  → 同样错位。已按会话边界切开分组。
  **修**:抽两个纯函数 `sessionWindowOffsets()`(按 xml 路径分桶累计)与 `splitGroupsBySession()`(按会话切组),
  pipeline 接入;删除整场 `globalOffset`。
  **验收**:新增 `packages/orchestrator/src/segment-pipeline.test.ts`(7 用例;已验证「还原旧实现即 2 例失败」);
  `pnpm test` **902 全过**、`tsc --noEmit`、`pnpm bundle`(`0.0.47`,产物已无 `globalOffset`)。
  **部署**:`0.0.47` 已上线 master + VPS1 + VPS2(三节点 ok)。
  **受影响的历史稿件**:`<房间>` 10-07 与 10-09 两场(10-07 稿件 `BV1xx` 3 个 livechat 全丢)。
  源 `.ts` 已被 cleanup 删除 → **无法补烧**,只能保留现状(弹幕 xml 仍在节点,但视频已删)。
  **另一类同症状但不同根因**:`68133201791`(凌晴)10-09 两场 `danmuCount:0`(xml 全空,取不到弹幕)
  → livechat 也无产物;那是弹幕采集问题(见 T-9),非本 bug。（2026-10-09）
- [x] **T-27 hub 上传撞 `21566 投稿过于频繁` → 整场转人工（真缺陷）** — 2026-10-09 实况:
  `douyin.76601480575`（汪汪想不到）hub 建稿两次均报 `code: 21566`,重试 1 次后转 `needs_manual`,
  白等一场;人工补传成功（`BV1xx`,3 分 P）。
  **根因(读源码 + 实测双向确认)**:`packages/app/src/upload/biliup.ts` 调 `biliup upload` **未指定
  `--submit`** → biliup CLI **默认走 app 提交接口**(`entry.rs`:`submit.unwrap_or(SubmitOption::App)`),
  而 app 接口(`member.bilibili.com/x/vu/app/add`)**更易触发 21566 风控**(biliup 自己的 server 端因此
  在 `server/common/upload.rs` 把默认改成 web;issue biliup#1609 / #1762)。叠加第二处缺陷:
  `core/src/upload-contract.ts` 的 `isUploadRateLimited` 只认 `601`,**不认 21566** → 命中后只退避
  60s 重试(仍处风控窗)→ 二次失败 → 转人工。
  **修**:①`buildUploadArgs`/`buildAppendArgs` 显式 `--submit web`(env `BILIUP_SUBMIT` 可覆盖,
  非法值回落 web);②`isUploadRateLimited` 加认 `code: 21566`/`投稿过于频繁`;③compose/.env.example
  加 `BILIUP_SUBMIT` 透传;④`upload-recording-today` skill 同步加 `--submit web`(唯一权威)。
  **验收**:`pnpm test` 894 全过(+6 用例:submit 默认/覆盖/非法回落 + 21566/601/普通错误识别)、
  `tsc --noEmit` 通过、`pnpm bundle` 产物含 `BILIUP_SUBMIT` 与 21566;本机实测
  `biliup ... --submit web upload P1 P2 P3` 建稿成功拿 `BV1xx`(水印 `state:0` 已确认)。（2026-10-09）

- [x] **T-28 `{title}` 渲染为空的真凶 = 录制节点跑的是**旧 bundle**(非代码缺陷)+ 跨场标题串台(真缺陷)**
  — 2026-10-09 实况:`BV1xx` 稿件名 `汪汪想不到_2026-10-09_ 直播回放`(双下划线 = `{title}` 空),
  当天 12 场 hub 上传**全部**如此。
  **根因 ①(部署滞后,非代码 bug)**:T-20 的侧car `title` 修复(`f8e7543`,10-08 23:00 PDT)**只存在于
  master 容器 + VPS 源码**,而该场由 VPS2 录制;VPS2 当时跑的进程 `PID 465892` **启动于 10-08 20:09 UTC**
  (早于修复),直到 10-09 15:59 UTC 才重启换新 bundle。该场(UTC 12:36:30→15:32:31)整段落在旧进程上 →
  `session.json` 无 `title`。**证据**:同一 VPS2 重启后新录的场(如 15:59 之后的 session)已带 title;
  VPS1 当前录制中(新 bundle)`不想卷了` 的 session.json `title:"天蝎"` 与抖音 API 一致。
  **根因 ②(真缺陷,已修)**:同一录制进程**跨场**(下播 → 主播重新开播)时,`RecordingSession.liveTitle`
  不清空 → 第二场的 `session.json` 沿用**第一场**的标题。**复现**:`video-rec-2 task 11` 20:36 那场收播后
  进程继续轮询等下一场(日志 15:32:50「主播已下播…等待下次开播」),若第二场开播即张冠李戴。
  **修**:`packages/manager/src/index.ts` 的 `onLive` 里,`offlineNotified`(onOffline 已查权威
  `getLiving=false` 确认下播)时清空 `liveTitle`;抖动断流(仍在播)不清,保留同场首值。
  同时删掉 onLive 里的 sidecar 补写(onLive 恒先于 onSegment,补写会误用 `lastXmlPath` 覆盖**上一场**
  的 sidecar —— 实测踩到)。
  **验收**:`pnpm test` **895 全过**(+1 用例 `T-20b`:下播→第二场用第二场标题;已验证「移除修复即失败」)、
  `tsc --noEmit` 通过、`pnpm bundle`(`0.0.46`,产物含 `offlineNotified&&(this.liveTitle="")`)。
  **线上修复**:`BV1xx` 稿件名经 web edit 接口改为
  `汪汪想不到_2026-10-09_养着不烧心 直播回放`(`{title}=养着不烧心`,与抖音 API 一致;水印仍 `state:0`,
  仅自己可见未变)。
  **遗留**:其余 11 场当天上传(10-09)同样 `{title}` 空,均系旧 bundle 所致 → 待 `0.0.46` 部署后不再复现;
  **已完成(2026-10-09)**:① 11 场标题全部修正(`{title}` 用抖音 API 当场标题填充);② `0.0.46`
  已部署到 master + VPS1 + VPS2(三节点 `0.0.46`,hub worker status 全 ok)。批量改标题的实现注意点:
  `x/vupre/web/archive/view` 对本机 IP 返 **412 风控** → 改走 biliup 同款 **app 接口**
  (`x/client/archive/view` 读 + `x/vu/app/edit/full` 写,access_key 签名);payload 只传 Studio 字段
  且必须带 `aid`(否则 21001/-400)。水印 `state:0` 逐稿复核未被 edit 改动。（2026-10-09）

- [x] **T-10 本机抑制也要走能力门控** — `localSuppressedSourceTaskIds` 原只看 `workers` 勾选,不看
  `requires`:若远端缺能力(reconciler 会排除它)而本机又被抑制 → **两头都不录**的静默漏录。
  **修复**:能力门控纯函数(`satisfiesCapabilities` 等)**从 orchestrator 下沉 @drec/core**(app L4 不能依赖
  orchestrator L4.5,且两处判定必须同一真理源;orchestrator 保留 re-export);本机抑制改为「远端存在 +
  能力 ⊇ requires」才算有人接;拿不到能力信息时**不抑制**(安全默认)。
  **验收**:hub-store +2 用例 / `pnpm test` 886 全过 / typecheck / bundle(`0.0.43`);layering 通过。(2026-10-08)

- [x] **T-20 直播间标题未采集 → 稿件 `{title}` 渲染为空**（bug） — **根因(2026-10-08 实测)**:
  ① 录制侧 `session.start` 只传 anchorName(平台 `getStream` 只在 living 时才有 title,开播前无从得知);
  ② manager 的 `onLive` 收到 `ev.onLive({title})` 但**不更新 `liveTitle`** → `<recordings>/*.session.json`
  永远无 `title` 字段;③ `scan.ts` 读不到 → pipeline `titleCtx.liveTitle` 空 → `{title}` 渲染为空。
  **修复**:manager `onLive` 里接收 `i.title`,首个非空值写入 `liveTitle` 并**立刻刷新 sidecar**;
  保留首值(重连不被空值清掉)。全链路 `getStream().title → probe.title → onLive({title}) → sidecar` 打通。
  **验收**:`test/session.test.ts` +2(开播时才拿到标题 / start 时已知标题 → sidecar 均有 title);
  `pnpm test` 884 全过 / typecheck / bundle(`0.0.42`)。(2026-10-08)

- [x] **T-23 仓库状态对齐(HEAD 断裂 / 生产跑未提交代码)** — 计划 `plans/028_repo_state_reconciliation.md`。
  **实测确认**:HEAD 单独 checkout 有 7 个真实类型错误(`requires`/`capabilities`/`ensureNodeIdentity`/
  `douyinApiMode` 定义侧全在 WIP);生产 `0.0.32-661663` 跑的是仓库里不存在的构建。
  **做法(按 plan 的「定义侧→消费侧」切分,实测每个 commit 都 typecheck 绿)**:
  ① `dfc659e` 定义侧(能力门控/节点身份/API 模式类型与实现 + 新模块);
  ② `552d792` 消费侧(reconciler/cli/web/danmu 引用 + 测试);
  ③ `f10e25b` 归档(审计文档/plans/026/运维脚本/架构图再生成/AGENTS.md 可提交)。
  **用户裁决 3 个未决问题**:脚本提交(非 gitignore)、`plans/026` 提交、T-17 脚本现在提交 —— 均按「提交」处理。
  **验收**:干净 worktree(真实 `pnpm install`)`tsc` ✅ / `pnpm test` **869 全过** ✅ / `pnpm bundle` ✅;
  工作区干净(`git status` 空);TODO 每个 `[x]` 可追溯。(2026-10-08)

- [x] **T-24 快手「无法获取直播」根因修复(取流改回页面优先 + 递进退避)** — **真凶与 IP 无关**:
  `livedetail` API **已被平台下线**(2026-10-08 实测:对真房间号/主播 id/乱码/空参数都返回同一 634 字节桩,
  `result:2`+`living:false`+`playUrls` 全空)→ 旧「API 优先且说没在播就不回退页面」让**任何节点**
  (含 IP 干净的 VPS1/VPS2)都报 `living:false`、永不回退页面 → 任务 75 一直「等待开播」。
  **修复**(`9db3d31`):`getStream`/`getLiving` 改回**页面优先、API 仅兜底**;API 只认「拿到可播流 URL」,
  拿不到一律 `null`(绝不 `{living:false}`);页面失败+API 桩 → **抛错**(未知,不静默);HTML 含限流文案 → `throttledReason`;
  持续风控探测间隔**递进退避** 5→10→20→30 分钟封顶(record-engine)。
  **实测**:同一在播房间,旧代码在 VPS1/VPS2 = `{living:false}` → 新代码 `{living:true, url:hw-origin...flv}`;
  本机(被限流)= `{living:false, throttledReason:"请求过快，请稍后重试"}`。
  **验收**:`pnpm test` 876 全过 / typecheck / bundle(`APP_VERSION 0.0.38`);文档 `docs/kuaishou-rate-limit.md` 补「修复 3」。(2026-10-08)

- [x] **T-25 快手限流:对照外部同类问题 + 补全浏览器请求头** — 参考 48tools#128(症状与我们 task 75
  一致,作者判定风控/被拉黑、建议国内 IP + 不要频繁刷新)、48tools v4.17.0(称「浏览器 fetch 替代 got
  解决请求过快」)、ordinaryroad live-chat-client(`livedetail` 的 `result:2`=请求过快、`400002`=需要验证,
  仅 1 正常 / 671·677 未开播,其余抛异常)。
  **我们的 A/B 实测(同一被限流出口,证伪)**:浏览器 fetch 的收益**不可复现**(第 2/3 轮 Node 与浏览器
  均被限流)→ 决定性变量是**请求速率**(48tools 是点击时请求一次,不轮询;我们已用 5 分钟 + 递进退避覆盖)。
  **采纳**:补全真实 Chrome 请求头(`Accept`/`Accept-Language`/`sec-ch-ua`/`sec-fetch-*`/
  `Upgrade-Insecure-Requests`,不手写 `Accept-Encoding`)。**未采纳**:浏览器 fetch 兜底(收益不可复现 + 成本高)。
  **验收**:`pnpm test` 878 全过 / typecheck / bundle(`0.0.40`);文档补「外部同类问题与解法对照」。(2026-10-08)

- [x] **T-15 节点自报稳定身份（nodeId）** — worker 首次 `serve`/`_node-id` 时生成并持久化
  `<root>/config/node.json`（**nodeId = 16 字符 hex 短 hash**（8 字节随机）+ hostname + createdAt），
  **此后永久不变**（跨重启/换 master/迁移）。短 hash 而非 uuid v4：36 字符在 UI/日志/URL 偏长；
  8 字节 hex 碰撞概率 2^-64 量级足够，且只含 `[0-9a-f]` 满足 worker id 路由字符集。
  master 经隐藏命令 `_node-id` 读它，UI「添加节点」的**测试连接**顺带返回 nodeId → 新建 worker 用它
  作 id（不再自分配 `worker-N`）。**为什么**：旧 id 由 master 按 seq 分配 → 删了重建就换号，规则里引用的
  id 变幽灵、身份丢失。**验收**：`pnpm test` 854 全过（+节点身份 4 用例、显式 id 3 用例）；真机 VPS1
  实测生成 `node.json` 且幂等（复跑同一 nodeId）。（2026-10-08）
  - 自审发现：`process.env.HOSTNAME` 在 ssh 非登录 shell 里为空 → 改用 `os.hostname()` 兜底;
    并给 `ensureNodeIdentity(root?)` 加可选 root（master 探测 local worker 时 dataRoot 可能 ≠ 自身 drecRoot）。
  - 兼容：旧 bundle 无 `_node-id` → `nodeId()` 返回 null,UI 回落旧的自分配行为(不阻断)。

- [x] **T-14 对照上游 1.17.4 查漏补缺（vendored 副本）** — 把上游 1.17.4 的 TS 逐个转译后与我们的
  vendored JS 做归一化 diff，补齐缺失的上游修复。**补入**：① 电台判活（`room_status===1` /
  `enter_mode==1`）；② `isLiveRadio` 全链路透传（`douyin_api.js` 4 处 + `stream.js` `getInfo` +
  `index.d.ts`）；③ 电台优先 `mobile` 取流；④ `userHTML` 的 `stream_url` 构造（`flv_pull_url` 重建、
  `or4`→`origin`）；⑤ `getFormatPriorities`（`preferAlternativeStream`）。**顺带修掉我们的历史 bug**：
  `getRoomInfoByUserWeb` 误标 `api:"webHTML"`（应为 `userHTML`），会让 `getRoomInfo` 的返回分支错判。
  **为什么**：这些缺失会导致**电台直播判活失败 → 漏录**、`userHTML` 路径取不到流。
  **验收**：`pnpm test` 847 全过；实测普通直播间取流/弹幕仍正常、`isLiveRadio` 正确透传；
  对照清单写进 `packages/douyin-live/src/stream/SOURCE.md`「上游修复对照」。（2026-10-07）
  - 自审发现：`isLiveRadio` 是**主播属性**而非「正在播」——实测未开播电台房间 `isLiveRadio:true` 且
    `living:false`。上游把 `room_status===1` 当 living 是「宁可多判也不漏录电台」的取舍，照抄并记入
    SOURCE.md 备忘。
  - 仍未同步（不影响我们路径，已在 SOURCE.md 记录）：`getRoomInfoByUserWeb` 的早退结构差异（功能等价）。

- [x] **T-13 抖音 API 模式加入 UI 设置（可选）** — 全局设置 `settings.douyinApiMode`，UI「设置 → 引擎」
  下拉可选 `balance`(默认)/`web`/`webHTML`/`mobile`/`random`。链路：设置 → `GET/POST /api/douyin-api-mode`
  → spawner 读 getter 注入子进程 `DOUYIN_REC_API_MODE` → `douyin-live` 的 `resolveApiMode()` 消费（取流/
  判活/主播名/弹幕 liveId 全走它）。契约常量在 `core`（`DOUYIN_API_MODES`/`normalizeDouyinApiMode`）。
  **为什么走 env 而非 Platform 参数**：`getStream(channelId,quality,cookies)` 是三方平台契约，不该加抖音
  专属参数；且这是全局设置、非 per-task。**验收**：`pnpm test` 847 全过（+4 API 用例）；真子进程实测
  `DOUYIN_REC_API_MODE=web node dist/douyin-rec.mjs probe` 取到流；非法值回落 balance。（2026-10-07）
  - 自审发现①（真缺陷）：UI 可选 `webHTML` 但取流用它**恒失败**（streams=0）。已补上游 1.17.1 修复
    —— `stream.js` 把 `webHTML` 与 `userHTML` 一并改回 `web`（取流路径），弹幕 liveId 路径不受影响。
  - 自审发现②：`setDouyinApiMode` 应存**归一后**的值（而非原样），否则设置里留非法串、UI 回显与生效值
    不一致。已改。
  - 自审发现③：`server.ts` 的路由名联合类型需同步加 `getDouyinApiMode`/`setDouyinApiMode`（typecheck 抓到）。

- [x] **T-11 单一真相源：`AGENTS.md` 为准，`CLAUDE.md` 变 `@AGENTS.md` 指针** — 把 `CLAUDE.md` 独有且
  仍有效的实质内容并入 `AGENTS.md`（弹幕健康监控/onLive 契约、数据根 `DOUYIN_REC_ROOT`、时区
  `applyTimezone`、hub 角色/数据流/选优/pipeline/SyncLedger/硬标准常量、`_recording-status`、
  `DownloadEngine`、ffmpeg `Opening` 解析、`patches/`+`bin/` 布局）；修掉失效引用（`plans/030` 不存在 →
  指向 `packages/core/src/platform.ts`；`Platform` 字段更正为 `defaultQuality/defaultEngine`）；
  修掉署名矛盾（实况：全仓 87 提交均用 `Co-Authored-By: Codex Opus 4.8`）。`CLAUDE.md` 压成 10 行指针
  （含 `@AGENTS.md`）；**取消 `.gitignore` 对 `AGENTS.md` 的忽略**，使规则可被提交。（2026-10-07）
  - 自审发现：反向 diff 出 24 个旧文档独有标识符，逐一核实 → 13 个确为过时项（`merge-recording-today`
    技能已不存在、`danmuProvider`/`live_poll` 字段已删、`Claude-Session` 废弃），其余全部补入。
- [x] **T-1 能力门控（capability gating）** — worker `capabilities` + 规则 `requires`，reconciler 与任务同步
  按「能力 ⊇ 要求」硬过滤（与 `workers` 取交集，不改冗余语义）；`explainRejections` 给排除理由；
  UI：WorkerDialog 能力标签输入 + WorkersPanel 展示 + HubRuleDialog 门控多选（含「会被排除」预警）。
  新增 `packages/orchestrator/src/capabilities.ts`（+8 测试）、reconciler 3 个门控场景。（2026-10-07）
  - 自审发现①：`gateWorkers` 未按 worker 去重 → 同一 worker 多会话（断流重连）会让 `rejected` 重复，
    警告文案刷 N 遍。已修（按 id 去重）+ 2 用例；修时一度引入 `requires` 为 undefined 时 `filter` 崩，
    随即修正并加回归用例（无要求也要去重）。
  - 自审发现②：`localSuppressedSourceTaskIds` 未走门控（本机可能白跑）→ 记为 `T-10`。
- [x] **T-3 选优补「弹幕完整度」维度** — `scan.ts` 统计 xml 条目数（`danmuCount`，仅表头空 xml=0）；
  `selectWinner(..., requireDanmu)` 在「要烧弹幕」时让有弹幕者优先（`clean` 仍是第一优先级）；
  落库 `sync_candidates.danmuCount` + UI 候选 tooltip 显示。7+3 测试。（2026-10-07）
  - 自审发现①：正则误命中风险 → 实测 `RECORDER_XML_STYLE` 里 `<d `/`<gift `/`<member ` 均 0 命中（`<d`
    无空格的 3 次不会命中带空格正则），真实 1MB xml 数出 13074 条正确。
  - 自审发现②：分段模式（`mergeSegments=false`）是否也受益 → 核对 `segment-pipeline.ts:206` 取的正是
    `winnerMembers` 自己的 xml，选优同点覆盖，无需另改。
- [x] **清理 10 月前台账** — master `douyin-rec-sync.db` 删 7–9 月 30 场（备份 `/tmp/douyin-rec-sync.before-2026-10.db`）。（2026-10-07）
- [x] **清理 VPS1 历史 xml** — 删 1444 个空 xml + 1444 个孤儿 session.json（~4.27MB），保留活跃会话「潘潘不困」。（2026-10-07）
- [x] **hub 上传模板统一** — 12 条 `mode:upload` 规则改为分段不合并 + `{name}_{date}_{HH}-{mm}-{ss}` 等模板（备份 `/tmp/hub-backup-20261007-200148/`）。（2026-10-07）
- [x] **VPS2 部署** — `video-rec-2` 装 worker + tailscale，master→VPS2 同步通。（2026-10-07）
- [x] **Dockerfile SSH 通配化** — `Host 100.97.21.80` → `Host 100.* *.ts.net`，修新 worker 走 `root@` 的 Permission denied。（2026-10-07）
- [x] **Web UI 移动端 nav** — 窄屏第二行显示「录制任务 / Hub / 处理队列」。（2026-10-07）
