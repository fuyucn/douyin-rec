# AUDITOR C — 仓库组织与卫生审计

**Repo**: /Users/yuf/Developer/video-screenshot — HEAD `a8399486195b2b36315dd1f78b796cf3d8d5021f`, 只读, 未做任何写操作。
**Scope**: 根文件/构建/CI、scripts/configs/bin/tools/assets、根遗留目录、docs/plans、test 布局。
**验证手段**: `ls` / `rg` / `git ls-files` / `git check-ignore` / `git log` / 临时 git 仓库复现 ignore 语义 / `docker build` + `docker compose` 复现 context 与 bind 行为 / `pnpm typecheck`、`pnpm test`、`pnpm bundle`(仅读)。

基线状态(实际跑过, 均通过): `pnpm typecheck` ✅ · `pnpm test` 78 files / 786 tests ✅ · `pnpm -C packages/web typecheck` ✅ · `pnpm -C packages/web install --frozen-lockfile` ✅ · `docker build`(构建上下文) ✅。

---

## 1. REPO LAYOUT

### 1.1 根目录应留 / 应移 / 应删

| 路径 | 状态 | 判定 |
|---|---|---|
| `.gitignore` `.dockerignore` `.env.example` `Dockerfile` `docker-compose.yml` `package.json` `pnpm-workspace.yaml` `pnpm-lock.yaml` `tsconfig.json` `vitest.config.ts` `esbuild.config.mjs` `README.md` `CLAUDE.md` `design.md` | 已跟踪 | **正确留在根**, 是构建/文档入口 |
| `AGENTS.md` | **未跟踪**(`.gitignore:34 /AGENTS.md`) | ⚠️ 与 CLAUDE.md 同源却不同命运, 见 §5 |
| `dist/` | 未跟踪, 被 `.gitignore:11` 覆盖 | ✅ 未提交(已确认 `git ls-files dist` = 0), 但**内容陈旧**, 见 §1.4 |
| `bin/` (53MB: biliup/mesio/youtubeuploader/cookies.json/qrcode.png) | 未跟踪(`/bin/`) | ✅ 未提交。`bin/cookies.json` 是 B 站凭证, 已被 `/bin/` 兜住 |
| `download.log` `ds_update.log` | 根目录, 0 字节, 6–8 月残留 | ❌ **可删**; 是旧 Python 管线遗留, 当前 TS 管线不写这两个文件(全仓 `rg` 无引用) |
| `douyin-rec.db` (28KB, 6/23) | 根目录残留 | ❌ **可删**; `packages/app/src/paths.ts:86` 现在写 `<root>/db/douyin-rec.db`, 根目录这份是旧默认布局遗留 |
| `.pytest_cache/` | 未跟踪, **未被 `.gitignore` 覆盖** | ⚠️ 见 §1.3 |
| `.DS_Store`(根/`assets/`/`docs/`/`packages/`/`test/`/`docs/superpowers/`/`remote/`) | 未跟踪 | ✅ 被 `.gitignore:7` 覆盖 |
| `.orka/`(空目录) | 未跟踪 | ✅ 已忽略(`/.orka/`), 空目录 → 可直接删 |
| `.hallmark/` `.agents/` `skills-lock.json` `logs/` | 未跟踪(`.gitignore:47-50`) | ✅ 已忽略(gitignore 于 `b39894e` 加入), 但见 §1.5 |
| `.claude/` `.codex/` | 未跟踪 | ✅ 已忽略。⚠️ 二者内容重复, `.codex/hooks.json` 与 `.claude/hooks/` 是同一个 `block_xml_ass_delete.py` 的两份 |
| `remote/` | 未跟踪(`.gitignore:43`) | ⚠️ 见 §1.2 |
| `data-local/` `docker-data/` | 未跟踪 | ✅ 已忽略 |
| `output-data/` | 不存在(默认数据根, 当前未生成) | ❌ 见 §1.3 — **规则本身是坏的** |
| `patches/` | **不存在** | ⚠️ `CLAUDE.md:45` 仍把它列在仓库树里 |
| `tools/` | **不存在** | ⚠️ `AGENTS.md:92` 仍把它列在仓库树里 |

> 注: 无 `tools/`、无 `patches/`, 但两份 agent 文档都把它们写进目录树 —— **文档描述的目录结构比实际多两个不存在的目录**。

### 1.2 `remote/` — 历史遗留 (P1: 应删或明确归档)

`remote/` 内容 (130KB, 未跟踪): `merge.py` `merge-all` `merge-{plain,danmu,livechat}` `deploy.sh` `setup_vps.sh` `pull_recordings.sh` `README.md` `vps.key` `vps_ip.txt` `download.log` `ds_update.log` `recordings/` `.claude/` `.DS_Store`。

- `remote/vps.key` 是 VPS SSH 私钥(权限 `-rw-------`), `remote/vps_ip.txt` 是 IP —— 二者**已被 `.gitignore:43 remote/` 兜住, 未入库**(已确认 `git ls-files remote` = 0)。**这一点没问题**。
- 但 `remote/` 目前仍是 **docker master 的硬依赖**: `docker-compose.yml:72` 挂载 `./remote/vps.key:/root/.ssh/vps.key:ro`。**实测**: 若宿主机没有该文件, `docker compose up` **不会报错**, Docker 会在宿主机上**创建同名目录** (`remote/vps.key/`)并把它挂进容器 → 容器内 SSH 认证必然失败, 且宿主机多出一个垃圾目录。对一份被 gitignore 的目录做 build/run 硬依赖 = 新机器 clone 后 `docker compose up` 必踩。
- **动作**: 二选一 —— (a) 删除 `remote/`(merge.py 等), 把 vps.key 挪到 `~/.ssh/` 或 `.secrets/`, 并把 `docker-compose.yml:72` 的宿主机路径改为可配置(如 `${VPS_KEY_PATH:?}` 或 `~/.ssh/drec-vps.key`); (b) 若确要保留 Python 参考实现, 移到 `docs/legacy/` 并把 vps.key 移出(私钥不该待在仓库工作树里, 哪怕被 ignore)。
- 文档口径也自相矛盾: `AGENTS.md:90` 说 "remote/ ⚠️历史留存", 而 `CLAUDE.md:45` 说 "remote/ 已移出仓库(已 gitignore)" —— 同一目录两种说法。

### 1.3 `.gitignore` 逐条核对 (P1: 有真 bug)

已核对我方点名的敏感文件 —— **全部正确忽略**:

```
cookies.json   .gitignore:26 cookies.json   ✅
config.yaml    .gitignore:25 config.yaml    ✅
douyin-rec.db  .gitignore:20 *.db           ✅
.env           .gitignore:27 .env           ✅
```
(`bin/cookies.json` 由 `/bin/` 兜住 ✅;`docker-data/` `data-local/` 由目录规则兜住 ✅)

**BUG 1 (P1) — `.gitignore:19` 是一条坏规则, 默认数据根实际没被忽略。**

```
19: output-data/     # 未设 DOUYIN_REC_ROOT 时的默认数据根(见 packages/app/src/paths.ts DEFAULT_ROOT)
```
gitignore 的 `#` **只在行首**才开启注释, 行内 `#` 是**字面字符**。因此该模式实际是
`output-data/     # 未设 ...`(带空格与井号), 匹配不到任何真实路径。
**独立 git 仓库复现**: `git check-ignore -v output-data/` → exit 1(未忽略); 造 `output-data/config/hub/douyin.7.json` → `?? output-data/`(可被 `git add`)。
结果: 未设 `DOUYIN_REC_ROOT` 裸跑生成的 `output-data/config/hub/*.json`(`hub.config.json` + 每房间 `{platform}.{roomSlug}.json`)、`output-data/config/*.yaml` 等**会出现在 `git status` 里**, 只靠同目录的 `*.db`/`*.log`/`cookies.json` 等窄规则侥幸兜底 —— `hub.config.json` 与房间规则文件**完全不在任何忽略规则内**。
**动作**: 把注释移到上一行, 规则改成纯 `output-data/`(并补 `stage/`):
```gitignore
# 未设 DOUYIN_REC_ROOT 时的默认数据根(见 packages/app/src/paths.ts DEFAULT_ROOT)
output-data/
stage/
```

**BUG 2 (P2) — `.pytest_cache/` 无仓库级规则。**
`git check-ignore -v .pytest_cache` → exit 1, 未被忽略;它仅靠 `.pytest_cache/.gitignore` 里 pytest 自己写的 `*` 自忽略(该目录内有 `.gitignore` + `CACHEDIR.TAG` + `README.md`, pytest 自身刚生成时 `.gitignore` 尚不存在 → 会短时间暴露)。仓库已完全无 Python 测试(pytest 是旧 Python 版残留), 目录本身也是死的。
**动作**: 删 `.pytest_cache/`, 并在 `.gitignore` 加 `.pytest_cache/`。

**其余缺口 (P2)**: `.gitignore` 未覆盖 `coverage/`、`*.tsbuildinfo`(web 有, 根无)、`/.claude/` 之外无 `stage/`。

### 1.4 `dist/` — 陈旧构建产物 (P2)

`dist/` 未被提交(git 只跟踪 0 个 dist 文件), 但工作树里混着**两代布局**:
- 当前产物: `douyin-rec.mjs`(10/6)、`tui.mjs`(10/6)、`douyin-rec`(launcher)、`releases/`(10/5)
- **6 月旧布局残留**: `dist/cli.js`(6/11)、`dist/core/{config,post,session,types}.js`、`dist/danmu/{bililive-source,xml-writer}.js`、`dist/recorder/{bililive,dlr}.js` —— 这些是 `pnpm build`(见 §4.1)按旧 `src/` 布局产出的, 对应的包(`danmu/`、`recorder/`)早已不存在于 `packages/`。
**动作**: 清理陈旧的 `dist/cli.js` `dist/core/` `dist/danmu/` `dist/recorder/`(构建产物不入库/不长期留存, 需要时 `pnpm bundle` 重生成)。属 taste 级清理。

### 1.5 `logs/` 含敏感运行数据 (P2)

`logs/cleanup/` 三个文件(288KB, 未跟踪但**未在 `.dockerignore` 里**, 见 §4.2):
- `vps-residuals-20261006-143156.txt` 首行含 `节点: ubuntu@100.97.21.80  dataRoot=/home/ubuntu/drec`(VPS IP + 用户名)
- `FULL-BACKUP-*.patch` 3264 行, 是整仓 `CLAUDE.md`/源码的完整备份快照
**动作**: `logs/` 已 gitignore ✅, 但建议按一次性产物清理掉(内容已被 git 历史覆盖), 并加入 `.dockerignore`。

---

## 2. 文件/包分类 (workspace 层)

### 2.1 数量与工作区定义

实际 `packages/` 下有 **14 个目录**: 13 个 `@drec/*` + `web`。
- `pnpm-workspace.yaml`: `packages/*` + `!packages/web` → **13 个 workspace 包, 排除 web**。✅ 正确。
- `packages/web/pnpm-workspace.yaml` (`packages: []`) + 独立 `pnpm-lock.yaml`(已跟踪) + 独立 `.gitignore` ✅ 自洽;`pnpm -C packages/web install --frozen-lockfile` 实测通过。
- 根 `pnpm-lock.yaml` 内**不含** `douyin-rec-web` ✅(`excludeLinksFromLockfile:false`, web 未串入)。

**因此 "13 包" 的说法本身没错(=13 个 workspace 包), 但三处目录树漏写了 `kuaishou-live`(P1):**
- `README.md:22-35` 树列出 13 项(=12 个 `@drec` + web), **缺 `kuaishou-live/`**(`grep -c kuaishou README.md` = 0)
- `CLAUDE.md:19-41` 树列出 13 项, **同样缺 `kuaishou-live/`**(`grep -c kuaishou CLAUDE.md` = 0)
- `docs/architecture.md:3` "13 个包", 全篇 **0 次**提到 kuaishou;`docs/architecture.html` 同样 0 次
- 对照组: `AGENTS.md:77` 树**有** `kuaishou-live/`(14 项), `test/arch/layering.test.ts:37` 也登记了 `@drec/kuaishou-live`:1.5 ✅

→ 快手平台包已完整实装(`packages/kuaishou-live/`, `packages/cli/src/providers-register.ts:24` 注册), 但**主要文档与架构图都当它不存在**。**动作**: 在 README/CLAUDE 树 + `docs/architecture.md`/`.html` 补上 `kuaishou-live`(或明确写 "13 个 workspace 包(web 独立)")。

### 2.2 `package.json` 不一致 (P1/P2)

**(a) P1 — `@drec/post-process` 依赖声明缺失, 靠幽灵提升侥幸工作。**
`packages/post-process/package.json:4` = `"dependencies": {}`, 但源码里:
- `packages/post-process/src/ass/livechat.ts:5` → `require("eastasianwidth")`
- `packages/post-process/src/ass/render.ts:2` → `import { XMLParser } from "fast-xml-parser"`

二者**只声明在根 `package.json:32,33`**。实测能解析, 只因 pnpm 把它提升到了仓库根 `node_modules/`(从任意子目录向上查找命中)。**`packages/post-process/node_modules/` 根本不存在**。一旦哪个依赖把 `eastasianwidth` 变成非提升布局(或改用 `node-linker=isolated`+`shamefully-hoist=false` 的严格解析), 或有人只 `pnpm -C packages/post-process install`, 就会断。**动作**: 在 `packages/post-process/package.json` 的 `dependencies` 里补 `eastasianwidth` 与 `fast-xml-parser`(根可保留以便 bundle)。

**(b) P1 — 声明了但源码不用(死依赖):**
- `packages/app/package.json:6` 声明 `ws@^8.0.0` 与 `yaml@^2.5.0` —— 全 `packages/app/src` 无 `from "ws"` / `from "yaml"`(全仓唯一 `ws` 使用者是 `packages/douyin-live/src/danmaku/client.ts:16`;`yaml` 唯一使用者是 `packages/core/src/config.ts:2`)。同行的 `playwright`(qr-login.ts:172 动态 import ✅)与 `qrcode`(bili-qr-login.ts:1 ✅)是真依赖。
- `packages/cli/package.json:15` 声明 `yaml@^2.5.0` —— `packages/cli/src` 无任何 `yaml` 引用。
**动作**: 从 app/cli 的 `dependencies` 删掉未使用的 `ws`/`yaml`, 保持最小面。

**(c) P2 — 元数据不统一:**
- `packages/orchestrator/package.json:3` `"version": "0.0.1"`, 其余 12 个 `@drec/*` 全是 `0.0.0`(orchestrator 的 0.0.1 是写 plan 时留下的)。**动作**: 统一为 `0.0.0`(私有包, 版本唯一真相是根 `package.json:3`)。
- `packages/observability/package.json:6` 与 `packages/orchestrator/package.json:6` **只有 `exports`, 缺 `main`/`types`**; 其余 11 个包三者齐备。`packages/cli/package.json:6` `main` 指 `./src/cli.ts`(其余包指 `src/index.ts`, cli 也没有 `index.ts`)。
- `packages/web/package.json` 是唯一非 `@drec` 命名的包(`douyin-rec-web`), 且版本 `0.1.0`、另带 `packageManager`/`engines`/`scripts` —— 因为它被排除出 workspace, 属**独立工程**, 合理;但值得在 README 里显式说明"14 个目录 = 13 workspace + 1 独立前端"。

**(d) P2 — `tsconfig.json:22-23` 指向不存在的类型路径。**
```
"@bililive-tools/manager":        ["./node_modules/@bililive-tools/manager/lib/index.d.ts"]
"@bililive-tools/douyin-recorder":["./node_modules/@bililive-tools/douyin-recorder/lib/index.d.ts"]
```
`node_modules/@bililive-tools/` 不存在, `pnpm-lock.yaml` 里 `bililive` 0 次 —— 这两个 **path 映射是死的**(路径存在性在 TS 中不校验别名, 所以不报错)。源码也不再 import 它们(vendored 到 `packages/douyin-live/src/stream/`)。**动作**: 删除这两条别名。

### 2.3 `tsconfig` / `vitest` 别名表漂移 (P1)

三处 `@drec/*` 解析表各写一份, 且**互不相同**:

| 包 | tsconfig.json paths(14-24) | vitest alias(50-56) | pnpm workspace link |
|---|---|---|---|
| core, manager, post-process, douyin-live, record-engine, ffmpeg-recorder-extra | ✅ | ✅ | ✅ |
| tui | ✅ | ❌ 缺 | — |
| orchestrator | ❌ 缺 | ✅(唯一只在 vitest 里) | ✅ |
| observability, app, bilibili-live, kuaishou-live, cli | ❌ 缺 | ❌ 缺 | ✅ |

现状靠 pnpm 的 `node_modules/@drec/*` 软链兜住了 typecheck/vitest(实测 `pnpm typecheck`、`pnpm test` 均 ✅), 但这是**隐式耦合**: 别名表的作用域 / 解析优先级(pnpm 软链 vs paths vs alias)在不同工具下不同, 且每加一个包要改 2–3 处。**动作**: 二选一 —— (a) 删掉 tsconfig `paths`(纯靠 pnpm workspace 软链, 各包 `package.json` 的 `exports` 已指向 `src/index.ts`); 或 (b) 补齐所有 13 个包到两张表并加注释"新增包必须在此登记", 与 `layering.test.ts RANKS` 一致。

---

## 3. DOCS / TESTS 组织

### 3.1 docs/ 与 plans/ 重叠、陈旧、重复 (P1)

**`docs/multi-node-sync*.md` 三份并存且互相打算覆盖:**
| 文件 | 行数 | 定位 | 引用数 |
|---|---|---|---|
| `docs/multi-node-sync.md` (288 行) | 原始设计稿, 头部自述"细节以 followups + 代码为准" | 5 |
| `docs/multi-node-sync-followups.md` (100 行) | "剩余 followup"清单, 但内容已标 ✅ 已修 | 10 |
| `docs/multi-node-sync-plan.md` (1199 行) | **实现计划**, 71 个未勾选 `[ ]`, 全仓 **0 引用** | 0 |

- `docs/multi-node-sync.md:1` 标题写「master/worker」, 但正文 §"心智模型"仍用旧词 `master-slave 复制`(第 15 行), 与 `packages/cli/src/cli.ts:1219`、`packages/app/src/web/api.ts:111` 的"slave"注释同源 —— 术语迁移只做了一半。
- `docs/multi-node-sync-plan.md` **1199 行、零引用、含 71 个未完成任务框**, 与 `plans/015_multi_node_followups.md`(722 行, 35 个未勾选框)职责重叠(015 的目标行就是"清掉 docs/multi-node-sync-followups.md 的全部待办")。**动作**: 把 `-plan.md` 归档到 `docs/archive/`(或删除, 因为其任务已被 plans/016–024 取代), 保留 `multi-node-sync.md` + `followups.md` 两份, 并把重复段落合并。
- **plans/ 无索引, 且 022/023/024 没有任何 `[ ]`/`[x]` 复选框**(已实测): 无法判断哪些已落地。001–014 已被删除(仅存在于 git 历史), 现存 015–024, 且 `AGENTS.md:95` 还引用**不存在的** `plans/030_platform_abstraction.md`。
**动作**: 加 `plans/README.md`(一行一计划: 编号/标题/状态 已实现|进行中|废弃/对应 commit), 给 022–024 补"已实现"状态行, 修正 AGENTS.md:95 的失效引用。

**`docs/superpowers/`(6 文件, 已跟踪)与 `plans/` 也是同一批设计的两次落盘:**
`plans/017_workers_management.md`(59,938B) ↔ `docs/superpowers/specs/2026-07-05-workers-management-design.md`(7,784B)、`plans/018`(47KB) ↔ `specs/2026-07-06-hub-rule-worker-selection-design.md`(5KB)、`plans/019` ↔ `specs/2026-07-06-worker-live-status-design.md`、`plans/020` ↔ `specs/2026-07-06-hub-page-redesign-design.md`(已实测 diff: 前者是 task 级实现计划, 后者是设计稿, 内容确为同特性两阶段)。**动作**: 明确分工(design 稿归 `docs/`、实现计划归 `plans/`), 或把二者各合并成一份。属 P2 整理, 但应写进一句"docs/=设计, plans/=实现计划, superpowers/=历史 brainstorming"的目录约定。

**`docs/architecture.md` ↔ `docs/architecture.html`(P2, 已承认的重复):**
`docs/architecture.md:13` 自述"同时维护一份等价的可交互图"。两者内容等价(包名提及集合一致), 一次架构改动要改两处 —— 实测两者都漏了 kuaishou(见 §2.1)。**动作**: 保留 `.md` 为唯一真相(README 也优先链它), `.html` 降级为"某次快照"或干脆删除;若确要保留 HTML, 在 `.html` 顶部注明"由 .md 生成/以 .md 为准"。

**`design.md`(根, 已跟踪, 8KB)** 是 web 设计 token 文档, 被 `packages/web/src/index.css:4` 引用。内容属 `docs/` 范畴。**动作**: 移到 `docs/web-design.md`(可选, taste)。

### 3.2 test 布局: 规则清楚, 但**执行不一致** (P1)

规则写在 `CLAUDE.md:42-44` / `AGENTS.md:87-88`: **纯包单测就近 `packages/**/*.test.ts`;集成/元测试放 `test/`**。实测分布:

| 包 | 就近 | `test/` 下 | 判定 |
|---|---|---|---|
| post-process | 13 | 0 | ✅ 一致 |
| orchestrator | 16 | 1(hub-wiring) | ✅ |
| record-engine | 3 | 1(save-path) | ✅ |
| core | 4 | 0 | ✅ |
| bilibili-live / kuaishou-live / douyin-live / manager | 4/1/1/1 | 0 / 0 / 1(extraction-parse) / 1(session) | ✅ 大体一致 |
| **observability** | 1(`logger/file.test.ts`) | **2**(`test/notify/{notifier,notif-toggles}.test.ts`) | ⚠️ 纯包单测放错层 |
| **app** | 4 | **19** | ⚠️ 规则允许(app 是集成层), 但 19:4 的悬殊说明"就近"几乎没在 app 落地 |
| **web** | 0 | **1**(`test/hub-flow-build.test.ts` 用相对路径 import `../packages/web/src/components/flow-build`) | ⚠️ web 是独立 workspace 且被 `vitest.config.ts:46` exclude, 却从 test/ 反向 import 其源码 |

具体不一致点: `test/notify/notifier.test.ts:3-4` 直接 import `packages/observability/src/notifier/*`, 而同一包已有 `packages/observability/src/logger/file.test.ts` 就近版 —— **同一个包两种放法**。`test/upload/biliup*.test.ts`(app)、`test/app/*`(20 个) 同理。
**动作**: (a) 补一句可判定规则, 例如"只能放 `test/` 的: (1) 跨包集成, (2) 需要 `test/setup.ts` 假平台的, (3) 元测试(arch);其余一律就近"; (b) 按此把 observability 的两个通知测试挪进 `packages/observability/src/notifier/`, 或反过来统一; (c) 若 `test/hub-flow-build.test.ts` 非要留在 test/, 在文件头注明"跨 workspace 的例外"。

### 3.3 docs/ 内容的陈旧引用(P2)

- `packages/app/src/web/static-html.ts:4,11,12,49,50` 仍写 `ts/web/`、`ts/dist/` —— **`ts/` 目录早已不存在**(项目从 `ts/` 迁到 `packages/`)。这是**用户可见文案**(SPA 未构建时的 fallback 页), 会误导。同类残留还在 `packages/post-process/src/*.test.ts` 的"// ts/test/post/..."首行注释(8 处)、`test/notify/notifier.test.ts:1`、`test/upload/biliup.test.ts:1`、`packages/web/pnpm-workspace.yaml` 注释("parent node CLI workspace at ts/")。**动作**: 批量把注释里的 `ts/web`→`packages/web`、`ts/test`→`test`、`ts/dist`→`dist`;`static-html.ts` 的 fallback 文案要改(用户可见)。
- `CLAUDE.md:45` 列 `patches/`(不存在)、`AGENTS.md:92` 列 `tools/`(不存在)、`AGENTS.md:95` 引 `plans/030_platform_abstraction.md`(不存在)、`AGENTS.md:218` 写 `.Codex/hooks/...`(实际是 `.codex/hooks/...`, 大小写不符)。

---

## 4. BUILD & CI

### 4.1 esbuild 双产物 (✅ 设计正确, P2 有死配置)

`esbuild.config.mjs` 双 bundle 设计已核验并跑通: 主 bundle `dist/douyin-rec.mjs`(cli.ts, `external: bufferutil/utf-8-validate/playwright/playwright-core`) + 独立 `dist/tui.mjs`(tui 入口, ink/react/yoga external), 外加 `dist/douyin-rec` 启动器。分层理由(避免 `task serve` 在 docker 里 eager import React/Ink)在注释里写清 ✅。版本号单一来源(根 `package.json.version` + `GIT_SHA`)✅。

**问题 (P2) — 根 `package.json:15` 的 `"build": "tsc -p tsconfig.json"` 是死的且会产出垃圾。**
`tsconfig.json` `rootDir:"."` + `outDir:"dist"` + `include:["packages/**/*"]` —— **实测**: 对 `packages/core/src/index.ts` 会产出 `dist/packages/core/src/index.js`(而不是 `@drec/*` 的可用产物), 正是 §1.4 里 `dist/core/`、`dist/danmu/`、`dist/recorder/` 那堆陈旧文件的来源(旧布局时路径更浅)。CI 从不调用它(ci.yml 只跑 `pnpm typecheck`/`test`/`bundle`)。唯一提及它的 `README.md:57` 说"（可选）tsc 逐文件转译到 dist/,供调试" —— 但产出路径与 bundle 命名(`dist/douyin-rec.mjs`)冲突, 调不出可用东西。**动作**: 删掉 `build` 脚本(或改成 `pnpm bundle` 别名), 并从 README:57 移除该说明。

**Dockerfile(P2/P1) — 有 build 期硬依赖不存在文件的隐患:**
- ✅ 分层做得好: 先 `COPY package.json pnpm-lock.yaml pnpm-workspace.yaml` + `COPY --parents packages/*/package.json`(第 20 行)再 install, 源码后拷, 缓存友好。
- ⚠️ `Dockerfile:31 COPY assets ./assets` 与 `Dockerfile:34 COPY configs ./configs` 是**构建期必需**(esbuild 内联 `configs/hub.config.example.json`、`fonts.ts` 搜 `assets/fonts`)。已核对 `.dockerignore` 未排除它们 ✅。
- ⚠️ `Dockerfile:107-109` 只把 `dist/` `packages/web/dist` `assets/` 拷进 runtime ✅ 正确;但 `packages/web/dist` 是 `.dockerignore:6 web/dist` 排除的 —— **实测**该模式不误伤 `packages/web/dist`(dockerignore 的 `web/dist` 只匹配 `<ctx>/web/dist`, 而真实路径是 `packages/web/dist`, 实测 COPY 上下文里 `packages/web/dist` **在**)。这条"侥幸正确"值得加注释, 否则后人改 `web/dist`→`**/web/dist` 会瞬间打断构建。
- ⚠️ **`.dockerignore` 遗漏本地数据根 `output-data/`(P1)**: 已在 `.gitignore` 里(若修好 §1.3), 但 `.dockerignore` 完全没有 —— 若本地跑过裸跑, 整个默认数据根(录像/DB)会进 build 上下文。同理缺 `stage`、`logs`、`.pytest_cache`、`coverage`。**实测**: 构建上下文当前 7.8MB(含 `.agents/` 1.2MB、`logs/` 288KB、`packages/web/dist` 1.5MB、`.claude/`、`.hallmark/`、`skills-lock.json`、`CLAUDE.md`、`README.md`、`design.md`、`.gitignore`、`.pytest_cache/`)—— 都不该进镜像上下文。
**动作**: `.dockerignore` 补 `output-data`、`stage`、`logs`、`coverage`、`.pytest_cache`、`.claude`、`.agents`、`.hallmark`、`.orka`、`skills-lock.json`、`CLAUDE.md`、`README.md`、`design.md`、`.gitignore`、`**/*.tsbuildinfo`。

### 4.2 GitHub workflows (✅ 大体健康, P2)

- `ci.yml` + `release-worker.yml` 分工清晰, 注释解释到位;`permissions` 最小化 ✅;`concurrency` 取消同分支旧跑 ✅;pnpm 版本不写死(靠 `packageManager`)✅ —— 这一组是本次审计里做得最好的部分。
- **P2 — 无缓存**: 两个 workflow 都没有 `actions/setup-node` 的 `cache: pnpm`(也没有 cache 步骤)。根 `pnpm install` + `packages/web` 第二次 `pnpm install` + esbuild/vite 构建每次全量重来。**动作**: 给 `setup-node@v4` 加 `cache: pnpm`(根)与给 web 那步加独立缓存 key。
- **P2 — 文案漂移**: `ci.yml:34` 与 `release-worker.yml:39` 步骤名写 "(root, 13 packages)" —— web 不在 typecheck 覆盖内(tsconfig `exclude: packages/web`), 措辞易误读, 建议改 "(root workspace, 13 packages; web 单独跑)"。
- **P2 — release 未构建前端/未跑 web 门禁外的路径**: release 已含 `packages/web` build ✅;但 `scripts/build-worker-release.sh:38-40` 硬依赖 `dist/douyin-rec.mjs`/`dist/tui.mjs`/`packages/web/dist/index.html` 存在(有清晰报错 ✅)。
- 未见"依赖未提交文件"的隐患: 已逐一确认构建所需的 `configs/hub.config.example.json`、`assets/fonts/NotoEmoji-Static.ttf` **均已跟踪**(`git ls-files` 已确认)。

### 4.3 `bin/`(53MB)与 `scripts/`(P2)

- `bin/` 含 `biliup`(25MB)、`youtubeuploader`(21MB, 全仓 **0 引用** —— 死二进制)、`mesio`(6.6MB)、`cookies.json`、`qrcode.png`、`download.log`、`ds_update.log`。已 gitignore ✅。**动作**: 删 `youtubeuploader`(无引用)与 `bin/download.log`/`ds_update.log`。
- `scripts/deploy-precheck.{sh,py}` 在本仓库**只有自身引用**, 未挂在任何 CI/hook/文档里(`rg 'deploy-precheck'` 仅命中脚本自身) —— 而 `AGENTS.md:203-215` 把"部署前 guard"写成硬规则。**动作**: 在 `AGENTS.md`/`CLAUDE.md` 的 guard 段落里点名 `scripts/deploy-precheck.sh`, 否则该脚本无人知道存在。
- `scripts/.claude/settings.local.json` —— AI 工具配置混进了 `scripts/`。**动作**: 删除(`.claude/` 已被 gitignore, 这份是误放)。

---

## 5. HOUSEKEEPING — AGENTS.md vs CLAUDE.md (P1, 有真实冲突)

**事实核对**:
- `AGENTS.md` 18,029B / `CLAUDE.md` 22,473B, 差异 323 行(diff 行数), 归一化空白后仍有 265 行不同 → **不是近乎相同, 是两份已分叉的文档**。
- **关键: `AGENTS.md` 未跟踪**(`.gitignore:34 /AGENTS.md`), `CLAUDE.md` 已跟踪。新 clone / CI / 任何其他 agent 拿到的是 `CLAUDE.md`, **拿不到 `AGENTS.md`**。
- 章节差异: `AGENTS.md` 独有 `## 快速部署`(Docker master/worker/裸跑/hub 配置, 42 行);`CLAUDE.md` 独有 web UI/多节点/observability 的更详细写法。
- **直接矛盾(必须修)**:
  - `AGENTS.md:231`: "commit 正文末尾附: `Co-Authored-By: Codex Opus 4.8 (1M context) <noreply@anthropic.com>`"
  - `CLAUDE.md:170`: "**不要加** `Co-Authored-By: Claude …` 等 AI 署名 trailer"
  - 而 git 历史里 **200 次** `Co-Authored-By:`(最近 12 个 commit **全部**带 `Co-Authored-By: Codex Opus 4.8`)。→ **CLAUDE.md(已跟踪的那份)的规则与实际历史相反**。
- **内容漂移**:
  - cookie 模型: `CLAUDE.md:91` 只写 `settings.defaultCookies`(全局单一), 而代码 `packages/app/src/store.ts:402-428` + `stream-cookies.ts:10` 是**按平台** `platformCookies`(抖音回落 `defaultCookies`)。`AGENTS.md:141-145` 写对了。→ **CLAUDE.md 的 cookie 章节已过时**。
  - 数据根: `CLAUDE.md:124` 示例 `task serve --port 7860 --db douyin-rec.db`(相对 cwd)与"默认 `./output-data`"的新约定不符。
  - 目录树: 两份都漏 `kuaishou-live`(§2.1);两份都列了不存在的 `patches/`(CLAUDE) / `tools/`(AGENTS)。
  - `AGENTS.md` 含 VPS IP `100.97.21.80`(与 `CLAUDE.md` 同), 而这两份文件都不该在公开仓库里带 IP/SSH 细节(CLAUDE.md 被跟踪 → IP 已入库)。

**动作(强烈建议, 单一真相源)**:
1. 选 `AGENTS.md` 作为唯一真相(它更新更准: cookie 模型、kuaishou、部署段落都在), **把它从 `.gitignore:34` 移出并 `git add`**;
2. `CLAUDE.md` 改成 3–5 行的指针文件:"项目上下文见 `AGENTS.md`"(Claude Code 会自动读 CLAUDE.md, 内容留一句指路即可), 或直接软链 `CLAUDE.md -> AGENTS.md`;
3. 合并前先解决 `Co-Authored-By` 矛盾(以实际 git 历史为准: 保留 Codex 署名);
4. 把 VPS IP 从两份文档里挪成占位符(`<vps-tailnet-ip>`), 因为 `CLAUDE.md` 已入库。

---

## 优先级汇总

**P0 — 必须修(安全/构建立即会坏)**
| # | 路径 | 动作 |
|---|---|---|
| (无) | — | 本次未发现 P0。SSH 私钥与 cookies.json 均已被 gitignore 且未入库(已逐个验证)。 |

**P1 — 值得修(真实问题)**
1. `.gitignore:19` 行内注释使 `output-data/` 规则失效 → 默认数据根(含 hub 规则文件)可被 `git add`。改为上一行注释 + 纯 `output-data/`, 并补 `stage/`。
2. `AGENTS.md:231` ↔ `CLAUDE.md:170` `Co-Authored-By` 规则互相矛盾, 且已跟踪的 CLAUDE.md 与 git 历史(200 次署名)相反 → 定一份真相源。
3. `AGENTS.md`(未跟踪) vs `CLAUDE.md`(已跟踪)双份分叉文档 → 合并为一份 + 指针。
4. `packages/post-process/package.json:4` 缺 `eastasianwidth`/`fast-xml-parser` 依赖声明, 靠根级幽灵提升 → 补声明。
5. `packages/app/package.json:6`(ws/yaml)、`packages/cli/package.json:15`(yaml) 为死依赖 → 删。
6. `docker-compose.yml:72` 硬依赖被 gitignore 的 `remote/vps.key`, 缺失时 Docker 静默建同名目录(已实测) → 路径可配置/挪出 remote。
7. `.dockerignore` 缺 `output-data`/`stage`/`logs`/`.claude`/`.agents`/`.hallmark`/`CLAUDE.md`/`README.md` 等 → 补全, 否则本地数据与 AI 产物进构建上下文。
8. README/CLAUDE/`docs/architecture.{md,html}` 目录树与架构图**漏 `kuaishou-live`** → 补齐。
9. `docs/multi-node-sync-plan.md`(1199 行 / 0 引用 / 71 未完成框)与 `plans/015`(722 行)重叠, `plans/` 无状态索引 → 归档 + 建 `plans/README.md`;修 `AGENTS.md:95` 的失效 `plans/030` 引用。
10. `tsconfig.json:22-23` 的 `@bililive-tools/*` 别名指向不存在目录 → 删。
11. `tsconfig` paths / `vitest.config.ts:50-56` alias 两张表与 13 包不一致(各缺不同的一批) → 统一。
12. test 布局规则虽已文档化但执行不一致(observability 同包两放法;app 19:4;web 反向 import) → 明确可判定规则。

**P2 — 顺手做(taste / 整洁)**
13. 根遗留可删: `douyin-rec.db`、`download.log`、`ds_update.log`、`.pytest_cache/`、`.orka/`、`bin/youtubeuploader`、`bin/*.log`、`scripts/.claude/`。
14. `dist/` 内 6 月旧布局残留(`cli.js`/`core/`/`danmu/`/`recorder/`)→ 清理。
15. `package.json:15` 死 `build` 脚本(产出 `dist/packages/**`) → 删或改别名。
16. CI 两个 workflow 缺 `cache: pnpm` → 加;`ci.yml:34` "(root, 13 packages)" 措辞。
17. `packages/orchestrator/package.json:3` 版本 `0.0.1` → 统一 `0.0.0`;observability/orchestrator 补 `main`/`types`。
18. 陈旧 `ts/` 引用: `packages/app/src/web/static-html.ts:4,11,12,49,50`(用户可见文案)、8 个 post-process 测试首行注释、`packages/web/pnpm-workspace.yaml` 注释 → 批量替换。
19. `AGENTS.md:92` `tools/`、`CLAUDE.md:45` `patches/`、`AGENTS.md:218` `.Codex/` 大小写、`CLAUDE.md:124` `--db douyin-rec.db` 示例 → 修正。
20. `docs/architecture.md` ↔ `.html` 双份等价内容 → 声明单一真相;`design.md` 建议移入 `docs/`。
21. `scripts/deploy-precheck.{sh,py}` 无人引用 → 在两份 agent 文档的部署 guard 段落点名。
22. 术语半迁移: `docs/multi-node-sync.md:15`、若干源码注释仍用 "slave" → 统一 "worker"。

**明确不是问题(勿改)**
- `dist/` 未提交 ✅(`git ls-files dist` = 0);`bin/`、`remote/`、`.env`、`cookies.json`、`config.yaml`、`douyin-rec.db` 均正确未入库 ✅(逐个 `git check-ignore` 验证)。
- `pnpm-workspace.yaml` 排除 web + web 自带 lockfile/workspace 的设计 ✅ 自洽且 `--frozen-lockfile` 通过。
- esbuild 双产物分层、Dockerfile 多阶段 + `--parents` 分层缓存、CI 权限/并发设计 ✅ 良好。
- "13 包" 计数本身准确(13 个 workspace 包;web 独立) —— 只有**目录树漏列 kuaishou-live**才是 bug。
