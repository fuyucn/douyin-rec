# Docker 部署

把录制服务（Web 控制台 + 定时调度）跑成**单个容器**：`task serve`（调度默认开）。
数据全部落在挂载卷上，容器重建不丢。适合「本地开发不跑实例，需要时手动 `docker compose up --build` 部署最新版」。

> 相关：CLI 命令见 [cli.md](./cli.md)，app 层（调度/排空/cookie）见 [app.md](./app.md)。

---

## 快速开始

```bash
cp .env.example .env       # 改时区 / 宿主机路径 / 端口 / Discord
docker compose up -d --build
docker compose logs -f     # 看日志（Ctrl-C 退出日志，容器继续跑）
```

打开 `http://localhost:<PORT>`（默认 `http://localhost:7860`）。

**部署最新版**：拉代码后再跑一次 `docker compose up -d --build` —— 重新构建镜像、滚动替换容器，数据卷不动。

```bash
docker compose down        # 停并删容器（卷保留）
docker compose ps          # 看状态
docker compose exec douyin-rec date   # 验证容器时区
```

---

## 环境变量

复制 `.env.example` 为 `.env` 后编辑。`.env` 已 gitignore，不会提交。

| 变量 | 默认 | 说明 |
|---|---|---|
| `TZ` | `Asia/Shanghai` | 只是容器启动前的初始值/`date` 等诊断命令参考。**调度实际用的时区由 config 决定**(`settings.timezone`,未设默认也是 `Asia/Shanghai`,启动时 `applyTimezone()` 会**覆盖** `process.env.TZ`,不看这个 env)——查看启动日志 `[tz] 时区 = ...` 或 `GET /api/timezone`;要改用 `POST /api/timezone`,立即生效。 |
| `PORT` | `7860` | Web UI 映射到宿主机的端口。 |
| `DB_DIR` | `./docker-data/db` | 宿主机目录 → 容器 `/data`；SQLite 库落在 `/data/douyin-rec.db`。任务、设置、全局 cookie 都在这。 |
| `OUTPUT_DIR` | `./docker-data/output` | 宿主机目录 → 容器 `/output`；任务**未单独设 outDir** 时录像/弹幕落在这（经 `DOUYIN_REC_OUTPUT`）。 |
| `CONFIG_DIR` | `./docker-data/config` | 宿主机目录 → 容器 `/config`；放 biliup 投稿 `cookies.json`、可选 `config.yaml`。 |
| `DISCORD_WEBHOOK` | 空 | 可选，录制开始/结束/出错通知。 |

> 容器内路径（`/data` `/output` `/config` `/app/web/dist`）是固定的，由 compose 写死，一般不用管；你只配宿主机侧路径。

### 改路径的例子

想把录像直接写到某块大盘、DB 放到固定位置：

```dotenv
# .env
TZ=Asia/Shanghai
PORT=7860
DB_DIR=/srv/douyin/db
OUTPUT_DIR=/mnt/bigdisk/douyin-recordings
CONFIG_DIR=/srv/douyin/config
```

改完 `docker compose up -d`（不必 `--build`，只改了卷映射时无需重新构建）。

---

## 卷与数据持久化

| 容器路径 | 宿主机（默认） | 内容 | 重建是否保留 |
|---|---|---|---|
| `/data` | `./docker-data/db` | `douyin-rec.db`（任务 + 设置 + cookie） | ✅ |
| `/output` | `./docker-data/output` | 录像 `.ts`/`.mp4`、弹幕 `.xml`/`.ass`（按 `{主播名}/` 分子目录） | ✅ |
| `/config` | `./docker-data/config` | biliup `cookies.json` / 可选 `config.yaml` | ✅ |

`docker-data/` 已 gitignore。容器以 root 跑，写到卷上的文件在宿主机也是 root 属主（自建 NAS/家用机一般无所谓；要非 root 可后续加 `user:`）。

---

## 设置抖音 Cookie（容器内）

镜像**不含 playwright/chromium**（省体积），所以**扫码登录不可用**。用手动粘贴：

1. 打开 Web 控制台 → 顶部「手动粘贴」。
2. 浏览器登录抖音，复制 cookie 字符串（含 `sessionid`、`sid_guard`），粘进去保存。
3. cookie 存进 `/data` 的 DB，所有任务共享；顶栏显示过期剩余天数（解析自 `sid_guard`）。

> 任务级「弹幕含礼物」开关需要全局 cookie 已设置；没设时该开关禁用。

---

## 它在容器里做什么

启动命令：`node dist/douyin-rec.mjs task serve --port 7860`

- **Web 控制台**（`/`）：建/启/停/删任务、查看详情与实时日志、管理全局 cookie。
- **定时调度**（默认开，`--no-schedule` 关）：按各任务 `schedule` 窗口（本地时区，支持跨夜）自动启停录制。
  - 进窗口 → 启动录制子进程（每任务独立 `record` 进程，崩溃自动重启）。
  - **出窗口 → 优雅排空（不腰斩直播）**：停开播轮询，当前这场录到自然收播再停；状态 `draining`，UI 显示「⏳ 超窗录制中」。详见 [app.md](./app.md#daemonts--taskdaemon)。

---

## 镜像构建说明

多阶段（见根 `Dockerfile`）：

- **builder**：`node:24-bookworm-slim` + pnpm workspace。装根依赖（无 pnpm patch，取流/弹幕均 vendored）→ `pnpm bundle` 打成自包含单文件 `dist/douyin-rec.mjs`；前端是独立工程 → `cd packages/web && pnpm build`，产物 `packages/web/dist`（runtime 拷成 `/app/web/dist`）。
- **runtime**：`node:24-bookworm-slim` + `ffmpeg`，只拷 `dist/` + `web/dist/` + `assets/`。bundle 内联了全部依赖，运行**无需 node_modules**。

要点：
- 需 **Node 24**（`node:sqlite` 内置库）。
- `ffmpeg`/`ffprobe` 录制必需，已 `apt-get install`。
- **Linux 容器免疫 macOS 的 rc-11 fork 崩溃**，比本地 mac 跑更稳。
- `.dockerignore` 排除了 `node_modules`/`dist`/`recordings`/`output`/`docker-data`/`*.db` 等，避免把 GB 级数据塞进构建上下文。

---

## 排查

| 现象 | 排查 |
|---|---|
| 定时窗口不按预期触发 | 时区由 config 决定,`docker compose exec ... date` 看到的是容器基线环境,**不是**我们服务实际用的时区(`applyTimezone()` 启动时覆盖了 `process.env.TZ`)——查 `docker compose logs` 里的 `[tz] 时区 = ...` 那行,或 `GET /api/timezone`;要改就 `POST /api/timezone {"timezone":"..."}`,立即生效不用重启。 |
| 页面打不开 | `docker compose ps` 看是否 running；`docker compose logs` 看启动报错；确认 `PORT` 没被占。 |
| 录像没出现 | 看任务详情日志；确认 `OUTPUT_DIR` 宿主机目录可写、磁盘有空间。 |
| 投稿失败 | 容器默认不自动投稿（`serve` 只录制）；投稿是单独的 `upload` 步骤，需 `/config/cookies.json`（biliup 登录态）。 |
| 扫码登录点了没反应 | 镜像不含 playwright，预期行为；改用「手动粘贴」。 |

```bash
docker compose logs -f --tail=200       # 实时日志
docker compose exec douyin-rec sh        # 进容器
docker compose up -d --build             # 改了代码后重建部署
```
