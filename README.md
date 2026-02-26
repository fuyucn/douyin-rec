# 抖音直播录制 & 截图工具

抖音直播流录制、自动截图（好看照片筛选）、高能时刻检测。提供 **Web UI** 和 **CLI** 两种使用方式，核心功能完全一致。

## 功能对照

| 功能 | CLI | UI | 说明 |
|------|-----|------|------|
| 录制 | `record` 子命令 | ☑ 录制 | ffmpeg 直录 .ts，`-c copy` 零转码 |
| 截图 | `portrait` 子命令 | ☑ 截图 | 人脸检测 + 模糊过滤 + 美学评分，自动筛选好看照片 |
| 画面预览 | `--headed` | ☑ 画面预览 | CLI 弹窗 / UI MJPEG 实时画面 |
| 等待开播 | `--wait` | 默认开启 | 未开播时轮询等待 (3 分钟间隔)，开播自动开始 |
| 分段录制 | `--segment 30` | 分段时长输入框 | 每 N 分钟自动切割 .ts 文件 (ffmpeg segment muxer) |
| 画质选择 | `--quality origin` | 画质下拉框 | origin / uhd / hd / sd / ld |

## 系统要求

- Python >= 3.11
- [ffmpeg](https://ffmpeg.org/) (录制功能)
- [uv](https://github.com/astral-sh/uv) (包管理)

## 安装

```bash
# 基础 (CLI)
uv sync

# Web UI (额外安装 fastapi + uvicorn)
uv sync --extra ui

# AI 后端 (可选)
uv sync --extra claude   # Anthropic Claude
uv sync --extra gemini   # Google Gemini
uv sync --extra openai   # OpenAI GPT-4o
uv sync --extra all-ai   # 全部 AI 后端
```

## 使用

### Web UI

```bash
python main.py record --ui                  # 默认端口 7860
python main.py record --ui --port 8080      # 自定义端口
```

浏览器打开 `http://localhost:7860`，填入直播间 URL，勾选需要的功能，点击「开始」。

支持的 URL 格式:
- `https://live.douyin.com/xxxxxxxxx` — 直播间页面
- `https://v.douyin.com/xxxxx` — 短链接
- 用户主页链接

### CLI

```bash
# 录制 (等待开播 + 30 分钟分段)
python main.py record https://live.douyin.com/xxx --wait --segment 30

# 录制 (不等待、不分段)
python main.py record https://live.douyin.com/xxx

# 截图 (从直播流自动筛选好看照片)
python main.py portrait https://live.douyin.com/xxx

# 截图 (本地视频文件)
python main.py portrait /path/to/video.mp4

# 高能时刻检测
python main.py highlight /path/to/video.mp4

# 指定画质 + cookies
python main.py record https://v.douyin.com/xxx --quality hd --wait --cookies cookies.txt
```

### 通用参数

```
--config FILE     配置文件路径 (默认 config.yaml)
--output-dir DIR  输出目录 (覆盖配置文件)
--headed          弹窗实时显示视频画面和标注 (CLI)
--cookies FILE    Netscape 格式 cookies.txt 文件路径
--name NAME       主播名称 (默认自动获取)
--quality Q       画质: origin(原画) uhd(蓝光) hd(高清) sd(标清) ld(流畅)
-v                详细日志
```

## 输出文件

```
output/
└── 主播名/
    ├── 主播名_2026-02-26_12-30-05_000.ts   # 分段录制
    ├── 主播名_2026-02-26_12-30-05_001.ts
    ├── 主播名_2026-02-26_14-00-00.ts        # 不分段录制
    ├── metadata.db                           # SQLite 元数据
    └── portrait/                             # 截图输出
        └── *.jpg
```

## 配置

默认读取项目根目录 `config.yaml`，不存在时使用内置默认值。

```yaml
input:
  extract_fps: 2.0          # 截图采样帧率
  quality: origin            # 直播画质
  segment_duration: 300.0    # 分段处理间隔秒数

blur:
  threshold: 100.0           # 模糊检测阈值 (Laplacian 方差)

face:
  detection_confidence: 0.7  # 人脸检测置信度
  min_face_ratio: 0.05       # 人脸最小面积比
  max_yaw: 30.0              # 最大偏航角
  max_pitch: 25.0            # 最大俯仰角

aesthetic:
  min_score: 5.0             # 最低美学评分 (1-10)
  top_k: 20                  # 每段保留张数
  dedup_similarity: 0.95     # CLIP 去重阈值

storage:
  output_dir: ./output
  image_format: jpg
  image_quality: 95
```
