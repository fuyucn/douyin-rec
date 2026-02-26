"""共享数据模型"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum

import numpy as np


class HighlightCategory(str, Enum):
    FUNNY = "funny"
    SKILLFUL = "skillful"
    EMOTIONAL = "emotional"
    OTHER = "other"


@dataclass
class FrameInfo:
    """帧信息"""
    frame: np.ndarray
    timestamp: float  # 秒
    frame_index: int
    source: str  # 视频来源路径或 URL


@dataclass
class FaceInfo:
    """人脸检测结果"""
    bbox: tuple[int, int, int, int]  # x1, y1, x2, y2
    confidence: float
    yaw: float = 0.0
    pitch: float = 0.0
    roll: float = 0.0
    face_ratio: float = 0.0  # 人脸面积 / 画面面积


@dataclass
class FrameScore:
    """帧综合评分"""
    frame_info: FrameInfo
    blur_score: float = 0.0  # Laplacian 方差 (越高越清晰)
    face_info: FaceInfo | None = None
    aesthetic_score: float = 0.0  # 美学评分 (1-10)
    clip_features: np.ndarray | None = None  # 用于去重


@dataclass
class AudioSegment:
    """音频候选高能区间"""
    start_time: float
    end_time: float
    volume_ratio: float  # 相对平均音量的倍率
    frequency_change: float = 0.0  # 频率变化指标


@dataclass
class HighlightResult:
    """多模态 AI 分析结果"""
    is_highlight: bool
    score: float  # 0-1
    category: HighlightCategory = HighlightCategory.OTHER
    description: str = ""
    key_frame_indices: list[int] = field(default_factory=list)


@dataclass
class HighlightMoment:
    """高能时刻"""
    start_time: float
    end_time: float
    frames: list[FrameInfo]
    result: HighlightResult
    audio_segment: AudioSegment | None = None
