# 049 上传目标契约与 bilibili-upload 包（审计 P1-1）

> 状态：**设计草案（2026-11-10，待独立评审）**。上游：issue #597、
> `docs/audit-2026-11-10-architecture-plugin.md` P1-1。
> 本文不含实现 diff；代码在评审通过后按 §8 分阶段落地。

## §0 一句话结论

「上传到哪儿」不是通用层的词汇，是插件轴：core 只留 `UploadTarget` 契约、注册表与通用
驱动；B 站实现（biliup CLI + UPOS 两种传输）整体迁入 `@drec/bilibili-upload`；
「建稿 → append → 重试 → 幂等」只保留一份，各路径只提供**文件清单 + 状态存储**。

## §1 事实基线（2026-11-10，main `0ea30b8f`）

### 1.1 现有上传路径（约 10 条，两套栈）

| 路径 | 入口 | 栈 | 幂等/续跑依据 | 闸门 |
|---|---|---|---|---|
| 合并模式 | `orchestrator/src/workflow.ts` 的 `uploadPlain` / `appendGroupSafe` | biliup | 台账 `append_*` 步骤 + 分 P 计数 | `ResourcePool.withUpload` |
| 分段模式 | `orchestrator/src/segment-pipeline.ts` | biliup | 台账 `markPartDone` | `ResourcePool.withUpload` |
| 合并续跑 | `orchestrator/src/pipeline.ts` 的 `resumeAppends` | biliup | 台账步骤 + 单段/多段分支 | `ResourcePool.withUpload` |
| 节点侧 | `app/src/node-pipeline.ts` | biliup | 节点状态 + 分 P 计数 | core `UploadGate` |
| 队列处理器 | `processors/src/biliup.ts` | biliup | 队列状态 + `findRecentArchive` + 分 P 计数 | `UploadGate` + `UploadSlot` |
| 分 P 链 | `processors/src/upload-part.ts` | biliup | 队列状态 | `UploadSlot` |
| 滚动边录边传 | `app/src/rolling-upload.ts` | biliup | sidecar `confirmed` / `uploading` 意图 + 分 P 计数 | `UploadGate` + `UploadSlot` |
| 直播直传（零落盘） | `zero-upload/src/live-pump.ts` | UPOS | state `parts[].confirmed` + 文件名去重 | `submitGate`（账号冷却） |
| 手动 upload | `cli/src/cli.ts` 的 `upload` 命令 | biliup | 无 | **无**（P0-5 / #596） |
| 手动直传 | `cli/src/cli.ts` 的 `_upos-upload` | UPOS | 无 | **无**（P0-5 / #596） |

同一件事存在多份实现：

- 「建稿后 append + 重试」至少 5 份：workflow、segment、pipeline 续跑、node-pipeline、
  `processors/biliup.ts`；`rolling-upload` 与 `live-pump` 各自再实现一遍。
- 「查分 P 数 / 按标题找稿」两套：biliup 侧 `countVideoParts` / `findRecentArchive`，
  UPOS 侧 `lookupArchive` / `findArchiveByTitle`。
- 「结果不确定」判定：`APPEND_AMBIGUOUS_MARKER`、`UposRateLimited`、`SubmitResult.raw`
  三套形态，重试策略各处各写。

### 1.2 硬策略与常量各定义一次、共两份

| 语义 | biliup（`processors/src/run-biliup.ts`） | UPOS（`zero-upload/src/upos-stream.ts`） |
|---|---|---|
| 关昵称水印 | `--extra-fields {"watermark":{"state":0}}`（upload 与 append 各一次） | `watermark: { state: 0 }` |
| 自制 | `--copyright 1` | `copyright: 1` |
| 仅自己可见 | `!public` 时加 `--is-only-self 1` | `is_only_self = private === false ? 0 : 1`（默认 private） |
| 转载声明 | 无 | `no_reprint: 0` |
| 标题上限 | 无显式截断 | `title.slice(0, 80)` |
| 标签上限 | 无显式截断 | `split(",").slice(0, 10)` |

可见性极性相反（`public` 对 `private`），每个调用边界手工转换；默认 tid/tag 分散在 CLI、
pipeline `uploadMeta`、live-pump、队列处理器，tag 值不一致。凭据路径（环境变量、数据根下的
`config/biliup/` 下的凭据文件、显式 `--cookies-file`）出现二十余处；账号键由
`biliAccountKey` / `biliAccountKeyFromCookiesJson` 计算，但只有生产路径使用。

### 1.3 通用层里的 B 站代码

- `core/upload-gate.ts` 的 `biliAccountKey*` / `biliupCookieHeader` / `biliupCsrf`；
- `core/bili-season*.ts`（合集/小节）；
- `core/upload-contract.ts` 的 `APPEND_AMBIGUOUS_MARKER`、`isAppendAmbiguous`、
  `isUploadRateLimited`、`UploadOpts`（`tid` / `tag` / `--line` 词汇）；
- `core/processor.ts` 的 `BILIUP_*` 能力常量；
- `proc-queue` 的 `bv` / `seasonState` 列与 `kind === "biliup"` 分支。

## §2 core 契约

### 2.1 类型草图（最终以评审后的 PR 为准）

```ts
// core：纯类型 + 注册表 + 纯函数；不 import 任何 B 站实现。
export type UploadVisibility = "private" | "public";

export interface CredentialRef {
  targetId: string;
  /** 不透明定位符；日志只打印 targetId，不打印路径或内容。 */
  locator: string;
}

export interface UploadFile {
  path: string;
  /** 分 P 标题；缺省由 target 的 formatPartTitle 生成。 */
  title?: string;
  /** 幂等线索：大小 + mtime 足以识别「同一段」，不读内容哈希。 */
  size?: number;
  mtimeMs?: number;
}

export interface UploadPolicy {
  visibility: UploadVisibility;      // 默认 private；公开必须显式
  watermark: false;                  // 硬性：关闭
  copyright: "self";                 // 硬性：自制
}

export interface ArchiveInfo {
  ref: ArchiveRef;
  title: string;
  visibility: UploadVisibility;
  partCount: number | null;          // null = 查不到/无法确认，不是 0
  parts?: Array<{ index: number; title?: string }>;
}

export interface ArchiveRef {
  targetId: string;
  /** 目标自己的稿件标识；对 B 站是 bvid，对别的目标可以是别的。 */
  id: string;
}

export type UploadErrorClass =
  | { kind: "rate-limited"; retryAfterMs?: number }
  | { kind: "transient"; reason: string }     // 明确未提交，可安全重试
  | { kind: "ambiguous"; reason: string }     // 结果不确定，转人工
  | { kind: "permanent"; reason: string };

export interface UploadTarget {
  readonly id: string;                        // "bilibili"
  readonly platformIds: readonly string[];    // ["bilibili"]

  /** 凭据定位：显式路径 > 环境变量 > 数据根默认；只由 target 实现。 */
  resolveCredential(input: { dataRoot: string; explicitPath?: string }): CredentialRef;
  /** 账号键：供 UploadGate / UploadSlot 分键；不泄露凭据内容。 */
  accountKey(cred: CredentialRef): string;

  /** 硬策略：水印/自制/默认可见性；调用方只能显式覆盖 visibility。 */
  hardPolicy(): UploadPolicy;
  /** 目标默认值：分区、标签上限、标题上限、最大分 P 数等。 */
  defaults(): UploadTargetDefaults;

  create(input: CreateArchiveInput): Promise<CreateArchiveResult>;
  append(input: AppendPartsInput): Promise<AppendPartsResult>;
  inspect(input: { ref: ArchiveRef; cred: CredentialRef }): Promise<ArchiveInfo | null>;
  /** 建稿前去重：同标题 + 预期时长找已有稿；"unknown" 时不得建稿。 */
  findRecent(input: { cred: CredentialRef; title: string; expectedDurationSec?: number }):
    Promise<ArchiveInfo | "none" | "unknown">;

  classifyError(err: unknown): UploadErrorClass;
  readonly capabilities: UploadTargetCapabilities;
}
```

`CreateArchiveResult` 必须带 `proof`：

- `created`：确定新建成功，返回 `ArchiveRef`；
- `found-existing`：去重命中，返回已有 `ArchiveRef`（不新建）；
- `unknown`：结果不明 → 驱动转人工，绝不重试建稿。

`AppendPartsResult` 必须带 `proof`：

- `observed`：服务端分 P 数/列表已增加，确认成功；
- `confirmed-not-submitted`：确认未提交，可安全重试；
- `unknown`：结果不确定 → 转人工。

### 2.2 注册表

```ts
export interface UploadTargetRegistry {
  register(target: UploadTarget): void;
  get(targetId: string): UploadTarget | undefined;
  forPlatform(platformId: string): UploadTarget | undefined;
  list(): UploadTarget[];
}
```

- 实现放 core（纯数据结构，无 IO）；
- 装配根在 `cli`（与 `providers-register.ts` 同构），`app` / `orchestrator` 通过注入拿到，
  不直接 import 任何目标包；
- 找不到目标 = 显式失败（不静默回落 biliup）。

## §3 包分层与所有权

| 包 | rank | 职责 | 允许依赖 |
|---|---|---|---|
| `@drec/core` | 0 | `UploadTarget` 契约、注册表、错误分类枚举、纯 helper | 无 |
| `@drec/upload-runtime`（新） | 0.5 | 通用驱动：状态机、重试/退避、幂等键、`UploadGate`/`UploadSlot` 接线；状态存储由注入接口提供 | core |
| `@drec/bilibili-upload`（新） | 0.5 | B 站目标实现：硬策略、凭据、账号键、错误分类；内部两种传输（biliup / UPOS） | core、processors(0.4)、zero-upload(0.35) |
| `@drec/processors` | 0.4 | 保留 biliup CLI 包装与队列处理器；不拥有上传语义 | core、zero-upload |
| `@drec/zero-upload` | 0.35 | 保留 UPOS 原子操作（preupload/chunk/complete/studio） | core、post-process |
| `@drec/orchestrator` | 4.5 | 只依赖 `upload-runtime` + core，拿注入的 target | 不 import `bilibili-upload` |
| `@drec/app` | 4 | 同上；节点侧用注入 target | 不 import `bilibili-upload` |
| `@drec/cli` | 5 | 注册 `bilibili-upload`，组装 target registry | 全部 |

验收口径：新增一个假上传目标 + 一个假平台，只需一个包 + `cli` 一行注册；
`app` / `web` / `orchestrator` 零改动。

## §4 通用驱动（`upload-runtime`）

### 4.1 状态机

```
ensureArchive
  ├─ 有 ref        → inspect(ref)（null → 转人工）
  ├─ 无 ref        → findRecent(title,duration)
  │                   ├─ found-existing → 复用 ref（记 checkpoint）
  │                   ├─ none           → create（proof 必须是 created）
  │                   └─ unknown        → 转人工（绝不建稿）
  └─ create 失败：rate-limited → 冷却后重试；transient → 有界重试；
                  ambiguous/permanent → 转人工；unknown → 转人工
appendParts
  ├─ 逐段/逐组调用 target.append（由 target 声明 appendGranularity）
  ├─ observed            → 记该段 checkpoint
  ├─ confirmed-not-submitted → 安全重试（有界）
  ├─ rate-limited        → UploadGate 冷却后重试（有界）
  ├─ ambiguous/permanent → 转人工；保留已确认段，不删源
  └─ unknown             → 转人工
verify
  ├─ inspect(ref).partCount 与期望一致 → done
  └─ 不一致/查不到       → 转人工（不重传、不删源）
```

驱动只依赖：

- `UploadTarget`（§2）；
- `UploadStateStore`（注入接口：读/写「目标 + 稿件 + 已确认段 + 赛季状态」）；
- `UploadGate` / `UploadSlot`（core，已有）；
- `sleep` / `now`（测试注入）。

### 4.2 幂等键

- 建稿：`(targetId, title, expectedDurationSec)` + `findRecent` 结果；
- append：`(targetId, archiveId, partIndex, size, mtimeMs)`；目标自己再做一层（biliup 用分 P 数，
  UPOS 用文件名去重）。
- 驱动**不**用内容哈希（大文件读不起）；用「分 P 序号 + 文件身份」足够识别同一段。

### 4.3 两种传输的语义差异（必须在 target 内消化）

| 维度 | biliup CLI | UPOS |
|---|---|---|
| 建稿 | `upload` 子命令，stdout 解析 BV | `submitStudio` 返回 `bvid/aid`，`filename` 必须是 complete 返回的 stem |
| append | 服务端末尾追加；`appendGroup` + `countParts` 读回判定 | `edit` **整表替换**：必须先 `lookupArchive`，把旧分 P 与新分 P 一起提交；文件名已存在即幂等 |
| 可见性 | `--is-only-self` 只在非公开时加 | `is_only_self` 显式 0/1（默认 private） |
| 限流错误 | 文本/JSON `code`（601/21566/21540/21186） | `UposRateLimited` / `SubmitResult.raw.code` |
| 结果不确定 | `APPEND_AMBIGUOUS_MARKER`（分 P 数读不到/变少） | 只读查稿失败 / `edit` 超时；无等价标记 |
| 封面 | 无（biliup 自己处理） | 每次 edit 都发空 `cover`；是否清掉手工封面待真实稿件验证 |

**结论**：`UploadTarget.append` 内部必须实现「读回/去重」的差异；驱动只认 `proof`。

## §5 硬策略、凭据与默认值

### 5.1 硬策略（单一出处）

- 水印：关闭（`watermark.state = 0`）；
- 自制：`copyright = 1`；
- 默认仅自己可见：`visibility = "private"`，公开必须显式调用；
- 标题/标签上限、分区默认值由 `defaults()` 提供，调用方不再各写一份；
- 转载声明（`no_reprint`）只出现在 B 站 target 的 UPOS 映射里，不上升为通用契约。

### 5.2 凭据与账号键

- 解析顺序：显式 `--cookies-file` > 环境变量 > `<dataRoot>/config/biliup/` 下的凭据文件；
  只由 `bilibili-upload.resolveCredential` 实现，CLI/daemon/queue 全部调用它；
- `accountKey` 由 target 从 cookies JSON 计算（B 站 `DedeUserID`）；`UploadGate` 只接收字符串键；
- 日志只打印 `targetId + accountKey 的稳定哈希前缀`，不打印路径/内容；
- 手动 `upload`（#596）与生产共用同一 `accountKey`，不新造一套。

## §6 `proc-queue` 迁移（需单独拍板）

### 6.1 目标形态

新增一列 `targetState TEXT`（JSON）：

```json
{"targetId":"bilibili","archiveId":"<id>","parts":2,"season":"pending"}
```

`bv` / `seasonState` 保留一个发布周期：

- 新代码写 `targetState`，同时写 `bv` / `seasonState`（dual-write）；
- 读优先 `targetState`，缺失回退 `bv` / `seasonState`；
- 旧 bundle 忽略新列，仍读旧列 → 可回滚；
- 下一个发布周期再停写旧列，最后删除。**不在本次 PR 做**。

### 6.2 兼容与回滚

- 队列库在节点本地；master 不直接开节点库（经 `Transport` 读状态）。因此 schema 迁移
  按节点逐个发生，不需要跨节点同时升级；
- 回滚：旧 bundle 读 `bv` 仍有效；新 bundle 遇到旧行自动回退；
- 迁移失败（ALTER 失败/磁盘满）→ 启动时显式告警并保持旧列读写，不允许静默跳过。

### 6.3 未决

- 是否把 `kind === "biliup"` 改成 `kind === "upload"` + `targetId` 参数？涉及队列模板、
  前端展示、旧任务重放，需单独决策。
- `proc-queue` 的 schema 版本号（当前 5）与迁移顺序。

## §7 与其它票的接缝

| 票 | 接缝 |
|---|---|
| P0-5 / #596 | 手动 `upload` / `_upos-upload` 用同一 `resolveCredential` + `accountKey` + `UploadGate` + 槽位；驱动不重复实现凭据解析 |
| P1-2 管线步骤注册表 | 步骤只调用驱动（`ensureArchive` / `appendParts` / `verify`），不直接调 target 内部传输 |
| P1-3 组装层 + `SyncLedger` | `UploadStateStore` 由组装层注入；target 不直接开库 |
| P1-6 core 瘦身 | `upload-gate` / `upload-slot` 的 IO 后续拆到 runtime；core 只留契约与纯函数 |
| P2 配置模块 | `resolveCredential` 的环境变量读取统一走配置模块，不在 target 里散读 `process.env` |

## §8 分阶段落地

| 阶段 | 内容 | 行为变化 | 验收 |
|---|---|---|---|
| 0 | core 契约 + 注册表 + `upload-runtime` 空驱动 + 假 target 测试 | 无 | `test/arch` 通过；fake target 一行注册；app/web/orchestrator 零改动 |
| 1 | `bilibili-upload` 包装 biliup；`run-biliup` 纯搬迁；orchestrator 合并/分段先接驱动 | 无（对拍） | 现有 upload/append 用例全绿；argv/输出与旧实现逐字一致 |
| 2 | UPOS 传输接入；`live-pump` / `rolling-upload` 改用驱动 | 无（对拍） | 分 P 数/文件名/可见性一致；cover 行为单独验证 |
| 3 | `proc-queue` `targetState` dual-write + 读取回退 | 无 | 新旧 bundle 互读；回滚演练 |
| 4 | 删 core 的 B 站代码、更新架构文档/守护 | 无 | `core` grep `bili|biliup|upos` 只剩注释；`pnpm arch:check` 绿 |

每个阶段单独 PR；阶段 0/1 先做，阶段 2 需要真实稿件验证 UPOS 封面行为。

### 8.1 阶段 1b 执行清单（上传轴接线）

阶段 1a 交付了 `@drec/bilibili-upload`，但是**零接入**。接线之前先认清现实：上传路径不是一条，是**五条
并行的**，各有自己的幂等、重试与台账语义。把它们一次全改，等于一次改五套行为——这正是审计说的「上传轴
散落」。所以 1b 必须分批。

| 路径 | 建稿 | append | 装配点 |
|---|---|---|---|
| workflow（节点式） | `orchestrator/workflow.ts:229` | `:348` | `app/node-pipeline.ts` 注入 |
| 分段 | `orchestrator/segment-pipeline.ts:571-573` | `:626`、`:732`、`:864` | 同上 |
| 合并续跑（只补 append） | —（已有 bv 绝不重建） | `orchestrator/pipeline.ts:1550-1551` | 同上 |
| 滚动上传 | `app/rolling-upload.ts:1355`（`uploadPlainRaw ?? uploadPlain`） | `:1377` | app 直连 |
| 处理器 | `processors/biliup.ts:298`、`processors/upload-part.ts:117` | `biliup.ts:359`、`upload-part.ts:121` | 直接 import `run-biliup` |

装配面：`cli/cli.ts:1857-1860`（把旧函数塞进 pipeline deps）、`app/node-pipeline.ts:831`/`:859`、
`app/rolling-upload.ts:1355`。

**分批（每批单独 PR、可回滚）**：

| 批 | 内容 | 行为 | 决策门 |
|---|---|---|---|
| 1b-1 | workflow 两处（`:229` 建稿、`:348` append）改经 `UploadTarget`；app 侧提供把旧函数包成 target 的适配器；`cli` 装配注入 | argv/重试/分 P 回读等价；`proof: unknown` 有意改变（见下） | **needs-decision** |
| 1b-2 | 分段路径四处接 target | 同上 | **needs-decision** |
| 1b-3 | 滚动上传接 target（`uploadPlainRaw`/`appendGroupRaw` 收进 target） | 同上 | **needs-decision** |
| 1b-4 | 处理器路径接 target（`biliup.ts` / `upload-part.ts`） | 同上 | **needs-decision** |
| 1b-5 | `run-biliup` / `biliup-progress` / `biliup` 从 `processors` 纯搬进 `bilibili-upload`；删掉兼容字段与全部旧引用 | 纯迁移 | 纯迁移，走常规门禁 |

**决策门说明**：上传是危险类（`docs/agent-workflow.md`），1b-1…1b-4 都改变生产上传路径，一律
`needs-decision`，不得由 agent 自行 accept 或自动合并；哪怕是文档/计划 PR，也不构成豁免。

**「等价」的边界要写清，别混为一谈**：

- **等价**：argv 逐字一致、线路重试次数与换线顺序、`countVideoParts` 的分 P 数回读、cover/标题处理。
  这些由 adapter 委托旧实现即可保证，可用 1a 的 golden argv 断言复验。
- **有意改变**：`proof: unknown`。旧实现是「解析不到 BV → 抛错 → 上层 retry」，重试会再建一份稿
  （B 站不可逆，只能删稿）。新契约是「不确定 → 不重试、转人工」。所以接 target 时**必须同批改上层**：
  台账状态、通知文案、`needs_manual` 入口、以及「已有 bv 绝不重建」这条断言的判定来源。这不是包装层
  能顺带完成的，要单独列进每个批次的验收项。

**测试面**：全仓有 **32 个文件**出现过 `uploadPlain` / `appendGroup`（含 `test/e2e/harness/scenario.ts`
这种集中 seam，以及 `workflow.test.ts`、`segment-pipeline.test.ts`、`reconciler.test.ts`、
`node-upload-poll.test.ts` 等构造旧字段的测试）。因此 1b-1 的取舍是 **保留旧字段做兼容**：新增可选
`uploadTarget`，传了就用 target、没传走旧字段。这样 1b-1 的 diff 只有两处调用点 + 适配器，32 个文件
不动；1b-5 才连兼容字段一起删。

**1b-5 的完成条件（防「兼容字段永久化」）**：全仓 `grep -rnE "uploadPlain|appendGroup" packages/ test/` 引用归零（只有 `bilibili-upload` 内部与 `run-biliup` 搬迁后的实现除外）、适配器文件删除、32 个文件里的
旧字段全部迁移成 target、并且加一条守护测试断言「新代码不得出现 `uploadPlain(`/`appendGroup(` 直接调用」。

## §9 验收清单（对应审计「复审验收点」）

- [ ] 新增假上传目标 + 假平台：一个包 + 一行注册；app/web/orchestrator 零改动；
- [ ] core 里 `bili|biliup|upos` 只剩注释（阶段 4 后）；
- [ ] 三种管线模式共用一份「建稿→append→重试→幂等」驱动；
- [ ] `proc-queue` 只存不透明目标状态（阶段 3 后）；
- [ ] 手动上传与生产共用 `UploadGate` + 槽位（#596）；
- [ ] 全量 `pnpm test` / `pnpm typecheck` / `pnpm arch:check` 绿；纯搬迁 PR 有对拍。

## §10 未决问题（评审时逐条回答）

1. **append 粒度**：B 站按「每段一次 append」拿到 per-part checkpoint，还是按逻辑组一次
   提交（danmu/livechat 一组）？前者安全、提交次数多；后者快、失败恢复差。建议每段一次，
   组语义只用于标题/顺序。
2. **UPOS 空 cover**：每次 edit 重发空 `cover` 是否清掉手工封面？需真实稿件验证后再定
   「保留旧 cover」还是「显式传空」。
3. **`proc-queue` 列迁移**：additive dual-write（建议）还是重命名 `bv`/`seasonState`？
   后者回滚成本高。
4. **默认传输**：同一路径何时选 biliup、何时选 UPOS？按能力（可 append / 可零落盘 /
   可查稿）还是按配置？建议 target 暴露 capabilities，由驱动选；默认保持现状。
5. **驱动归属**：`upload-runtime`（建议）还是 core？core 无 IO，驱动需要状态存储与 sleep。
6. **`kind === "biliup"`**：是否改成通用 `kind === "upload"` + `targetId`？涉及旧任务重放
   与前端文案。

## §11 参考

- `docs/audit-2026-11-10-architecture-plugin.md` P1-1、P0-5、复审验收点；
- `docs/architecture-package-split.md`（包分层与 rank 规则）；
- `test/arch/layering.test.ts`（新增包必须登记 `RANKS`）；
- `plans/046_part_chain_queue.md`（队列/分 P 链的既有语义）；
- `plans/038`（节点上传队列 / 槽位）。
