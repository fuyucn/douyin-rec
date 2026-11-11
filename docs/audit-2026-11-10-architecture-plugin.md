# 架构审核 + 插件化改造指导（2026-11-10）

只读审核，基线 `0ea30b8f`（版本 0.0.348）。本文是给 agent team 的改造指导，不是实施计划；
不含代码 diff。未跑测试（审核所在 worktree 未装依赖）。

**结论：录制侧（平台 / 引擎 / 处理器 / 传输）的插件骨架成立，但「上传目标」完全没有抽象，
「管线」有三份实现，hub 的组装逻辑塞在 `cli.ts` 里。** 包依赖图本身干净：无未声明依赖、
无跨包相对引用，`pnpm arch:check` 通过。

标注约定：**[已核实]** = 对照源码确认过；未标注 = 来自子审核且抽查一致，行号动手前重新定位。

## P0 — 现存缺陷，先修，不等重构

各自单独开 issue、小 PR、带回归测试。上传相关改动按仓库规则走 `needs-decision`。

1. **Web API 没有任何鉴权 [已核实]。** `packages/app/src/web` 下没有 token / 密码检查，
   只有 Host 白名单和 Origin 校验。
   - Host 白名单放行任意 IP 字面量；不带 `Origin` 的请求（curl）直接放行。
   - compose 默认 `${BIND:-0.0.0.0}:7860`，同网段机器可调删任务、停录制、清理文件、写 cookie。
   - 方向：默认只绑回环或 tailscale 地址；写操作要求共享密钥。
   - 待确认：tailscale sidecar 下的实际暴露面（需在部署机实测）。
2. **续跑 append 会重试「结果不确定」的错误 [已核实]。** `orchestrator/src/pipeline.ts:1545-1557`
   单文件 5 次重试且没传 `shouldRetry`；其它路径都排除了 `isAppendAmbiguous`。后果：可能重复分 P。
3. **多文件 append 的重试与注释相反 [已核实]。** `orchestrator/src/workflow.ts:346` 多文件组给了
   3 次重试；注释和 `segment-pipeline.ts:624` 都说多文件组不该重试。
4. **直传路径的数字限流码匹配不上 [已核实]。** `zero-upload/src/live-pump.ts:1187` 把
   `JSON.stringify(raw)` 交给 `isUploadRateLimited`，正则是 `code:\s*601`，JSON 里是 `"code":601`。
   只有中文文案能命中，文案一变就当永久失败。
5. **两条路径绕过账号闸门和节点槽位 [已核实]。** `cli.ts` 的 `upload` 命令（:1209 起）和
   `_upos-upload`（:815-877）没有任何 `UploadGate` / 槽位引用，也没有 21566/21540 冷却。

## P1 — 结构问题（插件化主体）

### 1. 缺「上传目标」这根轴

B 站不是某个接口背后的实现，而是通用层的词汇。

- 约 10 条上传路径，分属两套互不相干的栈（biliup CLI、自研 UPOS）。
- 硬常量各定义一次、共两份：关水印、copyright、仅自己可见分别在 `processors/src/run-biliup.ts`
  和 `zero-upload/src/upos-stream.ts`。可见性两边极性相反（`public` 对 `private`），每个边界手工转换。
- 重复：「建稿后 append + 重试」写了 5 遍；cookie 路径（`BILIUP_COOKIE` / `…/cookies.json`）
  出现 22 处、9 个文件 [已核实]；限流判定 3 个版本；BV 正则 3 处；默认 tid/tag 4 处且 tag 值不一致。
- 通用层里的 B 站代码：`core/upload-gate.ts`、`core/bili-season*.ts`、`core/upload-contract.ts`、
  `core/processor.ts` 的 `BILIUP_*` 能力常量；`proc-queue` 的 `bv` / `seasonState` 列和
  `kind === 'biliup'` 分支。
- 死代码 [已核实]：`uploadThenAppend` / `uploadThenAppendGroups`（`run-biliup.ts:351-387`）
  生产代码无调用方，只剩 re-export 和测试，可连测试一起删。

**改法方向：**

- 在 core 定义 `UploadTarget` 契约和注册表，与 `Platform` 同构：建稿、追加分 P、查稿件、
  错误分类（限流 / 不确定 / 永久）、账号标识、凭据定位、硬策略。
- 新建 `bilibili-upload` 包实现它；biliup CLI 和 UPOS 是它内部的两种传输。B 站专属代码从 core 迁入。
- 「建稿 → append → 重试 → 幂等」只写一份通用驱动；各路径只提供文件清单和状态存储。
- `proc-queue` 的 `bv` / `seasonState` 改成不透明的目标状态字段。这是 schema 迁移，需单独决策。

### 2. 管线有三份实现

合并模式走 DAG（`workflow.ts`），分段模式（`segment-pipeline.ts`）和节点侧
（`app/node-pipeline.ts`）是手写副本。

- `splitGroupsBySession` 有三份 [已核实]：`app/node-pipeline.ts:378`、
  `orchestrator/segment-pipeline.ts:122`、`processors/upload-prep.ts:23`。
  `linkOrCopySync` 两份：`node-pipeline.ts:438`、`segment-pipeline.ts:41`。
- DAG 不是注册表：6 个节点是封闭 union，在 `buildWorkflow` 里内联构造；select / pull / clean 在 DAG 外。
- 边声明两次：`core/hub-flow.ts` 只用于展示，注释（:20-23）承认与实际执行不一致 [已核实]。
- `RollingUploader`（约 1282 行）和 `LivePumpSession` 各自再实现一遍建稿、续传、限流重试。

**改法方向：** 步骤做成注册表（输入、输出、资源类别、可否重试、幂等键），三种模式变成同一执行器上的
三张图；`hub-flow.ts` 从同一份定义派生。先合并分段与合并模式，节点侧最后做。

### 3. hub 组装根在 `cli.ts`

`hubStarter` 从 `cli.ts:1440` 起约 1061 行闭包，前面 :1239-1339 有 20 个模块级可变量 [已核实]。
里面是业务逻辑：录制状态探测、任务与 cookie 同步、`retryNode`、每房间管线配置解析。

根因是分层：orchestrator（4.5）不能 import app（4），接线只能落到 cli。同一原因让 app 直接用
原始 SQL 读写 orchestrator 的台账库（`app/src/hub-jobs.ts:132` 开写连接删五张表）[已核实]，
一份 schema 两个所有者。

**改法方向：** 新建组装层包（rank 介于 orchestrator 与 cli 之间）承接 `hubStarter`，拆成若干有状态
服务；台账读写接口由 `SyncLedger` 提供，app 通过注入拿到，不再自己开库。`cli.ts` 只留命令接线，
19 个内联隐藏命令移到 `node-commands.ts`。

### 4. master ↔ worker 协议是逐命令临时拼的

- 约 25 个隐藏命令，没有版本或能力握手。「不支持」靠正则匹配 commander 的报错文本
  （`transport-ssh.ts:119-121`）[已核实]。
- 回落策略每处不同：返回 null、抛 `ProcUnsupported`、抛 `CookieSyncUnsupported`、退回旧命令。
- `Transport` 有 3 个必选、约 20 个可选方法；类型散在 `core/worker-contract.ts` 和 `transport.ts`。
- `_node-capabilities` 已存在，但只有节点侧上传在用。

**改法方向：** 一张命令表（名称、版本、请求和响应类型）放 core，两端从表生成；连接时读一次能力清单，
按清单决定调用或回落，回落策略统一一处。

### 5. 「加平台 = 一个包 + 一行注册」不成立

- 扫码登录在 app 里按名字三元选择（`serve.ts:173-178`）[已核实]；三平台的登录端点都在 `app/src/login`。
- 会话 cookie 判定写了 3 遍（`cookie-utils.ts`、`cli-task.ts:185`、前端 `CookieDialog.tsx`）；
  过期时间只支持抖音。
- 前端手工枚举平台，没用 `/api/platforms`：`SettingsDialog`、`QueuePage.tsx:209` [已核实]、
  `QrLoginDialog`、`RoomEditor.tsx:128`、`HubRuleDialog.tsx:232`。
- `"douyin"` 作为隐式默认约 15 处，没走 `defaultPlatform()`；`DOUYIN_REC_API_MODE` 穿透四层；
  `serve.ts:516` 动态加载 `@drec/douyin-live` 跑签名金丝雀。

**改法方向：** `Platform` 增加可选成员：扫码登录工厂、`hasSession`、`cookieExpiry`、cookie 提示文案、
是否用 cookie 取流、敏感 cookie 名、健康探测、平台专属设置与子进程环境。
前端全部由 `/api/platforms` 下发的描述驱动。

### 6. core 不是纯契约层

47 个源文件里 12 个做 IO [已核实]：`upload-gate`、`upload-slot`（两者直接开 sqlite）、
`bili-season`、`bili-season-resolve`、`link-or-copy`、`atomic-write`、`output-paths`、
`recorder-state`、`config`、`engine`、`child-identity`、`job-abort`。
`index.ts` 是 45 行 `export *`，暴露约 529 个符号。

**改法方向：** core 只留类型、注册表、纯函数；IO 工具（原子写、硬链接、子进程登记）拆到一个底层
运行时包；B 站部分随 P1-1 迁走。

## P2 — 治理与卫生

- **配置至少 8 个来源、无统一读取点。** `process.env` 78 处引用、29 个变量名、30 个文件 [已核实]；
  两套前缀（`DOUYIN_REC_`、`DREC_`）。方向：一个配置模块集中读取和校验，其它地方禁止直接读 env，
  加 grep 守护。
- **分层守护只看 `package.json`。** 根 `tsconfig.json` 的 paths 让未声明的导入也能编译；web 被跳过，
  却通过 vite 别名引 6 个 core 文件。方向：守护改为扫源码 import；web 可引用的 core 文件列白名单。
- **超大单元。** `runLivePump` 约 1117 行、`runServe` 约 575 行（整个文件只有这一个函数）、
  `TaskManager` 约 692 行 38 个方法、`live-pump.ts` 4019 行。拆分随 P1 进行，不单独立项。
- **空 catch 约 230–260 处**（正则统计，口径不同数字略有出入）；app、zero-upload、orchestrator 最多。
  与仓库「不静默」规则冲突，按包清理：每处要么记日志，要么写明为何可忽略。
- **Web 路由**是路由表加约 80 个 case 的 switch，手工同步；请求体只做类型断言不校验。
- **前端** 0 测试；i18n 键是 `string`，中英文是否齐全编译器不检查。
- **文档与配置漂移 [已核实]：**
  - `AGENTS.md` 列了不存在的 `tui` 包和 `dist/tui.mjs`，rank 清单缺 `zero-upload`，
    引用不存在的 `biliup.ts`。
  - 根 `tsconfig.json` 残留 `@drec/tui`、`@bililive-tools/*` 路径。
  - `TODO.md`「进行中」段 78 项，另 10 项 `[~]` 错放在「待办」段；规则是最多 1–2 项。
  - CI 注释写「13 packages」；esbuild `target: node20` 而引擎要求 Node 24。

## 分工与顺序

| 组 | 内容 | 依赖 |
|---|---|---|
| A | P0 五项，各自小 PR 带回归测试 | 无，立即开始 |
| B | 上传目标轴（P1-1） | 先出契约设计送审，再写代码 |
| C | 组装层 + 台账接口 + `cli.ts` 瘦身（P1-3） | 无，可与 B 并行 |
| D | 平台契约补全 + 前端描述驱动（P1-5） | 无，可并行 |
| E | 协议命令表与能力握手（P1-4） | C 之后，避免同改 `cli.ts` |
| F | 管线步骤注册表（P1-2） | B 之后，否则要改两遍 |
| G | 守护、配置模块、文档清理（P2） | 守护先行，其余随时 |

core 瘦身（P1-6）随 B 和 G 完成，不单列。

每组约束：

- 纯搬迁与行为变更分开 PR。
- 行为不变的 PR 要有对拍或原测试全绿作证。
- 本机同时最多 2 个 vitest，各组不要并发跑全量。

## 实现前需二次确认

- 子审核给的行号动手前重新定位。
- 「vitest 不能 import 平台包」疑似过时：`test/recorder/extraction-parse.test.ts` 无 mock 直接导入
  douyin-live。在装了依赖的检出里跑一次该文件，通过即说明该说法过时（`test/setup.ts` 的假平台可简化）。
- UPOS append 每次重发空 `cover` 是否会清掉手工封面：需真实稿件验证。
- tailscale sidecar 下 Web API 的实际暴露面：需在部署机实测。
- `proc-queue` 改列涉及线上节点的库迁移与回滚路径，需要人拍板。

## 复审验收点

- 新增一个假平台和一个假上传目标，只需要一个包加一行注册；app / web / orchestrator 零改动。
- core 里 grep `bili|biliup|upos` 只剩注释。
- `cli.ts` 只有命令接线；app 不再直接打开台账库。
- 三种管线模式共用一个执行器和一份步骤定义。
- 守护测试能拦住一条故意加的越层 import。

复审节点：B 组契约设计（写代码前）；P0 每个修复 PR；各组结构性 PR 合并前。
