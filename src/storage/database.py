"""SQLModel database models for screenshot and highlight metadata."""

from datetime import datetime

from sqlmodel import Field, SQLModel


class RecordingTask(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    url: str  # 直播间 URL
    name: str | None = None  # 主播名称 (自动获取或手动指定)
    quality: str = "uhd"  # 画质
    segment_min: int = 30  # (旧字段, 保留兼容) 分段时长(分钟)
    enable_record: bool = True  # 是否录制
    enable_screenshot: bool = False  # 是否截图
    cookies: str | None = None  # cookie 字符串
    enable_segment: bool = True  # 是否启用分段录制
    segment_sec: int = 1800  # 视频分段时间(秒)
    poll_interval: int = 180  # 循环检测间隔(秒)
    show_countdown: bool = True  # 是否显示循环倒计时
    max_threads: int = 3  # 同一时间访问网络的线程数
    enable_danmu: bool = False  # 是否录制弹幕
    danmu_cdn_delay: int = 6  # CDN 推流延迟补偿秒数（弹幕时间对齐）
    danmu_merge_types: str = "danmaku,gift"  # 合并时包含的弹幕类型（逗号分隔）
    auto_quality_fallback: bool = False  # ByteVC1 崩溃时自动降级画质
    schedule_enabled: bool = False  # 是否启用定时
    schedule_timezone: str = "Asia/Shanghai"  # 时区 (IANA)
    schedule_start: str = "00:00"  # 每日开始时间 HH:MM
    schedule_stop: str = "23:59"  # 每日停止时间 HH:MM
    schedule_run_until_end: bool = False  # 到定时停止时间后等直播自然结束
    custom_name: str | None = None  # 自定义输出文件夹名（可选，留空则用主播名）
    status: str = "pending"  # pending / running / stopped / error
    error_msg: str | None = None  # 错误信息
    created_at: datetime = Field(default_factory=datetime.now)
    started_at: datetime | None = None
    stopped_at: datetime | None = None
    # 流元数据（每次开播后从 API + FLV onMetaData 获取，覆盖写入）
    stream_title: str | None = None       # 直播标题
    stream_resolution: str | None = None  # 分辨率，如 "1088x1920"
    stream_fps: int | None = None         # 帧率
    stream_vbitrate: int | None = None    # 视频码率（bps）
    stream_vcodec: str | None = None      # 编码，如 "H264"
    stream_encoder: str | None = None     # FLV onMetaData Encoder 原始值


class Screenshot(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    source: str  # video file path or stream URL
    timestamp: float  # seconds in video
    frame_index: int
    blur_score: float
    aesthetic_score: float
    face_confidence: float | None = None
    face_yaw: float | None = None
    face_pitch: float | None = None
    category: str  # "portrait" or "highlight"
    image_path: str
    created_at: datetime = Field(default_factory=datetime.now)


class LocalVideoTask(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    video_path: str  # 本地文件路径
    name: str | None = None  # 显示名（默认取文件名）
    task_type: str = "portrait"  # "portrait" | "highlight"
    status: str = "pending"  # pending / running / completed / error
    error_msg: str | None = None
    progress: float = 0.0  # 0.0 ~ 100.0
    progress_text: str = ""  # "帧处理: 1234/5678"
    result_summary: str | None = None  # "保存 15 张照片"
    ai_backend: str | None = None  # 任务级 AI 后端覆盖，None 表示用全局默认
    created_at: datetime = Field(default_factory=datetime.now)
    finished_at: datetime | None = None


class RecordingSession(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    task_id: int = Field(index=True)
    ffmpeg_pid: int
    output_path: str
    started_at: datetime = Field(default_factory=datetime.now)
    ended_at: datetime | None = None
    duration_sec: float | None = None
    status: str = "active"  # active | stopped | orphan
    end_reason: str | None = None  # user_stop|stream_end|server_restart|orphan_died|error


class HighlightClip(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    source: str
    start_time: float
    end_time: float
    score: float
    category: str  # funny/skillful/emotional/other
    description: str
    key_frame_paths: str  # JSON list of image paths
    created_at: datetime = Field(default_factory=datetime.now)
