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
| 2 | UPOS 传输接入（2a 已完成：`bilibili-upos` 目标）；上传驱动实现完成（2b-1，0.0.378，零接入）；`live-pump` 改走驱动（2b-2a 接缝 0.0.379；2b-2b 流式发布契约 0.0.380；2b-2c 装配 0.0.381，默认关闭；**2b-2c 于 2026-11-12 实机验证通过，见 §8.3**）；`rolling-upload` 走驱动单独拆为 **2d（未开始，needs-decision）** | 无（对拍） | 分 P 数/文件名/可见性一致；cover 行为单独验证 |
| 3 | `proc-queue` `targetState` dual-write + 读取回退 | 无 | 新旧 bundle 互读；回滚演练 |
| 4 | 删 core 的 B 站代码、更新架构文档/守护（**已完成 0.0.384，2026-11-13，见 §8.4**） | 无（纯搬迁） | `core` grep `bili|biliup|upos` 只剩注释与两类登记例外；`pnpm arch:check` 绿 |

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

**1b-5 的完成条件（防「兼容字段永久化」）**：生产代码对旧函数的**引用归零**——即除
`@drec/bilibili-upload`（旧函数的所有者）之外，任何包都不再出现 `uploadPlain(` / `appendGroup(` 直接调用。

注意这里是「调用归零」而不是「名字归零」：`export { uploadPlain } from "@drec/bilibili-upload"` 这类
**re-export 是合法代理**，不是绕道，必须保留。这不只是措辞问题——实测过一次代价：删掉
`packages/app/src/upload/biliup.ts` 的转发后，`test/e2e/clean-visibility.test.ts` 的十条用例整片变红
（12 passed → 10 failed）。原因是 ESM 在**链接期**解析具名导入，删掉导出会让任何间接 import 它的模块
在加载时就失败，而不是等到调用。因此收口判据只能是「调用式」；守护测试
`test/arch/upload-single-path.test.ts` 也据此写成「名字 + 调用括号」，并附一条金丝雀断言防止规则被改弱。

**落地记录（2026-11-11）**：

| 批 | 实际 PR | 说明 |
|---|---|---|
| （前置） | #633 / PR #634 | `UploadChildHooks` 进契约；`upload-call` 从 orchestrator 移到 core（`app`(4) 不能依赖 `orchestrator`(4.5)） |
| 搬迁 | #629 / PR #630 | `run-biliup` / `biliup-progress` / `biliup` / `upload-part` 搬进 `bilibili-upload`；这同时让原 1b-4「处理器路径接线」**失去意义**——搬完之后它们就是 target 的所有者本身 |
| 1b-1 + 1b-2 | #631 / PR #632 | workflow、分段、合并续跑一次收完（同属编排层，共用一处装配，拆开反而要两次改同一批测试）；`PipelineDeps` 换成 `upload: UploadTarget` |
| 1b-3 | #635 / PR #636 | 滚动上传接 target；`hooks` 与 `countParts` 两处等价性细节 |
| 1b-4（计划外） | #637 / PR #638 | 计划里漏掉的**第六条生产路径**：`app/node-pipeline.ts`（`_node-pipeline` 执行体）自己拼 argv、自己写重试判定 |
| 1b-5 | 部分 | 调用归零已由守护测试钉住；`test-target.ts`（测试双）**保留**——它被 95 处测试引用，删它等于重写全部测试注入，与等价性无关，按需再决定 |

**阶段 3 落地（2026-11-12）**：issue #664 → PR #665（merge 3542759c，0.0.375）。proc_queue 新增
`targetState`（schema v5→v6，加列式迁移）；`setBv` / `setBvAndSeasonState` / `setSeasonState` 双写
`bv` / `seasonState`，读取优先 checkpoint、缺失或损坏回退旧列；`ALTER` 失败只告警不阻塞队列（
`user_version` 停在 5，下次开库重试）。回滚演练与新库升级写在 `test/proc-queue/target-state.test.ts`。

**阶段 3 补线（2026-11-12）**：issue #666 → PR #667（merge e5529350，0.0.376）。上一版只加了列和双写，
没有任何生产调用点，`parts` 永远写不进去；现在 `ProcessContext.setState` 接受 `UploadTargetState`
（`targetId` / `archiveId` / `parts?` / `season?`），`runner` 的 `ctxFor().setState` 遇到该载荷直接走
`store.setTargetState`（行不存在就抛 `[proc] target checkpoint write missed its row`），`biliup` 与
`upload-part` 的 5 个调用点改为发 checkpoint；`parts` 只由 `upload-part` 上报 `1`（每分 P 一次），
跨场累加仍由 `store` 按 archiveId 归并。

教训（写给下一个改这里的人）：**「调用点数量 / 文件数」必须 grep 实测，不能凭结构推断。** 我在 1b 里
三次数错——1b-1 前以为「只有两处」，实测五条路径；测试面以为「10 个文件」，实测 32 个；1b-3 之后以为
「最后一条」，实测还有 `node-pipeline`。这三个错误都会让「上传轴已接完」的结论提前成立。

### 8.2 阶段 2b-2b 的阻塞事实（2026-11-12）

2b-2a 的接缝默认不注入，正好用来验证「live-pump 能不能直接换成驱动的 create/append」。结论：不能。

live-pump 的顺序是**先传字节、再交元数据**：每段在 `runSegment` 里 `preupload` → 分块 PUT → `complete`（live-pump.ts 2517 / 2715），拿到 complete 结果之后才调用 `submitPart`（live-pump.ts 3597，`submitStudio` / `appendStudioPart` 只提交文件名和标题）。

而 `UploadTarget.create/append` 的语义是「把字节传上去，再建稿/追 P」（`upos-target.ts` 的 `preupload` → `uploadChunks` → `complete` → `submitStudio`）。让 live-pump 走驱动的 create/append，等于把已经传完的字节**再传一遍**；零落盘模式下这些字节根本不在磁盘上，第二次上传只会失败或翻倍。

所以 2b-2b 不是「装配一下」，而是契约缺一个操作：**把已经上传的分段发布成稿/分 P**。

- 契约：`UploadTarget` 增加可选 `publishStreamed`（`{ cred, ref?: ArchiveRef, name, title }` → `{ proof: "created" | "confirmed" | "confirmed-not-submitted" | "unknown", ref?: ArchiveRef }`），目标用 `capabilities.streamPublish` 声明支持；没有这个能力的路径（biliup 子进程）必须显式拒绝，不静默回落。
- 驱动：新增 `ensureStreamedArchive` / `appendStreamedPart`，复用现有判定（建稿前去重、unknown → needs-manual、`confirmed-not-submitted` 才重试），不再写第二套退避。
- live-pump：注入 submitter 时改调这两个方法，字节与元数据仍由它自己掌管。

这一步会翻转「拿不到稿件号」的行为（重试开第二个稿 → `needs-manual`），所以仍需单独 PR + 一场真实直播验证。


### 8.3 阶段 2b 实机验证（2026-11-12）

0.0.383 的 `_live-pump` 在真实直播上跑通了一次完整的「先传字节、再发布」。命令（用生产镜像跑新 bundle，
绕开宿主机 ffmpeg 的 ABI 问题，见文末）：

```
docker run --rm --network host --entrypoint node \
  -v $PWD/dist:/app/dist:ro -v <cookies.json>:/cookies.json \
  -e DREC_LIVE_PUMP_DRIVER=1 douyin-rec:latest dist/douyin-rec.mjs _live-pump \
  https://live.douyin.com/<房间> --cookies /cookies.json --size 10MiB \
  --segments 2 --max-sec 20 --submit --title 测试-driver-065059
```

结果：`ok:true`，稿件 `BV1xx`（aid <aid>），两段日志都是
`[直播直传] confirmed part N, removed spool`；建稿走 `add/v3`、追 P 走 `edit`，**整条链没有第二次上传字节**。

对稿核验（`member.bilibili.com/x/vupre/web/archive/view?bvid=BV1xx`）：

- 分 P 数 = 2；标题 `<stem>_000` / `<stem>_001`，即两个封口分段的 stem，与旧路径一致；
- `is_only_self = 1`（默认私有，只有显式 public 才打开）、`copyright = 1`、`tid = 21`，与旧路径一致；
- 封面是 B 站自动生成的默认封面：直播直传从不提交封面，旧路径也一样，所以「cover 行为单独验证」这一项
  在直播直传上没有差异可验（文件型路径的封面行为仍由既有用例覆盖）。

**环境事实（会被误判成代码问题，写下来）**：宿主机 `/opt/homebrew/bin/ffmpeg` 链接的 `libx265` 是 4.2
（`libx265.216.dylib`），而装的是 4.3（`libx265.217.dylib`），所以本机跑 `_live-pump` 会在 ~50ms 内报
`流比声明的 <size>B 短:第 0 块没有数据`。同一个 FLV URL `curl` 实测 `http=200`、1.36MB 正常下发，
说明 CDN 与 URL 都没问题。要么在容器里跑（上面的命令），要么 `brew reinstall ffmpeg`。

`_live-pump` 的失败 JSON 目前不带子进程 stderr，这类失败只能靠猜，排查成本很高——记为一个优化项。
**部署（2026-11-12，分批）**：第一批只更新 master（等不到空闲的那台节点被跳过），第二次单独跑节点批次
更新另一台空闲节点；两端报同一版本 `0.0.383-bd1d55`，bundle md5 一致（`eef4b6effdc5`）。第三台当时有任务
在录（#30），按 guard 跳过，仍是 `0.0.376-063584`——线上是「新 master + 新节点 + 旧节点」的混合态，在本
次改动范围内安全（只动上传包，没碰节点同步协议，也没改 DB schema）。更新前把旧 bundle 备份成
`dist/douyin-rec.mjs.bak-<旧版本>`，回滚 = `cp` 回去 + `systemctl restart video-screenshot`。worker id 已经是
nodeId，迁移步不用再跑。

### 8.4 阶段 4：core 去 B 站化（2026-11-13）

新增叶子包 **`@drec/bilibili-api`**（rank 0.1，不依赖任何内包），把「只有 B 站才有的知识」从 `core` 搬出去：

| 文件 | 来源 | 内容 |
|---|---|---|
| `credential.ts` | `core/upload-gate.ts` | 账号键（`biliAccountKey` / `biliAccountKeyFromCookiesJson`）、`biliupCookieHeader`、CSRF（`biliupCsrf`） |
| `season.ts` | 原 core 合集模块 | 提交后把稿件加入合集小节，返回 `SeasonAddOutcome` |
| `season-resolve.ts` | 原 core 小节解析模块 | 配置里的小节号归一化与解析 |

调用方（`app` / `cli` / `orchestrator` / `zero-upload` / `bilibili-upload` / `hub-compose`）改为从新包导入；
`tsconfig` / `vitest` 别名、`test/arch/layering.test.ts` 的 RANKS、`scripts/gen-architecture.mjs` 与生成的
`docs/architecture.{html,md}` 同步（19 → 20 包），README 包数同步。

**留下来的两类登记例外**（不是漏搬）：

1. `core/processor.ts` 的 `BILIUP_QUEUE_CAPABILITY` / `BILIUP_SLOT_CAPABILITY`——这是**能力字符串**（规则
   `requires`、worker 上报、UI 门控共用的一套词汇）。改字符串等于改节点协议，与「去 B 站化」无关。
2. `core/title-template.ts` 的 `formatBiliTitle` / `partTitleToFilename`——标题与文件名清洗，调用方是
   平台无关的分 P 命名逻辑；搬走会把纯格式化拖进叶子包并制造反向依赖。

**兼容壳**（保留一个发布周期，行为不变）：`orchestrator/src/upload-limits.ts` 与
`bilibili-upload/src/run-biliup.ts` 继续 re-export 同名符号，调用方不必同时改。

**验收**：`rg -ni "bili|biliup|upos" packages/core/src` 只剩注释、测试夹具里的字符串、上面两类例外；
测试改为 mock 新模块（`vi.mock("@drec/bilibili-api")`），撤掉对 core 内部函数的 mock；全量 `pnpm test`
5319 passed、`pnpm typecheck` 0 错、`arch:check` 一致、`pnpm bundle` 0.0.384。

**合并**：issue #682 → PR #683（merge `dca7cfa2`，0.0.384）。CI 首跑红在 `test/orchestrator/ledger-wal`
的「并发首开切 WAL」用例（5000ms 超时），与本改动无关——本机连跑 3 次全绿，重跑该 job 通过。

### 8.5 阶段 2b-2d：驱动路径对齐旧路径（0.0.385，2026-11-13）

阶段 2b-2c 的实机验证（§8.3）跑的是**本机直传**，而 `DREC_LIVE_PUMP_DRIVER=1` 一旦默认开启，执行体就在
节点上跑。逐行对拍旧路径（`submitWithRateLimitRetry`）与新路径（`submitPartViaSubmitter` → 驱动 →
`upos-target.publishStreamed`）后，共 **7 处**会改变「一场直播能不能收尾」的差异。

**第一轮发现并修复的 3 处**（首次提交时的结论，当时漏掉了下面 4 处）：

| 差异 | 旧路径 | 新路径（改前） | 改法 |
|---|---|---|---|
| 账号配额记账（#331） | 每次提交前 `submitGate.noteSubmit()`，限流时 `noteRateLimited()` | **完全没有** | `UploadRuntimeDeps.accounting` 可选注入；驱动在每次尝试前与每次限流判定后调用，异常吞掉 |
| 限流重试预算 | 5 次，60s 起，指数退避封顶 300s | 3 次（驱动默认，未传 `retry`） | `buildLivePumpSubmitter` 显式传 `attempts: 5` 与同一组退避参数 |
| 首次建稿去重 | 只在**崩溃恢复**里按标题找稿 | 每次建稿都 `findRecent`，命中即复用 | 首次建稿传 `skipFindRecent: true` |

**独立审查（6.1 sol）后追加的 4 处**，都不在前一次的结论里：

| 差异 | 后果 | 改法 |
|---|---|---|
| `RunLivePumpOptions` 没有 `submitter` 字段 | **flag 一直是空转**：CLI 用对象展开传参，TypeScript 的多余属性检查不报错，submitter 被静默丢弃，真实录制仍走旧路径 | `RunLivePumpOptions` 补 `submitter`/`submitterTargetId`，在 `openSession` 里透传给 `LivePumpSession`；补 `runLivePump` 级接缝测试，断言投稿端点一次都没被直连 |
| 限流码被折成 `confirmed-not-submitted` | 驱动按 transient 只等 1/2/4/8 秒，既不冷却账号也不等冷却窗口 | `publishStreamed` 保留原始响应体，限流照旧抛出交给分类器 |
| 分类判定收到的是包装对象 | `String(res)` 得到 `"[object Object]"`，601/21540 等码全部匹配失败——上一条「保留响应体」也因此形同虚设 | 先 `JSON.stringify(res.raw)` 再交给 `isUploadRateLimited`／`isAppendAmbiguous`／`isPlainNoBv` |
| 建稿遇到传输错误当作 transient | 重试可能建出**第二份稿件**（第一次 POST 也许已经成功，只是响应丢了） | POST 后的传输错误返回 `proof: unknown` 转人工；只有请求前就能判定的失败才允许重试 |

**顺带收紧的四处**（审查标为 should-fix，同样改变行为）：

- 限流等待改为按尝试次数增长（60s、120s、240s，封顶 300s）。原实现每次都取固定 `rateLimitMs`，等于在同一个冷却窗口里连撞 5 次。
- `signal` 从 runner 一路传到 driver：停止后排空中的分 P 不会再在冷却结束后补发一次不可逆请求。
- 首建成功时 checkpoint 从 **P1** 开始记录（原来是 `parts: []`，下一段会把自己记成 P1，而稿件实际已有两个分 P）。
- `publishStreamed` 的追加失败**不再按码猜「确定未提交」**：除限流外一律 `unknown`。按 21001 等码报「可重试」会让驱动把同一份无效载荷再提交 5 次（第三轮修正，见 §8.5.1）。

**接缝**：`PartSubmitter` 与 `UploadRuntimeDeps` 的新字段全部可选，队列/测试路径不注入即行为不变；
`RunLivePumpOptions` 的结构性缺口是本轮最严重的一条——它说明 **0.0.381–0.0.384 期间这个 flag 从未真正生效**，
§8.3 那次实机验证覆盖的也不是新路径执行体。

**验收**：新增 22 个用例（真实 UPOS 目标＋假网络 7 个、驱动层 8 个、装配层 6 个、runner 接缝 1 个）。
逐项撤回修复都会让对应用例失败（两轮各 5 条，见 PR 正文）。全量 `pnpm test` 5341 passed / 0 failed、
`pnpm typecheck` 0 错、`arch:check` 一致、`pnpm bundle` 0.0.385。

### 8.5.1 第三轮：复核发现的「对齐后仍然更危险」（0.0.385，2026-11-13）

第二轮独立复核确认上一版仍有四处会把一场直播的分 P 或稿件搞丢，全部修复后才算完成：

| 差异 | 后果 | 改法 |
|---|---|---|
| 建稿非 ok 响应按**文本**分类 | 响应体只要出现 `timeout` 就判 transient，驱动重试建稿 5 次；第一次 POST 可能已经建好 → 重复稿件 | 非 ok 只认限流码（冷却后重试）；其余一律 `proof: unknown`，一次即停 |
| 追加遇到传输错误仍重试 | 编辑请求可能已生效；旧路径遇异常直接停、留 pending，重试会重复分 P | 追加的 catch 里 transport／ambiguous 一律 `unknown` |
| 校验类拒绝报 `confirmed-not-submitted` | 该证明会被驱动当成「可安全重试」，同一份无效载荷（如 21001）再提交 5 次 | 去掉按码猜的证明：非限流拒绝一律 `unknown`；旧路径同样只停不重试 |
| pending 冷却等待不可中断 | 停止后还要等满 60–300s，超出 pump 7s 收尾预算，子进程只能被 supervisor 杀 | `driver.pause` 同时监听运行/单次 signal；`buildLivePumpSubmitter` 默认 sleep 在 abort 时清 timer |

复核后还补了一处同类缺陷：非流式 `create()` 的 `submitStudio` 没有包 `catch`，POST 超时抛出的错误仍会被文本分类成
transient → 再建一次稿（当前无生产调用者，但 `ensureArchive` 一接上就是活的）。已与流式路径同规则：`isTransport` → `unknown`，并加对应用例。

**测试补强**：等待序列改为断言精确的 `[60s,120s,240s,300s]`（旧的「最后一条 ≥60s」对平 60s 也成立）；
停止用例改为在**真正 pending 的 sleep** 中 abort；建稿/追加各加「响应体只提到 timeout」与「编辑响应丢失」用例，
并用驱动断言只发一次请求。默认 sleep 的 timer 清理用 fake timers 直接断言 `getTimerCount()===0`。

**验收（第三轮后）**：全量 `pnpm test` **5353 passed / 42 skipped / 0 failed**、`pnpm typecheck` 0 错、
`arch:check` 一致、`pnpm bundle` 0.0.385；本轮新增 12 条用例；每处修复逐项撤回都有用例变红（见 PR 正文）。

**真实直播间实跑（2026-11-13，flag=1）**：0.0.385 bundle 在容器内跑 `_live-pump`，3 段各约 30s，同一私稿 `BV1xx`；
服务端回读 3 个分 P、cid 不同、`is_only_self=1`、stem 与三段一致，`checkArchivePartsWarn` 未触发，确认后 spool 清空。
state 无 `aid`（driver 建稿只回 bvid）确认走的是 driver 路径。同一 spool/room 又续跑两轮，累计 12 个已确认分 P、cid 全不同；
3s 分段的压力轮命中 **preupload 601**（不是提交层的 21540），退避 30/60/120/240/300s，最坏约 48 分钟，停止后未确认分 P 与 spool 均保留（测试数据随后手工清理，未走恢复）。
**提交层 21540 冷却重试（2026-11-14 UTC）**：在私稿 `BV1xx` 上先真实 edit 删掉最后一个分 P，再用 driver `appendStreamedPart` 在 1s 内追回同一 stem。追加命中真实 `{"code":21540,"message":"请求过于频繁，请稍后再试"}`：`noteRateLimited` 被调用，driver 打出 `waiting 60s before retry (rate-limited)`，60s 后重试并 `confirmed=[1]`；紧接着的下一次 edit 也返回 21540，说明限流是服务端真实状态。稿件恢复 9 个分 P、私有（`is_only_self=1`）。**受管 append 与节点 gate 落库（2026-11-14 UTC）**：同一台节点开 flag，受管跑 1s 分段（任务 id 9997）：9 个分 P 进同一私稿 `BV1xx`（cid 全不同、私有），回执 parts=9。途中真实命中 21540，driver `waiting 60s before retry (rate-limited)`，60s 后重试继续确认。`douyin-rec.db` 的 `upload_limits` 该账号行被真实改写：`updatedAt` 与 `blockedUntil` 正好相差 30 分钟（1,800,000ms），`times` 记下 5 次 claim；日志出现 `account upload window is busy or cooling; submitting anyway`。跑完后 flag 关闭、测试任务/目录/回执清理，gate 冷却按真实限流保留到期。

**节点金丝雀（2026-11-13，一台空闲 worker）**：另一台在录，选空闲的那台；部署 0.0.385 后临时开 flag。
任务 id 48（非受管）跑 9 个分 P 同一私稿；受管分支用 `--zero-disk-managed 1` + `DREC_ZERO_DISK_DELIVERY` 手工跑：
预检通过、`submitGate` 记账成功（`upload_limits` 该账号 `claims=1`）、driver 建私稿 `BV1xx`、回执写入（bvid + parts=1），
SIGTERM 后 2s 退出。随后 flag 关闭、测试任务/目录/回执清理。**未覆盖** `noteRateLimited` 与真实 21540（601 把第 2 段挡在 preupload）。

**仍然不能默认开启**：`DREC_LIVE_PUMP_DRIVER` 默认值保持 0。上面 11 处对齐（§8.5 的 7 处 + §8.5.1 的 4 处）加上节点金丝雀，
已覆盖分 P 数、stem、private、受管回执；真实 21540 的冷却重试与 `noteRateLimited` 回调已在 driver 层跑通；受管 append 与节点 `makeNodeSubmitGate` 的 `blockedUntil` 落库也已在节点上实跑。**验证层面不再有硬缺口**，默认开启只剩放量决策与部署验收。

## §9 验收清单（对应审计「复审验收点」）

- [ ] 新增假上传目标 + 假平台：一个包 + 一行注册；app/web/orchestrator 零改动；
- [x] core 里 `bili|biliup|upos` 只剩注释（阶段 4，0.0.384，例外见 §8.4）；
- [ ] 三种管线模式共用一份「建稿→append→重试→幂等」驱动；
- [x] `proc-queue` 存不透明目标状态（阶段 3：`targetState` 双写，旧列保留一个发布周期）；
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
