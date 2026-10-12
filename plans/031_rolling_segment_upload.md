# 031 — 边录边传：封口分段确认后再删

> 状态：进行中 `T-33`（GitHub issue #3）。用户 2026-10-12 确认本设计可作为计划。
> 不替代 `plans/024_segment_upload.md`。024 决定「不合并、按段做分 P」；本计划决定「什么时候可以删盘上的源」。
> 来源：本文档随 `T-33` 从主工作区引入（基线 `feat/hub-optimization` 尚无此文件）。

## 为什么

节点现在整场录完才做 merge/upload，再删源。多房间同时在录时，源和 `.work` 会把盘写满，
后处理在写产物时失败，源也删不掉。

2026-10-12 某个 worker（49G 盘）写满后的某场就是这个：`needs_manual`、无 BV、`upload_plain=failed`，
stage 只剩半成品 mp4，journal 是 `No space left on device`。

## 不变量

1. 只处理**已经封口**的分段。ffmpeg 正在写的那个文件不上传、不删除、不选优。
2. 同一封口分段先选一个 winner。落败节点上这一段的视频立刻删。
3. winner 的 `.ts`/`.flv` 只在该分 P 得到 BV/append ack 之后删除。
4. `.xml` / `.ass` 留到整场结束，不随单段删除。
5. stage 里该段的 `.work` 在分 P 成品文件落地后就删，不把半成品留到整场结束。
6. 磁盘低于水位时拒绝新开录，禁止用「删掉还没确认上传的源」来腾空间。
7. append 失败不能盲目重试。B 站不能改已提交的视频，重复投稿禁止。失败转人工，保留该段源。

## 验收

- 封口段：winner 上传 ack 后源视频消失，落败节点同一段更早消失，`.xml` 仍在。
- 未封口段：上传与删除名单里都没有它；录制进程仍在写。
- 上传未 ack / `needs_manual` / 无 BV：源视频还在。
- 低于水位：新任务不启动；已在录的当前分段不被截断来腾空间。
- 与 024 的开关独立：默认仍是整场管线，本计划未实现前不改变线上删除行为。

## 明确不做

- 不把写满盘的「假失败」场当成可清理的假失败。它们没有 BV。
- 不自动重传已经可能部分提交分 P 的段。

---

## 实现（T-33，本会话；方案）

**开关**：任务配置上的独立布尔 `rollingUpload`（默认 false），与 `steps.mergeSegments`（按段产出）
区分：前者管「什么时候删源」，后者管「产出形态」。缺省关 → 行为与今天完全一致。

**证据/身份**：封口段用「同目录已有后继段或已停止写入 + grace」判定；删源前过 core 的三重证据闸门
（已封口 + 已确认上传 + (platform, roomSlug) 身份一致），绝不靠主播名。

### 落地方式（与原文的差异，必须解释）

开关只做在**任务配置**上（用户 2026-10-12 明确要求：类似节点侧上传、任务配置里的开关），
不再同时暴露 hub 规则 `steps.rollingUpload`（避免两处入口漂移）。实现：

1. **core 纯判定**（`rolling.ts`）：`sealedSegmentIndices` / `planRollingUploads` /
   `shouldRefuseNewRecording` / `sameRoomIdentity` / `canDeleteRollingSource` /
   `rollingUploadSingleNode`。
2. **录制端执行体**（app `rolling-upload.ts`）：`RollingUploader`（每会话一实例）—— 封口段 →
   P1 建稿 / append → 该段确认后删该段源；`.xml`/`.ass` 不删；失败/不确定 → `ambiguous`、保留源、
   不自动重传。已确认段号 + 段号→路径 持久化在 `{base}.rolling.json`（重启幂等、段号单调续号）。
3. **manager 接缝**：`SessionOpts.makeRolling?: () => RollingUploadHook`（**工厂**，每次 `_startInner`
   新建，会话隔离）；`onSegment` fire-and-forget、`onSessionEnd` 等上传完成。
4. **重复投稿闸门**（唯一处，master 判定）：`rollingUploadSingleNode(hasRule, rule.workers)` ——
   规则勾选恰好 1 个节点（或无规则=单机）才允许；master 下发远端时据此收窄（worker 节点没有规则文件）。
5. **master 识别短路**：scan 读 `{base}.rolling.json`（段全删也产出）；pipeline 见到 `rolling.bv`
   → 直接 done，**绝不重复建稿**；多节点各建稿 / 有 `ambiguous` 段 → 转人工。
6. **磁盘水位**：daemon tick 内查剩余（`freeBytes`），低于水位 → 拒绝启动**新**任务（不截断已在录的）。
   `{base}.rolling.json` 的删除走既有「删源」口径（`canDeleteRollingSource`）。
7. **CLI/web**：`task add/edit --rolling-upload`、`record --rolling-upload`、任务弹窗 + 房间面板开关。

### 与原文「落败节点上这一段的视频立刻删」的差异（风险主动审查）

原文不变量 2 说「落败节点上这一段的视频立刻删」—— 本实现**不采纳**该条，理由：

1. **落败段的唯一副本风险**：边录边传是**跨节点选优之前**就发生的。录制时无从知道哪个节点最终胜出；
   若在 winner 确认前删落败节点同段，而 winner 那段其实没传成（网络/风控），就**丢掉唯一副本**（不可逆）。
2. **重复投稿 vs 丢片**：整场管线在 master 选优后只删「非 winner 的源」；边录边传的定位是**省盘**，
   不是替代选优。因此本实现只在**该节点自己的段确认后**删**自己**的段，**不跨节点删**。
3. 安全等价物：**重复投稿闸门**（只有单节点录制才启用）已保证「不会多节点各建稿」；单节点场景下
   「落败节点」不存在，原文该条自然无需实现。多节点场景下整条链不启用，源由既有整场管线按选优删。

**结论**：不采纳原文「落败段立刻删」——单节点闸门下无落败节点；多节点下不启用。这比原文更保守，
不会丢片，也不会重复投稿。若日后要跨节点省盘，需先有「winner 段 ack 前不删任何副本」的选优时序。

### 测试

`packages/core/src/rolling.test.ts`（封口/水位/身份/删源三重证据/单节点闸门/会话 base 解析）、
`packages/app/src/rolling-upload.test.ts`（封口才传+删、重启幂等、续号、失败转人工不重传）、
`packages/orchestrator/src/scan.test.ts`（rolling-only 会话 + startMs 兜底）、
`packages/orchestrator/src/pipeline.test.ts`（rolling 短路四态）、`test/app/daemon.test.ts`（水位闸门）、
`test/app/{store,task-sync,record-args}.test.ts`（字段透传）。

### 关键风险（须主动审查）

- **落败段提前删除**：若在 winner 尚未 ack 前就删落败节点的同一段，会丢掉唯一副本。
  本实现**先 ack 后删**，且只在 winner 段确认后才删落败同段 —— 与计划不变量 2/3 一致。
  计划原文「落败节点上这一段的视频**立刻**删」隐含「winner 已封口且胜出」前提，实现须显式化。
