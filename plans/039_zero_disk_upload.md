# 039 — 上传即消费：不为备份而落盘

> 状态：设计稿 v1，**本文末节已附 2026-10-17 实测结论，与 v1 正文冲突处以附录为准**。未 accept。
> 目标读者：实现者。前置：`plans/031_rolling_segment_upload.md`、`plans/038_node_upload_queue.md`。

## 问题陈述

当前节点侧录像把「录制盘」当成了**备份介质**：每一段先落盘，等上传确认后才删。
这在需要烧录、需要选优、或者想要事后回看的房间是对的，但在
**「只要上传成功即可、不需要本地备份」** 的房间是纯浪费：

- 占的是最长、最紧张的录制盘（不是可清理的 stage，也不是对象存储）；
- 多房间并发时线性叠加（每房间一份整场长度）；
- 删源还带三重证据 + 头阻塞等复杂度，成本全花在保重复制上。

本计划的目标：**让「不需要备份」成为一条独立的录制路径**，该路径上视频不落盘，
只有弹幕仍写盘。

## 核心转变：解耦「分 P 边界」与「磁盘文件」

现状把三件事绑在一起：

1. ffmpeg 的分段（`segmentSec`）= 磁盘文件边界；
2. 磁盘文件封口 = 上传单元边界；
3. 上传单元 = 一个分 P。

本计划拆开：**上传单元（分 P）仍然按时间或按字节切，但不再对应磁盘文件**。
磁盘上只保留一个**上传缓冲**，用于承载「正在产生但还没传完」的那个分 P。

所以：

- 分 P 边界的**决策源**从「分段文件」改为「字节计数 / 时间计数」；
- 磁盘上的**唯一**持久对象是缓冲（环形、可覆盖）+ 弹幕 xml；
- 断流/网络波动时，**丢弃当前未完成的缓冲**，下一个缓冲是新的分 P，追加到同一稿件。

这与「分段数为 0（不分段）」配合：不分段时录制引擎根本不产文件，
缓冲按字节（或时间）封口 → 变成一个分 P。

## 数据流

```
直播流
  → ffmpeg（-f matroska -，容器可流式解析；不分段模式）
  → 上传缓冲（环形，容量 bufferCapMB，可选 spill 到盘）
  → 封口条件满足（字节阈值 或 时间阈值，策略见下）
  → preupload(size=预声明) → UPOS 分块上传 → complete
  → 分 P 确认（追 P 幂等查询）
  → 缓冲复位（丢弃已确认字节）→ 继续录下一个分 P
  → 所有分 P 追加到同一稿件
```

封口条件：

- **主策略：时间/字节阈值**。阈值直接决定投稿频率，与磁盘占用无关。
  「不分段」不等于「不分 P」——不分的是**文件**，分的是**上传单元**。
- **兜底：网络落后时降级**。缓冲写入速率 > 上传速率 → 缓冲涨 → 溢出策略（见下）。
- **异常：断流/重连**。当前缓冲直接丢弃（不重传、不补零），下一个缓冲是新分 P。

## 三个问题的答案

### Q1：分 P 大小怎么定？

由**封口条件**决定，与磁盘占用完全解耦：

| 模式 | 封口条件 | 磁盘占用 | 投稿频率 |
|---|---|---|---|
| 字节阈值 | `bufferCapBytes`（可配） | 恒定 = 缓冲上限 | 约 场长 / (阈值 / 码率) |
| 时间阈值 | `partSec`（可配） | 约 码率 × partSec（受缓冲上限截断） | 约 场长 / partSec |
| 混合（推荐） | 时间到 **或** 缓冲接近上限 | ≈ 缓冲上限 | 受时间控制 |

**推荐混合模式**：`partSec` 决定频率（用户可配，默认沿用现有任务的分段设置），
`bufferCapMB` 决定磁盘占用；两者解耦。当缓冲接近上限而时间未到时，提前封口以避免溢出。

### Q2：怎么保持同一个稿件？

已有设计直接继承，不需要新概念：

- **稿件**：按 `(platform, roomSlug)` 聚成一场，`streamKey` 含日期。断流重连产生新会话，
  仍是同一 `streamKey`，因此续同一稿件。
- **分 P**：一个 UPOS upload_id 就是一个分 P = 一次完整 upload 生命周期。

「一直上传到同一稿件」= 首个分 P 建稿拿稿件标识，之后每个新分 P 都追加到该稿件。
现有 `RollingUploader` 的 WAL 意图标记、分 P 数幂等核对、头阻塞全部复用。

### Q3：网络波动怎么办？

关键洞察：**网络波动时直接丢弃当前未完成的缓冲**，把「丢一段」当成正常路径而非异常。

| 情况 | 行为 | 理由 |
|---|---|---|
| 缓冲溢出 | 丢弃溢出部分，提前封口 | 直播不可重放；宁可少几秒，不可写满盘 |
| 网络断开 | 缓冲冻结，续上后继续传当前缓冲 | 缓冲还在，可以续 |
| 进程被杀 | 缓冲丢失（若纯内存）；重启后**新起一个分 P** | 服务端已确认的分 P 数是权威，重启不重复 |
| 缓冲损坏/无法续传 | 丢弃，新建分 P | 与网络断开同等处理 |

**丢弃未完成缓冲的语义要明确**：这会在稿件里产生一个**内容缺口**（分 P 少几秒），
但不会产生「重复分 P」或「乱序分 P」。头阻塞机制保证后续分 P 仍然按序追加。

## 背压与降级

| 档 | 条件 | 行为 | 占盘 |
|---|---|---|---|
| **流式** | 缓冲 < 上限 | 边录边传 | ≈ 0（纯内存）或 ≤ 缓冲上限 |
| **溢出保底** | 缓冲 > 上限 | 丢弃溢出字节，封口 | 0（仍不落盘） |
| **（可选）真落盘** | 配置开启 | 溢出字节落盘做兜底 | ≤ `spillCapMB` |

**默认不落盘**。若节点磁盘水位告急，可开启「真落盘」作为兜底，但那是可选项。
本设计的所有压力都在内存/缓冲里解决，录制盘不参与。

## 接入点

### 1. 录制引擎（新增分支，不改现有）

现有 `EngineSpawnArgs` 强制给 `dir` + `nameBase`，输出必然落盘。
新增「无盘」模式：

- ffmpeg 参数从 `-f segment -segment_time` 改为 `-f matroska -`（stdout），
  加 `-movflags +frag_keyframe+empty_moov` 保证容器可流式解析；
- stdout 管道接缓冲层，stderr 仍按现有逻辑解析 `time=` 喂看门狗；
- `sessionFirstPath` 改为「虚拟路径」（仅用于推导 `.xml` 的 base），不指向真实文件。

现有 ffmpeg / mesio 引擎**完全不动**，新引擎是并列选项，默认关闭。

### 2. 缓冲层（新增）

一个「按字节读写 + 可封口 + 可丢弃」的队列：

- `write(chunk)`：写入；到上限时触发封口或丢弃（按策略）；
- `freeze()`：封口当前缓冲，返回其只读视图给上传层；
- `reset()`：丢弃已确认字节，为下一个分 P 开始；
- 保留 `frozenAtMs` / `frozenBytes`，供 WAL 与诊断。

### 3. 上传层（复用现有，不新写）

现有 `RollingUploader` 已经处理了：建稿/追 P、WAL 意图标记、分 P 数幂等核对、头阻塞。
改造点：输入从「已封口的分段文件路径」改为「封口的缓冲视图」；「删源」改为「丢弃缓冲」。

### 4. 不变量（全部继承 + 一条新增）

继承 core 的 rolling 判定模块五条 + `plans/033` 十二条：

1. 只处理已封口的分 P；正在写的缓冲永不上传、永不丢弃。
2. 分 P 确认后才丢弃对应缓冲；未确认一律保留（可重试）。
3. `.xml` / `.ass` 不删（本来就不在缓冲里）。
4. 头阻塞：某 P 结果不确定时，其后所有 P 不外发。
5. 断流重连续同一稿件，不重新建稿。

**新增**：未完成缓冲的丢弃是**允许的**（与「未确认分 P 保留」不同）——
未完成 = 服务端还不知道它存在，丢弃不产生重复风险。

## 与提交频率的关系

本设计**不改变投稿频率的调节手段**——`partSec`（封口时间阈值）直接控制它：

- 现在的 120 秒分段撞 21540，是「封口时间 = 120 秒」导致的；
- 本设计让封口时间与磁盘解耦，所以调大封口时间不再付出磁盘代价；
- 要解决 21540，调 `partSec` 即可，与本设计正交。

## 不需要备份的房间 vs 需要备份的房间

这是本设计最大的价值——**按房间分流**：

| 房间类型 | 路径 | 磁盘占用 |
|---|---|---|
| 只要上传，不需备份 | 本设计：流式 + 缓冲 | ≈ 0 |
| 需要烧录 | 整场管线（现有） | 整场 |
| 需要多节点选优 | 整场管线（现有） | 整场 |
| 需要事后回看 | 整场管线（现有） | 整场（直到上传完） |

只要把「不需要备份的房间」切到新路径，多房间并发时的磁盘压力立即下降，
且这些房间的失败不再需要「保留源、人工核对」的兜底。

## PoC 步骤（不改业务代码、不真实上传）

1. **容器可流式解析**
   - 本地合成流，`ffmpeg -f matroska -movflags +frag_keyframe+empty_moov -` 输出。
   - 断言：读到 200 MB 时容器可解析，不依赖尾部 moov。

2. **假上传端**
   - 记录 preupload 的 `size`、chunk 数、每块参数、complete 的 parts。
   - 断言：chunk 数与声明值一致；parts 连续；顺序正确。

3. **网络波动**
   - 模拟上传速度 < 录制速度（0.5×、0.1×），以及中途断网。
   - 断言：缓冲不会无限涨；丢弃溢出后分 P 仍然连续；断网续上后继续传当前缓冲。

4. **崩溃恢复**
   - 在「已 preupload 未 complete」「已 complete 未记 confirmed」两个点杀进程。
   - 断言：重启后不重复建稿、不重复追 P、不跳 P。

5. **并发房间**
   - 3 个房间同时录，各 256 MB 缓冲。
   - 断言：总占用 ≈ 3 × 256 MB，与 `partSec` 无关。

## 明确不做

- 不改现有 ffmpeg / mesio 引擎行为。
- 不改 `segmentSec` 默认值。
- 不在本计划里解决 21540 / 601 / 21566（那是提交频率议题）。
- 不做「严格 0 字节落盘」——纯内存 is the default, 落盘是 optional 兜底。
- 不烧录（烧录需要完整文件，走整场管线）。

## 待决策

1. `partSec`（封口时间阈值）：默认沿用现有任务分段设置，还是独立配置？
2. `bufferCapMB`：默认 256 MB 是否合适？纯内存 vs 允许 spill 到盘。
3. 首 P 的建稿时机：第一个分 P 传完就建稿（与现在一致），还是攒够两个 P 再建？
4. 房间分流：哪些房间判定为「不需要备份」？规则文件里加字段，还是任务开关？

---

# 附录：2026-10-17 实测结论（PoC v1）

> 本节由 `packages/processors/src/upos-stream.ts` + 隐藏命令 `_upos-upload` 的真实接口跑批得出。
> **未接生产路径**；测试稿件已由用户清理。此后所有新设计以本节事实为准。

## A. 协议实测（B 站 UPOS，`ugcupos/bup`）

| 事实 | 值 | 影响 |
|---|---|---|
| `preupload` 的 `size` | **必须**预声明，无默认 | 流式上传的分 P 边界必须有上界 |
| `size` 可以大于实际字节数 | 是 | 预声明「上界」而非「精确值」即成立 |
| `chunk_size` | 10 MiB（10 MiB 的 chunk） | 服务端指定，不要自己算 |
| `endpoint` | `//upos-cs-upcdntxa.bilivideo.com`（**带前导 `//`**） | 拼 URL 时须 `https:` + `//host`，不是 `https://` |
| `complete` 响应 | `{OK:1, key:"<bucket>/<name>.<ext>"}` | `key` **带 bucket 前缀**，且带扩展名 |
| 建稿 `videos[].filename` | 必须是 `key` 的 stem（剥目录 + 剥扩展名） | 填 cid 或原名 → `code 21015`「第(N)个视频可能上传过程出现问题」 |
| 单稿件分 P 上限 | ≤ 2 GiB / P（UPOS 上限） | 「一个直播一 P」不可能，必须分 P |
| 限流 | `preupload` 返回 HTTP 406 + `code 601`「您上传视频过快」 | **只在 preupload**，不在 chunk PUT |

### 致命细节：`complete` 的 `key`

```json
{"OK":1,"location":"ugcever/n261018ad…ts","bucket":"ugcever","key":"n261018ad…ts"}
```

`key` 与 `location` 的区别：

| 字段 | 形状 | 含 bucket 前缀 | 含扩展名 |
|---|---|---|---|
| `location` | `ugcever/n261018ad…ts` | 是 | 是 |
| `key` | `n261018ad…ts` | **否** | 是 |

PoC v1 只做了「剥扩展名」没做「剥目录」，且按 `location` 的形状推断 `key` 也带目录，
结果 stem 变成 `/n261018ad3xxx`（前导斜杠被当成目录）→ `21015`。
**修正后的唯一真理**（`upos-stream.ts` 的 `uposStem`，同时兜住三种形状）：

```
stem = basename(decodeURIComponent(path).replace(/^upos:\/\//, "")).replace(/\.[^.]+$/, "")
```

即：剥 `upos://` scheme → 取最后一段（剥全部前导目录）→ 剥扩展名。
`upos_uri`、`key`、`location` 三种输入都得到同一个正确 stem。

## B. 601 限流的真实形状（提交频率，不是带宽）

实测 8 个 8 MiB 分段（合计 63 MiB）连续上传：

| 段 | 结果 |
|---|---|
| 1、2 | 直接通过 |
| 3 | 601 ×4（30s→60s→120s→240s 退避后通过），单段耗时 454 s |
| 4、5 | 直接通过 |
| 6 | 601 ×2 |
| 7 | 601 ×2，耗时 94 s |
| 8 | 601 ×4，耗时 454 s |

- 总字节约 63 MiB，理论数秒；**实际约 18 分钟**，几乎全是退避等待。
- 说明限流与字节数/带宽基本无关，与**「建新分 P 的频率」**正相关。
- 这正是 `align_file_size` 存在的理由：分段越大，preupload 次数越少。

**结论**：分 P 大小同时决定两件事 —— 磁盘占用与提交频率。二者不是独立的旋钮。
本计划原稿「`partSec` 决定频率，与磁盘占用无关」**不成立**，按字节封口时两者同向。

## C. 上游参照：biliup 的边录边传（`crates/biliup-cli/src/server/`）

必须与 `biliup-rs` 的 `VideoFile` 区分 —— **后者只吃已封口文件**，前者才有流式：

| 文件 | 作用 |
|---|---|
| `crates/biliup/src/uploader.rs` `VideoFile` | `std::fs::File` + `metadata().len()` —— 只吃文件，**无流式** |
| `crates/biliup-cli/src/server/core/downloader/sync_downloader.rs` | 边录边传（`SyncDownloader` + `pump_chunks`） |
| `crates/biliup-cli/src/server/common/sync.rs` | 分段循环 + 稿件提交编排 |

`sync_downloader.rs` 的关键实现：

```rust
pub fn align_file_size(file_size: Option<u64>) -> u64 {
    const MIN: u64 = 10 * 1024 * 1024;
    const DEFAULT: u64 = 2 * 1024 * 1024 * 1024;   // 缺省 2 GiB
    size.div_ceil(MIN) * MIN                        // 向上对齐 10 MiB
}

// ffmpeg: -fs <max> -c copy -f matroska -   （stdout）
// pump_chunks: 同时写临时文件 + 切块给上传通道
```

**它也不是 0 落盘**，是「spool 文件 + 尽力预传」：

- `pump_chunks` 每块先 `save.write_all()` 落盘，再 `tx.try_send()` 送上传；
- 通道跟不上 → `sender.take()` 放弃预传，**继续完整落盘**；
- 取消/停止 → 只结束本段，已写字节按 `actual_size` 保留，回退为文件上传；
- 注释原话：「本地写盘不受网络影响，不参与取消竞争」。

**分 P 上限 = `-fs` 值**，每一段是独立的 ffmpeg 进程 + 独立 UPOS 会话：

```
record_segments loop:
  start_segment(total_size)                       # ffmpeg -fs total_size
  pre_upload_stream(&file_name, total_size)       # 每段新会话
  spawn(upload_byte_stream_parts(...))            # 上传任务
  pump_chunks(..., total_size, path, tx, ...)     # 双写
  pending.push_back(PendingSegment { seq, ... })  # 备队列
```

超过 `total_size` 不报错：ffmpeg `-fs` 到点自停 → 本段结束 → `next_seq++` → 重启 ffmpeg。
另有 `MAX_UNCOMMITTED_SEGMENTS` 背压，到上限强制先提交再录新段。

## D. 修正后的结论

| 原判断 | 修正 |
|---|---|
| 「严格 0 落盘做不到（size 必须精确）」 | **仍做不到，但理由更精确**：size 必须是已知上界；`-fs` 提供上界，代价是「一段一进程」 |
| 「小窗口 spool 最现实」 | **与上游一致** —— biliup 就是 spool + 尽力预传；这不是我们的发明，是可复制的成熟方案 |
| 「`partSec` 与磁盘占用解耦」 | **错**。按字节封口时二者同向：分 P 越大 → 盘占用越高、提交越少 |
| 「单 P 可行」 | **不可行**。UPOS 单 P ≤ 2 GiB，长直播必然分 P |
| 「601 是网络问题」 | **错**。是 preupload 频率，退避有效但耗时暴涨 |

## E. 下一步建议（分阶段，先设计后动手）

1. **阶段 1**（低成本，可直接做）：分段从「30 秒」改为「按字节」（复用 ffmpeg `-fs`），
   默认 1 GiB，测试档 100 MiB。**不动录制引擎、不动 hub**，只改 `buildFfmpegArgs` 的
   `-segment_time` → `-fs` + `-segment_format mkv`。封口仍走现有 `onSegment` →
   `RollingUploader`。收益：提交频率大降（601 消失）+ 磁盘占用基本不变。
2. **阶段 2**：`readChunk` 从「整文件读内存」改为分段文件流式读，去掉 PoC 的内存翻倍。
3. **阶段 3**（可选）：`pump_chunks` 式双写降级，作为阶段 1 失败回退。
4. **不做**：纯内存环形缓冲（断流即丢，且需自证「未重复提交」）。

## F. 纪律教训（本轮）

- PoC 为二分调试**新建了 6 条测试稿件**，本可全部 append 到一条。B 站无删稿 API，
  清理代价由用户承担。此后任何真实投稿必须先获得显式确认，且优先追加而非新建。
- 汇报时把「上传路径打通」说成了「链路打通」，而落盘那一步行径未变 —— 措辞失实。

---

# 附录 B：2026-10-19 —— PoC v2（边录边传可用版）

> 状态：代码在 `codex/research-zero-disk-upload`（**未合并 / 未部署 / 未开 PR**）。
> 入口：隐藏命令 `_live-pump <room>`；模块 `packages/processors/src/live-pump.ts`。

## B1. 相对附录 A 的变化

| 项 | 附录 A（v1） | v2 |
|---|---|---|
| 容器 | matroska（写 stdout 会失败） | **mpegts**（带音轨、强杀后可读时长） |
| 上传时机 | 先录完整段再传 | **边录边传**（ffmpeg 还在录，块已在传） |
| remux 补 trailer | 必须 | **不需要**（TS 每包自带 PTS） |
| 音轨 | 丢（`-map 0:v` 绕 matroska 缺陷） | **保留** |
| 峰值占盘 | 一个分段 | 队列缓冲（≈0）+ spool 兜底 |
| 失败回退 | 文档承诺、**未实现** | `reuploadSpoolFile` 整文件重传 |

## B2. 为什么换 TS 是决定性的

附录 A 结论「严格 0 落盘做不到」的**理由错了**：不是协议不允许，是 matroska 不适合管道。
实测同一输入：

| 容器 | stdout 管道 | 带音轨 | `-fs` 强杀后 duration |
|---|---|---|---|
| matroska | ❌ `Error parsing AAC extradata` | — | 缺失（B站拒 → `62002`） |
| **mpegts** | ✅ | ✅ `audio,video` | ✅ 6.99s |

生产路径一直上传 `.ts` 分 P 且稿件「开放浏览」，容器是被验证过的。
于是「先录完再传」的唯一理由消失，边录边传成立。

## B3. 实测数据（真实直播间）

| 轮次 | 房间 | 配置 | 结果 |
|---|---|---|---|
| 单段 | <房间> | 100MiB cap | 1 稿 1 P；0 次 601 |
| 多段 | <房间> | 5 × 60s | 1 稿 **5 P**，durs=[62,62,62,63,62]；0 次 601 |
| 断流 | <房间> | 4 × 60s，中途 kill ffmpeg | 1 稿 **4 P**，durs=[63,63,51,64]；自动重取流续录 |
| TS 流式 | <房间> | 3 × 60s | 3 段成功（但每段丢尾，见 B4） |

## B4. 修掉的真 bug（都是实测打出来的，不是推想）

1. **尾块静默丢弃**：3 段各传 20.0MiB、spool 却 26.5MiB，每段丢约 3 秒视频。
   日志只打块数，**完全看不出异常**。两个成因：① `live-pump` 仍校验
   `chunk.length === size`，把合法短尾块判成故障（`uploadChunks` 本已支持）；
   ② 尾块在读循环退出后才入队，而上传侧在那之前就要它的大小 → 按满块算。
   修法：单一幂等 `pushTail()`，在结算点当场入队。
   **回归测试**：`上传总量 == spool 实际字节`（变异验证：把那行校验加回去，测试立刻复现 `3072 vs 3600`）。
2. **`maxMs` 从未下发**：`pumpSegment` 收了 `maxMs` 却没传给 `runSegment`，
   「谁先到算一 P」退化成只有字节兜底。
3. **ffprobe 自检**：`BV1xx` 被 B站拒成 `62002`，根因是 matroska 缺 trailer
   读不出时长。T-53 早有「读不出即拒投」，当时漏了。
4. **回退路径只写在注释里**：四处文档承诺「回退文件上传」，代码没有。失败段的字节
   白躺盘上。已实现 `reuploadSpoolFile`。

## B5. 协议事实（v2 新增/修正）

- `complete` 接受 **少传**：声明 `chunks=N`、只传 `M<N` 个连续 part → `OK:1`（实测）。
  → 附录 A「尾块必须精确等于声明值」**是错的**，从没验证过；它还把不必要的约束写成了规则。
- `chunks` 参数服务端不强校验。
- 尾块长度可以是 `0..chunk_size` 任意值，**不补零**。

## B6. 接入生产前仍缺

1. `RollingUploader` 契约扩展（`path` → `bytes`），才能让房间选这条路径。
2. 补真实断流重试场景，验证退避后仍续同一稿件。
3. 在线直播间做一轮至少 3P 的单稿实跑。

## B7. 直播复核（2026-10-18）

真实直播间跑通两轮，均为私稿：

| 轮次 | 配置 | 结果 |
|---|---|---|
| 1P | 100MiB cap / 20s | 8,771,328B 上传与 spool 完全一致；时长 22.071s；无回退 |
| 2P | 100MiB cap / 12s × 2 | 两段 5,603,340B / 4,883,300B；14.002s / 12.370s；服务端回读 2 个 cid |

两轮均在 ffmpeg 退出前完成首块上传，`usedFileFallback=false`。同时补了段间取流退避：
5s / 10s / 20s …，默认最多重试 5 次，避免短暂抖动被误判成收播。

## B8. 单稿状态机（2026-10-18）

PoC 原先“所有段完成后一次建稿”，不满足“P1 完成即上传、后续 P 继续追加同一稿件”。
现由 `LivePumpSession` 持久化 `live-pump-<room>.` + session 状态文件：

- P1 `complete` 后立即建稿，拿到 `bvid/aid` 即落盘；
- 后续 P `complete` 后先 `GET /x/vupre/web/archive/view` 读取完整 `archive + videos`，
  再把新 P 追加到**完整列表**后提交 `edit`。只发新 P 会覆盖掉旧 P，禁止；
- 请求前写 `pending` WAL（create/append），进程崩溃后按稿件 stem 核对：已提交则补确认，
  未提交才允许重试；建稿结果不明时按精确标题查稿件，查不到或匹配多于 1 条即转人工；
- 头阻塞：有 `pending` 或未确认 P 时拒绝提交后续 P，避免把失败 P1 误当“已有稿件”；
- spool 在对应 P 被稿件确认后才删除；失败/不确定时保留，作为整文件回退源。

测试覆盖：P1→P2→P3 同一稿件、完整 `videos` 列表、确认后清理、失败保留、
create/append 崩溃恢复、标题歧义、网络不可达、WAL 写失败。

## B9. 真实单稿多分 P 验证（2026-10-18，房间 <房间>）

- 一次在线跑出**同一稿件 5 个分 P**：`BV1xx`（aid ``<aid>``，私稿）。
- 服务端 `x/vupre/web/archive/view` 回读 `partCount=5`，5 个 cid 各不相同；P1 建稿、后续逐个 `edit` 追加。
- 每段 2 块、约 16MB、时长 41~47s；`usedFileFallback=false`、`sessionLeaked=false`、`backpressured=false`。
- 确认过的 spool 全部删除；残余孤儿 spool 已人工清理。
- 真 bug（真实跑出来）：续跑/恢复后 CLI 用本地段号 `index=seg` 提交 → 复用已确认索引、
  覆盖分 P 记录、新段 spool 泄漏。改为按已确认最大索引续号 + 回归用例。

## B10. 接成任务开关（2026-10-18，commit `<sha>`）

此前 0 落盘只能靠隐藏命令 `_live-pump` 手动跑；现在 `streamUpload` 是**一等任务字段**，
走完整任务链路：DB 列 → `TaskStore` → hub 同步 → 录制子进程 argv → Web 表单 → API 门禁。

- **互斥**：`streamUpload` 与 `rollingUpload`/`rollingEffective` 不能同时开（一个不写盘、一个靠文件传）。
  判定只在 core 一份 `streamUploadConflicts()`；`/api/tasks` 建/改任务、房间规则回写都调它，
  冲突回 400 且**不落库**。`buildRecordArgs` 另有兜底：两者同真时只下发 `--stream-upload`，
  否则子进程会因互斥检查 `exit 2`（表现为任务莫名起不来）。
- **输出格式**：0 落盘不产生文件，格式无对象可作用 → `OutputFormatLock` 新增 `"stream-upload"`，
  `resolveNodeOutputFormat` / `shouldConvertAtSeal` 一律回落 `original`；前端按后端下发的原因锁下拉。
- **实验性徽标**：登记 `stream-upload`（layer=`task`，观察期 168h——丢的是没传完的那一段，没有源文件可回退）。
- 旧库/旧节点向后兼容：`ensureColumn` 默认 0；旧 master 不下发该字段 → 节点按 false（照旧落盘）。

真实实跑（容器内，房间 <房间>，私稿）：

| 场景 | 命令 | 结果 |
|---|---|---|
| 8 段字节结算 | `_live-pump --size 25MiB --segments 8` | 同一稿件 `BV1xx`，服务端回读 **8 个分 P**（cid 各不同），8/8 无回退、无泄漏、无背压，spool 逐段删除 |
| 任务链路 + 时长结算 | `record --stream-upload 1 --stream-upload-size 25MiB --stream-upload-sec 45` | 稿件 `BV1xx`，每段 2 块 ~17MiB / 45s —— **时长上限先到**即结算（字节未到 cap），与设计一致 |

第二行是对 `buildRecordArgs` 实际下发 argv 的直接验证（同一参数集）。

## B11. 弹幕落盘 + 取流超时（2026-10-18，commit `<sha>`）

**弹幕**：0 落盘路径此前绕过 `RecordingSession`，`.xml` 完全不产出。现在 `record --stream-upload`
自己连平台弹幕（`platform.connectDanmu`），用**同一个** `XmlDanmuWriter`（从 `@drec/manager` 公开导出）
写会话级 xml，是该路径上**唯一**落盘产物。pump 保持平台无关：通过 `danmu` 接缝注入
`start/stop/xmlPath`，连接失败不阻断视频上传；`finally` 保证任何返回路径都停源。

**真事故（本轮实测跑出来）**：第 1 段确认后进程**静默停住** —— `acquireStreamWithBackoff`
直接 `await platform.getStream`，该调用可能永久挂起（DNS/socket 无超时），既不返回也不打重试日志；
弹幕 xml 还在增长，却再也不录下一段，也没有任何报错。现在每次取流有 30s 上限，超时与抛错都按
一次失败进入退避（5s/10s/20s…），不再冻结整个 pump。

**真实验证（房间 <房间>，私稿 `BV1xx`）**：

| 项 | 结果 |
|---|---|
| 分 P | **5 个**，同一稿件，服务端回读 5 个不同 cid |
| 时长 | 190s（每段 ~45s，**时长上限先到**，字节未到 25MiB cap） |
| spool | 每段确认后即删，结束时目录只剩 state + xml |
| 弹幕 xml | 会话同目录，含 `video_start_time` 锚点与 `<d>/<member>` 记录 |
| 修前/修后 | 修前第 1 段后静默卡死；修后连续跑到第 5 段 |

测试：danmu 接缝生命周期 2 例 + 取流挂起/抛错回归 2 例；`pnpm test` **2948 passed / 42 skipped**，
typecheck / arch:check / bundle 全绿。

## B12. 生产路径验证 + hub 边界（2026-10-18）

**真实 daemon 路径**（不是手工命令）：在隔离数据根起一个 `task serve`，通过
`POST /api/tasks {streamUpload:true}` 建任务、`POST /api/tasks/:id/start` 启动，观察到
`TaskManager` 真正 spawn 的子进程 argv 含 `--stream-upload 1`：

```
node dist/... record --room https://live.douyin.com/<房间> --quality origin --engine ffmpeg
  --danmu 1 --out .../recordings --segment 1800 --name su-e2e --stream-upload 1
```

同一次运行也验证了取流失败退避（抖音 `10011 当前服务繁忙` → 5s/10s/20s/40s/80s，
5 次后按收播收尾），以及弹幕 xml 正常落盘。该隔离环境出口拿不到流，未产出分 P；
分 P 的真实证据见 B10/B11。

**hub 边界（新 guard）**：0 落盘**不产生可扫描的录像文件**，而 hub 规则靠录像清单聚场/选优。
若把 streamUpload 任务绑成规则源，该房间会永远选不到 winner、卡在选优/收尾且无报错。
现在两个方向都回 400（同一句判定，复用 `ctx.recordingError`）：房间编辑把 sourceTaskId
指向 streamUpload 任务；已绑定规则的源任务再改开 streamUpload。

**结论**：`streamUpload` 当前是**单机/手动任务**能力，接 hub 规则必须先补
「上传结果如何回流 hub 台账」——已记入 TODO 下一步。

## B13. 更正与根因（2026-10-18，commit `<sha>`）

**更正 B11 的归因**：B11 把「第 1 段后静默停住」写成「取流无超时」。这个归因不完整 ——
实测 `probe` 正常、进程也没有 socket 在等网络。真正根因是**超时定时器被 unref**：

- B11 给每段取流加了 30s 上限，写成 `timer = setTimeout(...); timer.unref()`；
- 当 `platform.getStream` 永不返回时，这个定时器是事件循环里**唯一**的句柄；
- unref 后 Node 判定「没事可做」→ 事件循环空转，`Promise.race` 永不 resolve；
- 表现：进程存活、CPU 0、无 socket、无日志、不退出。任何重试日志都不会出现。

**修法**：不 unref。并补一个**真子进程**回归（esbuild 打单文件后 spawn），因为 vitest
自己持有句柄，测不出这个 bug。变异验证：临时加回 unref → 用例失败；移除 → 通过。

**实测**：修后同房间跑通 1 段（私稿 `BV1xx`，8.2MiB / 22.4s，无回退，spool 已清）。

**教训**：给「可能永不 settle 的 Promise」加超时兜底时，**兜底定时器本身必须 ref**；
否则兜底机制会在最需要它的时候把事件循环放空。

## B14. 重启续录验证 + 孤儿 spool（2026-10-18，commit `<sha>`）

**重启续录（真实）**：私稿 `BV1xx`，同一 spool 目录连续三次启动：

| 运行 | 结果 |
|---|---|
| run1 | part 0、part 1 确认进稿；随后 SIGKILL（part 2 录制中途） |
| run2 | `resumed state (2 parts)`，part 2、part 3 追加到**同一稿件**，编号连续 |
| run3 | `resumed state (4 parts)`，孤儿 spool 被清理，state 引用的 4 个 spool 保留 |

关键点：续跑按 state 里**已确认最大索引**续号，不重用索引；服务端回读分 P 数与 cid 均连续。

**孤儿 spool（真 bug，本轮跑出来）**：kill 在段中途时该段从未进 state，重启只新建文件，
旧 spool 永远没人删（实测 `live-pump-<ts>-<N>`，1.07MB）。修法：CLI 在启动 pump
前读 state 并清扫；放在 app 层，因为 processors 有静态守护禁止列目录。删除条件极窄：
本模块命名 + 不在 state + mtime 早于 10 分钟宽限 + unlink 成功；任何异常 best effort。

真实 CLI 验证日志：`清理上次中断遗留的孤儿 spool: live-pump-<ts>-<N>`，
state 引用的 4 个 spool 全部保留。单测 3 例覆盖孤儿/state 引用/新鲜/非本模块命名/宽限边界/目录缺失。

## B15. 真 0 落盘 + 分 P 时长跟随 segment（2026-10-18，commits `2941b12`/`a71bff4`）

**审计发现（重要更正）**：此前所谓「0 落盘」实际上每个字节都 `writeSync` 到 spool，
只是分 P 确认后再删 —— **峰值磁盘占用仍等于一个分 P**（默认 1GiB）。这不符合
「减少仅上传不需要备份的空间占用」的目标。

**修法：spool 可关**

| 模式 | 写盘 | 失败回退 | ffprobe 自检 |
|---|---|---|---|
| `full`（默认，行为不变） | 每段写 spool | 可整文件重传 | 有 |
| `none`（真 0 落盘） | **完全不写** | 无（该分 P 硬失败并显式报错） | 无（时长改用录制墙钟） |

接线：core 类型 → DB 列（默认 1，旧库向后兼容）→ store → hub 同步 →
`record --stream-upload-spool none`（仅显式关闭时下发）→ API → 任务弹窗子开关。

**分 P 时长跟随任务设置**：原实现只有显式 `--stream-upload-sec` 才有时长上限，
任务的 `segmentSec` 完全没传进 0 落盘路径。现在 `maxMs = --stream-upload-sec ?? --segment`；
`0`/缺失 = 只用字节兜底（即「不分段、按网络情况一直续传同一稿件」）。启动日志写明来源。

**验证**：单测覆盖 none 模式不创建任何文件、字节仍全部上传、失败必须报错；
真实 daemon spawn 已确认 argv 含 `--stream-upload-spool none` 且日志 `sec=30(--segment)`。
（该时段所有已知直播间离线，真 0 落盘的在线分 P 实测待下一个在播房间。）

### B15.1 真 0 落盘的真实 ffmpeg 证据（容器内）

用容器内**真实 ffmpeg** 生成 60s 测试流（640x360，12,094,228 字节），直接喂
`runSegment`，UPOS 侧用只接受 PUT 的假服务器（不建稿、不碰 B 站）：

| spoolMode | spool 文件 | PUT | chunks | streamed | spooled | 错误 |
|---|---|---|---|---|---|---|
| `none` | **不存在** | 1 | 1 | 10,485,760 | 10,485,760 | null |
| `full` | **存在** | 1 | 1 | 10,485,760 | 10,485,760 | null |

同一输入、同一字节数、同样上传成功，唯一差别是 `full` 在盘上留了 10MB 文件，
`none` 一个字节都没写。这就是「真 0 落盘」与「写完再删」的区别。

（宿主 ffmpeg 缺 libxcb，改在容器内跑；不涉及网络与投稿。）

## B16. 真 0 落盘端到端（2026-10-18，commits `83ac51d`/`42c3c39`）

**缺口 1 已补**（此前只有"块上传成功且不写文件"，没验证到建稿层）。

容器内**真实 ffmpeg**（本地 TS 源，不依赖直播间）+ 假 B 站（不建真稿），
`runLivePump` 以 `spoolMode: "none"` 跑 2 段：

```
段1 第 1 块完成,累计 1.0MiB
段2 已确认到稿件 BV1xx
段2 结束: 1 块 / 1.0MiB,无本地 spool(真 0 落盘),ffmpeg exit=0
{ ok: true, bvid: "BV1xx", segments: 2, calls: ["create","append"], videoFiles: [] }
```

即：2 个分 P 进**同一稿件**、`create` + `append` 各一次、**盘上视频文件 0 个**。

**顺带修掉两个真 bug**（都是这次端到端跑出来的）：

1. `runLivePump` 只把 `fetchImpl` 给了分段上传器，**没给** `LivePumpSession` ——
   假 UPOS 一路传完，建稿却打真实 B 站拿到 `-400`。任何自定义传输（测试/代理）
   都会在建稿处静默回落真实网络。已贯通，并补回归用例（假传输下必须看到
   `/x/vu/web/add/v3`），做了变异验证（移除传参即失败）。
2. none 模式时长用墙钟时间，`Math.round(ms/1000)` 把亚秒分 P 舍成 0 →
   「缺 duration(产物不可投)」把一个 67ms 的分 P 判死。改为保留两位小数、下限 0.001。

门禁：`pnpm test` **2965 passed / 42 skipped**，typecheck / arch:check / bundle 绿。

## B17. 多房间并发（2026-10-18，commit `<sha>`）

两个房间并发跑 `runLivePump(spoolMode:"none")`，各自独立 spool 目录、共享同一个假 B 站：

| 房间 | ok | 稿件 | 分 P | 盘上视频文件 | state 文件 |
|---|---|---|---|---|---|
| 111111 | true | ``BV1conc…`` | 2 | 0 | 按房间名分离 |
| 222222 | true | ``BV1conc…`` | 2 | 0 | 按房间名分离 |

即：**不串稿**（两个不同 BV）、状态互不污染、并发下仍是真 0 落盘。
回归用例已做变异验证：让假服务对两个房间返回同一 BV → 用例失败。

## B18. hub 守卫补洞（2026-10-18，commit `<sha>`）

**真漏洞**：`streamUpload` 不能当 hub 规则源的守卫写在 `ctx.recordingError` 里，
房间编辑与规则 PATCH 都调它，但 **`createHubRule` 自己内联查了一遍任务存在性**，
没调这个函数 —— 于是 `POST /api/hub/rules` 能把 streamUpload 任务绑成规则源，
造出一条**永远选不到 winner、卡在选优/收尾且无报错**的规则。

改为复用唯一判定（存在性 / 房间一致性 / 0 落盘），不再另写一份。
回归用例覆盖直接建规则这条路径，已做变异验证（移除守卫即失败）。

**结论**：0 落盘与 hub 规则的边界现在是**三条写入路径全部拒绝**（房间编辑、
规则 PATCH、规则新建），不存在能绕过的入口。真正的「上传结果回流 SyncLedger」
仍未做，仍记在 TODO 下一步。

## B19. 录制相位标记（2026-10-18，commits `17435af8`/`7b1d7f2f`）

**真缺口**：`TaskManager` 从子进程 stdout 解析 `[状态] 录制中` / `[状态] 等待开播`
来填任务的 `recording` 相位。0 落盘路径一条都不打 → 任务永远显示「进程在跑但没在录」，
用户无法区分「等开播」和「正在录」。

现在：进入段循环前打「等待开播」，拿到流后打「录制中」（只打一次，不刷屏）。
回归用例 + 变异验证（移除「录制中」即失败）。

**自查后否决的疑似问题**：`--output-format` 与 `--stream-upload` 同给时，流式路径在
`parseOutputFormat` 之前就 `return`，所以非法值不会 `exit 2` —— 不是 bug，
改动已回退，不留无谓 churn。

## B20. 停止不留孤儿 ffmpeg（2026-10-18，commit `<sha>`）

**真缺口**：0 落盘路径在安装共享 SIGINT/SIGTERM handler **之前**就 `return`，
所以停止一个 0 落盘任务时，正在录的 ffmpeg 没人杀 → 孤儿进程继续写盘。

修两处：
1. CLI 在启动 pump 前装自己的 SIGINT/SIGTERM handler，收到即 abort；
   `runLivePump` / `pumpSegment` 把 `AbortSignal` 贯通到 `runSegment`。
2. `runSegment` 对**已经** aborted 的信号补显式 kill —— `addEventListener`
   对已中止的信号永不触发，那种情况下 ffmpeg 永远不会被杀。

实测（容器内真实 ffmpeg）：abort 后分 P 干净失败、`ffmpeg_procs=0`（无孤儿）。
回归用例 + 变异验证（去掉已中止兜底即超时失败）。

## B21. 真 0 落盘在线验证（2026-10-18，房间 <房间>）

**缺口 1 已补**：真实直播间 + 真实 B 站投稿，`--stream-upload-spool none`。

| 阶段 | 结果 |
|---|---|
| 首次运行 | 10 个分 P 确认进稿件 `BV1xx`，日志每段写「无本地 spool(真 0 落盘)」 |
| SIGKILL 中断 | 段中途被杀 |
| 重启续录 | `resumed state (10 parts)`，又 6 个分 P 追加到**同一稿件** |
| 服务端回读 | `BV1xx`，**16 个分 P**、16 个不同 cid、duration 356s、state -6（审核中） |
| 磁盘 | 目录里只有 ``*.`*.session 状态文件``` + `xml`，**视频文件 0 个** |

即：真 0 落盘 + 中断续传 + 同一稿件，全部在真实链路上成立。

## B22. hub 台账回流 + 停止不作废已上传分 P（2026-10-18，commits `61d2d72e`/`2f79acfc`）

**台账回流**：新增 `orchestrator/recordStreamUpload` —— 0 落盘不产录像文件，
正常管线无对象可跑，房间会永远停在台账里没有结果。现在直接把「上传结果」写成终态
（pending → done + BV）。刻意收窄：只动台账状态，不碰文件、清理、对账。

真 bug（测试跑出来）：`markDone` 会覆盖已有 BV。B 站无删稿 API，覆盖会让台账指向一个
用户无法撤下的稿件，而真稿件反而看不见。改为终态即停手，返回**实际记录**的 BV。
另抽 `syncDbPathFor`（`<db>` → `<db>-sync.db`），与 serve 侧同一推导。

**停止不作废**（在线 SIGTERM 实测的 bug）：停止信号切断末段时 `runLivePump` 直接
`ok:false`，即使此前 4 个分 P 已全部入稿 → CLI 退出码非 0、台账不写，用户看到「失败」
而稿件其实已在 B 站。

修两处：① abort 落在「无任何数据」或「正好在 EOF」时进不了循环内判定，
收尾处补一次 `signal.aborted` 归类（否则 `sealedBy` 恒为 `eof`，守卫永不触发）；
② 末段 `sealedBy=abort` 且已有分 P 入稿 → 按成功收尾（该段仍带 `uploadError` 上报，不隐瞒）。

在线验证（房间 <房间>，真 0 落盘）：SIGTERM 后 `ok:true` + `台账已记录: BV1xx`，
服务端回读 4 个分 P / 152s / 4 个不同 cid。修前同场景 `ok:false` 且台账不写。

## B23. 多房间在线并发 + 21186 限流 + 退避留痕（2026-10-18，commit `<sha>`）

**在线多房间并发（缺口已补）**：两个直播间同时在线，各跑 `spoolMode:"none"`：

| 房间 | 稿件 | 分 P | 时长 | cid | 盘上视频文件 |
|---|---|---|---|---|---|
| <房间> | `BV1xx` | 3 | 119s | 3 个不同 | 0 |
| <房间> | `BV1xx` | 3 | 100s | 3 个不同 | 0 |

两个不同稿件、互不串稿、并发下仍零落盘。

**两个真问题（同场实测暴露）**

1. **`21186`「您投稿的频率过快,请稍等2秒」未被识别为限流**。两个房间同时开录时第二个的建稿
   被它拒掉 → 按「永久失败」处理 → 该分 P 已上传的 6.3MB 直接丢弃，房间整场零产出
   （零落盘下连本地副本都没有）。已纳入 core `isUploadRateLimited`，走既有冷却重试。
2. **preupload 的限流退避完全静默**：30s 起步、翻倍、封顶 300s、最多 9 次，总计可超 40 分钟；
   期间 ffmpeg 已在跑但一个字节不出、日志一行不涨 —— 形态上和「卡死」完全一样（本轮就因此
   误排查过几次）。现在每次退避都打一行（等待时长 + 第几次/共几次 + 文件名）。

回归：21186 识别用例，已做变异验证（同时去掉 code 与中文匹配即失败）。

## B24. 同房间双 0 落盘任务 guard（2026-10-18，commit `<sha>`）

**实测确认的风险**：同一房间被两个任务各录一次（state 文件按 `outDir` 隔离、互不知情），
产出**两个内容重复的稿件**（`BV1xx` / `BV1xx`）。B 站没有删稿 API，
这两个稿件用户永远撤不下来。

0 落盘是「每个启动的进程各建一个稿件」的模型，所以这不是罕见竞态，而是**配置写错时必然发生**。
在 `TaskManager.start` 挡：同房间已有 0 落盘任务在录 → 拒绝启动并写明原因。
普通录制任务不受影响（它们本来就是多节点各录一份，由 hub 选优去重）。

按「平台 + 房间 slug」判同房间，不用原始 URL 字符串比较（同一房间可能写成不同 URL 形式）。

回归三条：同房间第二个被拒（含日志原因）、不同房间互不挡、非 0 落盘不受影响；
变异验证：去掉守卫即失败。

### B24.1 同房间 guard 的真实 serve 验证

`task serve` 真实进程（非单测）里建两个同房间 0 落盘任务：

| 操作 | 结果 |
|---|---|
| 启动任务 1 | `status=running`, `running=true` |
| 启动任务 2 | `status=stopped`, `running=false`（被拒，未 spawn） |
| serve 日志 | `拒绝启动 id=2:同一房间已有 0 落盘任务 id=1(g1)在录,同时录会产出两个重复稿件且无法删除` |

即：拒绝原因对用户可见（日志里带任务 id / 名称 / 后果），不只是静默返回 false。

## B25. 窗口结束排空（SIGUSR2）—— 0 落盘路径的 P1（2026-10-18）

**根因**：0 落盘分支（`record --stream-upload`）**只**注册了 SIGINT/SIGTERM，而 daemon 窗口结束发的是
SIGUSR2（`TaskDaemon` → `TaskManager.stopGraceful` → `ChildRecorderProcess.stopGraceful`）。
Node 对无人处理的 SIGUSR2 的默认动作是**立即终止进程**（实测 exit 159）。后果两条：

1. 在录的那一段被腰斩。`--stream-upload-spool none` 下该分 P **没有本地副本**，视频永久丢失
   （不是延迟，是没了）。
2. `stopGraceful` 在发信号**之前**就置 `expected = true`，所以进程被杀后 `task-manager` 必然打印
   「直播自然收播，排空完成，已停止」—— 一句与事实相反的话。用户据此判断覆盖率/完整性。

又：0 落盘路径不经过 `RecordingSession`（它替换了落盘录制器、接管整个进程），465 行之后那个
`RecordingSession` 的 SIGUSR2 handler 对这条路永远不生效（397 行就 `return` 了）。

**修复**（方案 4：信号量接缝，非回调）
- `@drec/processors` 新增 `RunLivePumpOptions.drainSignal?: AbortSignal`；分段循环**顶部**读它
  → 只停「开下一场」，当前段照常传完入稿。与 `signal`（abort = 腰斩）职责分开。
- `cli record --stream-upload` 在 `runLivePump()` **之前**注册 `process.on("SIGUSR2")`，
  abort 一个独立的 AbortController 并作为 `drainSignal` 传入。幂等（daemon 每 tick 重发）。

**为什么不是回调/`onReady`**：信号到达前 handler 必须已存在。把 handler 放在 pump 起来之前，
这一点天然成立；回调方案反而要多守一道时序。语义与 `record-engine` 的 `drain()`
（只清开播轮询不腰斩当前进程）同构。

**回归**（9 条，含两条变异验证）
- `live-pump.test.ts`「窗口结束排空」4 条：对照组录满上限 / 首段后排空只录 1 段且入稿 /
  排空早于首段空手收尾 / drain 与 abort 并存时 in-flight 段仍被腰斩（证明两信号没混）。
- 「真子进程」2 条（esbuild bundle + `execFile` + `kill SIGUSR2`）：有 handler → `stoppedBy:"drain"` exit 0；
  删掉 handler → stdout 空 + 非 0 退出。（vitest 自带 signal handler 且持句柄，Node 默认动作在里面不触发，
  只能以子进程复现 —— 也就是 `record` 在 TaskManager 下的真实形态。）
- `test/arch/zero-disk-drain-guard.test.ts` 3 条 grep 守护：CLI 0 落盘分支内必须同时有
  `process.on("SIGUSR2"`、`drainSignal:`，且 SIGUSR2 块不得与 abort 共用。
  为什么需要 grep：删掉 CLI 那一行，行为用例仍然全绿。
- 变异验证：删 pump 的 `if (o.drainSignal?.aborted) break;` → 3 条排空用例失败、对照组仍过；
  删 child 的 handler → 真子进程用例失败；删 CLI 的 handler → grep 守护 2 条失败。

**夹具坑（记录，避免重蹈）**：每段必须 > `MIN_PART_BYTES`（1MiB），否则 pump 判「已收播」提前 break，
第二段根本不存在；而大 buffer 的假 ffmpeg 又会因同步 resolve 的假 fetch 追不上而稳定判背压
（spoolMode:none 下是硬失败）。两者都要满足只能靠 `installFakeFfmpeg` 的 `chunkEvery/delayMs`
压住写入速率，`delayMs: 1` + `chunkEvery: 64KiB` + 12MiB 可用。

**验收**：`pnpm test` 2987 passed / 42 skipped（接手基线 2978，新增 9 条）；`typecheck` / `arch:check` 绿；
`pnpm bundle` 重建且产物含 `drainSignal`。

**未覆盖**：排空落在取流退避的 sleep 里（最长约 155s）会多录一个分 P，与 `PollingRecorder`
对「已在飞的 poll」同行为，未专门测试；未做 daemon → serve → 子进程的真实 SIGUSR2 端到端。

## B26. 拆包后的真实环境验证（2026-10-19）

在独立构建的验证容器（`--network host`，镜像含本分支代码）内跑真实路径，房间 <房间>（在播）。

| 验证项 | 结果 |
|---|---|
| 真 0 落盘上传（`--stream-upload-spool none`） | 稿件 `BV1xx`，9.9MiB / 1 块，`无本地 spool(真 0 落盘)`；盘上**只有 `*.`*.session 状态文件`` + 弹幕 xml，零视频文件** |
| 多分 P 续同一稿件 | 容器手工跑 `_live-pump` → `BV1xx`，20.0MiB / 2 块 / 119s，`usedFileFallback=false` / `backpressured=false` / `sessionLeaked=false`，spool 已删 |
| serve 真实 spawn 的参数 | `[rec] 流式直传(0 落盘)已开启:… sizeCap=… sec=90(--segment) tid=21`（证明任务开关 → argv 接线通） |
| 同房间 guard（B24）在真实 serve 下 | `拒绝启动 id=5:同一房间已有 0 落盘任务 id=4(zdverify4)在录,同时录会产出两个重复稿件且无法删除` |
| 停止（SIGTERM） | `收到 SIGTERM,停止录制并中止当前分 P` |
| **窗口结束排空（SIGUSR2，B25 的 P1）** | 分 P 正在传时 `kill -USR2 <pid>` → 进程 **ALIVE**（未被杀），继续把当前段传完。**对照**：无 handler 时 Node 默认动作当场杀进程（实测 exit 159，见 B25 真子进程用例） |
| 台账回流 | `[stream-upload] 台账已记录: BV1xx` |

**验证中发现并修掉的缺陷**：排空**不打日志**。方案 4 的实现里 SIGUSR2 只 abort 一个 controller，pump 在循环顶部读到就 break —— 排空后往往还要等当前分 P 传完或 preupload 退避（实测可达数分钟），而「没有新分 P 出现」与「卡死」在日志之外**完全无法区分**。
已补 `[live-pump] 窗口结束已排空:不再开录下一场,当前分 P 传完后收尾`（只打一次），并加断言。

**环境限制（非代码问题，记录以免重复排查）**：
- 宿主机 ffmpeg 不可用（brew tap `homebrew-ffmpeg/ffmpeg` 未信任，`libx265.216` 与已装的 217 ABI 不兼容，软链会因缺 `_x265_api_get_216` 失败）→ 端到端验证改在容器内做。
- 容器里 `task serve` 拉起的子进程取流持续 `10011 当前服务繁忙`，但同一容器手工跑 `record` / `probe` 取流正常 → 抖音对该出口/端点组合的风控，不是 0 落盘代码问题。排空验证因此用手工 `record` 进程做（一样是真实进程 + 真实信号）。
- 真实 B 站 `preupload` 命中 601 限流（30/60/120/240s 退避），符合既有设计（B23）。

**仍未覆盖**：daemon → serve → 子进程链路上的 SIGUSR2 端到端（daemon 窗口结束真实触发一次）。
