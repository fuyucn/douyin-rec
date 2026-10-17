# 0 落盘上传调研

> 只读调研。没有改业务代码，没有部署，没有碰节点、录制或上传进程，也没有发起真实上传。
> 基线：`feat/hub-optimization` @ `077d129`。

## 结论

**部分可行，但不是严格 0 落盘。**

- 可以做到：ffmpeg 把直播流 remux 到 stdout，按**预先声明的固定大小**切成一个分 P，UPOS
  chunk 一边产生一边上传；biliup 上游已有这条路径。
- 不能直接做到：把 `ffmpeg stdout | biliup upload -` 当普通上传用。biliup CLI 的
  `upload` / `append` 只接受文件路径；UPOS preupload 必须先给出总大小，chunk 数、
  `start` / `end` / `partNumber` 都按总大小预先计算。
- 工程上最接近“0 落盘”的做法是：**固定大小的内存/临时 spool 窗口 + 预声明分 P 大小 +
  顺序 append**。窗口外仍要处理“网络跟不上”“断流”“提前结束”“重连”等异常；这些异常
  通常需要保留一小段可重传数据，否则失败时没有源可补。
- 当前最现实的生产方案不是纯管道，而是 **小窗口 spool（tmpfs 或普通临时目录）+ 封口后上传**；
  它是“低落盘/短窗口落盘”，不是严格 0 落盘。
- **21540 不是 0 落盘能解决的问题。** 本次 T14 人工授权实测（2026-10-17）是 120 秒分段，
  前 4 段成功，第 5 段被
  `21540 请求过于频繁` 拒绝。它表明提交/请求频率受限，不能靠“不写磁盘”绕过；如果仍然每
  120 秒 append 一次，0 落盘只会让提交来得更密、更稳定地撞上限。

## 调研方法与限制

本次按三路拆分：

1. biliup 的 CLI/库与 UPOS 协议能力；
2. 同类项目（biliup、BililiveRecorder、DanmakuRender）的边录边传/流式上传做法；
3. 本仓库的录制引擎、边录边传、节点侧上传与 plan 038 的接入点和不变量。

当前会话无法 spawn sub-agent（`multi_agent_v1` 不可用），因此三路由主会话依次完成，而不是并行
sub-agent。上游代码使用本地临时 clone 只读取证；文档不记录 clone 路径、账号、房间号、BV、
内部场次键或任何真实主机名/IP。

## 证据

### 1. biliup：有“边录边传”先例，但并非严格 0 落盘

上游 biliup 仓库（Python/Rust 同仓）HEAD `f81fd01a`（2026-10-15）：

- README 明确宣称“边录边传 0 落盘”（`README.md:30`），并说明 sync-downloader 把直播流
  remux 成 Matroska 写到 stdout，按 `file_size`（默认 2.5 GB，向上对齐 10 MiB）切片上传
  （`README.md:166-192`）。
- README 写默认 2.5 GB，而 `align_file_size` 的代码缺省值是 2 GiB（`sync_downloader.rs:285-292`）；
  这处文档/代码差异不改变“必须先声明每 P 大小”的结论。
- 同一段 README 同时写明：录制期间每 P 会写入系统临时目录作为兜底；预传完整且校验一致才
  complete，否则按实际长度从临时文件重传（`README.md:189`）。因此上游自己的“0 落盘”是
  **以临时文件为兜底的低落盘**，不是不产生任何中间文件。
- `sync_downloader.rs:20-24` 注释说“默认不落盘”，但 `pump_chunks` 实际同时打开
  `save_path` 并逐块 `write_all`（`sync_downloader.rs:189-283`）。临时文件不是可选项。
- `sync.rs:140-141` 先把每 P 目标大小向上对齐；`sync.rs:306-370` 每段先
  `start_segment`，再 `pre_upload_stream(..., total_size)`，再 `pump_chunks`。
- `sync.rs:475-535`：只有 `stream_complete` 且上传字节数与预声明大小一致时才直接
  complete；否则回退到临时文件上传。
- `sync.rs:538-567` 只提交紧接在已提交分 P 之后的分段，严格保序。
- `sync.rs:569-635` 首 P 投稿结果不确定时停止自动重试，避免生成重复稿件。

UPOS 协议的硬约束：

- `line.rs:315-330` 的 `preupload` 请求必须携带 `size: total_size`。
- `line.rs:388-401` 的 `pre_upload_stream` 只是允许在文件未完整时按**预声明大小**申请上传，
  不是允许未知长度的无限追加。
- `upos.rs:103-129`：`chunks_num = ceil(total_size/chunk_size)`；每个 chunk 参数都带
  `total`、`size`、`start`、`end`、`partNumber`，且由总大小和 chunk 索引预先计算。
- `upos.rs:152-205`：complete 前会校验 parts 连续（`sorted_parts`），不能有洞。
- `uploader.rs:110-145` 的常规 `VideoFile::new` 读取文件 `metadata().len()`；CLI 普通
  upload 从文件读取，不接受 stdin/FIFO。

biliup-rs 独立仓库 HEAD `56df8729`（2025-12-01）同样如此：

- `line.rs:165-190` preupload 带 `size`；
- `line/upos.rs:89-146` 按 `total_size` 预计算 chunks 和每块参数；
- CLI `upload` 只从 `VideoPath` 读取文件（`biliup-cli/src/uploader.rs:225-290`）。

stream-gears 的 Python 同步上传进一步说明协议假设：

- `bili_webup_sync.py:483-575` 用 `chunks = ceil(total_size/chunk_size)`，每块参数中的
  `total` 和 `size` 固定为预声明大小。
- `bili_webup_sync.py:623-689` 在流提前结束时用 `0x00` 补齐最后一个 chunk，前提是
  `max_size` 是 `chunk_size` 的整数倍。这是“预声明大小 + 内存队列/临时落盘兜底”，
  不是任意长度流的真正边产生边追加。
- 补零只能满足协议长度，不能把补出来的零字节当作有效媒体；本项目不能用它冒充完整视频。

### 2. 同类项目

#### biliup（Python/Rust）

它是目前最接近的先例：ffmpeg stdout → Matroska → 固定大小分 P → UPOS chunk 上传。
限制也最清楚：

- 需要预先给出每 P 的大小；
- 上传跟不上时回退到临时文件；
- 分 P 必须按录制顺序提交；
- 首投不确定时停止自动重试；
- 临时文件在投稿确认后才删除。

结论：可以做，但本质是**固定窗口 + 临时兜底**，不是“完全没有本地字节”。

#### BililiveRecorder

仓库 HEAD `2744d605`（2026-09-20）。它是录制/修复/弹幕/外部通知工具，未发现上传实现
（对 `Upload` / `upload` 的搜索结果为空）。`StandardRecordTask.cs:97-180` 直接从网络流解析
FLV 并写文件；`WriterTargetProvider` 在 `:290-330` 创建 `FileStream`。虽然有
`RecyclableMemoryStreamProvider`，但用于 FLV 处理缓冲，不是上传。

结论：没有可直接复用的边录边传实现；它证明“录制管线天然可以流式处理”，但最终仍以文件
作为持久化目标。

#### DanmakuRender

仓库 HEAD `ab8d3f3`（2026-10-10）。其 `sync_stream_downloader.py` 使用 streamlink +
`biliwebapi` 做边录边传（`docs/project_state.md:42-44`），但：

- `docs/usage.md:310` 明确写“正在测试，目前只支持 streamlink”；
- `streamlink_sync.py:46-121` 是 streamlink stdout → ffmpeg stdin → ffmpeg stdout →
  内存队列，队列积压超过约 10 MiB 就判定输出阻塞并杀掉录制；
- `biliwebapi.py:470-535` 的 UPOS 上传按预声明 `total_size` 计算 chunks；
- `biliwebapi.py:631-680` 在流提前结束时用 `0x00` 补齐尾块；
- `docs/project_state.md:171-191` 明确 B 站上传失败会从 0 重传，每次新建 `upload_id`；
  只有 YouTube 有字节级续传。

结论：同样是“内存窗口 + 预声明大小 + 失败重传”，且上传状态主要靠内存；对无人值守的
多节点录制不够稳。

### 3. 本仓库现状与接入点

#### 录制引擎目前只写文件

- `packages/record-engine/src/engines/ffmpeg` 文件 `:26-40` 构造
  `-f segment ...` 的分段模板或单文件 TS 输出，输出目标始终是磁盘路径。
- 同文件 `:43-68` 只从 stderr 解析分段打开事件和 `time=`，stdout 被
  `ignore`，没有媒体管道。
- `packages/record-engine/src/engines/mesio` 文件 `:38-95` 直接给 mesio 输出目录与文件名模板，
  产物是 `.flv`，同样没有 stdout 媒体流。
- `packages/record-engine/src/index` 文件 `:132-165` 把 `dir/nameBase/segSec` 交给引擎，并在
  `onSegment` 回调里通知 manager；所有分段都是真实文件。

因此，若要接 0 落盘，第一道改动不在 biliup，而在录制引擎：需要新增一个“stdout 媒体流”
模式（或一个新的 streaming engine），并重做分段、进度、卡死看门狗、断流重连和收尾语义。

#### 边录边传只在“已封口文件”上工作

- `packages/core/src/rolling` 文件 `:9-14` 的五条硬不变量：只处理已封口分段；确认后才删源；
  `.xml/.ass` 不删；不销毁唯一副本；低水位只拒新开录。
- 同文件 `:62-113` 的封口判定依赖分段文件和后继分段；正在写的文件永不上传。
- 同文件 `:145-166` 删源要求“封口 + 上传确认 + 房间身份一致”。
- `packages/app/src/rolling-upload` 文件 `:1-20` 明确只处理封口分段。
- 同文件 `:276-359` 崩溃恢复依赖 `uploading` 意图与 `countVideoParts`。
- 同文件 `:402-455` 封口后才进入上传，失败/不确定保留源并做头阻塞。
- 同文件 `:460-514` 首段建稿、后续 append，每次上传前写 WAL 意图。
- 同文件 `:516-544` 只有封口 + ack + 房间身份一致才删该段源。

这意味着“0 落盘”不能简单塞进现有 `RollingUploader`：它目前的设计前提是“源文件存在且已
封口”。流式上传需要另一套状态机，不能复用“封口文件即上传单位”的假设。

#### 节点侧整场上传同样以文件为输入

- `packages/app/src/node-pipeline` 文件 `:429-539` 的 `produceParts` 先 remux/merge/硬链接成
  `parts` 文件，再上传。
- 同文件 `:678-688` 上传前用 ffprobe 自检；读不出时长就拒投。
- 同文件 `:690-798` 落 `uploading`、建稿、逐个 append，并写 `confirmedParts` /
  `intentPart`。
- 同文件 `:799-807` 建稿后失败记 `failed`，无 BV 的失败保持 `uploading` 表示
  结果不确定。
- 同文件 `:816-846` 上传成功后才清源；`.xml` 一律保留。

流式上传会绕开 `produceParts` 的“完整文件自检”。若没有等价的媒体完整性校验，B 站可能
收下坏分 P（建稿返回 `code: 0`，转码阶段才暴露 `state=-16`）。

#### biliup 调用与硬常量

- `packages/processors/src/run-biliup` 文件 `:97-112` 的 `upload` 参数固定带
  `--submit web`、`--copyright 1`、关水印 `watermark.state=0`，private 时带
  `--is-only-self 1`。
- 同文件 `:196-207` 的 append 同样带关水印和私密设置，避免追加时重置整稿属性。
- 同文件 `:240-256` 用 `view?bvid` 查分 P 数；同文件 `:268-304` 的 append
  幂等判定依赖“失败后分 P 数是否变多”，查不到就抛 `APPEND_AMBIGUOUS_MARKER`。

任何流式上传都必须复用这些硬常量，不能另起一套 biliup 调用。

#### 限流与 21540

- `packages/core/src/upload-contract` 文件 `:40-54` 目前只识别 `601`、`21566`；**未识别 21540**。
- `packages/core/src/upload-gate` 文件 `:320-420` 按账号键做冷却 + 滑动窗口，命中已识别的限流码
  才记冷却。
- plan 038（`plans/038_node_upload_queue.md`）把上传拆成
  `gate_wait → transfer → submit`，并规定 `submit` 永不 kill、传输只按字节停滞判死；
  边录边传共用 lane 仍待 PR4。

T14 实测背景：

- 边录边传使用 120 秒分段；
- 前 4 段成功；
- 第 5 段被 B 站 `21540 请求过于频繁` 拒绝；
- 当前样本里 `tcp.acked` 比 `rchar` / `wchar` 更接近真实网络进度；`rchar` 在传输完成后
  长时间不增长。

这不是“网络慢”或“磁盘写不下”的问题，而是**提交/请求频率**问题。0 落盘不会减少提交次数；
如果仍然每 120 秒 append，反而会让请求更连续、更容易撞上限。真正的缓解是降低提交频率
（更长分 P / 合并多个段再提交）、在提交层做 21540 识别与冷却、以及避免把“传输完成”误判成
“可以立刻提交下一个”。

## 方案对比

| 方案 | 是否严格 0 落盘 | 可行性 | 主要问题 |
|---|---|---|---|
| 纯管道：`ffmpeg stdout → biliup upload -` | 是（理论） | **不可行** | biliup CLI 只接文件路径；UPOS 需预声明总大小；分 P 与失败重传无法安全处理 |
| 环形内存缓冲 + 预声明固定 P 大小 | 接近（无持久文件） | **部分可行，PoC 候选** | 需要自研 UPOS 流式上传；断流/短流/失败无源可重传；内存上限与背压必须硬控；弹幕 xml 仍需落盘 |
| tmpfs / 小窗口 spool + 封口后上传 | 否（短窗口落盘） | **最现实** | 仍占内存/临时盘；需要容量预算与清理；失败时保留窗口内数据 |
| 保持现状 + 缩短分段 | 否 | **不建议** | T14 已证明 120 秒会撞 21540；更短只会更密 |
| 保持现状 + 延长分段/降低提交次数 | 否 | **保守基线** | 单 P 更大、失败重传代价更高；但能直接降低提交频率 |

### 为什么纯管道不可行

1. `biliup upload` / `append` 的参数是文件路径；`VideoFile::new` 会 `File::open` 并读
   `metadata().len()`。
2. UPOS preupload 的 `size` 是必需的；chunk 总数和每块 `start/end` 由总大小预先算出。
3. 直播流长度事先未知；只能选一个固定“每 P 大小/时长”，到点截断并 complete，再开下一 P。
4. 截断点必须落在可解析的容器边界；不能像补零那样伪造媒体尾块。
5. 网络失败时，纯管道没有已落盘字节可供重传；要么重录（直播流通常不可重放），要么保留
   窗口内数据。后者已经不是严格 0 落盘。

## 受影响的不变量与风险

| 不变量/风险 | 0 落盘的影响 |
|---|---|
| 弹幕 `.xml` 必须落盘 | 不受影响；`.xml` 仍必须写，不能随视频流走 |
| 封口后才上传/删源 | 流式模式没有“文件封口”信号，必须换成“分 P 边界 + 上传确认”状态机 |
| 分 P 严格按时间顺序 | 必须继续保序；流式更容易出现“后段先传完”的乱序 |
| 失败/不确定保留源 | 纯管道没有源；必须保留窗口或明确转为人工不可恢复 |
| 断流重连 | 新连接会产生新的媒体流边界；同一场必须续同一稿件，不能重新建稿 |
| 上传前媒体自检 | 流式时无法先 ffprobe 完整文件；需要边写边校验或接受更高坏稿风险 |
| 关水印/私密硬常量 | 必须继续走现有 `run-biliup` 参数，不能绕过 |
| 21540/601/21566 限流 | 0 落盘不解决；反而可能增加提交密度 |
| 多节点重复投稿 | 仍需单节点闸门；流式不会让多节点问题消失 |
| 崩溃恢复 | 当前依赖 sidecar + 文件；流式需持久化分 P 边界、已确认 chunk/P 数、BV |

## 最小 PoC（不改业务代码、不真实上传）

目标：验证“固定大小 P + 预声明 UPOS + 顺序 append”在协议层成立，并量化缓冲与失败代价。

1. **离线合成流**
   - 用本地生成的测试媒体或本地 HTTP 流，`ffmpeg -c copy -f matroska -` 输出到 stdout。
   - 按固定字节/时长切成测试 P；不接真实直播。

2. **fake uploader**
   - 实现一个只记录参数的假 UPOS sink：记录每次 preupload 的 `size`、chunk 数、
     `total/start/end/partNumber`、complete 的 parts。
   - 断言：每个 P 的 chunk 数 = `ceil(total/chunk_size)`；parts 连续；顺序与输入一致。

3. **短流/断流/慢消费**
   - 模拟流提前结束、消费者变慢、进程被杀。
   - 断言：不会补零冒充媒体；失败时窗口数据可保留或明确标记不可恢复；不会重复 append。

4. **本地 HTTP sink 端到端**
   - 用本地假 B 站接口跑 preupload → chunk → complete → submit 的完整状态机。
   - 不接真实账号、不产生真实稿件。

5. **准入标准**
   - 通过：固定 P 协议参数正确、顺序正确、短流不伪造媒体、失败可判定且不重复提交。
   - 不通过：需要未知总大小、需要补零才能 complete、失败后无法证明未提交、或内存无上限。

## 明确不做 / 待决策

- 不把 `biliup upload -` 当作现成能力；当前上游 CLI 不支持。
- 不把“临时文件兜底”宣传成严格 0 落盘。
- 不在没有 21540 识别与冷却策略前，把边录边传提交频率进一步调高。
- 不在没有媒体完整性校验的情况下上线纯流式上传。
- 若要做 PoC，先只做假 uploader/本地 sink；真实上传仍需人工授权（T14）。

## 建议

1. **短期**：保持现有“封口后上传”的 rolling 路径，优先修 21540 识别、冷却和提交频率；
   同时评估延长分 P 或合并多个小段再提交。
2. **中期**：做 tmpfs/小窗口 spool 的 PoC，目标是把节点磁盘占用从“整场”降到“一个窗口”，
   而不是承诺严格 0 落盘。
3. **长期**：只有在固定 P 协议、断流续稿、失败可判定、媒体自检都通过后，才考虑纯内存
   环形缓冲 + 自研 UPOS 流式上传。

**一句话**：0 落盘上传在协议层“固定大小 P”是可行的，但在本仓库当前架构下应定义为
“低落盘/短窗口落盘”；纯管道方案不可行，且 21540 证明它不会自动解决上传限流。
