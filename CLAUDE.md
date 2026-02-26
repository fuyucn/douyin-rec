# CLAUDE.md — 项目上下文

## 项目概述

抖音直播流录制 & 自动截图工具。从直播流中录制视频、筛选好看照片（人脸检测 + 美学评分）、检测高能时刻。提供 CLI 和 Web UI 两种模式。

## 目录结构

```
main.py                      # 入口，argparse 子命令: portrait / highlight / live / record / task
src/
├── config.py                # 配置 dataclass (AppConfig) + YAML 加载
├── models.py                # 共享数据模型: FrameInfo, FaceInfo, FrameScore, HighlightMoment
├── display.py               # CLI headed 模式的 cv2 窗口显示 (人脸框、分数标注)
├── recorder.py              # StreamRecorder: ffmpeg -c copy 录制，支持 segment muxer 分段
├── task_manager.py          # TaskManager: 多任务并发管理 (CRUD + 执行控制 + 预览 + 日志持久化)
├── input/
│   ├── source.py            # VideoSource Protocol (统一接口)
│   ├── live.py              # DouyinLiveSource: 抖音直播流 (基于 streamget 库)
│   └── local.py             # LocalVideoSource: 本地视频文件
├── extract/
│   └── extractor.py         # FrameExtractor: 按目标 FPS 从视频源抽帧
├── filter/
│   ├── blur.py              # BlurDetector: Laplacian 方差模糊检测
│   ├── face.py              # FaceDetector: insightface 人脸检测 + 姿态过滤
│   ├── aesthetic.py         # AestheticScorer: CLIP + pyiqa 美学评分
│   └── pipeline.py          # FilterPipeline: 串联 blur → face → aesthetic，top-k 去重
├── highlight/
│   ├── audio.py             # 音频分析 (librosa 音量突变检测)
│   └── detector.py          # HighlightDetector: 音频候选 + 多模态 AI 判断
├── ai/
│   ├── base.py              # AIBackend 抽象基类
│   ├── factory.py           # 工厂函数，按配置创建后端
│   ├── claude_backend.py    # Anthropic Claude
│   ├── gemini_backend.py    # Google Gemini
│   ├── gpt4o_backend.py     # OpenAI GPT-4o
│   └── qwen_backend.py      # 通义千问
├── storage/
│   ├── database.py          # SQLModel 表定义 (Screenshot, HighlightClip, RecordingTask)
│   └── manager.py           # StorageManager: 保存图片 + SQLite 元数据
└── ui/
    ├── __init__.py
    ├── app.py               # FastAPI 应用: REST API + SSE 日志 + MJPEG 预览
    └── static/
        └── index.html        # SPA 前端 (daisyUI + Tailwind CDN, hash 路由)
tests/
├── test_config.py
├── test_extractor.py
├── test_live.py
├── test_models.py
├── test_recorder.py
├── test_task_manager.py
└── test_ui_api.py
output/
├── tasks.db                 # SQLite 任务数据库
└── logs/                    # 任务日志文件 (task_{id}.log)
```

## 关键设计

### 直播流获取 (streamget)

`src/input/live.py` 使用 [streamget](https://github.com/ihmily/streamget) 库获取抖音直播流地址：
- `fetch_app_stream_data()` — 支持短链接 (`v.douyin.com`)、用户主页链接，优先使用
- `fetch_web_stream_data()` — 仅支持 `live.douyin.com` 直链，作为回退
- streamget 是 async 库，通过 `_run_async()` 在同步上下文中调用
- `_run_async()` 检测是否已有 event loop (uvicorn 环境)，有则用 ThreadPoolExecutor 跑 `asyncio.run()`
- 开播状态: `status == 2` 开播, `status == 4` 未开播
- 画质映射: origin→OD, uhd→UHD, hd→HD, sd→SD, ld→LD
- `wait_for_live()` 支持 `show_countdown` 参数，启用后每 10 秒在日志输出剩余倒计时

### 录制 (ffmpeg segment muxer)

`src/recorder.py` 使用 ffmpeg 直接录制，`-c copy` 不转码：
- `segment_duration > 0` 时: `-f segment -segment_time N -segment_format mpegts -reset_timestamps 1`
- `segment_duration == 0` 时: `-f mpegts` 单文件
- `make_output_path()` 返回 `tuple[str, str]` (路径/模式串, 显示名)
- 文件命名: `{主播名}_{YYYY-MM-DD}_{HH-MM-SS}[_%03d].ts`

### 截图管线 (FilterPipeline)

`src/filter/pipeline.py` 三级串行过滤:
1. **模糊检测** (BlurDetector): Laplacian 方差，低于阈值丢弃
2. **人脸检测** (FaceDetector): insightface，检查置信度、面积比、姿态角
3. **美学评分** (AestheticScorer): CLIP 特征 + pyiqa 评分

选帧策略: 按美学评分降序，CLIP 余弦相似度去重，取 top-k。
`process_frame_detailed()` 返回中间结果，供 UI/headed 模式标注显示。

### 任务系统 (TaskManager)

`src/task_manager.py` 管理多任务并发:
- **DB 持久化**: SQLite 存储任务列表，跨 session 保留
- **自动迁移**: `_migrate_db()` 启动时自动为旧 DB 补充缺失列 (ALTER TABLE)
- **多任务并发**: 每个任务独立 worker 线程
- **持续监控**: 下播后自动等待下一次开播，直到手动停止
- **状态恢复**: 重启时将 running 状态恢复为 stopped
- **日志持久化**: 每个任务的日志写入 `output/logs/task_{id}.log`，页面刷新后可恢复
- **日志队列过滤**: `add_log_queue(task_id)` 支持按任务过滤，详情页 SSE 只收该任务日志

### RecordingTask 字段

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| url | str | - | 直播间 URL |
| name | str? | None | 主播名称 (自动获取) |
| quality | str | "origin" | 画质: origin/uhd/hd/sd/ld |
| enable_record | bool | True | 是否录制 |
| enable_screenshot | bool | False | 是否截图 |
| enable_segment | bool | True | 是否启用分段录制 |
| segment_sec | int | 1800 | 视频分段时间 (秒) |
| segment_min | int | 30 | (旧字段, 保留兼容) |
| poll_interval | int | 180 | 循环检测间隔 (秒) |
| show_countdown | bool | True | 是否显示循环倒计时 |
| max_threads | int | 3 | 网络线程数 |
| cookies | str? | None | cookie 字符串 |
| status | str | "pending" | pending/running/stopped/error |

### Web UI 架构 (FastAPI + SPA)

**前端**: 单 HTML 文件 SPA，daisyUI (night 主题) + Tailwind CDN，hash 路由 (`#/` 和 `#/task/{id}`)。

**后端 API**:

| 路由 | 方法 | 说明 |
|------|------|------|
| `/api/tasks` | GET | 任务列表 |
| `/api/tasks` | POST | 创建任务 |
| `/api/tasks/{id}` | GET | 单个任务详情 |
| `/api/tasks/{id}` | DELETE | 删除任务 |
| `/api/tasks/{id}/start` | POST | 启动任务 |
| `/api/tasks/{id}/stop` | POST | 停止任务 |
| `/api/tasks/{id}/preview` | POST | 切换预览 (toggle) |
| `/api/tasks/{id}/logs` | GET | SSE 该任务日志流 |
| `/api/tasks/{id}/logs/history` | GET | 历史日志 (JSON) |
| `/api/logs` | GET | SSE 全局日志流 |
| `/api/preview` | GET | MJPEG 画面流 |

**前端视图**:
- **列表页 `#/`**: 创建表单 + 任务表格，2 秒轮询刷新，行可点击进入详情
- **详情页 `#/task/{id}`**: 任务信息卡片 + 预览 toggle + 过滤后的 SSE 日志，加载时先 fetch 历史日志再接 SSE

线程模型:
- 每个任务一个 `_task_worker` 线程 (等待开播 → 录制/截图 → 流断重连)
- 每个活跃任务一个 `_preview_worker` 线程
- 每个任务用独立的 `threading.Event` 协调停止

预览优化:
- cv2 `CAP_PROP_BUFFERSIZE=1` 减少内部缓冲
- 连续 `grab()` 5 次排空缓冲区，只 `retrieve()` 最后一帧
- 目标 ~5fps，JPEG quality 65

### 子命令

| 命令 | 用途 |
|------|------|
| `record` | 纯录制 (支持 `--ui`, `--wait`, `--segment`) |
| `portrait` | 截图筛选好看照片 (本地视频或直播流) |
| `highlight` | 高能时刻检测 (本地视频) |
| `live` | 直播流处理 (截图 + 可选录制，旧接口) |
| `task` | 管理录制任务 (add/list/remove) |

`record --ui` 启动 FastAPI Web 界面，任务列表从 DB 加载。
`task add URL` 通过 CLI 创建持久化任务。

## 依赖

核心: opencv-python, ffmpeg-python, streamget, mediapipe, insightface, onnxruntime, torch, open-clip-torch, pyiqa, transformers, librosa, openai-whisper, sqlmodel, Pillow, pyyaml
UI: fastapi, uvicorn (optional extra)
AI: anthropic, google-generativeai, openai (optional extras)
系统: ffmpeg CLI

## 常用命令

```bash
# 开发运行
uv run python main.py record --ui                           # Web UI (任务列表从 DB 加载)
uv run python main.py record URL --wait --segment 30        # CLI 录制
uv run python main.py portrait URL                          # CLI 截图
uv run python main.py task add URL --record --screenshot     # CLI 创建任务
uv run python main.py task list                              # 列出所有任务
uv run python main.py task remove 1                          # 删除任务

# 安装依赖
uv sync --extra ui --extra all-ai

# 运行测试
uv run python -m pytest tests/ -v
```
