"""SQLModel database models for screenshot and highlight metadata."""

from datetime import datetime

from sqlmodel import Field, SQLModel


class RecordingTask(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    url: str  # 直播间 URL
    name: str | None = None  # 主播名称 (自动获取或手动指定)
    quality: str = "origin"  # 画质
    segment_min: int = 30  # 分段时长(分钟), 0=不分段
    enable_record: bool = True  # 是否录制
    enable_screenshot: bool = False  # 是否截图
    cookies: str | None = None  # cookie 字符串
    status: str = "pending"  # pending / running / stopped / error
    error_msg: str | None = None  # 错误信息
    created_at: datetime = Field(default_factory=datetime.now)
    stopped_at: datetime | None = None


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
