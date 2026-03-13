# 抖音直播录制 & 截图工具

抖音直播流录制、自动截图（好看照片筛选）、高能时刻检测。提供 **Web UI** 和 **CLI** 两种使用方式。

## 录制架构

录制核心基于 **[DouyinLiveRecorder (DLR)](https://github.com/ihmily/DouyinLiveRecorder)** 子进程方案：

```
uvicorn (Web UI + 任务管理)
  ├── task worker 线程 (task1)  →  DlrLauncher  →  Popen(runner.py, start_new_session=True)
  ├── task worker 线程 (task2)  →  DlrLauncher  →  Popen(runner.py, start_new_session=True)
  └── ...
```

每个任务启动一个独立 DLR 子进程，拥有自己的 tmpdir、config.ini、URL_config.ini，进程组完全隔离，互不干扰。DLR 负责等待开播、拉流地址获取、ffmpeg 录制、断流重连。

> 这个设计彻底解决了从 uvicorn 线程 fork ffmpeg 时由于 pthread 锁继承导致的 SIGSEGV (rc=-11) 问题。

## 功能

| 功能 | Web UI | CLI | 说明 |
|------|--------|-----|------|
| 录制 | ☑ 录制 | `record` 子命令 | DLR 子进程，.ts 分段，`-c copy` 零转码 |
| 等待开播 | 默认开启 | `--wait` | DLR 自行轮询，开播自动开始 |
| 分段录制 | 分段时长输入框 | `--segment 30` | 每 N 秒自动切割 .ts 文件 |
| 画质选择 | 画质下拉框 | `--quality origin` | origin / uhd / hd / sd / ld |
| 定时录制 | ☑ 定时 | — | 每日时间窗口，支持跨零点 |
| 多任务并发 | ☑ | — | 每任务独立 DLR 进程 |
| 自定义目录名 | 自定义目录名输入框 | — | 覆盖 DLR 主播子目录名 |
| 截图 | ☑ 截图 | `portrait` 子命令 | 人脸检测 + 模糊过滤 + 美学评分 |
| 高能时刻 | — | `highlight` 子命令 | 音频分析 + AI 判断 |

## 系统要求

- Python >= 3.11
- [DouyinLiveRecorder](https://github.com/ihmily/DouyinLiveRecorder) 安装于 `/Users/yuf/Developer/DouyinLiveRecorder`（含独立 `.venv`）
- [ffmpeg](https://ffmpeg.org/)（DLR 调用）
- [uv](https://github.com/astral-sh/uv)（包管理）

## 安装

```bash
# 基础 (CLI)
uv sync

# Web UI (额外安装 fastapi + uvicorn)
uv sync --extra ui

# AI 后端 (可选，高能时刻检测)
uv sync --extra claude   # Anthropic Claude
uv sync --extra gemini   # Google Gemini
uv sync --extra openai   # OpenAI GPT-4o
uv sync --extra all-ai   # 全部 AI 后端
```

## 使用

### Web UI

```bash
uv run python main.py record --ui          # 默认端口 7860
uv run python main.py record --ui --port 8080
```

浏览器打开 `http://localhost:7860`，填入直播间 URL，配置画质/分段/定时等选项，点击「添加任务」，再点任务行的「开始」。

支持的 URL 格式：
- `https://live.douyin.com/xxxxxxxxx` — 直播间页面
- `https://v.douyin.com/xxxxx` — 短链接
- 用户主页链接

### CLI

```bash
# 录制 (等待开播 + 1800s 分段)
uv run python main.py record https://live.douyin.com/xxx --wait --segment 30

# 截图 (从直播流自动筛选好看照片)
uv run python main.py portrait https://live.douyin.com/xxx

# 截图 (本地视频文件)
uv run python main.py portrait /path/to/video.mp4

# 高能时刻检测
uv run python main.py highlight /path/to/video.mp4

# 指定画质 + cookies
uv run python main.py record https://v.douyin.com/xxx --quality hd --wait
```

## 输出文件结构

```
output/
├── tasks.db                              # SQLite 任务数据库
├── logs/
│   └── task_{id}.log                     # 每个任务的持久化日志
└── recordings/
    └── task{id}_{主播名}/
        └── 抖音/
            └── {主播名或自定义目录名}/
                ├── 主播名_2026-03-13_12-30-05_000.ts
                ├── 主播名_2026-03-13_12-30-05_001.ts
                └── ...
```

> `自定义目录名` 在 Web UI 中配置，会覆盖 DLR 内部的主播子目录名。

## 任务配置说明

| 字段 | 说明 | 默认值 |
|------|------|--------|
| 直播间 URL | 抖音直播间地址 | — |
| 自定义目录名 | 覆盖录制子目录名（留空则用主播名） | — |
| 画质 | origin(原画) / uhd(超清) / hd(高清) / sd(标清) / ld(流畅) | origin |
| 分段时长 | 每段录制秒数，0 = 不分段 | 1800s |
| 循环检测间隔 | 未开播时轮询间隔（最少 180s） | 180s |
| 线程数 | DLR 同时访问网络的 API 请求并发数 | 3 |
| 定时录制 | 每日时间窗口，支持跨零点（如 22:00~02:00） | 关闭 |

## 技术细节

### DLR 子进程隔离

每次启动任务时：

1. `tempfile.mkdtemp()` 创建隔离 tmpdir（macOS 上用 `.resolve()` 展开 `/var → /private/var` 符号链接）
2. 写入 `tmpdir/config/config.ini`（录制参数）和 `tmpdir/config/URL_config.ini`（直播间 URL + 显示名）
3. 写入 `tmpdir/runner.py`：设置 `sys.argv[0] = __file__`，再 `exec()` DLR main.py（不用 `runpy.run_path`，后者会覆盖 `sys.argv[0]`）
4. `Popen([dlr_python, runner.py], start_new_session=True)` 启动独立进程组

DLR 通过 `os.path.realpath(sys.argv[0])` 确定 config 目录，指向 tmpdir，实现每任务配置完全隔离。

### 停止任务

`os.killpg(os.getpgid(pid), SIGTERM)` → wait 10s → SIGKILL。进程组包含 DLR 本身及其 fork 出的 ffmpeg。

## 配置文件

默认读取项目根目录 `config.yaml`（截图/AI 功能参数，录制参数在 Web UI 中配置）：

```yaml
input:
  extract_fps: 2.0           # 截图采样帧率
  quality: origin

blur:
  threshold: 100.0           # 模糊检测阈值

face:
  detection_confidence: 0.7
  min_face_ratio: 0.05
  max_yaw: 30.0
  max_pitch: 25.0

aesthetic:
  min_score: 5.0
  top_k: 20
  dedup_similarity: 0.95

storage:
  output_dir: ./output
  image_format: jpg
  image_quality: 95
```

## 常用命令

```bash
# 启动 Web UI
uv run python main.py record --ui

# 运行测试
uv run python -m pytest tests/ -v

# 重启（杀掉残留 DLR 进程后重启）
pkill -f "dlr_task"; uv run python main.py record --ui
```
