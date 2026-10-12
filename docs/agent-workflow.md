# Agent 开发流程

GitHub issue 是队列和证据。`TODO.md` 只记录已经 `accept` 的实现项。对话不是台账。

## 角色

| 角色 | 能做 | 不能做 |
| --- | --- | --- |
| 值班 Audit | 读 master 与各 worker 的录制状态、queue、`sync_jobs`、磁盘、日志；有证据才开 `incident` | 改代码、删文件、重启、重传、部署 |
| 优化 Audit | 低频开 `enhancement`，写清代价和验收标准 | 把优化伪装成故障，或直接改代码 |
| Triage | 打 `accept` / `decline` / `needs-decision`，`decline` 写原因 | 写代码；对危险类自行 accept |
| 实现 | 领一个 `accept` issue，开分支和 PR | 合并、部署、顺手做无关改动 |

危险类永远是 `needs-decision`，等人点头：上传、删源、删稿、部署、改 hub 规则、清理录像。

## 流转

1. **开票前过隐私闸门**：`python3 scripts/issue-guard.py <body-file>`（评论同样要过）。
   命中就先脱敏。不合格（没有命令输出、没有节点角色 / 时间）直接 `decline`。
2. **Audit 开 issue**，挂 `incident` 或 `enhancement`。
3. **Triage 打标签**：`accept` / `decline` / `needs-decision`。`accept` 后在 `TODO.md` 加 `T-N`，链到 issue。
4. **人指定实现会话**（不是 triage 自动派）。实现会话认领时打 `in-progress` 并留言「哪个 agent、何时开始」。
5. **实现 agent 只做这一条**，开分支和 PR，PR 正文写 `Fixes #N`。不合并、不部署、不顺手做无关改动。
6. **代码做完先在 issue 留言**：做了什么、评论里哪条没采纳、为什么。不要这时 close。
7. **另一个 agent 只 review**，不改实现；review 结论回帖到 issue 或 PR。
8. **人合并**。PR 用 `Fixes #N`，合并后由 GitHub 关闭。部署仍走「无 `recording===true` 才重启」。

`accept` 只是「可以做」，不等于「有人在做」——看板上区分这两件事靠 `in-progress` 标签。

## 自强化闭环总览

整体五环门禁详见 `docs/self-reinforcing-dev.md`。这里只给每环对应谁、卡什么：

| 环 | 承担者 / 机制 | 门禁 |
| --- | --- | --- |
| 1 观察 | 值班 Audit + 自动巡检 | 有命令输出、节点角色、查询时间才开票；无证据不开 |
| 2 决策 | Triage | 危险类 `needs-decision` 等人；`accept`/`decline` 留痕；不自动派活 |
| 3 开发 | 实现 agent | 一个 issue 一个分支；行为变更必有回归测试；自审清单 |
| 4 发布+验证 | 部署 guard + 实跑验证 | 无 `recording===true` 才部署；验证达标才算完成 |
| 5 回写强化 | 回归测试 + 规则 + 指标 | 不回写经验、无回归测试不 close |

`accept` 不是环的终点：它只表示「可以做」，真正收口要等环 4 的验证 + 环 5 的回写。

## 四不 close

close 一个 issue 前，四个门禁全过才算真正完成：

1. **无证据不开**——开票/评论必须有命令输出和节点角色、时间；没有就补，补不了就不开。
2. **不验证不 close**——声称修复前必须实跑验证（或由人在评论里写明由谁、何时验证）。
3. **无回归测试不 close**——行为变更必须有测试钉住；无法自动化的写清人工验证步骤。
4. **不回写经验不 close**——根因与教训写入设计文档/规则/指标，让下一轮不再重复踩。

违反任一条而 close 的，视为把「自强化环 5」断掉；review 时发现可直接打回。

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
- `in-progress`：已认领，正在做。实现会话认领时打，PR 打开后保留到合并。
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
- 不让 triage 自动开实现 agent。
- master 把 job 标成 `failed`，但节点进程还在时，禁止再开一场上传。
