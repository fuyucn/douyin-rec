# 024 — 分段产出(steps.mergeSegments=false:不合并,逐段上传)

## 背景 / 需求

hub 后处理此前只有一条路径:**整场合并成一片**再烧录/上传(`merge → burn ×2 → upload_plain → append ×2`)。
用户希望新增开关:**不合并**,直接按录制时的分段(`record --segment`,默认 1800s 一段的每个 `.ts`)
逐个产出并上传 —— 每段 = B 站一个分 P。若开了烧录,则**逐段烧录**(每段用自己那段的弹幕)。

## 决策

- 开关名 `pipeline.steps.mergeSegments`(boolean,**缺省 true = 旧行为**:各分段合成一片)。
  置 `false` = 不合并,逐段产出/上传。与 `burnDanmu`/`burnLivechat` 并列在 `steps` 里(同属「产出什么」),
  放在 hub 规则里,Web「hub 房间」弹窗可配。
- **「段」= 录制分段**(用户确认,选项 1):`winnerMembers.flatMap(m => m.rec.tsFiles)`,即
  `--segment` 切出的每个 `.ts/.flv`,按会话序 → 段序排列。
- **不合并**:每段各自 `-c copy` remux 成独立 mp4(不做 concat)。
- **逐段烧录**:录制端弹幕默认是**会话级单 xml**(`danmuXmlMode=session`),没有 per-segment xml。
  故按该段在整场时间轴上的窗口 `[startSec, endSec)` 从会话 xml 切出该段弹幕并**时间重定基到 0**,
  使 ASS 与「只有这一段的 mp4」对齐。
- **上传编排**:全部 plain 段**一次多文件 `biliup upload`** 建稿(P1..Pn 顺序 = 段序),
  再 `append` 两个逻辑组:danmu 各段一组、livechat 各段一组(组内多段一次 append,顺序 = 段序)。
  一稿多分 P,单次多文件 upload 是 biliup 正常用法(见 AGENTS.md 上传规则)。

## 改动

### core
- `api-types.ts`:`HubPipelineConfig.steps.mergeSegments?: boolean`(缺省 true)。
- `upload-contract.ts`:`UploadOpts` 增 `videos?: string[]`(多文件建稿;`video` 变可选)。

### post-process
- `ass/render.ts`:`ExtractOpts.window` —— 只保留窗内条目并把时间重定基到 0(`extractItems` 内 `place()`)。
- `segment.ts`(新):`buildRemuxArgs` / `remuxSegment`(单段无损 remux)、
  `renderXmlWindowToAss`(一份 xml + 段窗口 → 该段 ASS;窗内无条目 → 空 ass)。

### orchestrator
- `session-plan.ts`:`SegmentPart` / `SegmentPlan` / `segmentStem` / `deriveSegmentPlan`(续跑反推)。
- `pipeline.ts`:`PipelineSteps.mergeSegments` + `runSegmentPipeline` 分支
  (逐段 remux → 逐段烧 → 多文件建稿 → 逐组 append)、`resumeSegmentAppends` 续跑。
  节点语义复用 `sync_node_states`:`merge` = 逐段产出 plain 段,`upload_plain` = 多文件建稿。
  测试接缝:`remuxSegment` / `segmentDuration` / `burnSegment`(默认走真 ffmpeg)。

### app
- `upload/biliup.ts`:`buildUploadArgs` 支持 `videos`(多文件 → 多分 P)。

### cli
- `resolveCfg` 透传 `steps`(含 `mergeSegments`);分段模式禁用单节点重跑(改用「重新运行」整场)。

### web
- `HubRuleDialog`:新增「合并分段 / merge segments」开关(默认开);`flow-build` / `HubJobs` / i18n 同步。

## 幂等 / 续跑

- 建稿成功(`bv` 落库)后绝不重传 plain 组(否则重复建稿)→ 续跑只补 append。
- 单段组就地重试安全;分段模式组内多段 → `tries=1` 不就地重试(可能已部分提交分 P)。
- 产物已在 stage(`{stem}_segNNN.mp4`)→ remux/烧录跳过重做。

## 已知边界

- 多段组 append 无 per-part checkpoint,中途失败转人工(与合并路径 >16GB 多段组同)。
- 分段模式要求录制时已按想要的粒度切段(`--segment`);段太碎会导致分 P 很多。
- 水印关闭 / 仅自己可见 / copyright 1 等硬性上传设置沿用既有 `buildUploadArgs`(多文件路径同)。

## 跟进:全局上传队列 + B站 601 + mesio 碎片(2026-10-03)

线上首跑分段模式撞 B 站 `code 601 上传视频过快`。复盘:

- **根因不是多任务并发**,而是**一次 `biliup upload` 提交太多文件**(某场 21 个 plain 段一次建稿)。
  biliup 每个文件过一次投稿提交,短时间 21 次 → 触发频率限制。
- 同时该场(mesio 引擎)因 `--fix` 的 `SplitOperator` 在流不连续时切出 **10 个 0.2s 级、
  分辨率不同的初始化残片**(`Detected different init segment, splitting the stream`),
  这些残片也是独立分 P → 段数虚高。mesio 无 CLI 开关关掉该切割(除非不用 `--fix`,那就失去意义)。

改动:

1. **全局上传队列 + 提交限速**(`ResourcePool.withUpload`):master 进程内共享,**串行**所有
   hub 任务的上传/append 提交,并对「提交次数」滑动窗口限速(`uploadRateLimit` 缺省 5 次 /
   `uploadRateWindowMs` 缺省 10min);命中 601 后全局冷却 `uploadCooldownMs`(缺省 30min)再自动重试。
   合并路径的上传节点新增 `resource: "upload"` 走此队列;分段路径的每次提交也经 `runUpload` 走它。
   → 多任务同时收播时上传统一排队,不会叠加打爆 B 站频率限制。
2. **分段上传:P1 建稿 + 逐文件 append**:`uploadBatchSize` 缺省 **1**——biliup 的
   `upload/append a b c` 实质是**每个文件一次提交**,故每次只提交一个文件:
   ① 提交次数可控(不会一次打 21 次);② 失败可安全重试(单文件未提交即无副作用);
   ③ 601 由队列冷却 + retry 吸收,不再整场转人工。
3. **碎片过滤**:分段模式下跳过短于 `minSegmentSec`(缺省 2s)的段(不 remux、不上传),
   产出序号跳过碎片后连续(分 P 无空洞)。

**实测(2026-10-03)**:21 段(含 10 碎片)→ 过滤后 11 段;P1 建稿成功,第 6 次提交撞 601 →
证实 B 站限的是**提交次数**(与并发无关,`--limit` 只管单文件分块并发)。故最终以
「窗口限速 + 601 冷却重试 + 单文件提交」为解,而非单纯拉开间隔。

以上三项均可经 hub 规则 pipeline 或 hub.config.json 覆盖(0 = 关闭)。
