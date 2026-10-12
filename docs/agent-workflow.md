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
