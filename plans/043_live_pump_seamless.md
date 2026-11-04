# 043 直播直传无缝分 P：一场一个 ffmpeg，关键帧处切 TS

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans 按任务逐个实现。Steps 用 checkbox 跟踪。

**Goal:** 直播直传（落 spool 与不落 spool 两种模式）切分 P 时不再丢直播内容，也不再因切分 P 误发开播 / 收播通知。

**Issue:** [#452](https://github.com/fuyucn/douyin-rec/issues/452)（`TODO.md` T-136）。

**Architecture:** 现在每个分 P 一个 ffmpeg（`-fs` / 时长到点即退出），封口后串行做 probe → 断档扫描 → complete → 提交 → 重新取流 → preupload，再起下一个 ffmpeg，期间没人拉流（实测 1.5GiB 分 P ≥58s 空档）。改为：一次取流连接只起一个 ffmpeg，stdout 持续输出 mpegts；新增纯函数模块 `TsCutter` 在视频关键帧的 TS 包边界切分 P，新分 P 开头补最近的 PAT/PMT；每个分 P 是一个「分 P 槽」（上传会话 + 队列 + 可选 spool 文件），切点时字节立即改写入下一个槽；旧分 P 的 complete / 提交在后台按顺序完成。ffmpeg 只在收播、停滞（300s 无数据）、停止 / 排空时退出。

**Tech Stack:** Node 24 / TypeScript / vitest。无新依赖。

## 已验证（2026-11-04，容器内 ffmpeg，20s 测试流）

- 单个 ffmpeg 输出 mpegts，按「视频 PID + PUSI + random_access_indicator」整包切 4 段，新段前置 PAT/PMT：视频包 600/600、音频包 939/939（音频逐字节一致），逐帧解码 md5 全一致，各段单独解码 0 报错。
- 待查：每段首个视频包的包级 md5 与源不同（解码一致）。Task 1 测试里按字节对比切点前后，确认我们的切分本身不改字节。
- 第 2 段起 PTS 不从 0 开始，本地可播；B 站转码 Task 6 实测。

## Global Constraints

- **字节守恒**：同一连接内，所有分 P 去掉前置 PAT/PMT 后按序拼接 == ffmpeg stdout 全部字节（测试钉死）。
- **分 P 不超声明 size**：preupload 声明的 `sizeCap` 是硬上界。触发阈值 = `sizeCap - margin`（margin = max(16MiB, 2 × 观测到的最大 GOP 字节)）；到 `sizeCap - 1 个 TS 包` 仍无关键帧 → 在当前包边界强切（字节不丢，新分 P 开头几帧不可解码，记日志）。
- **时长阈值**：`maxMs` 到点后在下一个关键帧切；时长按切点处视频 PTS 计算（不再用墙钟，也不再整文件 ffprobe）。
- **提交顺序**：分 P 索引在**切点**分配（不是提交时），complete / 提交串行链，严格按索引。
- **失败语义不放宽**：后台收尾失败（complete / 提交）→ 与现在相同：落 spool 时记未确认分 P，停止 ffmpeg，返回错误；不落 spool 时报「分 P 丢失」硬错误。不吞错。
- **背压**：沿用现有有界队列（默认 4 块 × 10MiB）；不新增内存缓冲。下一个分 P 的 preupload 在当前分 P 到 80% 阈值时提前做，切点时会话通常已就绪；未就绪则字节进新槽队列，满了按现有背压处理（落 spool → 整文件回退；不落 spool → 硬错误）。
- 不改：取流、弹幕、稿件状态文件格式、未确认分 P 恢复的数据结构（一个分 P 仍对应一个 spool 文件）。

## Review Focus

1. `TsCutter` 跨 Buffer 边界的半包、PAT/PMT 未出现前的数据、无视频 PID（纯音频）时的退化。
2. 切点处的尾块 / 首块：旧槽 `pushTail` 与新槽首块不能交错丢字节（重点看 `runSegment` 拆分后 `totalSizeOfNow` 语义）。
3. 后台收尾与新分 P 并发时，`session.nextPartIndex` 不能被两边同时用。
4. 停止 / 排空 / 停滞三条路径各自的最后一个分 P 如何收尾。

---

### Task 1: `TsCutter` 纯函数模块

**Files:** Create 模块 `packages/zero-upload/src/ts-cutter`（源文件 + 同目录测试）

- [ ] 输入任意切片的 Buffer，输出按 188 字节对齐的包；解析 PAT → PMT → 视频 PID（stream_type 0x1b / 0x24）；记录最近的 PAT/PMT 包。
- [ ] `push(buf) → Array<{ bytes } | { cut: true, reason }>`：调用方通过 `requestCut(reason)` 置位，遇到下一个视频关键帧包时在其前切；`forceCutAt(limit)` 处理 size 硬上界。
- [ ] 解析 PES 头的 PTS，给出每段视频 PTS 起止（33 位回绕处理）→ 分 P 时长。
- [ ] 测试（合成 TS，不依赖 ffmpeg）：字节守恒；只在关键帧切；新段首部 PAT/PMT；半包跨 Buffer；无 PMT 前的数据归第一段；强切；PTS 时长与回绕；纯音频流退化为在 PUSI 处切。

### Task 2: 拆 `runSegment` 为「源」+「分 P 槽」

**Files:** Modify `packages/zero-upload/src/live-pump.ts`、`live-pump.test.ts`

- [ ] `PartSink`：一个上传会话 + 有界队列 + 可选 spool fd；`write(bytes)`、`seal() → SegmentRunResult` 等价物（尾块、`totalSizeOfNow`、`sessionLeaked` 语义保持）。
- [ ] `runStream`：起一个 ffmpeg（去掉 `-fs`），stdout → `TsCutter` → 当前 `PartSink`；切点时 seal 旧槽、换新槽；停滞看门狗 / abort / 退出等待逻辑从 `runSegment` 原样搬过来。
- [ ] 现有 `runSegment` 的单测改为针对 `PartSink` + `runStream`，行为用例全部保留（尾块、背压、停滞、abort、孙进程占用 stdout）。

### Task 3: `runLivePump` 主循环改为「一个连接多个分 P」

**Files:** Modify `packages/zero-upload/src/live-pump.ts`

- [ ] 一次取流 → `runStream`，分 P 在切点产生；索引在切点分配。
- [ ] 后台收尾链：complete → （落 spool 时）断档扫描 → 提交 → `[状态] 分P已确认` / 事件；串行。
- [ ] 下一个分 P 的 preupload 提前（80% 阈值）；601 限流退避沿用。
- [ ] 排空（SIGUSR2）：到下一个切点时停 ffmpeg，最后一段照常收尾。停止（SIGTERM）：语义不变。
- [ ] 停滞：封当前分 P，走现有恢复窗口重新取流（新连接 = 新 ffmpeg）。
- [ ] `[状态] 录制中` 每个连接只打一次；`maxSegments` 按分 P 计数。
- [ ] 后台收尾失败 → 停 ffmpeg、返回错误（见 Global Constraints）。

### Task 4: 测试

**Files:** `packages/zero-upload/src/live-pump.test.ts`

- [ ] 假 spawn 产出多 GOP 合成 TS：一个连接产出 N 个分 P，spawn 次数 = 1；分 P 字节去 PAT/PMT 后拼接 == 输入。
- [ ] 提交顺序在后台收尾乱序完成时仍按索引。
- [ ] 两种 spool 模式各覆盖：正常、背压、complete 失败、排空、停止、停滞恢复。
- [ ] 切换期间录制状态不翻转（无 `[状态] 等待开播` / 进程退出）。
- [ ] 变异验证：把切点挪到关键帧之后 / 去掉 PAT/PMT 前置 / 后台收尾不排序，对应用例失败。

### Task 5: 版本、打包、PR

- [ ] `pnpm test` / `pnpm typecheck` / `pnpm bundle`；version patch +1。
- [ ] PR `Fixes #452`；`pr-risk-scan` 必为 RISK（上传路径）→ 不自动合并，等用户拍板。

### Task 6: 测试直播间实测（部署由用户决定，precheck 通过后）

- [ ] 落 spool 与不落 spool 各录一场，分 P 阈值调小（如 5 分钟）以多切几次。
- [ ] 验收：各分 P 时长之和 ≈ 直播时长（误差 < 1 个 GOP）；日志切点无空档；整场 `recording` 恒为 true，无切 P 引起的开播 / 收播通知；每个分 P 在 B 站转码后单独可播。
- [ ] B 站转码若不接受非 0 起始 PTS → 另开任务在切点改写时间戳。

## 不做

- 一场直播合成一个分 P（UPOS 单 P ≤ 2GiB）。
- 时间戳改写（先实测，不需要就不做）。
- 文件录制（record-engine）：它本来就是 segment muxer 无缝分段。

## 附：恢复态分 P 的处理口径

- 恢复重传前，每个未确认 spool 都要过与新录分 P 相同的可读性探测 + dts gap 扫描。
- dts gap：spool 改名 `.held-gap`、不投稿、告警，并从恢复状态摘除；它之后的分 P 照常按序补传，稿件缺这一 P 属已告警的已知缺口。
- 不可读（ffprobe 读不出 duration）：**按设计阻塞该房间**——它不是已知 gap，摘行会静默丢掉唯一副本，且后续分 P 不得越过未确认分 P。手工处置：修复或确认作废该 spool，再从状态文件 `live-pump-<room>.state.json` 的 `parts` 里删掉对应行，下次启动即继续。
- 停止时丢失与交付互不覆盖：只要已有分 P 入稿，run 仍 `ok:true`（照常记台账），丢失以 `lostParts` / `unknownParts` + 告警呈现。
