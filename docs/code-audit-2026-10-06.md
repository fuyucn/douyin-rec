# 代码审计报告(2026-10-06)

**审计对象**：本仓库 HEAD `a839948`（近 25 次提交含 hub 多节点、分P改名、快手接入等大改）。
**方法**：3 个独立 sub-agent 交叉审核（A=app/cli/orchestrator，B=core/平台/web/manager，
C=仓库布局/构建/文档），主线程对每条高影响结论**独立复验**后才收录。
**基线**：`pnpm typecheck` ✅ / `pnpm test` 78 files·786 tests ✅ / `web build` ✅ / `docker build` ✅。

**总体结论**：**没有发现 P0(正确性/安全阻塞)**。架构分层（`test/arch/layering.test.ts`）**通过且没有被破坏**。
问题集中在三类：① 少数**文件过长、职责混杂**；② 若干**可合并的重复代码**；③ 一堆**配置/文档/死代码的小污点**。
下面每条都带文件:行号与具体动作，按优先级排列。

> 记号：`[已复验]` = 主线程独立确认；`[双证]` = 两个 sub-agent 各自独立命中。

---

## 一、P1 — 值得尽快修（都是真问题，非风格）

### 1.1 `sync_parts` 表从未被清理（孤儿行累积）`[双证][已复验]`
- `packages/orchestrator/src/ledger.ts:94` 创建 `sync_parts` 表；
- 但 `packages/core/src/hub-ledger-contract.ts:35` 的 `HUB_TABLE_NAMES` **漏了它**；
- `packages/app/src/hub-jobs.ts:57` 的 `HISTORY_TABLES = HUB_TABLE_NAMES` → `deleteHubJobHistory()` 永远删不到该表。
- **动作**：把 `"sync_parts"` 加进 `HUB_TABLE_NAMES`；补一条单测断言「建表集合 == HUB_TABLE_NAMES 集合」，从根上防止再次漂移。

### 1.2 `.gitignore` 里 `output-data/` 因行内注释而失效 `[已复验]`
- `.gitignore:19` 写作 `output-data/     # 未设 DOUYIN_REC_ROOT 时的默认数据根…` —— git 把整行当 pattern，**默认数据根其实没被忽略**。
  复验：`git check-ignore -v output-data/config/hub/x.json` → 未命中（exit 1）。
- 后果：本机一旦用默认数据根，`config/hub/*.json`（含房间号）会以 untracked 出现，极易误提交。
- **动作**：注释独立成行 + 纯 `output-data/`；顺带补 `stage/`。

### 1.3 `post-process` 缺声明依赖，靠 root hoisting 侥幸可用 `[双证][已复验]`
- `packages/post-process/package.json` 是 `"dependencies": {}`，但
  `src/ass/render.ts:2` `import { XMLParser } from "fast-xml-parser"`、
  `src/ass/livechat.ts:5` `require("eastasianwidth")`。
  该包没有自己的 `node_modules`，只靠根依赖提升 → `pnpm install --frozen-lockfile` 在干净环境或 `--strict` 下会炸。
- **动作**：两个包声明进 `dependencies`；`livechat.ts` 的 CJS `require` 改 `import`（与 B 报告一致）。

### 1.4 `sanitizeKey` 双实现必须保持一致（写/读跨包）`[已复验]`
- 写：`packages/orchestrator/src/pipeline.ts:133`；读：`packages/app/src/hub-jobs.ts:61`；另有内联 2 处（`cli.ts:794,981`）。
  两者必须逐字相同，否则 job 日志/目录定位错位。
- **动作**：提升为 core 的 `sanitizeStreamKey()`，四处共用（列为本轮首选小重构）。

### 1.5 `cli.ts` / `web/api.ts` / `cli-task.ts` 过大且职责混杂 `[已复验]`
| 文件 | LOC | 混杂的职责 | 建议拆分 |
|---|---|---|---|
| `packages/cli/src/cli.ts` | 1334 | 6 组：record/merge/burn/upload + `hubStarter.start`（563–1139，约 590 行）+ 若干隐藏命令 | `commands/*.ts` + `hub/{hub-starter,task-sync,retry-node,recording-status}.ts` + `helpers.ts` |
| `packages/app/src/web/api.ts` | 1132 | `makeApi()` 里 48 个 handler 跨 4 个域 | `handlers/{tasks,cookies,settings,hub}.ts` + `ctx.ts` |
| `packages/app/src/cli-task.ts` | 866 | `serve` action 内嵌 4 个 watch（rec/disk/cookie/canary） | `serve/` 子目录 |

（`scheduler.ts` / `timezone.ts` / `task-input.ts` / `paths.ts` / `transports` 等小文件职责清晰，**保持不动**。）

### 1.6 死依赖与失效路径 `[已复验]`
- `packages/app/package.json`：`ws`、`yaml` 全仓库无 import（`ws` 实际只在 `douyin-live/src/danmaku/client.ts:16`，`yaml` 只在 `core/src/config.ts:2`）→ 删。
- `packages/cli/package.json`：`yaml` 无 import → 删。
- `packages/orchestrator/package.json:3` 版本 `0.0.1`（其余包皆 `0.0.0`）→ 统一。
- 根 `package.json:15` `"build": "tsc -p tsconfig.json"` 会产出 `dist/packages/core/src/index.js` 这种错位布局，CI 也从不调用 → 删或改成 noEmit。

---

## 二、文件分类（File classification）

### 2.1 前端
- `packages/web/src/lib/i18n.tsx`(506) —— 实为**纯 TS**（0 个 JSX 标签），却承 3 份职责 → `lib/i18n/{index,dict.zh,dict.en}.ts`。
- `packages/web/src/components/HubJobs.tsx`(545) —— 混了 4 个无关单元 → 拆 `lib/hub-labels.ts` + `components/PipelineFlow.tsx`。
- [P2] `web/src/lib/labels.ts:46,61`（`QUALITY_OPTIONS`/`DANMU_LABEL`）与 `web/src/index.css:757` 一组 `metric-*`/`log-panel` 类**无引用** → 删。
- [P2] i18n 中英两套各 **29 个死键**（键集一致，含 `tasks.startFailed/stopFailed`，`TaskList.tsx:82,92` 直接用 `errMessage` 绕过）→ 清理。

### 2.2 后端
- `orchestrator/src/workflow.ts`(725) 与 `pipeline.ts`(640) 各担 2+ 职责（DAG 执行/节点构造/ResourcePool vs pipeline/cleanup 原语）—— 拆分价值中等，可后排。
- core 的 `*-contract.ts` 系列**分类良好，保持**（各有真实跨包消费者与破环理由）；**唯一**建议：把 `api-types.ts:10-62` 的 `HubPipelineConfig`/`HubRecordingConfig`（本质是落盘文件 schema）挪到 `hub-rule-contract.ts`。

### 2.3 包结构
- `test/arch/layering.test.ts` 通过；`orchestrator` 确实不反向依赖 `app`，`app`(L4) 直读 orchestrator 的 ledger sqlite 是**有意为之**但最脆的耦合 —— [P2] 建议把 ledger 读模型收进 orchestrator 暴露类型化 API。
- [P2] `ffmpeg-recorder-extra`（101 行）**该存在**（被 douyin-live + record-engine 真实依赖），只是命名含糊、且 rank 0 定位迫使它内联 logger。
- [P2] `web` 的 `@drec/contracts` 是**指向别的包源码的 alias 伪包**（`vite.config.ts:10`、`tsconfig.app.json:12`，4 处 import）—— 可用，但要在 README 记一句「不是真包」。

---

## 三、代码重复（可合并项，按收益排序）

1. **`ffprobe` 适配器闭包在 `cli.ts` 抄了 4 份**（`621 / 1098 / 1121 / 1245`，字节级相同）`[已复验]` → 提一个工厂函数。
2. **`sanitizeSeg`（`app/src/web/api.ts:145`）≈ `sanitizePathSegment`（`record-engine/src/index.ts:52`）**（文件头注释已自我声明「必须与 UI 一致」却各写一份）→ 后者 import 前者。
3. **类型后缀剥离正则不一致**（`manager/src/index.ts:440` 认 `-PART<n>|_<3+位>`；`post-process/src/concat.ts:19` 多认 `_PART<n>`）—— 在 `x_PART001.ts` 上行为分叉。
4. 平台层可上提的重复：`roomToUrl` 3 份、Chrome UA 3 份、弹幕健康看门狗逻辑 2 份、快手 codec 选择链 2 份 —— **建议**：URL 语法/WS 编解码**各平台自留**，把「取流 parse 骨架 + 看门狗」上提。
5. `web/src/lib/tz.ts:8` 每次调用 new `Intl.DateTimeFormat`（2s 轮询里按行调用）→ memoize；`core/src/title-template.ts:70,75` 同类。
6. `web/src/modals/HubRuleDialog.tsx:98-125` 重实现了 core 的 `title-template` 引擎（**就是本轮 `{kind}` 改动的那段**）；:88 重实现 `labels.ts:81` 的 `roomId`。→ 前端别重写，直接 import 或抽共享。
7. `tui/src/log-level.ts:9-17` ≡ `web/src/lib/logLevel.ts:9-17`（逐字节相同）→ 下沉 core。
8. `sumBytes`(`format.ts:22`) vs `sumBytesOf`(`workflow.ts:304`)、`splitToSizeLimit` wrapper 2 份、`sh` logger 3 份、`roomToUrl` 2 份。

---

## 四、死代码 / 导出卫生

- [P1] `app/src/index.ts`：53 个导出里 **29 个从未被 barrel 消费**（全仓库只有 `cli.ts` 经 barrel 取 24 个）。
- [P1] `orchestrator/src/index.ts`：26 个导出里 **12 个无 barrel 消费者**（`EndDebouncer`/`FfprobeAdapter`/`Workflow*` 等）。
- [P2] 零引用符号：`rootHubTaskConfig`(`paths.ts:63`)、`planPartFilename`(`session-plan.ts:151`)、`post-process/src/index.ts` 15 个导出、`HubJobStepDTO`(`api-types.ts:102`)、`RecorderKind`(`store.ts:16`)。
- [P2] 失效路径：`test/session.test.ts:10` `import … "../src/core/notify/notifier.js"`（该路径**已不存在**，因 type-only 被擦除才没报错）→ 改成从 `@drec/core` 取 `Notifier/NotifyEvent`。

---

## 五、效率（只列真热点）

- [P1] `cli.ts:919` `buildTransports()` 被写在 worker **循环体内** → 每轮 N 次重建 transport map、每次重读 `hub.config.json`。
- [P1] `hub-jobs.ts:124` `hubStageDir()` 每次调用都重新读+parse `hub.config.json`，而它是 `jobLogPath` 的默认参数 → `listHubJobs` 每行一次（N+1 IO）。
- [P2] `cli.ts:1078` `refreshRecordingStatus` 每 5s 对每个绑定 worker SSH 一次；`readHubJobLog`(`hub-jobs.ts:283`) 先把整文件读进内存再切片（应读尾部）。
- [P2] `record-engine/src/index.ts:216` 告警用 `POLL_MS` 而非实际 `this.pollDelayMs` → 风控降频时把已耗时长低估最多 10×。
- [P2] `manager/src/index.ts:103-110` 的 3s race `setTimeout` **从不 clear**；`core/src/job-abort.ts:99` 升级 SIGKILL 的 timer 无 `unref()`。
- [P2] `HubPage.tsx:45,54` / `RoomDetail.tsx:102` 每 3s 重复拉同一批端点；`lib/hooks.ts:46-55` 页面隐藏时仍在轮询。

---

## 六、仓库 / 构建 / 文档卫生

- [P1] **`AGENTS.md`(18KB，**.gitignore 第 34 行忽略了它**) vs `CLAUDE.md`(22KB，被跟踪)** 是两份分叉的同源文档，且 `Co-Authored-By` 一处要求加、一处要求不加 —— 直接矛盾。→ 定**单一真相源**（被跟踪的 `CLAUDE.md`），另一份压成指针。
- [P1] `.dockerignore` 漏了 `output-data`、`stage`、`logs`、`.claude`、`.agents`、`.hallmark`、`CLAUDE.md`、`README.md`、`design.md` → 本地数据根与 AI 产物、甚至含 VPS IP 的 `logs/cleanup/vps-residuals-*.txt` 都会进 build context。
- [P1] `docker-compose.yml:72` bind-mount 了 `.gitignore` 掉的 `./remote/vps.key`；**该文件缺失时 Docker 会静默建同名目录**（已复现）→ 容器 SSH 失败且难排查。→ 键位改成可配置路径，别放在 `remote/`。
- [P1] 文档**漏了 `kuaishou-live`**：`README.md:22`、`CLAUDE.md:19`、`docs/architecture.md:3`、`docs/architecture.html` 都没有它（仅 `AGENTS.md:77` 有）。→ 四处补齐。
- [P1] `docs/multi-node-sync-plan.md`（1199 行、71 个未勾选 box、**零引用**）与 `plans/015_multi_node_followups.md` 重叠；`AGENTS.md:95` 引用的 `plans/030_platform_abstraction.md` **不存在**。→ 给 `plans/` 加索引+状态，归档已完成计划。
- [P1] 别名表漂移：`tsconfig.json:14-24` 覆盖 7 个包，`vitest.config.ts:50-56` 覆盖另 7 个，**都未覆盖全部 13 个**；`tsconfig.json:22-23` 的 `@bililive-tools/*` 指向**不存在的** `node_modules/@bililive-tools/…`。→ 统一生成。
- [P2] 根目录残留可删：`douyin-rec.db`、`download.log`、`ds_update.log`、`.pytest_cache/`(未忽略)、`.orka/`、`bin/*.log`、`scripts/.claude/`、`bin/youtubeuploader`(0 引用)。
- [P2] `dist/` 里有 6 月旧布局残骸(`cli.js`/`core/`/`danmu/`/`recorder/`)（未跟踪，可清理）；`.pytest_cache` 未进 .gitignore。
- [P2] 两个 CI workflow 都**没有 `cache: pnpm`**；`ci.yml:34` 文案写「13 packages」但树列表漏 kuaishou。
- [P2] 术语未收尾：`docs/multi-node-sync.md:15` 及 `cli.ts:1219`、`app/src/web/api.ts:111` 注释里仍有「slave」。
- [P2] `docs/architecture.md` ↔ `architecture.html` 同内容双份；`design.md` 该挪进 `docs/`。

---

## 七、建议执行顺序（按「收益/风险」）

**第 1 批 — 低风险、纯收益（可一次性做完）**
1. `.gitignore:19` 修注释 + 补 `stage/`（1.2）
2. `HUB_TABLE_NAMES` 补 `sync_parts` + 防漂移单测（1.1）
3. `post-process` 补声明依赖（1.3）
4. 删死依赖 `app:{ws,yaml}`、`cli:{yaml}`（1.6）
5. 修 `test/session.test.ts:10` 失效 import（四）
6. `hubStageDir()` 缓存 + `cli.ts:919` 移出循环（五）

**第 2 批 — 小重构，需回归**
7. `sanitizeStreamKey` 收口（1.4）+ `sanitizeSeg` 复用（三-2）
8. 统一段后缀正则（三-3）
9. `ffprobe` 工厂 + `tz`/`Intl` memoize（三-1、三-5）
10. 删 barrel 死导出（四）

**第 3 批 — 结构性拆分（建议单独 PR / 单独 plan）**
11. `cli.ts` → `commands/` + `hub/`（1.5）
12. `web/api.ts` → `handlers/`（1.5）
13. `cli-task.ts` → `serve/`（1.5）
14. `i18n.tsx` / `HubJobs.tsx` 拆分（2.1）
15. 文档单一真相源 + `plans/` 索引 + kuaishou 补齐（六）

**第 4 批 — 需要设计决策，先讨论**
16. `app` 直读 orchestrator ledger → 收进 orchestrator 类型化 API
17. 平台层重复上提的边界（URL 语法留平台 / 取流骨架与看门狗上提）
18. `hubLedger`/`api-types` 的 `HubPipelineConfig` 迁到 `hub-rule-contract.ts`

---

*原始分报告：`/tmp/audit-vs/{A,B,C}.md`（A=app/cli/orchestrator 279 行，B=core/平台/web 200 行，C=仓库/构建/文档 295 行）。*
