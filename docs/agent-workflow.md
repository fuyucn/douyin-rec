# Agent 开发流程

GitHub issue 是队列和证据。`TODO.md` 只记录已经 `accept` 的实现项。对话不是台账。

## 角色

| 角色 | 能做 | 不能做 |
| --- | --- | --- |
| 值班 Audit | 读 master 与各 worker 的录制状态、queue、`sync_jobs`、磁盘、日志；有证据才开 `incident` | 改代码、删文件、重启、重传、部署 |
| 优化 Audit | 低频开 `enhancement`，写清代价和验收标准 | 把优化伪装成故障，或直接改代码 |
| 自动 Triage（heartbeat） | 自动打 `accept` / `decline` / `needs-decision`，`decline` 写原因。**当前 PAUSED，由实现心跳或人代跑** | 对危险类自行 accept；替人拍板 |
| 自动实现（heartbeat） | 领 `accept` issue（并行 ≤2，见下），开分支和 **开 PR**（`Fixes #N`）；打回后在原分支返工；`待验证` 票部署实跑后按「四不 close」**close issue**（close 的单一负责方） | 合并 PR、部署、顺手做无关改动 |
| 自动 Review（heartbeat） | 对每个 open PR 派**独立会话**审查（门禁见下）；**审查通过即合并 PR 并把票转 `待验证`**；不通过打回并列出缺口 | 改实现代码（只打回，不代改）、部署、跳过门禁合并、close issue |
| 人 | 部署、危险类拍板（`needs-decision`） | —— |

危险类永远是 `needs-decision`，等人点头：上传、删源、删稿、部署、改 hub 规则、清理录像。

## 自动 gate（2026-10-12 起）

**不是每张票都等人 accept。** 低风险、有证据的票由自动 triage 直接进开发流程；只有真正需要
人拍板的才拦下来。**合并也不再等人**：PR 由独立 review 会话审查，通过即自动合并。这一层由
三个 heartbeat 承担（配置在 `~/.codex/automations/`）：

| heartbeat | 节奏 | 做什么 | 禁止 |
| --- | --- | --- | --- |
| issue 自动 triage（当前 PAUSED，由实现心跳或人代跑） | 5min | 对新票自动打标签（规则见下） | 写代码、开分支、开 PR、close |
| issue 自动实现 | 10min | 领 `accept` 且无 `in-progress` 的票 → 分支 + PR；打回票原分支返工；`待验证` 票收口 close | 合并 PR、部署、并行超过 2 张 |
| PR 自动 review + 合并 | 10min（与实现错开） | 派独立会话审 open PR；**门禁全过 → `gh pr merge --merge`，票转 `待验证`**；不过 → 打回并列缺口 | 改实现代码、部署、跳过门禁合并、close issue |

**自动 triage 判定规则**：

1. **危险类 → `needs-decision`**（永不自动 accept）：上传、删源、删稿、部署、改 hub 规则、清理录像，
   以及任何「不确定影响面」的票。评论必须写「决定三行」。
2. **证据充分 + 低风险 + 可测试 → `accept`**：能按正文复现/定位（故障类有命令输出与节点角色；
   优化类有明确现象、影响、验收标准），且改动局限在单个模块、有回归测试可钉。
3. **证据不足 / 明确不做 → `decline`**：缺命令输出、无节点角色/时间、描述无法验证、重复票已在
   开着的 issue 里，或与仓库方向冲突（如绕过 guard）。评论写清原因。
4. **拿不准 → `needs-decision`**，不猜。

**自动实现约束**：并行**最多 2 张**活跃票（已认领、PR 未合并），且两张票的改动范围（文件/模块）
**不重叠**才可并行，重叠的第二张等第一张合并；认领时先打 `in-progress`
并评论「哪个 agent、何时开始、范围（要改哪些文件/模块）、模型」；只开 PR——**合并交给 review 心跳**
（审查通过即自动合并），部署仍不自动；**close 见下方「四不 close」——四条门禁全过才允许 close**；
危险类哪怕已误标 `accept` 也要退回 `needs-decision` 再停手。

**模型分工与会话管理**：

- **编排 = 主会话**；**实现 / 返工 sub = `claude/claude-sonnet-5-5`**；**审查 sub = `claude/claude-opus-5-5`**。
  所有 sub 都以 `fork_context: false` 派出（不继承主会话上下文，评审尤其要独立）。
- **线程清理**：实现、review 两个心跳都在**每轮开头先清理已完成/空闲的子会话**（归档/关闭），再派新会话；
  清理后线程仍满，本轮只做免派生工作。
- **版本号撞号（现行做法）**：并行 PR 各自 bump 版本撞号时，后合并的一方机械 rebase 到最新 base 并顺延 patch，
  `dist/douyin-rec.mjs` 重新 `pnpm bundle`（dist 不手工合并）；这类顺延**不计返工轮次**。
  （提案，心跳暂未执行：认领时在评论里预留版本号，以免撞号。）

## 流转

1. **开票前过隐私闸门**：`python3 scripts/issue-guard.py <body-file>`（评论同样要过）。
   命中就先脱敏。不合格（没有命令输出、没有节点角色 / 时间）直接 `decline`。
2. **Audit 开 issue**，挂 `incident` 或 `enhancement`。
3. **自动 Triage 打标签**（无需人工介入）：`accept` / `decline` / `needs-decision`，判定规则见上。
   `accept` 后在 `TODO.md` 加 `T-N`，链到 issue；`needs-decision` 才需要人回一句结论。
4. **自动实现认领**：实现 heartbeat 扫到 `accept` 且无 `in-progress` 的票即认领（并行 ≤2、范围不重叠），
   打 `in-progress` 并留言「哪个 agent、何时开始、范围、模型」。**人不需要点名派活**；
   只在想指定别的会话做时手动接管。
5. **实现会话只做这一条**，开分支和 PR，PR 正文写 `Fixes #N`。不合并 PR（合并归 review 会话）、
   不部署、不顺手做无关改动。
6. **代码做完先在 issue 留言**：做了什么、评论里哪条没采纳、为什么，然后按「四不 close」自查。
7. **自动 Review 派独立会话审查**（`fork_context: false` 的新会话，只读审查、不改实现），
   按下方「review 门禁」逐条核；结论回帖到 PR。
8. **审查通过 → review agent 直接合并 PR**（`gh pr merge <N> --merge`，base 保持
   `feat/hub-optimization`）——**不再等人操作**，并把票由 `in-review` 转 **`待验证`**；
   不通过 → 打回并列缺口，票转 `rework-N`（N=第几轮；返工回路见「review 门禁」）。
   所有状态标签变化一律经 `scripts/issue-state.py`（见「循环工具」）。
9. **部署后实跑 → 收口**：**部署仍由人做**（走「无 `recording===true` 才重启」）；部署后实跑验证，
   再按「四不 close」收口：门禁全过就 `gh issue close` 并写明关闭依据（验证命令与结果 / 回归测试 /
   回写位置）。**close 的单一负责方 = 实现心跳的收口步骤**；review 心跳只做合并与转标签，不 close。

> **注意 `Fixes #N` 在这里不会自动关票**：所有 agent PR 的 base 都是 `feat/hub-optimization`，
> 不是仓库默认分支 `main`，GitHub 的 closing keyword 只在合进默认分支时生效。所以 close 必须显式执行，
> 不能指望 PR 合并顺带关掉。

`accept` 只是「可以做」，不等于「有人在做」——看板上区分这两件事靠 `in-progress` 标签。
自 2026-10-12 起，`accept` → `in-progress` 这一步由实现 heartbeat 自动完成，不再等人指定；
`in-progress` → `in-review`（PR 已开，实现侧打）→ **合并 → `待验证`** 由 review heartbeat 自动完成，`待验证` → **close** 由实现 heartbeat
在部署实跑后收口，人只在危险类拍板与部署时出场。
**文档/测试类票**（无需部署实跑）合并后，由实现心跳当轮按「四不 close」收口，无需等部署。

## 自强化闭环总览

整体五环门禁详见 `docs/self-reinforcing-dev.md`。这里只给每环对应谁、卡什么：

| 环 | 承担者 / 机制 | 门禁 |
| --- | --- | --- |
| 1 观察 | 值班 Audit + 自动巡检 | 有命令输出、节点角色、查询时间才开票；无证据不开 |
| 2 决策 | 自动 Triage heartbeat | 危险类 `needs-decision` 等人才拦；`accept`/`decline` 自动打标并留痕 |
| 3 开发 | 自动实现 heartbeat + 自动 Review heartbeat | 自动认领 `accept`；一个 issue 一个分支 + PR；行为变更必有回归测试；自审清单；独立 review 会话按门禁审查，**通过即合并** |
| 4 发布+验证 | review 合并 + 部署 guard + 实跑验证 | review 门禁全过才合并；无 `recording===true` 才部署；验证达标才算完成 |
| 5 回写强化 | 回归测试 + 规则 + 指标 | 不回写经验、无回归测试不 close |

`accept` 不是环的终点：它只表示「可以做」，真正收口要等环 4 的验证 + 环 5 的回写。

## 四不 close

**close 由实现 agent（实现心跳的收口步骤）自己做，不等人**——但四个门禁全过才算真正完成：

1. **无证据不开**——开票/评论必须有命令输出和节点角色、时间；没有就补，补不了就不开。
2. **不验证不 close**——声称修复前必须实跑验证（或由人在评论里写明由谁、何时验证）。
3. **无回归测试不 close**——行为变更必须有测试钉住；无法自动化的写清人工验证步骤。
4. **不回写经验不 close**——根因与教训写入设计文档/规则/指标，让下一轮不再重复踩。

违反任一条而 close 的，视为把「自强化环 5」断掉；review 时发现可直接打回。

执行方式：四条全过 → `gh issue close N` + 评论写明依据（哪条验证命令、什么结果；回归测试文件；
回写落在哪个文档 / 规则 / 指标）；缺任一条 → **不 close**，在 issue 里写清缺什么、谁来补、什么时候补。
危险类（`needs-decision`）的票等人拍板后才动，拍板后同样按这四条收口。

## review 门禁（PR 自动审查 + 合并）

**review 由独立会话做，不自我审查**：实现 sub-agent 开完 PR 后，review heartbeat 另起一个
`fork_context: false` 的新会话（只读审查、不改实现代码），逐条核下面的门禁。**门禁全过 → review
agent 直接 `gh pr merge <N> --merge` 合进 `feat/hub-optimization`，不等人操作**；缺任一条 → 打回，
在 PR 里列出缺口，票转 `rework-N`，等实现会话补。review 结论一律回帖到 PR（评论也过隐私闸门）。

1. **PR 形态**：base = `feat/hub-optimization`，分支名 `codex/issue-N-<slug>`，正文有 `Fixes #N`；
   diff 尽量小、单一插入点。用 `gh pr view` / `gh pr diff --name-only` /
   `git log --oneline origin/feat/hub-optimization..<branch>` 核对确实存在且对得上 issue。
2. **验证有实际结果**：`pnpm test` 全量 + `pnpm typecheck`；动前端加 `cd packages/web && pnpm build`；
   动运行时加 `pnpm bundle`；**动运行时的改动还须本地 dev 实跑**（`pnpm serve:local` 端口 7861，或
   `drec-dev` 容器端口 7871），实跑步骤与结果写进 PR 正文。**不许只信自述**——review 要复核命令与输出
   （必要时在 PR 分支 worktree 重跑）。
3. **行为变更有回归测试**：新分支 / 新边界 / 修 bug 都有 vitest 用例钉住；无法自动化的写明人工验证步骤。
4. **自审清单可查**：PR 里有「自审发现 → 修复」清单；issue 评论里哪条没采纳及理由写清楚。
5. **CI 状态**:不得有红,没有豁免项。架构文档漂移守护(`gen-architecture.mjs --check`)只比结构
   (包清单 / 依赖边 / 层级 / 流程图 / mermaid),不比生成时间与热度统计,所以任何红都是真红,
   一律打回。结构漂移的修法:`node scripts/gen-architecture.mjs` 重新生成并提交产物。
6. **版本号**(按路径判定,不按提交类型):触及运行时路径的 PR 已 bump 根 `package.json` patch,
   且 `dist/douyin-rec.mjs` 的 `APP_VERSION` 同步。**非运行时豁免**(黑名单语义):只改工具类目录
   (`docs/`、`test/`、`.github/`、`plans/`、`dev/`、`remote/`、`scripts/` 里除两个 install 脚本外的文件 等)
   或 `*.test.ts` 的 PR 不 bump、不 bundle,PR 版本段写「无需 bump + 理由」。必须 bump 的运行时路径清单:
   `packages/`、`package.json`、`Dockerfile`、`docker-compose`、`dist/`、`configs/`、`assets/`、
   `esbuild.config.mjs`、`tsconfig.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`.dockerignore`、
   `scripts/install-mesio.sh`、`scripts/install-biliup.sh`。
   清单说明:configs 目录会内联进产物;assets 目录与两个 install 脚本会进镜像;dockerignore 决定构建上下文。单一真相 =
   `scripts/pr-gate.py` 的 `RUNTIME_PATHS`,本段与 AGENTS.md 的清单必须逐字同步(有回归测试钉住)。
7. **隐私闸门**:PR 正文与评论都过 `python3 scripts/issue-guard.py`;diff 本身由 CI 跑
   `issue-guard.py --diff origin/feat/hub-optimization`(只扫新增行,历史内容不计)。
   源码文件名误报口径见该脚本头部说明:源码类文件不套「文件名 / 凭证类 / 主机名 / streamKey」语义词规则,
   文档里的文件名若是仓库已跟踪文件则放行;确属夹具的行加 `issue-guard: allow` 并在评审中说明。
8. **关联 issue 必须已进入开发状态**:合并前 `gh issue view N --json labels` 核对 PR 的 `Fixes #N` 对应
   issue 带 `in-review`(旧口径票为 `accept` + `in-progress`/`待验证`),且无 `needs-decision` / `decline`。
   没有 `Fixes #N`、issue 仍停在 `accept`/无状态、或被人改回 `needs-decision` → 不合并,打回并在 PR 里写明。
9. **diff 触及危险类 → 强制 `needs-decision`,不自动合并**:合并前跑
   `scripts/pr-risk-scan.sh`(默认对 `origin/feat/hub-optimization...HEAD`),输出 `RISK`(退出码 1)
   即命中上传 / biliup / 清理 / 删除(rm、unlink)/ ledger 状态转换。命中后 review agent
   **不得自动合并**:给 PR 打 `needs-decision`,评论按「决定三行」写清(要决定什么 / 不做会怎样 /
   建议选项),等人拍板。issue 即使是 `accept`,diff 命中 RISK 也一样拦。`PASS` 只表示没命中这些
   规则,不代替第 1–8 条。

**打回后的回路**:review 打回(任一门禁不过)→ PR 保持 open、issue 转 `rework-1`(第 2 次转 `rework-2`),
review 在 PR 评论里列出缺口;**由实现 heartbeat 下一轮扫到「带 `rework-N` 的 PR」时派会话(返工 sub =
`claude/claude-sonnet-5-5`)在原分支(`codex/issue-N-<slug>`)继续修复并 push**,不另开分支、不另开 PR;
修完后实现侧把票转回 `in-review`,review 心跳下一轮重新审。**返工最多 2 轮(`rework-1`、`rework-2`),
第 3 次仍不过 → 转 `needs-decision`**(评论按「决定三行」写)。
版本号冲突导致的 rebase 顺延不计入轮次。review 只打回、不代改。危险类(第 9 条)打回后不进此回路,
等人在 issue/PR 上回「决定」后再动。

合并后：**不删分支**（repo 设 `delete_branch_on_merge=false`）；票转 **`待验证`**（PR 已合并、等部署后线上实跑，
不占并行位）；部署后实跑，再由实现心跳按「四不 close」收口。
**部署仍由人做**（走 `recording===true` guard）。review agent 只合并并转标签，不改代码、不部署、不 close。

## 循环工具（审查第 0 步与状态迁移唯一入口）

issue #78 起，循环里的「状态变更」和「审查前检查」不再靠提示词散文，统一走仓库内可测的脚本：

| 工具 | 用途 | 谁调 |
| --- | --- | --- |
| `scripts/issue-state.py <issue> <to> [--reason-file F]` + `scripts/issue-state.json` | **状态标签迁移的唯一入口**：状态标签唯一化（一次删光旧状态标签再加新标签）、按迁移表校验合法性、评论先过 `issue-guard.py`、评论末行带机器可读标记 | 所有心跳；**禁止直接 `gh issue edit` 改状态标签** |
| `.github/pull_request_template.md` | PR 硬字段：`Fixes #N`、改动范围、验证方式、自审五项、变异验证（撤修复 FAIL + 复原 PASS 两段输出）、验证命令与输出、评论采纳、回写位置、残余风险、版本 | 实现 agent 开 PR 时按模板填 |
| `scripts/pr-gate.py <PR>` | **审查第 0 步**：机械检查模板字段齐全、变异两段、版本声明、正文过隐私闸门；缺项输出清单、退出码非 0 | review 心跳，派 Opus 之前 |
| `scripts/reinforce-metrics.py --loop --days N` | 只读 PR 流程指标：返工率与打回轮数分布、逃逸率（合并 48h 内同根因新 incident，按标题关键词粗匹）、`待验证` 停留时长、台账 `[ledger] 拒绝` 计数（`--ledger-log` / `--ledger-container`，日志不可得则标注跳过）；无 gh / 无网络时降级 | 巡检与周报，纯文本表可直接贴 loop 通知 |

**状态集**：(无) / `accept` / `in-progress` / `in-review` / `rework-1` / `rework-2` / `待验证` / `needs-decision` / `decline` / `blocked`，同一时刻最多一个。新标签 `in-review`、`rework-1`、`rework-2` 用 `issue-state.py --ensure-labels` 补建。

**合法迁移**（唯一真相 = `scripts/issue-state.json`，改表必须同步改本文）：

- `accept → in-progress`（认领）→ `in-review`（PR 已开）→ PASS：`待验证` ｜ FAIL：`rework-1` → `in-review` → 再 FAIL：`rework-2` → `in-review` → 再 FAIL：`needs-decision`。
- `待验证 → closed`（实现侧收口）；`decline → closed`（不做的票收口，需 `--reason-file`）。
- 任意活跃状态 → `needs-decision` / `blocked`；`needs-decision` 由人改回 `accept` / `decline`。
- 非法迁移（如 `accept → 待验证`、跳过 `in-review`）退出码 1，不发任何远端写调用；当前同时挂多个状态标签时退出码 3，须 `--from <真实状态>` 指明后才会清理。
- `needs-decision` 的评论必须带「决定三行」（脚本校验）；`rework-N` / `decline` / `blocked` / `closed` 必须带 `--reason-file`。
- **close 只归实现侧**：`issue-state.py <N> closed --close --reason-file F`，默认 `--role impl`；`--role review` 调 close 会被拒。review 心跳永远不调 close。

**存量票过渡**：已挂 `accept` + `in-progress`（旧口径、PR 已开或在做）的票会同时带两个状态标签，脚本按歧义退出码 3。
用 `--from` 指定其中仍在进行的那一个即可修复（例如 `--from in-progress`），脚本会清掉全部旧状态标签再加新标签。

**`--from` 的约束**：它只用来消除歧义，必须真的是该票当前挂着的状态标签；单标签票不带 `--from`，无标签票才用 `--from -`。
传错会退出码 1 且不改任何标签——否则就能伪造起始状态、绕过迁移表。

迁移方法：对 PR 已开的票 `python3 scripts/issue-state.py <N> in-review --from in-progress --reason-file F`
（一次删光 `accept`、`in-progress` 等旧状态标签再加 `in-review`），此后走新流程；PR 未开的票在开 PR 时同样用
`--from in-progress` 迁到 `in-review`。先 `--ensure-labels` 补建新标签，再用 `--dry-run` 预检。

**`accept` + `待验证` 存量票收口**：早期 PR 合并后票上同时留下 `accept` 与 `待验证`。收口时用 `--from 待验证`
明确真实现状：`python3 scripts/issue-state.py <N> closed --close --from 待验证 --reason-file F`；
不要直接 `gh issue close`——那会留下状态标签与机器标记分叉，下一次心跳又会把它当歧义票卡住。

**心跳将引用这些工具（本 PR 不改 automations 文件，由人在合并后改提示词）**：

1. 实现心跳：认领、开 PR、返工、收口里所有标签变化改为调 `issue-state.py`（认领 `in-progress`、开 PR 后 `in-review`、打回后回到 `in-review`、收口 `closed --close`）；PR 正文按模板填。
2. review 心跳：每个 open PR 先跑 `scripts/pr-gate.py <PR>`；**缺项不派 Opus、直接 `issue-state.py <N> rework-N` 打回并把缺项清单贴到 PR**；通过才进入上文 review 门禁 1–9；结论经 `issue-state.py` 转 `待验证` 或 `rework-N`，不 close。
3. 巡检/周报：附 `reinforce-metrics.py --loop --days 7` 的输出。

## 指标与闭环回写

五环的「可衡量」由 `scripts/reinforce-metrics.py` 承担（默认只读，`--write` 才落
`docs/metrics/<date>.md`）。它从 `sync_jobs` 台账、master stage 与（可选）节点磁盘聚合：

- **假失败率** = `needs_manual` 里的疑似假失败（已拿 BV，或 error 是节点侧 ssh rc≠0/超时）
  / 当日收口场次。
- **卡死残留** = 台账 done 但源视频仍在的场次与字节（只读扫描，不删文件）。
- **开单→收口时长** = 近 30 天已关闭 issue 的 `createdAt → closedAt`。
- **复发数 / 验证覆盖** = 收口时人工回填（见下）。

运行节奏：每个**奇数日**巡检跑一次 `--days 7 --write`，把上周指标追加进
`docs/self-reinforcing-dev.md`「指标记录」，并把当周结果落一份 `docs/metrics/`。
**未做 = 记为缺口，不假装达标。**

修复类 issue 的验收默认带「验证 + 回写」，收口时在评论里补齐两项：

1. **验证**：部署后核对各节点版本号 + 尽量实跑一场（台账终态 + 文件系统证据）；
   没开播 / 时间不够就如实写成待办。
2. **回写**：至少一项——回归测试 / 规则沉淀 / 指标。

做不到这两项就不满足「四不 close」，review 可直接打回。

## 标签

- `incident`：正在影响录制、上传、磁盘或台账真实性。
- `enhancement`：优化，不修当前故障。
- `accept`：可以做。
- `decline`：不做。评论里写原因。
- `in-progress`：已认领，正在做。实现会话认领时打；PR 打开后换成 `in-review`。
- `in-review`：PR 已开，等独立 review 会话审查。审查通过合并后换成 `待验证`，打回则换成 `rework-N`。
- `rework-1` / `rework-2`：review 打回第 1 / 2 轮，等实现会话在原分支返工；修完转回 `in-review`。第 3 次仍不过转 `needs-decision`。
- `blocked`：被外部条件阻塞，评论写明阻塞原因与解除条件；解除后由人或实现心跳迁回原状态。
- `待验证`：PR 已合并，等部署后线上实跑；**不占并行位**。实跑通过并满足「四不 close」后由实现心跳 close（文档/测试类票合并后当轮收口，无需等部署）。
- `needs-decision`：危险类，或证据不够。见下方「决定三行」。

## 决定三行（`needs-decision` 必填）

打这个标签的评论必须写清三行，缺一行就说明决定还没准备好：

1. **要决定什么** —— 一句话，具体到动作（例如「是否把这一场重传」）。
2. **不做会怎样** —— 影响范围（磁盘、台账、下一场会不会被拖住）。
3. **建议选项** —— 给出推荐项和理由，人可以直接回「按建议做」。

人拍板后把标签换成 `accept` 或 `decline`，并把结论复述一句，避免只靠标签传达。

## 开 issue 的最低证据

- 节点角色（master 或哪个 worker）和查询时间。
- 台账状态、有没有 BV、错误类型（例如 ssh rc、超时）。用「当天第几场」指代，不写 streamKey。
- 磁盘余量；相关进程还在不在；源视频还在不在。

## 禁止写入 issue

- 主播名、房间号、streamKey、文件名、BV 号。
- IP、主机名、家目录、节点路径、cookie、webhook、密钥。
- 这些只留在本地台账和对话里，用 issue 编号对照。

开票和发评论前都跑一遍 `scripts/issue-guard.py`（正文和评论都算），命中就先脱敏。
编辑过的 issue 在 GitHub 上仍保留旧版本，所以要在**第一次提交之前**挡住。

## 现在不要做的

- 不常驻四个 agent 互相派活。
- 自动实现**不部署**（部署仍走 `recording===true` guard，永远是人做）；**PR 由 review heartbeat
  派独立会话审查，通过即由 review agent 合并**，人不必手动合并。
  **close issue 不是禁忌**——过了「四不 close」四条门禁就由实现心跳的收口步骤直接关；缺一条才留 open。
- **分支角色**：`main` = 最稳定版本，其余分支（含 `feat/hub-optimization`）= 开发版。agent 的 PR 一律以
  `feat/hub-optimization` 为 base，**agent 不得向 `main` 开 PR、合并或推送**；`main` 只由人在开发分支
  长时间实测稳定后合并。
- **提交身份只能用自己的账号**：`git config` 的 `user.name/user.email` 必须是仓库所有者
  （`fuyucn` + GitHub noreply 邮箱），禁止占位值（如 `t@主机名`）——会泄漏主机名并把作者映射到错误账号。
  commit 也不加 AI 署名 trailer。
- 危险类（上传、删源、删稿、部署、改 hub 规则、清理录像）不得自动 accept。
- master 把 job 标成 `failed`，但节点进程还在时，禁止再开一场上传。
