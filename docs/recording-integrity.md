# 录制产物完整性(末段花屏)问题记录

记录 2026-09-25/26 的「合并上传后末段乱码」排查结论与修复。属于**录制侧**问题，不是合并/上传 bug。

## 症状

- 2026-09-25 B 站场次（`bilibili:1724219649:2026-09-25`）上传后**只有最后一段**出现花屏/乱码，前面正常；用户已删稿。
- 同类现象在 2026-09-26 抖音场次（`douyin:391647909803:2026-09-26`）被新加的体检标出（stage 模式，未上传）。

## 定位过程

源文件与 stage 在上传后按规则清理（`sourceAfterDone` / `stageAfterDone`），无法事后复盘，故用**生产同一条 merge 代码路径**做复现：

1. 3 段完好 TS → `merge` 产物解码扫描 **0 错**（合并本身干净）。
2. 末段截断 35% → `merge` **exit 0 且打印「完成」**，产物尾部报 `cbp too large` / `error while decoding MB`（播放器看到的就是花屏）。

结论：merge 是全程 `-c copy`（逐段规范化 remux + concat demuxer），只能把损坏**原样带过去**，不会自己产生损坏；上传前又没有任何校验，于是坏文件被发布。

## 根因

1. **末段 `.ts` 未收尾**：主播硬切断流时 ffmpeg 写出的最后一帧不完整；「主播已下播但下载进程吊着」的路径原先直接 `SIGKILL`，文件没有 PAT/PMT 与完整 GOP。
2. **合并无损拷贝**：`-c copy` 不做解码/纠错，损坏直达成品。
3. **缺少校验**：上传前无人检查码流是否可完整解码。

## 修复

### 1. 合并前后体检（`packages/post-process/src/integrity.ts`）

- 合并前：逐段只读解码扫描（末段**整段**扫，其余段跳尾 90s 覆盖段边界）。
- 合并后：扫成品最后 60s。
- hub 管线解析 `[integrity] ⚠` 行 → 写 merge 步骤详情（UI 时间线）+ 发通知，上传前即有信号。

### 2. 告警分级（避免误报）

`ffmpeg -v error` 的行不都是画面损坏，必须分两类：

| 类别 | 内容 | 是否告警 |
| --- | --- | --- |
| problem | `cbp too large`、`error while decoding MB`、`max resync size reached`、`Invalid data`、全片扫描下的缺参考帧 | ⚠ 告警 |
| info | `non monotonically increasing dts`（TS+`-c copy` 的重复时间戳）；**跳尾扫描**时的 `co located POCs unavailable` / `mmco: unref short failure` | 不告警，仅附注 |

跳尾伪影已用**完好 TS 对照验证**：全片扫 0 错，`-sseof -90` 立刻复现上述两条 —— TS 无索引，跳过去落在非关键帧，解码器缺前置参考帧就会报，与文件好坏无关。

### 3. 录制器优雅收尾（`packages/record-engine/src/index.ts`）

主播已下播但下载进程吊着时：先 `SIGINT` 让 ffmpeg 正常收尾，`STALL_GRACEFUL_EXIT_MS`（5s）内没退再 `SIGKILL`。从源头减少「末段未 finalize」。

## 验证

容器内用生产同一条命令（`node dist/douyin-rec.mjs merge …`）：

- 完好 TS：`✓ 段 1/3 … 解码正常(另有 3 条时间戳/跳尾提示,无画面影响)`（假阳性已消除）。
- 确定性破坏（段中间写 20 万字节零）：`⚠ 末段 … max resync size reached, could not find sync byte`（真损坏仍能抓到）。
- 2026-09-26 爱馬人士成品复核：合并版全片仅重复时间戳提示、**0 解码错误**；烧录版 **0 报错**。

## 运营注意

- 清理会删源 `.ts` 与 stage 产物，事后无法复盘。要追查某场时先暂停清理，或保留末段原件。
- 体检只报信号、不阻断上传；看到 ⚠ 应先抽样确认画面再决定是否重录。
